// Loopback only. Schema, automatic directory updates and fixtures are rolled back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { PROJECT_MASTER_DEPARTMENTS, ensureProjectMastersSchema, syncProjectMasters } from "../app/projectMasters.ts";

const hostname = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname), "Use a loopback PostgreSQL database.");
const source = await readFile(new URL("../db/client.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('"pg"', JSON.stringify(import.meta.resolve("pg")));
const { PostgresDatabase, PostgresStatement } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
const executor = { prepare: sql => new PostgresStatement(database, sql, [], connection) };
const scoped = { ...executor, async transaction(callback) {
  await connection.query("SAVEPOINT project_masters_operation");
  try { const result = await callback(executor); await connection.query("RELEASE SAVEPOINT project_masters_operation"); return result; }
  catch (error) { await connection.query("ROLLBACK TO SAVEPOINT project_masters_operation"); await connection.query("RELEASE SAVEPOINT project_masters_operation"); throw error; }
} };

try {
  await connection.query("BEGIN");
  const schema = `project_masters_test_${randomUUID().replaceAll("-", "")}`;
  await connection.query(`CREATE SCHEMA ${schema}`);
  await connection.query(`SET LOCAL search_path TO ${schema}`);
  await connection.query(`CREATE TABLE sites(id integer PRIMARY KEY, active integer NOT NULL DEFAULT 1);
    CREATE TABLE employees(id integer PRIMARY KEY, full_name text NOT NULL, position text NOT NULL, active integer NOT NULL DEFAULT 1, employment_type text NOT NULL, department text NOT NULL);
    CREATE TABLE employee_project_assignments(id serial PRIMARY KEY, employee_id integer NOT NULL REFERENCES employees, site_id integer NOT NULL REFERENCES sites, active integer NOT NULL DEFAULT 1);
    CREATE TABLE masters(id serial PRIMARY KEY, site_id integer NOT NULL REFERENCES sites, name text NOT NULL, active integer NOT NULL DEFAULT 1);
    CREATE TABLE placement_entries(id serial PRIMARY KEY, master_id integer REFERENCES masters, master_name_snapshot text NOT NULL DEFAULT '');
    CREATE TABLE personnel_reports(id integer PRIMARY KEY, site_id integer REFERENCES sites);
    CREATE TABLE personnel_report_rows(id serial PRIMARY KEY, report_id integer REFERENCES personnel_reports, master_id integer REFERENCES masters, master_name_snapshot text NOT NULL DEFAULT '');
    INSERT INTO sites VALUES (1,1),(2,1),(3,0);`);
  const employees = [
    [1, "Первый мастер", "Мастер участка строительных конструкций", 1, "ИТР", PROJECT_MASTER_DEPARTMENTS[0]],
    [2, "Второй мастер", "Прораб", 1, "ИТР", PROJECT_MASTER_DEPARTMENTS[1]],
    [3, "Неподходящий тип", "Мастер участка строительных конструкций", 1, "ОПР", "МУ"],
    [4, "Архивный сотрудник", "Прораб", 0, "ИТР", "МУ"],
    [5, "Другой проект", "Руководитель", 1, "ИТР", "МУТТ"],
    [6, "Без назначения", "Прораб", 1, "ИТР", "МУ"],
    [7, "Снятое назначение", "Прораб", 1, "ИТР", "МУ"],
    [8, "Два проекта", "Руководитель", 1, "ИТР", PROJECT_MASTER_DEPARTMENTS[2]],
    [9, "Закрытый проект", "Прораб", 1, "ИТР", "МУ"],
    [10, "Неподходящий отдел", "Мастер участка технологических трубопроводов", 1, "ИТР", "УСР"],
  ];
  for (const values of employees) await connection.query("INSERT INTO employees(id,full_name,position,active,employment_type,department) VALUES ($1,$2,$3,$4,$5,$6)", values);
  await connection.query(`INSERT INTO employee_project_assignments(employee_id,site_id,active) VALUES (1,1,1),(2,1,1),(3,1,1),(4,1,1),(5,2,1),(7,1,0),(8,1,1),(8,2,1),(9,3,1),(10,1,1);
    INSERT INTO masters(site_id,name) VALUES (1,'Первый мастер'),(1,'Ручной исторический мастер'),(2,'Ручной другого проекта');
    INSERT INTO placement_entries(master_id,master_name_snapshot) VALUES (1,''),(1,'Историческое имя');
    INSERT INTO personnel_reports VALUES (1,1);
    INSERT INTO personnel_report_rows(report_id,master_id,master_name_snapshot) VALUES (1,1,''),(1,1,'Утверждённое имя');`);

  await ensureProjectMastersSchema(scoped);
  await ensureProjectMastersSchema(scoped);
  const directory = async siteId => (await connection.query("SELECT id, site_id, employee_id, name, active FROM masters WHERE site_id=$1 ORDER BY id", [siteId])).rows;
  const historicalRows = async () => ({
    placements: (await connection.query("SELECT * FROM placement_entries ORDER BY id")).rows,
    reports: (await connection.query("SELECT * FROM personnel_report_rows ORDER BY id")).rows,
  });
  const sourceRows = async () => ({ employees: (await connection.query("SELECT * FROM employees ORDER BY id")).rows, assignments: (await connection.query("SELECT * FROM employee_project_assignments ORDER BY id")).rows });
  const sourcesBefore = await sourceRows();
  await syncProjectMasters(scoped, 1);
  const first = await directory(1);
  assert.deepEqual(first.filter(row => row.employee_id !== null).map(row => row.employee_id).sort((a, b) => a - b), [1, 2, 8], "ITR in all three departments qualify regardless of position, within active project assignments only");
  assert.equal(first.find(row => row.employee_id === 1).id, 1, "an unambiguous legacy row keeps its historical ID");
  assert.equal(first.find(row => row.id === 2).active, 1, "manual legacy masters remain unchanged");
  assert.deepEqual(await sourceRows(), sourcesBefore, "automatic masters must never create or move employees or assignments");
  await syncProjectMasters(scoped, 1);
  assert.deepEqual(await directory(1), first, "reconciliation must be idempotent");
  assert.deepEqual((await directory(2)).map(row => row.name), ["Ручной другого проекта"], "one project cannot update another project");

  await syncProjectMasters(scoped, 2);
  const second = await directory(2);
  assert.deepEqual(second.filter(row => row.employee_id !== null).map(row => row.employee_id).sort((a, b) => a - b), [5, 8]);
  assert.notEqual(second.find(row => row.employee_id === 8).id, first.find(row => row.employee_id === 8).id, "one employee has separate stable master references in each project");
  const otherProjectBefore = await directory(2);
  await syncProjectMasters(scoped, 3);
  assert.deepEqual(await directory(3), [], "a closed project cannot acquire active automatic masters");

  await connection.query("UPDATE employees SET full_name='Новое имя первого мастера' WHERE id=1");
  await syncProjectMasters(scoped, 1);
  const renamed = await directory(1);
  assert.equal(renamed.find(row => row.employee_id === 1).id, 1);
  assert.equal(renamed.find(row => row.employee_id === 1).name, "Новое имя первого мастера");
  assert.deepEqual((await historicalRows()).placements.map(row => row.master_name_snapshot), ["Первый мастер", "Историческое имя"]);
  assert.deepEqual((await historicalRows()).reports.map(row => row.master_name_snapshot), ["Первый мастер", "Утверждённое имя"]);
  assert.deepEqual(await directory(2), otherProjectBefore);

  await connection.query("UPDATE employees SET position='Главный инженер' WHERE id=8");
  await syncProjectMasters(scoped, 1);
  assert.deepEqual(await directory(1), renamed, "changing position within an eligible type/department keeps the same master reference");

  await connection.query(`UPDATE employee_project_assignments SET active=0 WHERE employee_id=1 AND site_id=1;
    UPDATE employees SET active=0 WHERE id=2;
    UPDATE employees SET department='УСР' WHERE id=8;`);
  const historyBeforeArchive = await historicalRows();
  await syncProjectMasters(scoped, 1);
  const archived = await directory(1);
  assert.ok(archived.filter(row => row.employee_id !== null).every(row => row.active === 0), "removal, employee archival and moving outside the eligible departments remove the automatic choice");
  assert.equal(archived.find(row => row.employee_id === null).active, 1);
  assert.deepEqual(await historicalRows(), historyBeforeArchive, "archival must not remove or rewrite historical reports");
  await syncProjectMasters(scoped, 1);
  assert.deepEqual(await directory(1), archived, "repeated reads must not resurrect removed project assignments");
  assert.equal((await connection.query("SELECT active FROM employee_project_assignments WHERE employee_id=1 AND site_id=1")).rows[0].active, 0);

  await connection.query("UPDATE employee_project_assignments SET active=1 WHERE employee_id=1 AND site_id=1");
  await syncProjectMasters(scoped, 1);
  assert.deepEqual((await directory(1)).find(row => row.employee_id === 1), { ...renamed.find(row => row.employee_id === 1), active: 1 }, "returning must reuse the original master reference");
  assert.equal((await directory(1)).length, first.length);

  await connection.query("ALTER TABLE masters ADD CONSTRAINT test_master_name CHECK(name <> '__FAIL__')");
  await connection.query("INSERT INTO employees VALUES (99,'__FAIL__','Руководитель',1,'ИТР','МУ')");
  await connection.query("INSERT INTO employee_project_assignments(employee_id,site_id) VALUES (99,1)");
  await connection.query("INSERT INTO placement_entries(master_id) VALUES (1)");
  await connection.query("UPDATE employees SET full_name='Не сохранять при ошибке' WHERE id=1");
  const beforeFailure = { directory: await directory(1), history: await historicalRows() };
  await assert.rejects(syncProjectMasters(scoped, 1), /check constraint/i);
  assert.deepEqual({ directory: await directory(1), history: await historicalRows() }, beforeFailure, "a failure must roll back renaming, snapshot backfill and all master changes together");

  console.log("Project masters: ITR in MU/MUTT/MUSK regardless of position, project scoping, legacy ID adoption, idempotence, rename/history snapshots, archival, reactivation and atomic rollback passed. Employees and assignments were never changed by reconciliation. All data rolled back.");
} finally { await connection.query("ROLLBACK"); connection.release(); await pool.end(); }
