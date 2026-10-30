import assert from "node:assert/strict";
import test from "node:test";
import { gridRowSelection } from "../app/gridRowSelection.ts";
import { gridRowEntityId } from "../app/tableRowOrder.ts";

const selection = (options = {}) => gridRowSelection({ supplied: undefined, canSelect: true, canReorder: true, isOrderable: row => Boolean(gridRowEntityId(row)), ...options });

test("selection permission overrides both supplied selection and reorder fallback", () => {
  const supplied = { mode: "multiRow", checkboxes: true };
  assert.equal(selection({ canSelect: false }), undefined);
  assert.equal(selection({ canSelect: false, supplied }), undefined);
});

test("reorder fallback does not expose checkboxes without reorder permission", () => {
  assert.equal(selection({ canReorder: false }), undefined);
  assert.equal(selection({ canSelect: false, canReorder: false }), undefined);
});

test("supplied mutation selection remains unchanged even without reorder permission", () => {
  const onSelect = () => true;
  const supplied = { mode: "multiRow", checkboxes: onSelect, headerCheckbox: false, isRowSelectable: onSelect };
  assert.equal(selection({ supplied }), supplied);
  assert.equal(selection({ supplied, canReorder: false }), supplied);
  assert.equal(selection({ supplied: "multiple" }), "multiple");
});

test("create-only tables can select saved rows for ordering without enabling draft checkboxes", () => {
  // No bulk-update/delete rowSelection was supplied; ordering grants its own local selection.
  const fallback = selection();
  assert.equal(fallback.mode, "multiRow");
  assert.equal(fallback.checkboxes, true);
  assert.equal(fallback.headerCheckbox, true);
  assert.equal(fallback.selectAll, "filtered");
  assert.equal(fallback.enableClickSelection, false);
  assert.equal(fallback.hideDisabledCheckboxes, true);
  assert.equal(fallback.isRowSelectable({ data: { kind: "entry", employee: { id: 7 } } }), true);
  assert.equal(fallback.isRowSelectable({ data: { kind: "entry", item: { id: 9 } } }), true);
  assert.equal(fallback.isRowSelectable({ data: { kind: "draft", employee: { id: 7 } } }), false);
  assert.equal(fallback.isRowSelectable({ data: { kind: "entry", unassigned: true } }), false);
  assert.equal(fallback.isRowSelectable({ data: {} }), false);
  assert.equal(fallback.isRowSelectable({}), false);
});
