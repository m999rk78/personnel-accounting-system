import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { bitrixReviewUpdateBatches, bitrixReviewUpdateIds } from "../app/bitrixReviewSelection.ts";

const changed = id => ({ kind: "changed", employeeName: `Сотрудник ${id}`, localEmployeeId: id, bitrix24Id: `B${id}` });
test("review selection excludes creation, dismissal, missing cards and accepted warnings", () => {
  assert.deepEqual(bitrixReviewUpdateIds({ differences: [changed(1), changed(1), { ...changed(2), acknowledged: true }, { ...changed(3), kind: "dismissed_in_bitrix" }, { ...changed(4), kind: "missing_in_bitrix" }, { ...changed(5), kind: "missing_locally" }, { ...changed(6), bitrix24Id: undefined }, { ...changed(7), localEmployeeId: undefined }] }), [1]);
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
  assert.ok(fn);
  const fixture = `
    const rows=${JSON.stringify(rows)}, failures=new Set(${JSON.stringify(failIds)});
    export const calls=[];
    const env={DB:{prepare(){return {bind(ids){return {async all(){return {results:rows.filter(row=>ids.includes(row.id))}}}}}}}};
    const asPositiveInteger=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
    async function updateBitrixEmployeeRecord(snapshot,id,bitrixId){
      const card=snapshot.find(card=>card.bitrix24Id===bitrixId);calls.push({id,bitrixId,position:card?.position});
      if(failures.has(id))throw new Error('Ошибка отдельной карточки');
      return {id,name:card.fullName};
    }
    async function buildBitrixInspection(){return {response:{status:'mismatch',differences:[]}}}
    ${fn.getText(source).replace(/^export /, "")}
    export {updateSelectedBitrixEmployees};
  `;
  const code = ts.transpileModule(fixture, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const linked = id => ({ id, fullName: `Сотрудник ${id}`, bitrix24Id: `B${id}`, checkStatus: "mismatch", acknowledgedAt: null });
const snapshot = [1, 2, 3].map(id => ({ bitrix24Id: `B${id}`, fullName: `Сотрудник ${id}`, position: `Разная должность ${id}` }));
test("bulk API chooses each employee's own linked Bitrix card and preserves partial results", async () => {
  const api = await serverHarness([linked(1), linked(2), linked(3)], [2]);
  const result = await api.updateSelectedBitrixEmployees(snapshot, { employeeIds: [3, 1, 2, 1], bitrix24Id: "B1" });
  assert.deepEqual(api.calls, [3, 1, 2].map(id => ({ id, bitrixId: `B${id}`, position: `Разная должность ${id}` })));
  assert.deepEqual(result.updatedEmployees.map(row => row.id), [3, 1]);
  assert.equal(result.failedEmployees[0].id, 2);
});
test("bulk API refuses unlinked, dismissed, accepted, missing and oversized selections", async () => {
  const api = await serverHarness([linked(1), { ...linked(2), bitrix24Id: null }, { ...linked(3), checkStatus: "dismissed_in_bitrix" }, { ...linked(4), acknowledgedAt: "2026-11-02" }]);
  const result = await api.updateSelectedBitrixEmployees(snapshot, { employeeIds: [1, 2, 3, 4, 999] });
  assert.deepEqual(api.calls.map(row => row.id), [1]);
  assert.deepEqual(result.failedEmployees.map(row => row.id), [2, 3, 4, 999]);
  await assert.rejects(api.updateSelectedBitrixEmployees(snapshot, { employeeIds: Array.from({ length: 201 }, (_, index) => index + 1) }), /200 сотрудников/);
  await assert.rejects(api.updateSelectedBitrixEmployees(snapshot, { employeeIds: [] }), /Не выбраны/);
});
