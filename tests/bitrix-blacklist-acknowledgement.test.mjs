import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const path = new URL("../app/server/data/createData.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
const queries = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare"
    && node.arguments[0] && ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) {
    const sql = node.arguments[0].text;
    if (/UPDATE bitrix24_employee_check_states\s+SET acknowledged_at/.test(sql)) queries.push(sql);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(queries.length, 2, "exercise the actual single and bulk acknowledgement statements");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE employees(id INTEGER PRIMARY KEY, active INTEGER);
    CREATE TABLE bitrix24_employee_check_states(employee_id INTEGER PRIMARY KEY, status TEXT, acknowledged_at TEXT, acknowledged_by_user_id INTEGER);
    INSERT INTO employees VALUES(1,1),(2,1),(3,1);
    INSERT INTO bitrix24_employee_check_states VALUES(1,'blacklisted_in_bitrix',NULL,NULL),(2,'mismatch',NULL,NULL),(3,'dismissed_in_bitrix',NULL,NULL);`);
  return db;
}

test("single acknowledgement SQL cannot hide a blacklist; ordinary warnings retain acknowledgement", t => {
  const db = fixture(); t.after(() => db.close());
  const query = queries.find(sql => !sql.includes("ANY"));
  assert.equal(db.prepare(query).run(9, 1).changes, 0);
  assert.equal(db.prepare("SELECT acknowledged_at AS value FROM bitrix24_employee_check_states WHERE employee_id=1").get().value, null);
  assert.equal(db.prepare(query).run(9, 2).changes, 1);
  assert.equal(db.prepare(query).run(9, 3).changes, 1);
});

test("bulk acknowledgement SQL excludes blacklist IDs in a mixed selection", t => {
  const db = fixture(); t.after(() => db.close());
  const query = queries.find(sql => sql.includes("ANY")).replace("= ANY(?)", "IN (?,?,?)");
  const changed = db.prepare(query).all(9, 1, 2, 3);
  assert.deepEqual(changed.map(row => row.employeeId), [2, 3]);
  const blacklisted = db.prepare("SELECT status,acknowledged_at,acknowledged_by_user_id FROM bitrix24_employee_check_states WHERE employee_id=1").get();
  assert.deepEqual({ ...blacklisted }, { status: "blacklisted_in_bitrix", acknowledged_at: null, acknowledged_by_user_id: null });
});
