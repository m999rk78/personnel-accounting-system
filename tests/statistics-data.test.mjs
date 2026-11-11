import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readStatisticsRows } from "../app/statisticsData.ts";

function fixture(t) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  // Match PostgreSQL's Unicode case conversion while executing the real queries.
  sql.function("upper", value => value?.toUpperCase() ?? null);
  sql.exec(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, employment_type TEXT, position TEXT, active INTEGER);
    CREATE TABLE zones (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT, active INTEGER);
    CREATE TABLE subwork_types (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT, active INTEGER);
    CREATE TABLE placement_entries (
      id INTEGER PRIMARY KEY, site_id INTEGER, work_date TEXT, employee_id INTEGER, zone_id INTEGER,
      hours INTEGER, position_snapshot TEXT, employment_type_snapshot TEXT,
      responsible_user_id INTEGER, deleted_at TEXT
    );
    CREATE TABLE equipment_entries (
      id INTEGER PRIMARY KEY, site_id INTEGER, work_date TEXT, equipment_id INTEGER, zone_id INTEGER,
      hours INTEGER, subwork_type_id INTEGER, responsible_user_id INTEGER, deleted_at TEXT
    );
    CREATE TABLE personnel_reports (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE personnel_report_rows (report_id INTEGER, employee_id INTEGER, zone_id INTEGER, hours INTEGER);
    CREATE TABLE equipment_reports (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE equipment_report_rows (report_id INTEGER, equipment_id INTEGER, zone_id INTEGER, hours INTEGER);
    CREATE TABLE personnel_timesheet_marks (employee_id INTEGER, hours INTEGER);
    CREATE TABLE equipment_timesheet_marks (equipment_id INTEGER, productive_hours INTEGER, downtime_hours INTEGER);
    INSERT INTO employees VALUES (1, 'ОПР', 'Сварщик', 1), (2, 'ОПР', 'Слесарь', 1),
      (3, 'ИТР', 'Мастер', 0), (4, 'АУП', 'Руководитель', 1);
    INSERT INTO zones VALUES (10, 7, 'Монтажная площадка', 1), (11, 7, 'Монтажная площадка', 0),
      (20, 8, 'Зона другого проекта', 1);
    INSERT INTO subwork_types VALUES (1, 7, 'Перевозка материалов', 1), (2, 7, 'ПРОСТОЙ техники', 0),
      (3, 7, 'Плановый простой', 1), (4, 8, 'Простой другого проекта', 1);
  `);
  const queries = [];
  const db = {
    prepare(query) {
      assert.match(query, /^SELECT /, "Statistics must only read persisted records");
      return {
        bind(...values) {
          queries.push({ query, values });
          return { async all() { return { results: sql.prepare(query).all(...values) }; } };
        },
      };
    },
  };
  function personnel({ id, site = 7, date = "2026-11-01", employee = 1, zone = 10, hours = 8,
    position = "Сварщик", employment = "ОПР", owner = 100, deleted = null }) {
    sql.prepare("INSERT INTO placement_entries VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, site, date, employee, zone, hours, position, employment, owner, deleted);
  }
  function equipment({ id, site = 7, date = "2026-11-01", unit = 1, zone = 10, hours = 8,
    subwork = 1, owner = 100, deleted = null }) {
    sql.prepare("INSERT INTO equipment_entries VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, site, date, unit, zone, hours, subwork, owner, deleted);
  }
  return { sql, db, queries, personnel, equipment };
}

const read = (db, kind = "personnel", from = "2026-11-01", to = "2026-11-30", site = 7) =>
  readStatisticsRows(db, site, kind, from, to);
const totals = rows => rows.reduce((sum, row) => sum + row.total, 0);

test("statistics sums every foreman once, includes date boundaries, and isolates projects", async t => {
  const { db, queries, personnel, equipment } = fixture(t);
  for (const add of [personnel, equipment]) {
    add({ id: 1, date: "2026-10-31", hours: 20 });
    add({ id: 2, date: "2026-11-01", hours: 3, owner: 100 });
    add({ id: 3, date: "2026-11-01", hours: 4, owner: 101 });
    add({ id: 4, date: "2026-11-30", hours: 5, owner: 102 });
    add({ id: 5, date: "2026-12-01", hours: 20 });
    add({ id: 6, site: 8, zone: 20, hours: 19 });
    add({ id: 7, hours: 17, deleted: "2026-11-02T00:00:00Z" });
  }
  for (const kind of ["personnel", "equipment"]) {
    assert.equal(totals(await read(db, kind)), 12);
    assert.equal(totals(await read(db, kind, "2026-11-01", "2026-11-01")), 7);
    assert.equal(totals(await read(db, kind, "2026-11-30", "2026-11-30")), 5);
    assert.equal(totals(await read(db, kind, "2026-11-01", "2026-11-30", 8)), 19);
    assert.deepEqual(await read(db, kind, "2026-09-01", "2026-09-30"), []);
  }
  assert.ok(queries.every(({ values }) => values.length === 3), "One bound aggregation query per request");
});

test("personnel grouping uses saved position and employment history even after employee or zone archival", async t => {
  const { db, personnel } = fixture(t);
  personnel({ id: 1, employee: 3, position: "ЭЛЕКТРОГАЗОСВАРЩИК", hours: 5 });
  personnel({ id: 2, position: "Монтажник стальных конструкций", hours: 7 });
  personnel({ id: 3, employee: 2, position: "Подсобный рабочий", hours: 3, employment: " опр " });
  personnel({ id: 4, employee: 2, position: "Монтажник", hours: 2, employment: "" });
  personnel({ id: 5, employee: 1, position: "Мастер", employment: "ИТР", hours: 8 });
  personnel({ id: 6, employee: 4, employment: "", hours: 8 });
  personnel({ id: 7, zone: 11, employee: 3, position: "Сварщик-монтажник", hours: 4 });
  personnel({ id: 8, zone: null, position: "", hours: 1 });
  const rows = await read(db);
  assert.deepEqual(rows.map(({ zoneId, welders, installers, other, total }) =>
    ({ zoneId, welders, installers, other, total })), [
    { zoneId: 10, welders: 5, installers: 9, other: 3, total: 17 },
    { zoneId: 11, welders: 4, installers: 0, other: 0, total: 4 },
    { zoneId: null, welders: 0, installers: 0, other: 1, total: 1 },
  ]);
  assert.equal(rows[0].zone, rows[1].zone, "Two zones with identical names keep distinct totals");
  assert.equal(rows[2].zone, "Без зоны");
});

test("equipment separates working and downtime hours including archived and unassigned zones", async t => {
  const { db, equipment } = fixture(t);
  equipment({ id: 1, hours: 8 });
  equipment({ id: 2, hours: 3, subwork: 2 });
  equipment({ id: 3, hours: 2, subwork: 3, owner: 101 });
  equipment({ id: 4, hours: 4, zone: 11, subwork: 2 });
  equipment({ id: 5, hours: 1, zone: null });
  const rows = await read(db, "equipment");
  assert.deepEqual(rows.map(({ zoneId, productive, downtime, total }) =>
    ({ zoneId, productive, downtime, total })), [
    { zoneId: 10, productive: 8, downtime: 5, total: 13 },
    { zoneId: 11, productive: 0, downtime: 4, total: 4 },
    { zoneId: null, productive: 1, downtime: 0, total: 1 },
  ]);
  assert.ok(rows.every(row => row.productive + row.downtime === row.total));
});

test("pending reports and manual timesheet values do not inflate published statistics", async t => {
  const { db, sql, personnel, equipment } = fixture(t);
  sql.exec(`
    INSERT INTO personnel_reports VALUES (1, 'draft'), (2, 'submitted'), (3, 'rejected');
    INSERT INTO equipment_reports VALUES (1, 'draft'), (2, 'submitted'), (3, 'rejected');
    INSERT INTO personnel_report_rows VALUES (1,1,10,20), (2,1,10,20), (3,1,10,20);
    INSERT INTO equipment_report_rows VALUES (1,1,10,20), (2,1,10,20), (3,1,10,20);
    INSERT INTO personnel_timesheet_marks VALUES (1,20);
    INSERT INTO equipment_timesheet_marks VALUES (1,10,10);
  `);
  personnel({ id: 1, hours: 6 });
  equipment({ id: 1, hours: 7 });
  assert.equal(totals(await read(db)), 6);
  assert.equal(totals(await read(db, "equipment")), 7);
});

test("corrections, zone or date moves, and removal of published entries update aggregate totals", async t => {
  const { db, sql, personnel, equipment } = fixture(t);
  personnel({ id: 1, hours: 5 });
  equipment({ id: 1, hours: 6 });
  for (const [kind, table] of [["personnel", "placement_entries"], ["equipment", "equipment_entries"]]) {
    sql.exec(`UPDATE ${table} SET hours = 9, zone_id = 11 WHERE id = 1`);
    const corrected = await read(db, kind);
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].zoneId, 11);
    assert.equal(corrected[0].total, 9);
    sql.exec(`UPDATE ${table} SET work_date = '2026-12-01' WHERE id = 1`);
    assert.deepEqual(await read(db, kind), []);
    assert.equal(totals(await read(db, kind, "2026-12-01", "2026-12-01")), 9);
    sql.exec(`UPDATE ${table} SET deleted_at = '2026-12-02T00:00:00Z' WHERE id = 1`);
    assert.deepEqual(await read(db, kind, "2026-12-01", "2026-12-31"), []);
  }
});

test("stale cross-project references cannot disclose zone or subwork names", async t => {
  const { db, personnel, equipment } = fixture(t);
  personnel({ id: 1, zone: 20, hours: 3 });
  equipment({ id: 1, zone: 20, subwork: 4, hours: 2 });
  for (const kind of ["personnel", "equipment"]) {
    const rows = await read(db, kind);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].zoneId, null);
    assert.equal(rows[0].zone, "Без зоны");
  }
  const [equipmentRow] = await read(db, "equipment");
  assert.equal(equipmentRow.productive, 2);
  assert.equal(equipmentRow.downtime, 0);
});
