import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const deletionSource = await readFile(new URL("../app/server/data/deleteData.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("deleteData.ts", deletionSource, ts.ScriptTarget.Latest, true);
const deleteBranches = new Map();
function visit(node) {
  if (ts.isIfStatement(node)) {
    const entity = node.expression.getText(ast).match(/^url\.searchParams\.get\("entity"\) === "(employee-assignment|site)"$/)?.[1];
    if (entity) deleteBranches.set(entity, node.thenStatement.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function bindRemoval(entity, environment) {
  const branch = deleteBranches.get(entity);
  assert.ok(branch, `Expected the actual removal branch for ${entity}`);
  const code = ts.transpileModule(`async function remove() ${branch}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), `${code}\nreturn remove;`)(...Object.values(environment));
}

function harness({ allow = true, failUpdate = false } = {}) {
  const saved = { siteId: 7, assignments: [{ siteId: 7, active: true }, { siteId: 8, active: true }] };
  const statements = [];
  const env = { DB: { async transaction(action) {
    const draft = structuredClone(saved);
    const result = await action({ prepare(sql) {
      return { bind(...values) {
        statements.push({ sql, values });
        return {
          async first() { return { id: 10 }; },
          async run() {
            if (sql.startsWith("UPDATE employee_project_assignments")) {
              const assignment = draft.assignments.find(item => item.siteId === values[1]);
              assignment.active = false;
              assignment.endDate = "2026-11-13";
            } else if (sql.startsWith("UPDATE employees")) {
              if (failUpdate) throw new Error("Synthetic update failure");
              draft.siteId = Math.min(...draft.assignments.filter(item => item.active).map(item => item.siteId));
            } else assert.fail(`Unexpected write: ${sql}`);
            return { meta: { changes: 1 } };
          },
        };
      } };
    } });
    Object.assign(saved, draft);
    return result;
  } } };
  const run = bindRemoval("employee-assignment", {
    env, authUser: { id: 17 }, url: new URL("http://localhost/api/data?entity=employee-assignment&siteId=7&id=10"), id: 10,
    asPositiveInteger: Number, canAccessProject: (_actor, siteId) => allow && siteId === 7,
    forbidden: () => new Response(null, { status: 403 }),
  });
  return { run, saved, statements };
}

test("project removal locks the employee before closing only the selected assignment", async () => {
  const { run, saved, statements } = harness();
  assert.equal((await run()).status, 200);
  assert.match(statements[0].sql, /FROM employees.*FOR UPDATE/);
  assert.deepEqual(statements[0].values, [10]);
  assert.match(statements[1].sql, /end_date = COALESCE\(end_date, \(CURRENT_TIMESTAMP AT TIME ZONE 'Europe\/Moscow'\)::date\)/);
  assert.deepEqual(statements[1].values, [10, 7]);
  assert.deepEqual(saved, { siteId: 8, assignments: [{ siteId: 7, active: false, endDate: "2026-11-13" }, { siteId: 8, active: true }] });
});

test("a failed pointer update cannot leave a partially closed assignment", async () => {
  const { run, saved } = harness({ failUpdate: true });
  await assert.rejects(run(), /Synthetic update failure/);
  assert.equal(saved.siteId, 7);
  assert.equal(saved.assignments[0].active, true);
});

test("project removal rejects a foreign project before reading or changing the employee", async () => {
  const { run, statements } = harness({ allow: false });
  assert.equal((await run()).status, 403);
  assert.deepEqual(statements, []);
});

test("database initialization never prunes an archived card with manual timesheet history", async () => {
  const source = await readFile(new URL("../app/server/data/bootstrap.ts", import.meta.url), "utf8");
  const cleanup = source.match(/db\.prepare\(`DELETE FROM employees[\s\S]+?`\)/)?.[0];
  assert.ok(cleanup);
  assert.match(cleanup, /AND NOT EXISTS \(SELECT 1 FROM timesheet_marks WHERE employee_id = employees\.id\)/);
});

test("a project's manual timesheet marks prevent archive even when it has no other records", async () => {
  for (const marksSiteId of [7, 8]) {
    const archived = [];
    const database = {
      async batch(statements) {
        return statements.map(({ sql, values }) => {
          if (sql.includes("COUNT(*)")) return { results: [{ count: 2 }] };
          if (sql.includes("FROM timesheet_marks")) {
            assert.deepEqual(values, [7]);
            return { results: values[0] === marksSiteId ? [{ id: 10 }] : [] };
          }
          return { results: [] };
        });
      },
      prepare: sql => ({ sql, bind: (...values) => ({ sql, values, async run() {
        assert.match(sql, /^UPDATE sites SET active = 0/);
        archived.push(...values);
        return { meta: { changes: 1 } };
      } }) }),
    };
    const run = bindRemoval("site", { env: { DB: database }, id: 7 });
    if (marksSiteId === 7) {
      await assert.rejects(run(), /Проект используется.*табелями/);
      assert.deepEqual(archived, []);
    } else {
      assert.equal((await run()).status, 200);
      assert.deepEqual(archived, [7]);
    }
  }
});
