// Loopback only. A disposable schema, fixtures and every import are rolled back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { equipmentExcelName } from "../app/equipmentExcel.ts";
import { importEquipmentEntries } from "../app/equipmentImportServer.ts";
import { equipmentTimesheetUnitsStatement } from "../app/equipmentTimesheetUnits.ts";

const hostname = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname), "Use a loopback PostgreSQL database.");
const source = await readFile(new URL("../db/client.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('"pg"', JSON.stringify(import.meta.resolve("pg")));
const { PostgresDatabase, PostgresStatement } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const connection = await pool.connect();
const database = new PostgresDatabase(pool);
const executor = { prepare: (sql) => new PostgresStatement(database, sql, [], connection) };
const scoped = { async transaction(callback) {
  await connection.query("SAVEPOINT equipment_import_operation");
  try { const result = await callback(executor); await connection.query("RELEASE SAVEPOINT equipment_import_operation"); return result; }
  catch (error) { await connection.query("ROLLBACK TO SAVEPOINT equipment_import_operation"); await connection.query("RELEASE SAVEPOINT equipment_import_operation"); throw error; }
} };

const a = { id: 1, equipmentType: "Кран", brand: "SANY", model: "STC250", registrationNumber: "А001", organization: "Организация А" };
const b = { ...a, id: 2, organization: "Организация Б" };
const row = (overrides = {}) => ({ workDate: "2026-10-01", equipmentName: equipmentExcelName(a), shiftName: "День", zoneName: "Новая зона", mainWorkTypeName: "Вспомогательные", subworkTypeName: "Перевозка", note: "", hours: "8", ...overrides });
const actor = { id: 7, fullName: "Прораб", role: "foreman" };

try {
  await connection.query("BEGIN");
  const schema = `equipment_import_test_${randomUUID().replaceAll("-", "")}`;
  await connection.query(`CREATE SCHEMA ${schema}`);
  await connection.query(`SET LOCAL search_path TO ${schema}`);
  await connection.query(`CREATE TABLE sites(id integer PRIMARY KEY, active integer DEFAULT 1);
    CREATE TABLE equipment_units(id integer PRIMARY KEY, equipment_type text, brand text, model text, registration_number text, organization text, active integer DEFAULT 1, note text DEFAULT '');
    CREATE TABLE equipment_project_assignments(equipment_id integer REFERENCES equipment_units, site_id integer REFERENCES sites, active integer DEFAULT 1);
    CREATE TABLE shifts(id integer PRIMARY KEY, site_id integer REFERENCES sites, name text, active integer DEFAULT 1);
    CREATE TABLE main_work_types(id integer PRIMARY KEY, site_id integer REFERENCES sites, name text, active integer DEFAULT 1);
    CREATE TABLE subwork_types(id integer PRIMARY KEY, site_id integer REFERENCES sites, name text, main_work_type_id integer REFERENCES main_work_types, active integer DEFAULT 1);
    CREATE TABLE zones(id serial PRIMARY KEY, site_id integer REFERENCES sites, name text, active integer DEFAULT 1);
    CREATE TABLE equipment_entries(id serial PRIMARY KEY, site_id integer REFERENCES sites, work_date date, equipment_id integer REFERENCES equipment_units,
      shift_id integer REFERENCES shifts, zone_id integer REFERENCES zones, main_work_type_id integer REFERENCES main_work_types, subwork_type_id integer REFERENCES subwork_types,
      note text, hours integer CHECK(hours BETWEEN 1 AND 10), created_by text, responsible_user_id integer, created_by_user_id integer, updated_by_user_id integer, deleted_at timestamptz);
    CREATE TABLE equipment_timesheet_marks(site_id integer REFERENCES sites, equipment_id integer REFERENCES equipment_units, work_date date, productive_hours integer, downtime_hours integer, note text);
    INSERT INTO sites VALUES (1,1),(2,1);
    INSERT INTO shifts VALUES (1,1,'День',1),(2,2,'Другая смена',1);
    INSERT INTO main_work_types VALUES (1,1,'Вспомогательные',1),(2,1,'Земляные',1);
    INSERT INTO subwork_types VALUES (1,1,'Перевозка',1,1),(2,1,'Копка',2,1);
    INSERT INTO zones(site_id,name,active) VALUES (1,'Архивная зона',0);`);
  for (const unit of [a, b]) {
    await connection.query("INSERT INTO equipment_units(id,equipment_type,brand,model,registration_number,organization) VALUES ($1,$2,$3,$4,$5,$6)", [unit.id, unit.equipmentType, unit.brand, unit.model, unit.registrationNumber, unit.organization]);
    await connection.query("INSERT INTO equipment_project_assignments(equipment_id,site_id) VALUES ($1,1)", [unit.id]);
  }

  const snapshot = async () => ({
    zones: (await connection.query("SELECT * FROM zones ORDER BY id")).rows,
    entries: (await connection.query("SELECT * FROM equipment_entries ORDER BY id")).rows,
  });
  const unchanged = async (entries, expected, callback) => {
    const before = await snapshot();
    await assert.rejects(importEquipmentEntries(scoped, 1, entries, actor, callback), expected);
    assert.deepEqual(await snapshot(), before, "failed import must roll back zones and all earlier entries");
  };

  assert.deepEqual(await importEquipmentEntries(scoped, 1, [row()], actor), { imported: 1, skipped: 0 });
  assert.equal((await connection.query("SELECT equipment_id FROM equipment_entries")).rows[0].equipment_id, 1, "same registration cannot redirect import to unit B");
  const saved = await snapshot();
  assert.deepEqual(await importEquipmentEntries(scoped, 1, [row()], actor), { imported: 0, skipped: 1 });
  assert.deepEqual(await snapshot(), saved);
  await unchanged([row({ equipmentName: "Экскаватор // SANY STC250 // А001 // Организация А", zoneName: "Не создавать" })], /полным наименованием не найдена/);
  await unchanged([row({ workDate: "2026-02-31", zoneName: "Не создавать" })], /календарная дата/);
  await unchanged([row({ shiftName: "Другая смена", zoneName: "Не создавать" })], /Смена.*не найден/);
  await unchanged([row({ subworkTypeName: "Копка", zoneName: "Не создавать" })], /Подвид.*не найден/);
  await unchanged([row({ zoneName: "Архивная зона", note: "Откатить", hours: 10 }), row({ zoneName: "Не создавать", note: "Перелимит", hours: 3 })], /не более 20/);
  await connection.query("INSERT INTO equipment_timesheet_marks VALUES (1,2,'2026-10-01',0,8,'Ремонт')");
  await unchanged([row({ zoneName: "Архивная зона", note: "Откатить", hours: 1 }), row({ equipmentName: equipmentExcelName(b), zoneName: "Не создавать" })], /недоступна по табелю.*Ремонт/);
  await unchanged([row({ workDate: "2026-10-02", zoneName: "Не создавать" })], /Сбой отчёта/, async () => { throw new Error("Сбой отчёта"); });

  const long = { id: 3, equipmentType: "Т".repeat(120), brand: "Б".repeat(120), model: "М".repeat(180), registrationNumber: "", organization: "О".repeat(120) };
  await connection.query("INSERT INTO equipment_units(id,equipment_type,brand,model,registration_number,organization) VALUES ($1,$2,$3,$4,$5,$6)", [long.id, long.equipmentType, long.brand, long.model, long.registrationNumber, long.organization]);
  await connection.query("INSERT INTO equipment_project_assignments(equipment_id,site_id) VALUES (3,1)");
  assert.ok(equipmentExcelName(long).length > 400);
  assert.deepEqual(await importEquipmentEntries(scoped, 1, [row({ equipmentName: equipmentExcelName(long), zoneName: "Архивная зона" })], actor), { imported: 1, skipped: 0 });
  assert.equal((await connection.query("SELECT active FROM zones WHERE name='Архивная зона'")).rows[0].active, 1);
  await connection.query("INSERT INTO equipment_units(id,equipment_type,brand,model,registration_number,organization,active) SELECT 4,equipment_type,brand,model,registration_number,organization,active FROM equipment_units WHERE id=1");
  await connection.query("INSERT INTO equipment_project_assignments(equipment_id,site_id) VALUES (4,1)");
  await unchanged([row({ zoneName: "Не создавать" })], /неоднозначно/);
  await connection.query("UPDATE equipment_project_assignments SET active=0 WHERE equipment_id=2");
  await connection.query("UPDATE equipment_units SET active=0 WHERE id=2");
  await connection.query("INSERT INTO equipment_units(id,equipment_type,brand,model,registration_number,organization,active) SELECT 5,equipment_type,brand,model,'005',organization,0 FROM equipment_units WHERE id=1");
  await connection.query("INSERT INTO equipment_units(id,equipment_type,brand,model,registration_number,organization,active) SELECT 6,equipment_type,brand,model,'006',organization,0 FROM equipment_units WHERE id=1");
  await connection.query("INSERT INTO equipment_timesheet_marks VALUES (2,5,'2026-10-01',8,0,''),(1,6,'2026-09-01',8,0,'')");
  const historicalUnits = (await equipmentTimesheetUnitsStatement(executor, 1, "2026-10-01", "2026-11-01").all()).results;
  assert.ok(historicalUnits.some((unit) => unit.id === 2), "mark-only equipment remains in its historical month after archival/removal");
  assert.ok(!historicalUnits.some((unit) => unit.id === 5 || unit.id === 6), "other projects and months do not leak into the timesheet");
  console.log("Equipment imports: full identities, strict dates/scoping, idempotent skips, long names and atomic zone/entry rollback passed. Historical mark-only equipment survives archival. All data rolled back.");
} finally {
  await connection.query("ROLLBACK");
  connection.release();
  await pool.end();
}
