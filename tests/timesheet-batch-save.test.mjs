import assert from "node:assert/strict";
import test from "node:test";
import { createTimesheetBatchSave } from "../app/timesheetBatchSave.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const job = (key, save, value = "8") => ({ key, label: `Техника ${key}, 5 ноября`, value, save });

test("large paste limits concurrent writes and accounts for every saved cell", async () => {
  const controller = createTimesheetBatchSave();
  const pending = [];
  let inFlight = 0;
  let maximum = 0;
  const operation = controller.run(Array.from({ length: 13 }, (_, index) => job(String(index), async () => {
    const request = deferred();
    pending.push(request);
    maximum = Math.max(maximum, ++inFlight);
    await request.promise;
    inFlight--;
    return index;
  })));
  assert.equal(pending.length, 4);
  assert.equal(controller.getSnapshot().status.pending, 13);
  for (let index = 0; index < 13; index++) {
    assert.ok(pending[index], "Another request starts only after a slot is free");
    pending[index].resolve();
    await tick();
  }
  const result = await operation;
  assert.equal(maximum, 4);
  assert.equal(result.saved.length, 13);
  assert.equal(result.failed.length, 0);
  assert.equal(controller.getSnapshot().busy, false);
  assert.deepEqual(controller.getSnapshot().status, { total: 13, saved: 13, failed: 0, pending: 0, failures: [] });
});

test("partial failures retain values and retry only failed stable IDs", async () => {
  const calls = [];
  const updates = [];
  let failSecond = true;
  const controller = createTimesheetBatchSave({ onSaved: (saved, retry) => updates.push({ keys: saved.map(row => row.job.key), retry }) });
  const jobs = ["unit-1:2026-11-05", "unit-2:2026-11-05", "unit-3:2026-11-05"].map(key => job(key, async () => {
    calls.push(key);
    if (key.startsWith("unit-2") && failSecond) throw new Error("Нет соединения");
    return { key, hours: 8 };
  }));
  const first = await controller.run(jobs);
  assert.deepEqual(first.saved.map(row => row.job.key), [jobs[0].key, jobs[2].key]);
  assert.deepEqual(first.failed.map(row => row.job.key), [jobs[1].key]);
  assert.equal(controller.getCellState(jobs[1].key).value, "8");
  assert.equal(controller.getCellState(jobs[1].key).error, "Нет соединения");
  assert.equal(controller.getSnapshot().status.saved, 2);
  assert.equal(controller.getSnapshot().status.failed, 1);
  failSecond = false;
  const retry = await controller.retry();
  assert.deepEqual(retry.saved.map(row => row.job.key), [jobs[1].key]);
  assert.deepEqual(calls, [jobs[0].key, jobs[1].key, jobs[2].key, jobs[1].key]);
  assert.equal(controller.getSnapshot().status.saved, 3);
  assert.equal(controller.getSnapshot().status.failed, 0);
  assert.deepEqual(updates, [{ keys: [jobs[0].key, jobs[2].key], retry: false }, { keys: [jobs[1].key], retry: true }]);
});

test("all failures remain visible and cannot be dismissed accidentally", async () => {
  let callbacks = 0;
  const controller = createTimesheetBatchSave({ onSaved: () => callbacks++ });
  const first = await controller.run([job("1", async () => { throw new Error("Запрещено"); }), job("2", async () => { throw "network"; })]);
  assert.equal(first.saved.length, 0);
  assert.equal(first.failed.length, 2);
  assert.equal(callbacks, 0);
  controller.dismiss();
  assert.equal(controller.getSnapshot().status.failed, 2);
  assert.match(controller.getCellState("2").error, /Не удалось сохранить/);
});

test("a later paste replaces its targeted retry value while retaining failures in other cells", async () => {
  const calls = [];
  const controller = createTimesheetBatchSave();
  await controller.run([job("employee-1:day-5", async () => { calls.push("old 8"); throw new Error("Сбой"); }), job("employee-2:day-5", async () => { calls.push("other 8"); throw new Error("Сбой"); })]);
  await controller.run([job("employee-1:day-5", async () => { calls.push("new 6"); return 6; }, "6")]);
  assert.equal(controller.getCellState("employee-1:day-5").value, "6");
  assert.equal(controller.getSnapshot().status.failed, 1);
  await controller.retry();
  assert.deepEqual(calls, ["old 8", "other 8", "new 6", "other 8"]);
  assert.equal(controller.getCellState("employee-1:day-5").state, "saved");
});

test("successful manual correction clears its old retry without resending stale input", async () => {
  let saves = 0;
  const controller = createTimesheetBatchSave();
  await controller.run([job("employee-1:2026-11-05", async () => { saves++; throw new Error("Сбой"); })]);
  controller.clearCell("employee-1:2026-11-05");
  const retry = await controller.retry();
  assert.equal(saves, 1);
  assert.equal(retry.saved.length, 0);
  assert.equal(retry.failed.length, 0);
  assert.equal(controller.getSnapshot().status, null);
});

test("duplicate attempts cannot send a second overlapping batch", async () => {
  const request = deferred();
  let count = 0;
  const controller = createTimesheetBatchSave();
  const operation = controller.run([job("1", async () => { count++; await request.promise; return 8; })]);
  await assert.rejects(controller.run([job("2", async () => { count++; return 4; })]), /Дождитесь завершения/);
  await assert.rejects(controller.retry(), /Дождитесь завершения/);
  assert.equal(count, 1);
  request.resolve();
  await operation;
  assert.equal(controller.getSnapshot().status.total, 1);
});

test("changing scope stops queued jobs and prevents old responses from updating the new table", async () => {
  const requests = [];
  let started = 0;
  let finished = 0;
  const callbacks = [];
  const controller = createTimesheetBatchSave({ concurrency: 2, onStart: () => started++, onFinish: () => finished++, onSaved: saved => callbacks.push(saved) });
  const operation = controller.run(Array.from({ length: 8 }, (_, index) => job(String(index), async () => {
    const request = deferred();
    requests.push(request);
    await request.promise;
    return index;
  })));
  assert.equal(requests.length, 2);
  controller.deactivate();
  requests.forEach(request => request.resolve());
  const result = await operation;
  assert.equal(result.cancelled, true);
  assert.equal(requests.length, 2, "Six queued writes must never be sent after changing project/month");
  assert.equal(callbacks.length, 0);
  assert.equal(controller.getSnapshot().status, null);
  assert.equal(started, 1);
  assert.equal(finished, 1);
});

test("an old scope finishing cannot release the lock of a newer operation", async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const saved = [];
  const controller = createTimesheetBatchSave({ onSaved: results => saved.push(...results.map(row => row.value)) });
  const oldOperation = controller.run([job("old", async () => { await oldRequest.promise; return "old"; })]);
  controller.deactivate();
  controller.activate();
  const newOperation = controller.run([job("new", async () => { await newRequest.promise; return "new"; })]);
  oldRequest.resolve();
  await oldOperation;
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getCellState("new").state, "saving");
  newRequest.resolve();
  await newOperation;
  assert.deepEqual(saved, ["new"]);
});

test("duplicate keys in a single batch submit only the latest value", async () => {
  const calls = [];
  const controller = createTimesheetBatchSave();
  await controller.run([job("same", async () => { calls.push(8); return 8; }), job("same", async () => { calls.push(6); return 6; }, "6")]);
  assert.deepEqual(calls, [6]);
  assert.equal(controller.getSnapshot().status.total, 1);
});

test("clearing an in-flight cell prevents its stale completion from restoring a removed retry", async () => {
  const request = deferred();
  const updates = [];
  const controller = createTimesheetBatchSave({ onSaved: saved => updates.push(...saved) });
  const operation = controller.run([job("same", async () => { await request.promise; throw new Error("Late failure"); })]);
  controller.clearCell("same");
  request.resolve();
  const result = await operation;
  assert.equal(result.failed.length, 0);
  assert.equal(controller.getSnapshot().status, null);
  assert.equal(updates.length, 0);
});

test("successful notice can be dismissed after completion", async () => {
  const controller = createTimesheetBatchSave();
  await controller.run([job("1", async () => 8)]);
  controller.dismiss();
  assert.equal(controller.getSnapshot().status, null);
  assert.equal(controller.getCellState("1"), undefined);
});
