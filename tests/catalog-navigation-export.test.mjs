import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/CatalogSpreadsheetGrid.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("CatalogSpreadsheetGrid.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(ast);
const callback = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "visible")?.initializer;
const effect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useLayoutEffect" && node.arguments[0]?.getText(ast).includes("navigationBlockedRef.current = navigationBlocked"));
assert.ok(callback);
assert.ok(effect);
function bind(expression, environment) {
  const code = ts.transpileModule(`const result = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), `${code}; return result;`)(...Object.values(environment));
}

test("catalog export row IDs stay empty until navigation settles, then reflect filtering and reset", () => {
  const published = [];
  const navigationBlockedRef = { current: true };
  const current = { current: { onVisibleIdsChange: ids => published.push(ids) } };
  let rows = [1, 2, 3];
  let destroyed = false;
  const grid = {
    isDestroyed: () => destroyed,
    forEachNodeAfterFilterAndSort: callback => {
      rows.forEach(id => callback({ data: { record: { id } } }));
      callback({ data: { draft: { key: "new" } } });
    },
  };
  const api = { current: grid };
  const visible = bind(callback.getText(ast), { useCallback: callback => callback, navigationBlockedRef, current });
  const settle = blocked => bind(effect.arguments[0].getText(ast), { navigationBlockedRef, navigationBlocked: blocked, api, visible })();

  visible(grid); // gridReady occurs before the navigation filter is applied.
  assert.deepEqual(published.at(-1), []);
  rows = [2];
  visible(grid); // The model event arrives before pending becomes false.
  assert.deepEqual(published.at(-1), []);
  settle(false); // No further grid event is needed to publish the selection.
  assert.deepEqual(published.at(-1), [2]);
  rows = [1, 2, 3];
  visible(grid);
  assert.deepEqual(published.at(-1), [1, 2, 3], "Clearing the ordinary filter restores the full export scope");
  settle(true);
  visible(grid);
  assert.deepEqual(published.at(-1), [], "Failed or pending navigation must not expose an unfiltered export");
  const before = published.length;
  destroyed = true;
  settle(false);
  visible(grid);
  assert.equal(published.length, before);
});
