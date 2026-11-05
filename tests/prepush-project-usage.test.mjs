import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectForemanCounts } from "../app/projectUserUsage.ts";
import { readDataImplementation } from "./fixtures/read-implementation.mjs";

const routePath = new URL("../app/api/data/route.ts", import.meta.url);
const route = ts.createSourceFile(routePath.pathname, await readDataImplementation(), ts.ScriptTarget.Latest, true);
const queries = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare"
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) queries.push(node.arguments[0].text);
  ts.forEachChild(node, visit);
}
visit(route);
const statsSql = queries.find(sql => sql.includes("AS foremanCount") && sql.includes("FROM sites project"));
const usageSql = queries.find(sql => sql.startsWith("SELECT target.id FROM app_users target WHERE target.active = 1"));
assert.ok(statsSql, "Use the actual project statistics statement");
assert.ok(usageSql, "Use the actual project deletion user guard");
// The fixture runs the application SQL; only PostgreSQL's cast spelling changes.
const sqliteSql = sql => sql.replace(/::(?:int|boolean)\b/g, "");

function fixture(users = []) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY, active INTEGER);
    CREATE TABLE app_users(id INTEGER PRIMARY KEY, role TEXT, assigned_site_id INTEGER, active INTEGER);
    CREATE TABLE user_project_access(user_id INTEGER PRIMARY KEY, all_projects INTEGER);
    CREATE TABLE user_project_access_sites(user_id INTEGER, site_id INTEGER);
    CREATE TABLE employees(id INTEGER PRIMARY KEY, active INTEGER);
    CREATE TABLE employee_project_assignments(employee_id INTEGER, site_id INTEGER, active INTEGER);
    INSERT INTO sites VALUES (7,1),(8,1),(9,1),(10,0);
    INSERT INTO employees VALUES (1,1),(2,0);
    INSERT INTO employee_project_assignments VALUES (1,7,1),(1,8,1),(2,7,1);`);
  for (const [index, user] of users.entries()) {
    const id = index + 1;
    db.prepare("INSERT INTO app_users VALUES (?,?,?,?)").run(id, user.role, user.assignedSiteId ?? null, user.active === false ? 0 : 1);
    if (user.projectAccess) {
      db.prepare("INSERT INTO user_project_access VALUES (?,?)").run(id, user.projectAccess.mode === "all" ? 1 : 0);
      for (const siteId of user.projectAccess.siteIds) db.prepare("INSERT INTO user_project_access_sites VALUES (?,?)").run(id, siteId);
    }
  }
  return db;
}
const users = [
  { role: "foreman", assignedSiteId: 7 },
  { role: "foreman", assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [7, 8] } },
  { role: "foreman", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] } },
  { role: "foreman", assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [] } },
  { role: "foreman", assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [8] } },
  { role: "foreman", assignedSiteId: 7, active: false, projectAccess: { mode: "all", siteIds: [] } },
  { role: "engineer", assignedSiteId: 7 },
];

test("project statistics and card fallback count multi/all grants and ignore revocation", () => {
  const db = fixture(users);
  try {
    const stats = db.prepare(sqliteSql(statsSql)).all(1, 1);
    assert.deepEqual(stats.map(row => [row.siteId, row.foremanCount, row.employeeCount]), [[7, 3, 1], [8, 3, 1], [9, 1, 0]]);
    const fallback = projectForemanCounts(stats.map(row => ({ id: row.siteId })), users.filter(user => user.active !== false));
    assert.deepEqual([...fallback], [[7, 3], [8, 3], [9, 1]]);
    assert.deepEqual(db.prepare(sqliteSql(statsSql)).all(0, 1).map(row => row.foremanCount), [0, 0, 0]);
    assert.deepEqual(db.prepare(sqliteSql(statsSql)).all(1, 0).map(row => row.employeeCount), [0, 0, 0]);
  } finally { db.close(); }
});

for (const [label, user, protectedSites] of [
  ["legacy assignment", users[0], [7]],
  ["several selected projects", users[1], [7, 8]],
  ["explicit all projects", users[2], [7, 8, 9]],
  ["explicit no access despite legacy assignment", users[3], []],
  ["selection replacing legacy assignment", users[4], [8]],
  ["inactive account", users[5], []],
  ["legacy engineer assignment", users[6], [7]],
  ["legacy all-project navigation without an assignment", { role: "superadmin", assignedSiteId: null }, []],
  ["viewer project grant", { role: "viewer", assignedSiteId: null, projectAccess: { mode: "selected", siteIds: [8] } }, [8]],
]) test(`project deletion preserves user protection for ${label}`, () => {
  const db = fixture([user]);
  try {
    const query = db.prepare(sqliteSql(usageSql));
    for (const siteId of [7, 8, 9]) assert.equal(Boolean(query.get(siteId, siteId)), protectedSites.includes(siteId), `project ${siteId}`);
  } finally { db.close(); }
});

test("project overview uses server counts even when personal catalogs are intentionally omitted", async () => {
  let code = ts.transpileModule(await readFile(new URL("../app/ProjectCards.tsx", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const [specifier, replacement] of Object.entries({
    react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
    "./projectUserUsage": new URL("../app/projectUserUsage.ts", import.meta.url).href,
    "./useTableEscapeSelection": new URL("../app/useTableEscapeSelection.ts", import.meta.url).href,
  })) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  const { ProjectCards } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const html = renderToStaticMarkup(createElement(ProjectCards, {
    rows: [{ id: 7, name: "Северный", code: "N", timezone: "Europe/Moscow" }, { id: 8, name: "Южный", code: "S", timezone: "Europe/Moscow" }],
    drafts: [], users: [], employees: [], selectedIds: [], currentSiteId: 7, saving: false, readOnly: true,
    projectStats: [{ siteId: 7, employeeCount: 4, foremanCount: 3 }, { siteId: 8, employeeCount: 5, foremanCount: 2 }],
  }));
  assert.match(html, /<b>9<\/b> назначений сотрудников/);
  assert.match(html, /<b>5<\/b> назначений прорабов/);
});
