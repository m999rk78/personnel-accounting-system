import assert from "node:assert/strict";
import test from "node:test";
import { reportFooterSaveScope } from "../app/reportFooterActions.ts";

const approved = [
  { rowKey: "report-10-1", proposalId: 10 },
  { rowKey: "report-10-2", proposalId: 10 },
  { rowKey: "approved-45", draftGroupKey: "entry-45" },
];
const submitted = [{ rowKey: "report-12-1", proposalId: 12 }];

test("approved saves select exact report and legacy entry owners, preserving other tabs", () => {
  const result = reportFooterSaveScope(approved, ["10", "entry-45", "12", "new:2026-11-20", "10"]);
  assert.deepEqual(result, { saveKeys: ["10", "entry-45"], hasChanges: true });
});

test("a clean or empty approved view has no save action even with dirty drafts or reviews", () => {
  for (const rows of [[], approved]) {
    assert.deepEqual(reportFooterSaveScope(rows, ["12", "new:2026-11-20"]), { saveKeys: [], hasChanges: false });
  }
});

test("review save targets only the currently opened report", () => {
  assert.deepEqual(reportFooterSaveScope(submitted, ["10", "12", "13", "entry-45"]), { saveKeys: ["12"], hasChanges: true });
  assert.equal(reportFooterSaveScope(submitted, ["13"]).hasChanges, false);
});

test("typing reveals Save before blur, while typing in another view cannot expose it", () => {
  assert.deepEqual(reportFooterSaveScope(approved, [], "report-10-1"), { saveKeys: [], hasChanges: true });
  assert.equal(reportFooterSaveScope(approved, [], "report-12-1").hasChanges, false);
  assert.equal(reportFooterSaveScope(approved, [], null).hasChanges, false);
});

test("successful saves remove the action, partial failures retain only unsaved owners", () => {
  assert.deepEqual(reportFooterSaveScope(approved, ["entry-45", "new:2026-11-20"]), { saveKeys: ["entry-45"], hasChanges: true });
  assert.deepEqual(reportFooterSaveScope(approved, ["new:2026-11-20"]), { saveKeys: [], hasChanges: false });
});
