import assert from "node:assert/strict";
import test from "node:test";
import { draftHistoryReducer, personnelImportedEmployeeOrder } from "../app/personnelSpreadsheet.ts";
import { personnelReportImportSortOptions, personnelReportSortOptions } from "../app/personnelReportSorting.ts";

const draft = (key, employeeId, importBatchId) => ({ key, employeeId: String(employeeId), importBatchId });
const snapshot = (id, rows) => ({ id, rows: rows.map(({ key, employeeId }) => ({ key, employeeId })) });

test("workbook employee order uses first appearance across interleaved days, not names or IDs", () => {
  const file = [draft("first", 30, "file"), draft("second-day", 10, "file"), draft("first-again", 30, "file"), draft("third", 20, "file")];
  const batches = [snapshot("file", file)];
  assert.deepEqual(personnelImportedEmployeeOrder([file[0], file[2]], batches, file), [30, 10, 20]);
  assert.deepEqual(personnelImportedEmployeeOrder([file[1], file[3]], batches, file), [30, 10, 20]);
  // Saving the first day must not turn the second day into a different file order.
  assert.deepEqual(personnelImportedEmployeeOrder([file[1], file[3]], batches, [file[1], file[3]]), [30, 10, 20]);
});

test("later imports have their own restore order, without leaking into untouched manual drafts", () => {
  const old = [draft("old-1", 30, "old"), draft("old-2", 10, "old")];
  const fresh = [draft("new-1", 20, "new"), draft("new-2", 30, "new")];
  const batches = [snapshot("old", old), snapshot("new", fresh)];
  assert.deepEqual(personnelImportedEmployeeOrder([...fresh, ...old], batches), [20, 30]);
  assert.deepEqual(personnelImportedEmployeeOrder(old, batches), [30, 10]);
  assert.equal(personnelImportedEmployeeOrder([draft("manual", 10)], batches), undefined);
});

test("correcting unmatched employees keeps their original file position and omits unresolved identities", () => {
  const file = [draft("unmatched", "", "file"), draft("valid", 10, "file"), draft("bad", "", "file")];
  const batches = [snapshot("file", file)];
  assert.deepEqual(personnelImportedEmployeeOrder(file, batches), [10]);
  assert.deepEqual(personnelImportedEmployeeOrder(file, batches, [{ ...file[0], employeeId: "30" }, file[1], file[2]]), [30, 10]);
  assert.deepEqual(personnelImportedEmployeeOrder(file, batches, [{ ...file[0], employeeId: "10" }, file[1], file[2]]), [10]);
  assert.equal(personnelImportedEmployeeOrder([file[0]], [snapshot("file", [file[0]])]), undefined);
});

test("undo and redo retain import identity and restore the matching workbook order", () => {
  const original = [draft("old", 30, "old")];
  const imported = [draft("new", 10, "new"), ...original];
  const batches = [snapshot("old", original), snapshot("new", imported.slice(0, 1))];
  let history = { present: original, past: [], future: [] };
  history = draftHistoryReducer(history, { type: "change", update: imported });
  assert.deepEqual(personnelImportedEmployeeOrder(history.present, batches), [10]);
  history = draftHistoryReducer(history, { type: "undo" });
  assert.deepEqual(personnelImportedEmployeeOrder(history.present, batches), [30]);
  history = draftHistoryReducer(history, { type: "redo" });
  assert.deepEqual(personnelImportedEmployeeOrder(history.present, batches), [10]);
});

test("personnel has an explicit ascending import sort without affecting equipment activity options", () => {
  assert.deepEqual(personnelReportImportSortOptions[0], { label: "Порядок импорта", columnId: "__importOrder", sort: "asc" });
  assert.deepEqual(personnelReportImportSortOptions.slice(1), personnelReportSortOptions);
});
