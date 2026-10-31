import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { personnelCellErrors, personnelOptionFields } from "../app/personnelSpreadsheet.ts";
import { compatibleSubworkId } from "../app/workTypeHierarchy.ts";

const source = ts.transpileModule(await readFile(new URL("../app/personnelReportStore.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replaceAll('"./personnelReportWorkflow"', JSON.stringify(new URL("../app/personnelReportWorkflow.ts", import.meta.url).href));
const { mutatePersonnelReport, mutatePersonnelReportEntry } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const actor = { id: 8, role: "engineer", fullName: "Инженер", projectAccess: { mode: "selected", siteIds: [7] }, permissions: rolePermissionTemplate("engineer") };
const original = {
  id: 101, reportId: 17, siteId: 7, workDate: "2026-10-30", employeeId: 55,
  shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1,
  hours: 6, note: "Первоначально", rowOrder: 0, employeeName: "Сотрудник на дату отчёта",
  employmentType: "ОПР", department: "Старый отдел", positionSnapshot: "Монтажник",
  masterName: "Мастер на дату отчёта", shiftName: "День", zoneName: "Зона",
  mainWorkTypeName: "Монтаж", subworkTypeName: "Подготовка", approvedEntryId: 500,
  approvedEntryRevision: 1, createdAt: "2026-10-30T05:00:00Z", updatedAt: "2026-10-30T05:00:00Z",
};
const snapshotFields = ["employeeName", "employmentType", "department", "positionSnapshot", "masterName"];
const aliases = { employee_name_snapshot: "employeeName", employment_type_snapshot: "employmentType", department_snapshot: "department", position_snapshot: "positionSnapshot", master_name_snapshot: "masterName" };
const property = name => aliases[name] ?? name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

/** Execute the real store against a SQL boundary containing only synthetic history. */
function fixture({ archived = false, legacy = false, status = "approved" } = {}) {
  let header = { id: 17, siteId: 7, workDate: original.workDate, ownerUserId: 9, ownerName: "Прораб", status, revision: 1 };
  let row = structuredClone(original);
  let entry = { ...structuredClone(original), id: 500, revision: 1, responsibleUserId: 9 };
  const writes = [];
  const changedEmployee = { id: 55, fullName: "Новое ФИО", position: "Новая должность", employmentType: "ИТР", department: "Новый отдел" };
  function select(sql, values) {
    if (sql.includes("FROM personnel_reports report JOIN app_users owner")) return legacy ? [] : [structuredClone(header)];
    if (sql.includes("FROM personnel_report_rows draft_row JOIN")) return [{ ...structuredClone(row), ...(sql.includes("CASE WHEN report.status") && header.status === "approved" ? entry : {}), id: row.id, reportId: 17, approvedEntryId: 500, approvedEntryRevision: entry.revision }];
    if (sql.includes("FROM sites WHERE id = ?")) return [{ id: 7 }];
    if (sql.includes("SELECT clock_timestamp() AS changedAt")) return [{ changedAt: "2026-10-31T08:30:00Z" }];
    if (sql.includes("FROM employees employee") && sql.includes("employee.id = ANY")) return archived ? [] : [changedEmployee, { id: 56, fullName: "Другой сотрудник", position: "Сварщик", employmentType: "ОПР", department: "УСР" }].filter(employee => values[0].includes(employee.id));
    if (/SELECT id, name/.test(sql)) {
      const table = sql.match(/FROM (\w+)/)[1];
      return archived ? [] : [1, 2].filter(id => values[1].includes(id)).map(id => ({ id, name: table === "masters" ? "Новое имя мастера" : `Значение ${id}`, mainWorkTypeId: id }));
    }
    if (sql.includes("SUM(entry.hours)")) return [];
    if (sql.includes("pg_advisory_xact_lock") || /^SELECT entry.id FROM/.test(sql)) return [];
    if (sql.includes("SELECT id FROM personnel_reports")) return [{ id: 17 }];
    if (sql.includes("FROM placement_entries entry")) return [{ ...structuredClone(entry), reportId: legacy ? null : 17 }];
    throw new Error(`Unexpected SELECT: ${sql.slice(0, 100)}`);
  }
  function mutate(sql, values) {
    writes.push({ sql, values });
    if (sql.startsWith("UPDATE personnel_reports SET revision")) header.revision++;
    else if (sql.startsWith("UPDATE personnel_report_rows SET row_order = ?") || sql.startsWith("UPDATE placement_entries SET employee_id")) {
      const target = sql.startsWith("UPDATE placement_entries") ? entry : row;
      const fields = [...sql.split(" SET ")[1].split(" WHERE ")[0].matchAll(/(\w+)\s*=\s*\?/g)].map(match => property(match[1]));
      fields.forEach((field, index) => { target[field] = values[index]; });
      if (target === entry) entry.revision++;
    } else if (!sql.startsWith("DELETE FROM personnel_report_rows") && !sql.startsWith("UPDATE personnel_report_rows SET row_order = -id")) throw new Error(`Unexpected mutation: ${sql.slice(0, 100)}`);
    return [{ id: 17 }];
  }
  const db = {
    writes,
    state: () => structuredClone({ header, row, entry }),
    prepare(sql) {
      sql = sql.trim(); let values = [];
      const execute = () => /^SELECT\b/.test(sql) ? select(sql, values) : mutate(sql, values);
      const statement = { bind(...next) { values = next; return statement; }, async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; }, async run() { return { results: execute(), meta: { changes: 1 } }; } };
      return statement;
    },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async batch(statements) { const result = []; for (const statement of statements) result.push(await statement.run()); return result; },
    async transaction(callback) { const before = structuredClone({ header, row, entry }); try { return await callback(db); } catch (error) { ({ header, row, entry } = before); throw error; } },
  };
  return db;
}
const save = (db, changes = {}) => mutatePersonnelReport(db, actor, { action: "save", siteId: 7, workDate: original.workDate, reportId: 17, revision: 1, rows: [{ ...original, hours: 8, note: "Уточнение", ...changes }] });

for (const archived of [false, true]) test(`approved correction preserves historical employee/master snapshots with ${archived ? "archived references" : "changed current catalog"}`, async () => {
  const db = fixture({ archived });
  const result = await save(db, { employeeName: "Подмена снимка", positionSnapshot: "Подмена должности" });
  assert.equal(result.status, "approved");
  assert.equal(db.state().entry.id, 500);
  assert.equal(db.state().entry.responsibleUserId, 9);
  assert.equal(db.state().entry.hours, 8);
  assert.equal(db.state().entry.note, "Уточнение");
  assert.equal(db.state().entry.revision, 2);
  for (const field of snapshotFields) assert.equal(db.state().entry[field], original[field], field);
});

test("an explicit employee/master replacement uses validated current snapshots", async () => {
  const db = fixture();
  await save(db, { employeeId: 56, masterId: 2 });
  assert.equal(db.state().entry.employeeId, 56);
  assert.equal(db.state().entry.employeeName, "Другой сотрудник");
  assert.equal(db.state().entry.positionSnapshot, "Сварщик");
  assert.equal(db.state().entry.masterName, "Новое имя мастера");
});

for (const changes of [{ employeeId: 999 }, { zoneId: 999 }, { masterId: 999 }, { mainWorkTypeId: 2 }, { subworkTypeId: 2 }, { id: 999 }]) test(`historical allowance cannot introduce invalid references: ${JSON.stringify(changes)}`, async () => {
  const db = fixture({ archived: true }), before = db.state();
  await assert.rejects(save(db, changes));
  assert.deepEqual(db.state(), before);
});

test("unapproved rows still require current active employees and project references", async () => {
  const db = fixture({ archived: true, status: "draft" });
  await assert.rejects(save(db), error => error.details?.issues.some(issue => issue.code === "INVALID_EMPLOYEE"));
  assert.equal(db.writes.length, 0);
});

test("legacy approved entry corrections preserve snapshots and archived references", async () => {
  const db = fixture({ archived: true, legacy: true });
  const result = await mutatePersonnelReportEntry(db, actor, { action: "save-approved-entry", entryId: 500, revision: 1, siteId: 7, workDate: original.workDate, row: { ...original, hours: 7, note: "Уточнение старой записи" } });
  assert.equal(result.id, 500);
  assert.equal(result.hours, 7);
  for (const field of snapshotFields) assert.equal(result[field], original[field], field);
});

test("grid values use saved snapshots until the employee or master is replaced", async () => {
  const path = new URL("../app/PersonnelReportGrid.tsx", import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "valueFor");
  const code = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const valueFor = new Function("optionFields", `${code}; return valueFor;`)(personnelOptionFields);
  const props = { employees: [{ id: 55, position: "Измененная должность", employmentType: "ИТР", department: "Новый отдел" }, { id: 56, position: "Сварщик", employmentType: "ОПР", department: "УСР" }], masters: [{ id: 1, name: "Переименованный мастер" }, { id: 2, name: "Другой мастер" }] };
  const row = { entry: original, draft: { employeeId: "55", masterId: "1" } };
  assert.equal(valueFor(row, "position", props), original.positionSnapshot);
  assert.equal(valueFor(row, "employmentType", props), original.employmentType);
  assert.equal(valueFor(row, "department", props), original.department);
  assert.equal(valueFor(row, "master", props), original.masterName);
  row.draft = { employeeId: "56", masterId: "2" };
  assert.equal(valueFor(row, "position", props), "Сварщик");
  assert.equal(valueFor(row, "master", props), "Другой мастер");
});

test("approved and legacy editors retain unchanged references; copying starts a strict current draft", async () => {
  const path = new URL("../app/PersonnelReportWorkspace.tsx", import.meta.url);
  const file = ts.createSourceFile(path.pathname, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  const wanted = new Set(["makeDraft", "toDraft", "toApprovedDraft", "toEntryDraft", "copyRows"]);
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && wanted.has(node.name.text)) declarations.set(node.name.text, `const ${node.getText(file)};`);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(declarations.size, wanted.size);
  const code = ts.transpileModule([...declarations.values()].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const catalogs = { employees: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [] };
  let copied;
  const helpers = new Function("props", "appendToday", "setError", "compatibleSubworkId", `${code}; return {toDraft,toApprovedDraft,toEntryDraft,copyRows};`)(catalogs, rows => { copied = rows; }, message => { throw new Error(message); }, compatibleSubworkId);
  const approved = helpers.toApprovedDraft(original);
  const legacy = helpers.toEntryDraft({ ...original, id: 500 });
  assert.deepEqual(personnelCellErrors(approved, catalogs, true), {});
  assert.deepEqual(personnelCellErrors(legacy, catalogs, true), {});
  assert.ok(personnelCellErrors(helpers.toDraft(original), catalogs, true).employeeName);
  assert.ok(personnelCellErrors({ ...approved, employeeId: "999" }, catalogs, true).employeeName);
  assert.ok(personnelCellErrors({ ...approved, mainWorkTypeId: "2" }, catalogs, true).subwork);
  assert.ok(personnelCellErrors({ ...approved, hours: "11" }, catalogs, true).hours);
  assert.ok(personnelCellErrors({ ...approved, inputValues: { employeeName: "Неизвестное ФИО" } }, catalogs, true).employeeName);
  helpers.copyRows([{ draft: { ...approved, lockedEmployee: true }, entry: original }]);
  assert.equal(copied[0].referenceIds, undefined);
  assert.equal(copied[0].lockedEmployee, false);
  assert.equal(copied[0].employeeId, "");
  assert.ok(personnelCellErrors(copied[0], catalogs, true).employeeName);
});
