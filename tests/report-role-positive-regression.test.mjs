import assert from "node:assert/strict";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { equipmentExcelName } from "../app/equipmentExcel.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

async function storeModule(domain) {
  return import(await compileModuleGraph(`app/${domain}ReportStore.ts`));
}

const CREATED = "2026-10-29T05:00:00.000Z", CHANGED = "2026-10-30T08:30:00.000Z";
const camel = value => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const aliases = { position_snapshot: "positionSnapshot", employee_name_snapshot: "employeeName", employment_type_snapshot: "employmentType", department_snapshot: "department", master_name_snapshot: "masterName", equipment_name_snapshot: "equipmentName", organization_snapshot: "organization", equipment_type_snapshot: "equipmentType", brand_snapshot: "brand", model_snapshot: "model", registration_number_snapshot: "registrationNumber" };
const property = value => aliases[value] ?? camel(value);

/** A SQL boundary fixture: execute the real store, keeping only synthetic rows. */
function memoryDatabase(domain, siteId, ownerUserId = 9, status = "draft") {
  const entryTable = domain === "personnel" ? "placement_entries" : "equipment_entries";
  const assetField = domain === "personnel" ? "employeeId" : "equipmentId";
  const unit = { id: 55, organization: "Учебная механизация", equipmentType: "Кран", brand: "Учебный", model: "КР-1", registrationNumber: "ТЕСТ-001" };
  const identity = domain === "personnel"
    ? { employeeName: "Тестовый сотрудник", employmentType: "ОПР", department: "УСР", positionSnapshot: "Монтажник", masterName: "Тестовый мастер", masterId: 1 }
    : { ...unit, equipmentName: equipmentExcelName(unit) };
  let state = {
    header: { id: 17, siteId, ownerUserId, ownerName: "Тестовый прораб", workDate: "2026-10-30", status, revision: 1, createdAt: CREATED, updatedAt: CREATED },
    rows: [{ ...identity, id: 101, reportId: 17, siteId, workDate: "2026-10-30", [assetField]: 55, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, hours: 6, note: "Первоначально", rowOrder: 0, createdAt: CREATED, updatedAt: CREATED, approvedEntryId: null }],
    entries: [],
  };
  const writes = [];
  const outputRows = (publishedValues) => state.rows.map(row => {
    const published = state.entries.find(entry => entry.id === row.approvedEntryId);
    return structuredClone({ ...row, ...(publishedValues && state.header.status === "approved" && published ? published : {}), id: row.id, reportId: 17, approvedEntryId: row.approvedEntryId, approvedEntryRevision: published?.revision ?? null });
  });
  function select(sql, values) {
    if (sql.includes(`FROM ${domain}_reports report JOIN app_users owner`)) return [structuredClone(state.header)];
    if (sql.includes(`FROM ${domain}_report_rows draft_row JOIN`)) return outputRows(sql.includes("CASE WHEN report.status"));
    if (sql.includes("FROM sites WHERE id = ?")) return values[0] === siteId ? [{ id: siteId }] : [];
    if (sql.includes("SELECT clock_timestamp() AS changedAt")) return [{ changedAt: CHANGED }];
    if (sql.includes("FROM employees employee") && sql.includes("employee.id = ANY")) return values[0].includes(55) ? [{ id: 55, fullName: identity.employeeName, employmentType: "ОПР", department: "УСР", position: "Монтажник" }] : [];
    if (sql.includes("FROM equipment_units equipment") && sql.includes("equipment.id = ANY")) return values[0].includes(55) ? [unit] : [];
    if (/SELECT id, name/.test(sql)) {
      const table = sql.match(/FROM (\w+)/)?.[1];
      const names = { shifts: "День", zones: "Зона", main_work_types: "Монтаж", subwork_types: "Подготовка", masters: "Тестовый мастер" };
      return values[1]?.includes(1) ? [{ id: 1, name: names[table], mainWorkTypeId: 1 }] : [];
    }
    if (sql.includes("SUM(") && sql.includes(`FROM ${entryTable}`)) {
      const ids = values[1], excluded = values[2];
      return state.entries.filter(row => row.workDate === values[0] && ids.includes(row[assetField]) && !excluded.includes(row.id)).map(row => ({ [assetField]: row[assetField], hours: row.hours }));
    }
    if (/SELECT entry.id FROM/.test(sql) || sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes(`SELECT id FROM ${domain}_reports`)) return [{ id: state.header.id }];
    if (sql.includes("FROM equipment_timesheet_marks")) return [];
    throw new Error(`Unexpected fixture SELECT: ${sql.slice(0, 110)}`);
  }
  function mutate(sql, values) {
    writes.push({ sql, values });
    if (sql.startsWith(`INSERT INTO ${entryTable}`)) {
      const columns = sql.match(/\(([\s\S]*?)\)\s*VALUES/)?.[1].split(",").map(value => value.trim());
      const entry = Object.fromEntries(columns.map((column, index) => [property(column), values[index]]));
      entry.id = 500 + state.entries.length; entry.revision = 1; state.entries.push(entry);
      return [{ id: entry.id }];
    }
    if (sql.startsWith(`UPDATE ${domain}_reports SET status`)) {
      Object.assign(state.header, { status: values[0], revision: state.header.revision + 1, reviewedByUserId: values[5], reviewComment: values[6], updatedAt: CHANGED });
    } else if (sql.startsWith(`UPDATE ${domain}_reports SET revision`)) {
      state.header.revision++; state.header.updatedAt = CHANGED;
    } else if (sql.startsWith(`UPDATE ${domain}_report_rows SET approved_entry_id`)) {
      state.rows.find(row => row.id === values[1]).approvedEntryId = values[0];
    } else if (sql.startsWith(`UPDATE ${domain}_report_rows SET row_order = ?`)) {
      const fields = domain === "personnel"
        ? ["rowOrder", "employeeId", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "masterId", "hours", "note", "positionSnapshot", "employeeName", "employmentType", "department", "masterName"]
        : ["rowOrder", "equipmentId", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "hours", "note", "equipmentName", "organization", "equipmentType", "brand", "model", "registrationNumber"];
      const row = state.rows.find(row => row.id === values[17]);
      fields.forEach((field, index) => { row[field] = values[index]; });
      if (values[14]) row.updatedAt = values[15];
    } else if (sql.startsWith(`UPDATE ${entryTable} SET`)) {
      const entry = state.entries.find(row => row.id === values.at(-1));
      const fields = [...sql.split(" SET ")[1].split(" WHERE ")[0].matchAll(/(\w+)\s*=\s*\?/g)].map(match => property(match[1]));
      fields.forEach((field, index) => { entry[field] = values[index]; });
      entry.revision++; entry.updatedAt = CHANGED;
    } else if (sql.startsWith(`UPDATE ${domain}_report_rows SET position_snapshot`) || sql.startsWith(`UPDATE ${domain}_report_rows SET equipment_name_snapshot`)) {
      const row = state.rows.find(row => row.id === values.at(-1));
      const fields = [...sql.split(" SET ")[1].split(" WHERE ")[0].matchAll(/(\w+)\s*=\s*\?/g)].map(match => property(match[1]));
      fields.forEach((field, index) => { row[field] = values[index]; });
    } else if (!sql.startsWith(`DELETE FROM ${domain}_report_rows`) && !sql.startsWith(`UPDATE ${domain}_report_rows SET row_order = -id`) && !sql.includes("_report_days")) throw new Error(`Unexpected fixture mutation: ${sql.slice(0, 110)}`);
    return [{ id: state.header.id }];
  }
  const database = {
    state: () => structuredClone(state), writes,
    prepare(sql) {
      let values = [];
      const execute = () => /^SELECT\b/.test(sql.trim()) ? select(sql.trim(), values) : mutate(sql.trim(), values);
      const statement = { bind(...next) { values = next; return statement; }, async first() { return execute()[0] ?? null; }, async all() { return { results: execute() }; }, async run() { const results = execute(); return { results, meta: { changes: 1 } }; } };
      return statement;
    },
    async readBatch(statements) { return Promise.all(statements.map(statement => statement.all())); },
    async batch(statements) { const result = []; for (const statement of statements) result.push(await statement.run()); return result; },
    async transaction(callback) { const before = structuredClone(state); try { return await callback(database); } catch (error) { state = before; throw error; } },
  };
  return database;
}

for (const domain of ["personnel", "equipment"]) {
  const store = await storeModule(domain), title = `${domain[0].toUpperCase()}${domain.slice(1)}`;
  const mutate = store[`mutate${title}Report`];
  const actor = (role, siteId, mode = "selected") => ({ id: role === "foreman" ? 9 : 8, fullName: "Тестовый проверяющий", role, assignedSiteId: siteId, projectAccess: { mode, siteIds: mode === "selected" ? [siteId] : [] }, permissions: rolePermissionTemplate(role) });
  for (const [role, siteId, mode] of [["engineer", 7, "selected"], ["engineer", 12, "all"]]) test(`${domain}: ${role}/${mode} edits another foreman's submitted report, approves and corrects published hours`, async () => {
    const db = memoryDatabase(domain, siteId), user = actor(role, siteId, mode);
    const save = (report, hours, note, writer = user) => mutate(db, writer, { action: "save", siteId, workDate: report.workDate, reportId: report.id, revision: report.revision, rows: report.rows.map(row => ({ ...row, hours, note })) });
    let report = { ...db.state().header, rows: db.state().rows };
    const foreman = actor("foreman", siteId);
    const entryTable = domain === "personnel" ? "placement_entries" : "equipment_entries";
    const publishedWrites = () => db.writes.filter(write => write.sql.startsWith(`INSERT INTO ${entryTable}`));
    report = await save(report, 6, "Заполнено прорабом", foreman);
    assert.equal(report.status, "draft");
    assert.deepEqual(db.state().entries, [], "Saving a personal draft does not publish canonical hours");
    assert.deepEqual(publishedWrites(), [], "Saving a draft never inserts canonical entries");
    report = await mutate(db, foreman, { action: "submit", reportId: report.id, revision: report.revision });
    assert.equal(report.status, "submitted");
    assert.deepEqual(db.state().entries, [], "Submission makes the report reviewable, not published");
    assert.deepEqual(publishedWrites(), [], "Submitting for review never inserts canonical entries");
    report = await save(report, 7, "Исправлено проверяющим");
    assert.equal(report.ownerUserId, 9);
    assert.equal(report.rows[0].createdAt, CREATED);
    assert.equal(report.rows[0].updatedAt, CHANGED);
    assert.equal(db.state().entries.length, 0);
    assert.equal(report.status, "submitted");
    assert.equal(db.state().entries.length, 0);
    report = await mutate(db, user, { action: "approve", reportId: report.id, revision: report.revision });
    assert.equal(report.status, "approved");
    assert.equal(db.state().entries.length, 1, "Only authorized approval publishes the canonical entry");
    assert.equal(publishedWrites().length, 1);
    const published = db.state().entries[0];
    assert.equal(published.hours, 7);
    assert.equal(published.responsibleUserId, 9);
    assert.equal(published.updatedByUserId, 8);
    assert.equal(published.createdAt, CREATED);
    const approvedRevision = report.revision;
    report = await save(report, 8, "Уточнение после подтверждения");
    assert.equal(report.status, "approved");
    assert.equal(db.state().entries.length, 1);
    assert.equal(db.state().entries[0].id, published.id);
    assert.equal(db.state().entries[0].hours, 8);
    assert.equal(db.state().entries[0].revision, 2);
    await assert.rejects(save({ ...report, revision: approvedRevision }, 9, "Устаревшее изменение"), error => error.code === "STALE_REPORT");
    assert.equal(db.state().entries[0].hours, 8);
  });

  test(`${domain}: a submitted report is published only after approval by a permitted reviewer`, async () => {
    const db = memoryDatabase(domain, 7, 9, "submitted");
    const original = db.state();
    const foreman = actor("foreman", 7), deniedEngineer = actor("engineer", 7);
    deniedEngineer.permissions[domain === "personnel" ? "workers_report" : "equipment_report"].update = false;
    for (const user of [foreman, deniedEngineer]) {
      await assert.rejects(mutate(db, user, { action: "approve", reportId: 17, revision: 1 }),
        error => error.status === 403 && ["REPORT_FORBIDDEN", "REVIEW_FORBIDDEN"].includes(error.code));
      assert.deepEqual(db.writes, [], "A denied approval never reaches SQL mutations");
      assert.deepEqual(db.state(), original, "A denied approval leaves draft and canonical data unchanged");
    }
    const report = await mutate(db, actor("engineer", 7), { action: "approve", reportId: 17, revision: 1 });
    assert.equal(report.status, "approved");
    assert.equal(db.state().entries.length, 1);
    assert.equal(db.state().entries[0].hours, 6);
    assert.equal(db.state().entries[0].responsibleUserId, 9);
  });

  test(`${domain}: returning an own-project report preserves the foreman's ability to correct and resubmit`, async () => {
    const db = memoryDatabase(domain, 7), foreman = actor("foreman", 7), engineer = actor("engineer", 7);
    let report = await mutate(db, foreman, { action: "submit", reportId: 17, revision: 1 });
    report = await mutate(db, engineer, { action: "reject", reportId: 17, revision: report.revision, comment: "Уточните часы" });
    assert.equal(report.status, "rejected"); assert.equal(report.reviewComment, "Уточните часы");
    report = await mutate(db, foreman, { action: "save", siteId: 7, workDate: report.workDate, reportId: 17, revision: report.revision, rows: report.rows.map(row => ({ ...row, hours: 5 })) });
    report = await mutate(db, foreman, { action: "submit", reportId: 17, revision: report.revision });
    report = await mutate(db, foreman, { action: "reopen", reportId: 17, revision: report.revision });
    assert.equal(report.status, "draft"); assert.equal(report.rows[0].hours, 5); assert.equal(db.state().entries.length, 0);
  });
}
