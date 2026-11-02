import assert from "node:assert/strict";
import test from "node:test";
import { requestTimesheetMonthChange, timesheetEditorCellChanged } from "../app/timesheetNavigation.ts";

test("outside clicks and dialogs keep the inline buffer when clipboard selection clears", () => {
  const editor = { rowIndex: 3, columnIndex: 8, value: "invalid hours", error: "Check the value" };
  assert.equal(timesheetEditorCellChanged(editor, null), false);
  assert.equal(timesheetEditorCellChanged(editor, { rowIndex: 3, columnIndex: 8 }), false);
  assert.equal(timesheetEditorCellChanged(editor, { rowIndex: 4, columnIndex: 8 }), true);
  assert.equal(timesheetEditorCellChanged(editor, { rowIndex: 3, columnIndex: 9 }), true);
  assert.equal(editor.value, "invalid hours");
  assert.equal(editor.error, "Check the value");
});

test("month navigation waits for the answer and cancellation preserves month, editor and URL", async () => {
  const editor = { value: "12?", error: "Invalid value" };
  const state = { month: "2026-10", editor, url: "/timesheets/equipment?month=2026-10" };
  let answer;
  const pending = requestTimesheetMonthChange({
    currentMonth: state.month, nextMonth: "2026-11", busy: false, hasPendingEditor: true,
    confirmDiscard: () => new Promise(resolve => { answer = resolve; }),
    commit: month => { state.month = month; state.editor = null; state.url = `/timesheets/equipment?month=${month}`; },
  });
  assert.deepEqual(state, { month: "2026-10", editor, url: "/timesheets/equipment?month=2026-10" });
  answer(false);
  assert.equal(await pending, false);
  assert.deepEqual(state, { month: "2026-10", editor, url: "/timesheets/equipment?month=2026-10" });
});

test("confirmed month navigation discards only after acceptance and applies exactly once", async () => {
  const events = [];
  const changed = await requestTimesheetMonthChange({
    currentMonth: "2026-10", nextMonth: "2026-11", busy: false, hasPendingEditor: true,
    confirmDiscard: async () => { events.push("confirm"); return true; },
    commit: month => events.push(month),
  });
  assert.equal(changed, true);
  assert.deepEqual(events, ["confirm", "2026-11"]);
});

test("active saves and the current month neither prompt nor discard an editor", async () => {
  for (const [busy, nextMonth] of [[true, "2026-11"], [false, "2026-10"]]) {
    const changed = await requestTimesheetMonthChange({
      currentMonth: "2026-10", nextMonth, busy, hasPendingEditor: true,
      confirmDiscard: () => { assert.fail("No confirmation during a save or unchanged month"); },
      commit: () => assert.fail("The current editor must remain intact"),
    });
    assert.equal(changed, false);
  }
});

test("month navigation without an editor does not ask for unnecessary confirmation", async () => {
  const applied = [];
  assert.equal(await requestTimesheetMonthChange({
    currentMonth: "2026-10", nextMonth: "2026-11", busy: false, hasPendingEditor: false,
    confirmDiscard: () => assert.fail("No input buffer to discard"),
    commit: month => applied.push(month),
  }), true);
  assert.deepEqual(applied, ["2026-11"]);
});
