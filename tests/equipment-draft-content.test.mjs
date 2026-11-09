import assert from "node:assert/strict";
import test from "node:test";
import { equipmentDraftContent } from "../app/equipmentReportDraftContent.ts";

const draft = (key, changes = {}) => ({ key, equipmentId: "1", equipmentQuery: "Иван", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", hours: "", note: "", ...changes });
const catalogs = { units: [{ id: 1, equipmentType: "Кран", brand: "", model: "", registrationNumber: "" }], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [] };
const report = (id, changes = {}) => ({ id, siteId: 1, ownerUserId: 10, status: "draft", revision: 1, rows: [{ id: id * 10, note: "Исходное примечание" }], ...changes });
const toDraft = row => draft(`report-${row.reportId}-${row.id}`, { reportRowId: row.id, note: row.note });

test("autosave keeps only this user's unfinished records and preserves each original day", () => {
  const reports = [report(1), report(2, { status: "rejected" }), report(3, { ownerUserId: 11 }), report(4, { siteId: 2 }), report(5, { status: "submitted" }), report(6, { status: "approved" })];
  const edits = Object.fromEntries(reports.map(item => [String(item.id), [draft(`row-${item.id}`)]]));
  edits["new:2026-11-05"] = [draft("new-yesterday")]; edits["new:2026-11-06"] = [draft("new-today")];
  edits["new:2026-02-30"] = [draft("invalid-date")]; edits["entry-7"] = [draft("approved-legacy")];
  const result = equipmentDraftContent(10, 1, "2026-11-06", edits, {}, reports, [], null, catalogs, toDraft);
  assert.deepEqual(Object.keys(result.edits), ["1", "2", "new:2026-11-05", "new:2026-11-06"]);
  assert.deepEqual(Object.keys(result.sessions), ["1", "2"]);
  assert.equal(result.edits["new:2026-11-05"][0], edits["new:2026-11-05"][0]);
});

test("active input is recoverable before Enter without changing the displayed draft or undo history", () => {
  const original = draft("typing");
  const edits = { "new:2026-11-06": [original] };
  const result = equipmentDraftContent(10, 1, "2026-11-06", edits, {}, [], [], { rowKey: "typing", field: "hours", value: "ошибка ввода" }, catalogs, toDraft);
  assert.equal(result.edits["new:2026-11-06"][0].hours, "ошибка ввода");
  assert.equal(result.edits["new:2026-11-06"][0].inputValues.hours, "ошибка ввода");
  assert.equal(original.hours, ""); assert.equal(original.inputValues, undefined);
});

test("typing into a saved personal draft captures its original identity and version", () => {
  const saved = report(1); saved.rows[0].reportId = saved.id;
  const frozen = { ...saved, revision: 2 };
  const newer = { ...saved, revision: 3 };
  const result = equipmentDraftContent(10, 1, "2026-11-06", {}, { 1: frozen }, [newer], [], { rowKey: "report-1-10", field: "note", value: "Не успел нажать Enter" }, catalogs, toDraft);
  assert.equal(result.sessions[1].revision, 2);
  assert.equal(result.edits[1][0].reportRowId, 10);
  assert.equal(result.edits[1][0].note, "Не успел нажать Enter");
  assert.equal(saved.rows[0].note, "Исходное примечание");
  for (const status of ["submitted", "approved"]) {
    assert.deepEqual(equipmentDraftContent(10, 1, "2026-11-06", {}, {}, [{ ...saved, status }], [], { rowKey: "report-1-10", field: "note", value: "Не сохранять автоматически" }, catalogs, toDraft).edits, {});
  }
});

test("recovery retains import ordering metadata only while its draft rows remain", () => {
  const batch = { id: "file-1", rows: [{ key: "imported", equipmentId: "1" }] };
  const unused = { id: "file-2", rows: [{ key: "other", equipmentId: "2" }] };
  const result = equipmentDraftContent(10, 1, "2026-11-06", { "new:2026-11-06": [draft("imported", { importBatchId: "file-1" })] }, {}, [], [batch, unused], null, catalogs, toDraft);
  assert.deepEqual(result.importBatches, [batch]);
  assert.deepEqual(equipmentDraftContent(10, 1, "2026-11-06", {}, {}, [], [batch, unused], null, catalogs, toDraft).importBatches, []);
});
