import assert from "node:assert/strict";
import test from "node:test";
import { comparePersonnelActivity, personnelActivityTime } from "../app/personnelReportSorting.ts";
import { timestampPersonnelDraft } from "../app/personnelSpreadsheet.ts";
import { normalizePersonnelReportRows, personnelReportRowChanged } from "../app/personnelReportWorkflow.ts";

const sortRows = (rows, field, descending) => rows.map((row, rank) => ({ ...row, rank })).sort((a, b) => (descending ? -1 : 1) * comparePersonnelActivity(
  personnelActivityTime(a[field], a.workDate), personnelActivityTime(b[field], b.workDate), a.rank, b.rank));
const rows = [
  { name: "Анна", workDate: "2026-10-28", createdAt: "2026-10-28T08:00:00Z", updatedAt: "2026-10-28T11:00:00Z" },
  { name: "Яков", workDate: "2026-10-27", createdAt: "2026-10-28T09:00:00Z", updatedAt: "2026-10-28T10:00:00Z" },
];

test("activity comparison ignores employee names; date grouping is applied separately", () => {
  assert.deepEqual(sortRows(rows, "createdAt", true).map(row => row.name), ["Яков", "Анна"]);
  assert.deepEqual(sortRows(rows, "createdAt", false).map(row => row.name), ["Анна", "Яков"]);
  assert.deepEqual(sortRows(rows, "updatedAt", true).map(row => row.name), ["Анна", "Яков"]);
  assert.deepEqual(sortRows(rows, "updatedAt", false).map(row => row.name), ["Яков", "Анна"]);
});

test("oldest-first reverses the order even for rows saved together in one batch", () => {
  const batch = ["Яков", "Борис", "Анна"].map(name => ({ ...rows[0], name }));
  assert.deepEqual(sortRows(batch, "createdAt", true).map(row => row.name), ["Яков", "Борис", "Анна"]);
  assert.deepEqual(sortRows(batch, "createdAt", false).map(row => row.name), ["Анна", "Борис", "Яков"]);
  assert.ok(Number.isFinite(personnelActivityTime("invalid", "2026-10-28")));
});

test("editing changes only the modification time and no-op commits keep the original row", () => {
  const draft = { key: "a", employeeId: "1", employeeQuery: "Яков", shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", masterId: "1", hours: "8", note: "", createdAt: rows[0].createdAt, updatedAt: rows[0].updatedAt };
  assert.equal(timestampPersonnelDraft(draft, { ...draft }), draft);
  const changed = timestampPersonnelDraft(draft, { ...draft, note: "Исправлено" }, "2026-10-28T12:00:00Z");
  assert.equal(changed.createdAt, draft.createdAt);
  assert.equal(changed.updatedAt, "2026-10-28T12:00:00Z");
});

test("row IDs are validated, client-supplied timestamps are ignored, reordering is not editing", () => {
  const [original] = normalizePersonnelReportRows([{ id: 5, employeeId: 3, hours: 8, createdAt: "2099-01-01T00:00:00Z", updatedAt: "2099-01-01T00:00:00Z" }]);
  assert.equal(original.id, 5);
  assert.equal(original.createdAt, undefined);
  assert.equal(original.updatedAt, undefined);
  assert.equal(personnelReportRowChanged(original, { ...original, rowOrder: 90 }), false);
  assert.equal(personnelReportRowChanged(original, { ...original, note: "Новое примечание" }), true);
  for (const id of [0, -2, "3", 1.5]) assert.throws(() => normalizePersonnelReportRows([{ id }]), /идентификатор/);
});
