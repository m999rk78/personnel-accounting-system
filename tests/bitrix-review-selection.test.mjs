import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { bitrixReviewUpdateBatches, bitrixReviewUpdateIds } from "../app/bitrixReviewSelection.ts";

const changed = id => ({ kind: "changed", employeeName: `Сотрудник ${id}`, localEmployeeId: id, bitrix24Id: `B${id}` });
test("review selection excludes creation, missing cards and ignored warnings", () => {
  assert.deepEqual(bitrixReviewUpdateIds({ differences: [changed(1), changed(1), { ...changed(2), acknowledged: true }, { ...changed(3), kind: "dismissed_in_bitrix", acknowledged: true }, { ...changed(4), kind: "missing_in_bitrix" }, { ...changed(5), kind: "missing_locally" }, { ...changed(6), bitrix24Id: undefined }, { ...changed(7), localEmployeeId: undefined }] }), [1]);
});
test("review selection includes explicit dismissal and blacklist status application", () => {
  const blacklisted = { ...changed(8), kind: "blacklisted_in_bitrix" };
  const dismissed = { ...changed(11), kind: "dismissed_in_bitrix" };
  assert.deepEqual(bitrixReviewUpdateIds({ differences: [changed(1), blacklisted, dismissed, { ...blacklisted, acknowledged: true, localEmployeeId: 9 }, { ...blacklisted, bitrix24Id: undefined, localEmployeeId: 10 }] }), [1, 8, 11]);
});
test("select all uses the full server ID set, not the 100-row preview", () => {
  const ids = Array.from({ length: 451 }, (_, index) => index + 1);
  assert.deepEqual(bitrixReviewUpdateIds({ differences: ids.slice(0, 100).map(changed), updatableEmployeeIds: [...ids, 1, -1, 0, 1.5] }), ids);
  assert.deepEqual(bitrixReviewUpdateIds({ differences: [changed(1)], updatableEmployeeIds: [] }), []);
  const batches = bitrixReviewUpdateBatches([...ids, 1, -1, NaN]);
  assert.deepEqual(batches.map(batch => batch.length), [200, 200, 51]);
  assert.deepEqual(batches.flat(), ids);
});

async function serverHarness(rows, failIds = []) {
  // Exercise the existing real batch coordinator without loading server/env/DB modules.
  const route = await readFile(new URL("../app/server/data/bitrixReview.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("route.ts", route, ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "updateSelectedBitrixEmployees");
  const guard = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "assertBitrixEmployeeNotInCentralOffice");
  assert.ok(fn && guard);
  const fixture = `
    import { isBitrixCentralOfficeEmployee } from ${JSON.stringify(new URL("../app/bitrix24Sync.ts", import.meta.url).href)};
    const rows=${JSON.stringify(rows)}, failures=new Set(${JSON.stringify(failIds)});
    export const calls=[];
    const env={DB:{prepare(){return {bind(ids){return {async all(){return {results:rows.filter(row=>ids.includes(row.id))}}}}}}}};
    const asPositiveInteger=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
    async function updateBitrixEmployeeRecord(snapshot,id,bitrixId){
      const card=snapshot.find(card=>card.bitrix24Id===bitrixId);calls.push({id,bitrixId,position:card?.position});
      if(failures.has(id))throw new Error('Ошибка отдельной карточки');
      return {id,name:card.fullName};
    }
    async function archiveTerminalBitrixEmployeeRecord(card,id,bitrixId){
      calls.push({id,bitrixId,archiveStatus:card.availabilityStatus});
      if(failures.has(id))throw new Error('Ошибка отдельной карточки');
      return {id,name:card.fullName};
    }
    async function buildBitrixInspection(){return {response:{status:'mismatch',differences:[]}}}
    ${guard.getText(source)}
    ${fn.getText(source).replace(/^export /, "")}
    export {updateSelectedBitrixEmployees};
  `;
  const code = ts.transpileModule(fixture, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const linked = id => ({ id, fullName: `Сотрудник ${id}`, bitrix24Id: `B${id}`, checkStatus: "mismatch", acknowledgedAt: null });
const bitrixCard = (id, availabilityStatus = "on_site") => ({ bitrix24Id: `B${id}`, fullName: `Сотрудник ${id}`, position: `Разная должность ${id}`, availabilityStatus });
const snapshot = [1, 2, 3].map(id => bitrixCard(id));
test("bulk API chooses each employee's own linked Bitrix card and preserves partial results", async () => {
  const api = await serverHarness([linked(1), linked(2), linked(3)], [2]);
  const result = await api.updateSelectedBitrixEmployees(snapshot, { employeeIds: [3, 1, 2, 1], bitrix24Id: "B1" });
  assert.deepEqual(api.calls, [3, 1, 2].map(id => ({ id, bitrixId: `B${id}`, position: `Разная должность ${id}` })));
  assert.deepEqual(result.updatedEmployees.map(row => row.id), [3, 1]);
  assert.equal(result.failedEmployees[0].id, 2);
});
test("bulk API refuses unlinked, unauthorized dismissal, ignored, missing and oversized selections", async () => {
  const api = await serverHarness([linked(1), { ...linked(2), bitrix24Id: null }, { ...linked(3), checkStatus: "dismissed_in_bitrix" }, { ...linked(4), acknowledgedAt: "2026-11-02" }]);
  const result = await api.updateSelectedBitrixEmployees([bitrixCard(1), bitrixCard(3, "dismissed"), bitrixCard(4)], { employeeIds: [1, 2, 3, 4, 999] });
  assert.deepEqual(api.calls.map(row => row.id), [1]);
  assert.deepEqual(result.failedEmployees.map(row => row.id), [2, 3, 4, 999]);
  assert.match(result.failedEmployees[1].error, /Недостаточно прав/);
  await assert.rejects(api.updateSelectedBitrixEmployees(snapshot, { employeeIds: Array.from({ length: 201 }, (_, index) => index + 1) }), /200 сотрудников/);
  await assert.rejects(api.updateSelectedBitrixEmployees(snapshot, { employeeIds: [] }), /Не выбраны/);
});

test("bulk API routes fresh dismissal and blacklist to archival without applying their HR fields", async () => {
  const api = await serverHarness([
    linked(1),
    { ...linked(2), checkStatus: "dismissed_in_bitrix" },
    { ...linked(3), checkStatus: "blacklisted_in_bitrix" },
    { ...linked(4), checkStatus: "dismissed_in_bitrix", acknowledgedAt: "2026-11-02" },
  ]);
  const result = await api.updateSelectedBitrixEmployees([
    bitrixCard(1), { ...bitrixCard(2, "dismissed"), position: "" }, { ...bitrixCard(3, "blacklisted"), position: "" }, bitrixCard(4, "dismissed"),
  ], { employeeIds: [2, 1, 3, 4] }, { mayArchiveDismissed: true });
  assert.deepEqual(api.calls, [
    { id: 2, bitrixId: "B2", archiveStatus: "dismissed" },
    { id: 1, bitrixId: "B1", position: "Разная должность 1" },
    { id: 3, bitrixId: "B3", archiveStatus: "blacklisted" },
  ]);
  assert.deepEqual(result.updatedEmployees.map(row => row.id), [2, 1, 3]);
  assert.deepEqual(result.failedEmployees.map(row => row.id), [4]);
});

test("bulk API refuses a fresh terminal change, reversed terminal warning or duplicate Bitrix ID", async () => {
  const api = await serverHarness([
    linked(1), linked(2), linked(3), linked(4),
    { ...linked(5), checkStatus: "dismissed_in_bitrix" },
    { ...linked(6), checkStatus: "blacklisted_in_bitrix" },
    { ...linked(7), checkStatus: "dismissed_in_bitrix" },
    linked(8), linked(9),
  ]);
  const result = await api.updateSelectedBitrixEmployees([
    bitrixCard(1), bitrixCard(2, "dismissed"), bitrixCard(3, "blacklisted"), bitrixCard(4, "deleted"),
    bitrixCard(5), bitrixCard(6, "dismissed"), bitrixCard(7, "blacklisted"), bitrixCard(8), bitrixCard(8, "dismissed"),
  ], { employeeIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { mayArchiveDismissed: true });
  assert.deepEqual(api.calls.map(row => row.id), [1]);
  assert.deepEqual(result.failedEmployees.map(row => row.id), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(result.failedEmployees.slice(0, 6).every(row => /изменился после проверки/.test(row.error)));
  assert.match(result.failedEmployees[6].error, /несколько карточек/);
  assert.match(result.failedEmployees[7].error, /больше не найдена/);
});
