import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as helpers from "../app/equipmentDirectorySpreadsheet.ts";

const source = await readFile(new URL("../app/EquipmentDirectoryGrids.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("EquipmentDirectoryGrids.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node)).map(node => node.getText(ast).replace(/^export\s+/, "")).join("\n");
const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const environment = { ...helpers, React: { createElement: (_component, props) => props }, useMemo: build => build(), CatalogSpreadsheetGrid: () => {} };
const { EquipmentRegistryAgGrid, ProjectEquipmentAgGrid } = new Function(...Object.keys(environment), `${compiled}; return { EquipmentRegistryAgGrid, ProjectEquipmentAgGrid };`)(...Object.values(environment));
const units = [1, 2, 3].map(id => ({ id, organization: "Организация", equipmentType: "Кран", brand: "Марка", model: "Модель", registrationNumber: `А00${id}`, note: "", assignedSiteId: 10 }));

test("registry navigation seeds the ID filter without removing hidden rows from duplicate validation", () => {
  const onClearEquipmentFocus = () => {};
  const grid = EquipmentRegistryAgGrid({
    rows: units, drafts: [], sites: [{ id: 10, name: "Проект" }], focusedEquipmentId: 1, onClearEquipmentFocus, loading: false,
  });
  assert.equal(grid.rows, units, "Every unit remains in the ordinary grid data");
  assert.deepEqual(grid.navigationFilter, { columnId: "registrationNumber", value: "1", ready: true, onCleared: onClearEquipmentFocus });
  const column = grid.columns.find(column => column.field === "registrationNumber");
  assert.equal(column.getFilterValue(units[0]), "1");
  assert.equal(column.getFilterValue({ ...units[0], id: 99 }), "99", "Equal labels cannot merge different equipment identities");
  assert.equal(column.formatFilterValue("1"), "А001");
  assert.equal(column.formatFilterValue("99"), "Техника №99");
  assert.equal(column.formatFilterValue(null), "(Пустые)");
  const duplicate = { ...helpers.equipmentRegistryDraft(units[1]), key: "new", id: undefined };
  assert.throws(() => grid.validateDrafts([duplicate], [duplicate.key]), /уже есть/);
  assert.equal(EquipmentRegistryAgGrid({ rows: units, drafts: [], sites: [], focusedEquipmentId: 1, loading: true }).navigationFilter.ready, false);
});

test("project navigation retains all assigned units for options and validation while the filter remains resettable", () => {
  const rows = units.slice(0, 2), draft = { key: "new", equipmentId: "" }, onClearEquipmentFocus = () => {};
  const grid = ProjectEquipmentAgGrid({ rows, allUnits: units, drafts: [draft], focusedEquipmentId: 1, onClearEquipmentFocus, loading: false });
  assert.equal(grid.rows, rows);
  assert.deepEqual(grid.navigationFilter, { columnId: "registrationNumber", value: "1", ready: true, onCleared: onClearEquipmentFocus });
  assert.deepEqual(grid.columns[0].options(draft, [draft]).map(option => option.value), ["3"]);
  assert.throws(() => grid.validateDrafts([{ ...draft, equipmentId: "2" }], [draft.key]), /уже/);
  const column = grid.columns.find(column => column.field === "registrationNumber");
  assert.equal(column.getFilterValue(rows[0]), "1");
  assert.equal(column.formatFilterValue("1"), "А001");
  assert.equal(column.formatFilterValue("99"), "Техника №99");
  assert.equal(ProjectEquipmentAgGrid({ rows, allUnits: units, drafts: [], loading: false }).navigationFilter, undefined);
});
