// Isolated equipment report QA: synthetic assets and in-memory approved entries.
// No environment files, database clients or external services are loaded.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  EquipmentReportError, assertCanSaveEquipmentReport, assertEquipmentReportOwner,
  assertEquipmentReportRevision, assertEquipmentReportSiteAccess, canReviewEquipmentReport,
  collectEquipmentReportHourIssues, equipmentReportRowChanged, inspectEquipmentReportRows,
  nextEquipmentReportStatus, validEquipmentReportDate,
} from "../app/equipmentReportWorkflow.ts";
import { equipmentReportOrderScope, isEquipmentReportOrderId, moveEquipmentReportRows, remapEquipmentReportOrder } from "../app/equipmentReportRowOrder.ts";

const TODAY = "2026-10-30";
const YESTERDAY = "2026-10-29";
const BEFORE = "2026-10-28";
const SCENARIOS = ["default", "workflow", "conflicts"];
let scenario = "workflow";
let port = 3109;
let buildOnly = false;
let selfTest = false;
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === "--scenario") scenario = process.argv[++i];
  else if (argument === "--port") port = Number(process.argv[++i]);
  else if (argument === "--build-only") buildOnly = true;
  else if (argument === "--self-test") selfTest = true;
  else throw new Error(`Неизвестный аргумент стенда: ${argument}`);
}
if (!SCENARIOS.includes(scenario)) throw new Error("Сценарий: default, workflow или conflicts.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Некорректный порт стенда.");
const site = { id: 1, name: "Учебный проект техники" };
const units = [
  { id: 1, organization: "Учебная механизация", equipmentType: "Экскаватор", brand: "Учебный", model: "ЭК-1", registrationNumber: "ТЕСТ-001", note: "", assignedSiteId: site.id, assignedSiteName: site.name },
  { id: 2, organization: "Учебная механизация", equipmentType: "Автокран", brand: "Пример", model: "КР-2", registrationNumber: "ТЕСТ-002", note: "", assignedSiteId: site.id, assignedSiteName: site.name },
  { id: 3, organization: "Демонстрационный транспорт", equipmentType: "Автобус", brand: "Образец", model: "АВ-3", registrationNumber: "ТЕСТ-003", note: "", assignedSiteId: site.id, assignedSiteName: site.name },
];
const directories = {
  shiftId: [{ id: 1, name: "Дневная" }, { id: 2, name: "Ночная" }],
  zoneId: [{ id: 1, name: "Зона А" }, { id: 2, name: "Зона Б" }],
  mainWorkTypeId: [{ id: 1, name: "Монтажные работы" }, { id: 2, name: "Вспомогательные работы" }],
  subworkTypeId: [
    { id: 1, name: "Монтаж в проектное положение строительных конструкций с проверкой геометрии", mainWorkTypeId: 1 },
    { id: 2, name: "Перевозка персонала между участками строительной площадки", mainWorkTypeId: 2 },
    { id: 3, name: "Простой техники по организационным причинам", mainWorkTypeId: 2 },
  ],
};
const actors = Object.fromEntries([
  ["foreman", 10, "Алексей Тестовый", "foreman"], ["foreman2", 11, "Борис Другая Бригада", "foreman"],
  ["engineer", 20, "Ирина Проверяющая", "engineer"], ["superadmin", 30, "Администратор Проверки", "superadmin"],
].map(([key, id, fullName, role]) => [key, { id, fullName, role, assignedSiteId: site.id, permissions: { equipment_report: { view: true, create: true, update: true, delete: true } } }]));
const reports = new Map();
const entries = new Map();
const orders = new Map();
const requestCounts = { validation: 0, save: 0, submit: 0, mutations: 0, approvedEdits: 0 };
let availabilityMarks = [];
let nextReportId = 101;
let nextRowId = 2000;
let nextEntryId = 3000;
const equipmentName = id => { const unit = units.find(item => item.id === id); return unit ? `${unit.equipmentType} ${unit.brand} ${unit.model} • ${unit.registrationNumber}` : ""; };
const equipmentNames = new Map(units.map(unit => [unit.id, equipmentName(unit.id)]));
const fail = (message, status = 400, code = "INVALID_REPORT", details) => { throw new EquipmentReportError(message, status, code, details); };
const rowInput = (equipmentId, hours = 8, extra = {}) => ({ equipmentId, hours, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, note: "Учебная запись", ...extra });
function enrichRow(input, report, previous, rowOrder = 0) {
  const unit = units.find(item => item.id === input.equipmentId);
  const name = field => directories[field].find(option => option.id === input[field])?.name ?? "";
  return {
    ...input, id: previous?.id ?? nextRowId++, reportId: report.id, siteId: report.siteId, workDate: report.workDate, rowOrder,
    createdAt: previous?.createdAt ?? report.updatedAt,
    updatedAt: previous && !equipmentReportRowChanged(previous, input) ? previous.updatedAt : report.updatedAt,
    equipmentId: input.equipmentId ?? null, shiftId: input.shiftId ?? null, zoneId: input.zoneId ?? null,
    mainWorkTypeId: input.mainWorkTypeId ?? null, subworkTypeId: input.subworkTypeId ?? null, hours: input.hours ?? null, note: input.note?.trim() ?? "",
    equipmentName: equipmentName(input.equipmentId), equipmentType: unit?.equipmentType ?? "", organization: unit?.organization ?? "",
    brand: unit?.brand ?? "", model: unit?.model ?? "", registrationNumber: unit?.registrationNumber ?? "",
    shiftName: name("shiftId"), zoneName: name("zoneId"), mainWorkTypeName: name("mainWorkTypeId"), subworkTypeName: name("subworkTypeId"),
    approvedEntryId: previous?.approvedEntryId ?? null, approvedEntryRevision: previous?.approvedEntryRevision,
  };
}
function publishEntries(report) {
  for (const row of report.rows) {
    const id = row.approvedEntryId ?? nextEntryId++;
    const revision = (entries.get(id)?.revision ?? 0) + 1;
    entries.set(id, { ...row, id, revision, orderRowId: row.id, orderReportId: report.id, responsibleUserId: report.ownerUserId, responsibleUserName: report.ownerName });
    row.approvedEntryId = id; row.approvedEntryRevision = revision;
  }
}
function addReport(date, owner, status, rows) {
  const stamp = `${date}T12:00:00.000Z`;
  const report = { id: nextReportId++, siteId: site.id, workDate: date, ownerUserId: owner.id, ownerName: owner.fullName, status, revision: 1,
    submittedAt: status === "submitted" || status === "approved" ? stamp : null,
    reviewedAt: status === "approved" || status === "rejected" ? stamp : null,
    reviewedByUserId: status === "approved" || status === "rejected" ? 20 : null,
    reviewedByName: status === "approved" || status === "rejected" ? actors.engineer.fullName : "", reviewComment: "", createdAt: stamp, updatedAt: stamp, rows: [] };
  report.rows = rows.map((row, index) => enrichRow(row, report, undefined, index));
  if (status === "approved") publishEntries(report);
  reports.set(report.id, report);
  return report;
}
function resetFixture() {
  reports.clear(); entries.clear(); orders.clear(); availabilityMarks = [];
  nextReportId = 101; nextRowId = 2000; nextEntryId = 3000;
  for (const key of Object.keys(requestCounts)) requestCounts[key] = 0;
  if (scenario === "conflicts") {
    addReport(TODAY, actors.foreman, "draft", [rowInput(1, 4), rowInput(2, 3), rowInput(3, 5)]);
    addReport(YESTERDAY, actors.foreman, "draft", [rowInput(1, 4), rowInput(2, 3)]);
    addReport(TODAY, actors.foreman2, "approved", [rowInput(1, 9), rowInput(1, 9), rowInput(2, 10), rowInput(2, 9)]);
    addReport(YESTERDAY, actors.foreman2, "approved", [rowInput(1, 10), rowInput(1, 8), rowInput(2, 9), rowInput(2, 9)]);
    availabilityMarks = [{ equipmentId: 3, workDate: TODAY, productiveHours: 0, downtimeHours: 8, note: "Техника недоступна — учебная отметка табеля" }];
  } else if (scenario === "workflow") {
    for (const date of [TODAY, YESTERDAY, BEFORE]) addReport(date, actors.foreman, "draft", [rowInput(1, 4), rowInput(2, 3)]);
    addReport(TODAY, actors.foreman2, "submitted", [rowInput(3, 5)]);
    addReport(YESTERDAY, actors.foreman2, "approved", [rowInput(2, 2, { mainWorkTypeId: 2, subworkTypeId: 3 })]);
    addReport(BEFORE, actors.foreman2, "rejected", [rowInput(3, 4)]).reviewComment = "Уточните участок работ";
    availabilityMarks = [{ equipmentId: 2, workDate: TODAY, productiveHours: 4, downtimeHours: 2, note: "Смешанная отметка не блокирует работу" }];
  } else {
    addReport(YESTERDAY, actors.foreman, "approved", [rowInput(1, 8), rowInput(2, 6, { mainWorkTypeId: 2, subworkTypeId: 3 })]);
    const legacy = enrichRow(rowInput(3, 4), { id: 0, siteId: site.id, workDate: BEFORE, updatedAt: `${BEFORE}T15:00:00.000Z` });
    const id = nextEntryId++;
    entries.set(id, { ...legacy, id, revision: 1, responsibleUserId: 10, responsibleUserName: actors.foreman.fullName });
  }
}
function inspectReferences(rows) {
  return rows.flatMap((row, index) => {
    const issues = [];
    const add = message => issues.push({ rowNumbers: [index + 1], equipmentId: row.equipmentId ?? undefined, code: "INVALID_REFERENCE", message: `Строка ${index + 1}: ${message}` });
    if (row.equipmentId !== null && !units.some(unit => unit.id === row.equipmentId)) add("техника не закреплена за проектом.");
    for (const field of Object.keys(directories)) if (row[field] !== null && !directories[field].some(option => option.id === row[field])) add(`значение ${field} отсутствует в справочнике.`);
    const subwork = directories.subworkTypeId.find(option => option.id === row.subworkTypeId);
    if (subwork && subwork.mainWorkTypeId !== row.mainWorkTypeId) add("подвид не относится к выбранному виду работ.");
    return issues;
  });
}
function availabilityIssues(rows, workDate) {
  return rows.flatMap((row, index) => availabilityMarks.some(mark => mark.workDate === workDate && mark.equipmentId === row.equipmentId && mark.productiveHours === 0 && mark.downtimeHours > 0)
    ? [{ rowNumbers: [index + 1], equipmentId: row.equipmentId, equipmentName: equipmentName(row.equipmentId), code: "EQUIPMENT_UNAVAILABLE", message: `Строка ${index + 1}: техника недоступна по отметке табеля за ${workDate}.` }] : []);
}
function approvedHours(date, excluded = []) {
  const used = new Map();
  for (const entry of entries.values()) if (entry.workDate === date && !excluded.includes(entry.id)) used.set(entry.equipmentId, (used.get(entry.equipmentId) ?? 0) + entry.hours);
  return used;
}
function checkedRows(input, required = false) {
  const inspected = inspectEquipmentReportRows(input, required);
  const issues = [...inspected.issues, ...inspectReferences(inspected.rows)];
  if (issues.length) fail(issues[0].message, 400, issues[0].code, { issues });
  return inspected.rows;
}
function checkMaterialization(rows, date, excluded = []) {
  const issues = [...availabilityIssues(rows, date), ...collectEquipmentReportHourIssues(rows, approvedHours(date, excluded), equipmentNames)];
  if (issues.length) fail(issues[0].message, 409, issues[0].code, { issues });
}
function validateSubmissions(body, actor) {
  assertEquipmentReportSiteAccess(actor, body.siteId);
  if (body.siteId !== site.id || !Array.isArray(body.reports) || !body.reports.length || body.reports.length > 100) fail("Укажите проект и от 1 до 100 отчётов.");
  const targets = body.reports;
  if (new Set(targets.map(target => target.key)).size !== targets.length) fail("Отчёт указан повторно.");
  for (const target of targets) if (target.reportId && reports.has(target.reportId)) assertEquipmentReportOwner(actor, reports.get(target.reportId));
  const issues = [];
  const normalized = [];
  for (const target of targets) {
    if (typeof target.key !== "string" || !target.key || !validEquipmentReportDate(target.workDate)) fail("Некорректный ключ или дата отчёта.");
    const report = target.reportId ? reports.get(target.reportId) : undefined;
    const add = issue => issues.push({ ...issue, key: target.key, workDate: target.workDate });
    if (target.reportId && !report) add({ code: "REPORT_NOT_FOUND", message: "Отчёт не найден." });
    if (report) {
      try { assertEquipmentReportRevision(report.revision, target.revision); nextEquipmentReportStatus(actor, report, "submit"); }
      catch (error) { if (error.status === 403) throw error; add({ code: error.code, message: error.message }); }
      if (report.workDate !== target.workDate) add({ code: "REPORT_DATE_MISMATCH", message: "Дата существующего отчёта не может измениться." });
    } else if ([...reports.values()].some(item => item.workDate === target.workDate && item.ownerUserId === actor.id && item.status !== "approved")) add({ code: "REPORT_EXISTS", message: "Для этой даты уже есть черновик." });
    const inspected = inspectEquipmentReportRows(target.rows, true);
    [...inspected.issues, ...inspectReferences(inspected.rows), ...availabilityIssues(inspected.rows, target.workDate)].forEach(add);
    normalized.push({ target, rows: inspected.rows });
  }
  for (const date of new Set(normalized.map(item => item.target.workDate))) {
    const countable = normalized.filter(item => item.target.workDate === date).flatMap(item => item.rows.flatMap((row, index) => row.equipmentId && row.hours ? [{ ...row, item, index }] : []));
    for (const issue of collectEquipmentReportHourIssues(countable, approvedHours(date), equipmentNames)) {
      for (const item of normalized.filter(item => item.target.workDate === date)) {
        const rowNumbers = countable.filter(row => row.item === item && row.equipmentId === issue.equipmentId).map(row => row.index + 1);
        if (rowNumbers.length) issues.push({ ...issue, key: item.target.key, workDate: date, rowNumbers });
      }
    }
  }
  return { issues };
}
function mutateReport(body, actor) {
  const now = new Date().toISOString();
  if (body.action === "save-approved-entry") {
    assertEquipmentReportSiteAccess(actor, body.siteId);
    if (!canReviewEquipmentReport(actor)) fail("Исправить подтверждённую запись может инженер.", 403, "REVIEW_FORBIDDEN");
    const previous = entries.get(body.entryId);
    if (!previous || previous.siteId !== body.siteId || previous.workDate !== body.workDate) fail("Подтверждённая запись не найдена.", 404, "ENTRY_NOT_FOUND");
    if (previous.orderReportId) fail("Исправьте запись через её отчёт.", 409, "REPORT_LOCKED");
    assertEquipmentReportRevision(previous.revision, body.revision);
    const rows = checkedRows([body.row], true); checkMaterialization(rows, body.workDate, [previous.id]);
    const next = { ...enrichRow(rows[0], { id: 0, siteId: body.siteId, workDate: body.workDate, updatedAt: now }, previous), id: previous.id, revision: previous.revision + 1, responsibleUserId: previous.responsibleUserId, responsibleUserName: previous.responsibleUserName };
    entries.set(next.id, next); requestCounts.approvedEdits++;
    return { entry: next };
  }
  if (body.action === "save") {
    assertEquipmentReportSiteAccess(actor, body.siteId);
    if (body.siteId !== site.id || !validEquipmentReportDate(body.workDate)) fail("Некорректный проект или дата.");
    const current = body.reportId ? reports.get(body.reportId) : undefined;
    if (body.reportId && !current) fail("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
    if (current && current.workDate !== body.workDate) fail("Нельзя изменить дату существующего отчёта.");
    assertCanSaveEquipmentReport(actor, current);
    if (current) assertEquipmentReportRevision(current.revision, body.revision);
    else if ([...reports.values()].some(item => item.workDate === body.workDate && item.ownerUserId === actor.id && item.status !== "approved")) fail("На эту дату уже есть ваш черновик.", 409, "REPORT_EXISTS");
    const rows = checkedRows(body.rows, current && ["submitted", "approved"].includes(current.status));
    const retained = new Set();
    for (const row of rows) if (row.id) {
      const previous = current?.rows.find(item => item.id === row.id);
      if (!previous || retained.has(row.id)) fail("Строка не принадлежит этому отчёту или указана повторно.");
      retained.add(row.id);
      if (current.status === "approved") assertEquipmentReportRevision(previous.approvedEntryRevision, row.approvedEntryRevision);
    }
    if (current && ["submitted", "approved"].includes(current.status)) checkMaterialization(rows, current.workDate, current.status === "approved" ? current.rows.map(row => row.approvedEntryId) : []);
    const report = current ? { ...structuredClone(current), revision: current.revision + 1, updatedAt: now } : {
      id: nextReportId++, siteId: site.id, workDate: body.workDate, ownerUserId: actor.id, ownerName: actor.fullName, status: "draft", revision: 1,
      createdAt: now, updatedAt: now, submittedAt: null, reviewedAt: null, reviewedByUserId: null, reviewedByName: "", reviewComment: "", rows: [],
    };
    const oldEntries = report.rows.map(row => row.approvedEntryId).filter(Boolean);
    report.rows = rows.map((row, index) => enrichRow(row, report, current?.rows.find(previous => previous.id === row.id), index));
    if (report.status === "approved") {
      for (const id of oldEntries) if (!report.rows.some(row => row.approvedEntryId === id)) entries.delete(id);
      publishEntries(report); requestCounts.approvedEdits++;
    }
    reports.set(report.id, report);
    return { report };
  }
  const current = reports.get(body.reportId);
  if (!current) fail("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
  assertEquipmentReportRevision(current.revision, body.revision);
  const status = nextEquipmentReportStatus(actor, current, body.action, body.comment);
  if (status === "submitted" || status === "approved") checkMaterialization(checkedRows(current.rows, true), current.workDate);
  const report = { ...structuredClone(current), status, revision: current.revision + 1, updatedAt: now };
  if (status === "submitted") Object.assign(report, { submittedAt: now, reviewedAt: null, reviewedByUserId: null, reviewedByName: "", reviewComment: "" });
  if (status === "approved" || status === "rejected") Object.assign(report, { reviewedAt: now, reviewedByUserId: actor.id, reviewedByName: actor.fullName, reviewComment: body.comment?.trim() ?? "" });
  if (status === "approved") publishEntries(report);
  reports.set(report.id, report);
  return { report };
}
function timesheetEntries() {
  const grouped = new Map();
  for (const entry of entries.values()) {
    const key = `${entry.equipmentId}:${entry.workDate}`;
    const row = grouped.get(key) ?? { equipmentId: entry.equipmentId, workDate: entry.workDate, productiveHours: 0, downtimeHours: 0 };
    row[/простой/i.test(entry.subworkTypeName) ? "downtimeHours" : "productiveHours"] += entry.hours;
    grouped.set(key, row);
  }
  return [...grouped.values()];
}
function balancesByDate() {
  return [...new Set([...reports.values(), ...entries.values()].map(row => row.workDate))].sort().reverse().map(workDate => {
    const dated = [...reports.values()].filter(report => report.workDate === workDate);
    const count = (...statuses) => dated.filter(report => statuses.includes(report.status)).reduce((total, report) => total + report.rows.length, 0);
    const materialized = timesheetEntries().filter(row => row.workDate === workDate);
    return { workDate, reportCount: dated.length, draftRows: count("draft", "rejected"), submittedRows: count("submitted"), approvedRows: [...entries.values()].filter(row => row.workDate === workDate).length,
      productiveHours: materialized.reduce((sum, row) => sum + row.productiveHours, 0), downtimeHours: materialized.reduce((sum, row) => sum + row.downtimeHours, 0) };
  });
}
function json(response, payload, status = 200) { response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.end(JSON.stringify(payload)); }
function requestActor(request) { return actors[/(?:^|;\s*)equipment_smoke_role=([^;]+)/.exec(request.headers.cookie ?? "")?.[1]] ?? actors.foreman; }
function visibleReports(actor) { return [...reports.values()].filter(report => actor.role !== "foreman" || report.ownerUserId === actor.id); }
function availableOrderIds(actor) {
  const visible = visibleReports(actor);
  return [...visible.flatMap(report => report.rows.map(row => `${report.workDate}/report-${report.id}-${row.id}`)), ...[...entries.values()].filter(entry => !entry.orderReportId && (actor.role !== "foreman" || entry.responsibleUserId === actor.id)).map(entry => `${entry.workDate}/approved-${entry.id}`)];
}
resetFixture();
if (selfTest) {
  const savedScenario = scenario;
  scenario = "workflow"; resetFixture();
  const own = visibleReports(actors.foreman).find(report => report.workDate === TODAY);
  const before = entries.size;
  const submitted = mutateReport({ action: "submit", reportId: own.id, revision: own.revision }, actors.foreman).report;
  assert.equal(entries.size, before, "Sending for review must not publish hours");
  assert.throws(() => mutateReport({ action: "approve", reportId: own.id, revision: submitted.revision }, actors.foreman), { code: "REVIEW_FORBIDDEN" });
  assert.throws(() => mutateReport({ action: "reopen", reportId: own.id, revision: submitted.revision }, actors.engineer), { code: "REPORT_FORBIDDEN" });
  const reopened = mutateReport({ action: "reopen", reportId: own.id, revision: submitted.revision }, actors.foreman).report;
  const resubmitted = mutateReport({ action: "submit", reportId: own.id, revision: reopened.revision }, actors.foreman).report;
  const rejected = mutateReport({ action: "reject", reportId: own.id, revision: resubmitted.revision, comment: "Уточните часы" }, actors.engineer).report;
  assert.equal(rejected.status, "rejected"); assert.equal(entries.size, before);
  const again = mutateReport({ action: "submit", reportId: own.id, revision: rejected.revision }, actors.foreman).report;
  const approved = mutateReport({ action: "approve", reportId: own.id, revision: again.revision }, actors.engineer).report;
  assert.equal(entries.size, before + 2);
  const corrected = mutateReport({ action: "save", reportId: own.id, revision: approved.revision, siteId: site.id, workDate: TODAY, rows: approved.rows.map((row, index) => ({ ...row, hours: index ? row.hours : 5 })) }, actors.engineer).report;
  assert.equal(corrected.status, "approved"); assert.equal(entries.size, before + 2);
  assert.equal(timesheetEntries().find(row => row.workDate === TODAY && row.equipmentId === 1).productiveHours, 5);
  assert.throws(() => mutateReport({ action: "save", reportId: own.id, revision: corrected.revision, siteId: 1, workDate: TODAY, rows: corrected.rows }, actors.foreman2), { code: "REPORT_FORBIDDEN" });
  assert.throws(() => checkedRows([rowInput(1, 11)], true), { code: "INVALID_ROW_VALUE" });
  scenario = "conflicts"; resetFixture();
  const candidate = visibleReports(actors.foreman).find(report => report.workDate === TODAY);
  const validation = validateSubmissions({ siteId: 1, reports: [{ key: String(candidate.id), reportId: candidate.id, revision: candidate.revision, workDate: TODAY, rows: candidate.rows }] }, actors.foreman);
  assert.ok(validation.issues.some(issue => issue.code === "HOURS_CONFLICT"));
  assert.ok(validation.issues.some(issue => issue.code === "EQUIPMENT_UNAVAILABLE"));
  assert.throws(() => mutateReport({ action: "submit", reportId: candidate.id, revision: candidate.revision }, actors.foreman), { code: "EQUIPMENT_UNAVAILABLE" });
  scenario = "default"; resetFixture();
  const legacy = [...entries.values()].find(entry => !entry.orderReportId);
  const edited = mutateReport({ action: "save-approved-entry", siteId: 1, workDate: legacy.workDate, entryId: legacy.id, revision: legacy.revision, row: rowInput(3, 5) }, actors.engineer).entry;
  assert.equal(edited.revision, 2); assert.equal(edited.hours, 5);
  assert.throws(() => mutateReport({ action: "save-approved-entry", siteId: 1, workDate: legacy.workDate, entryId: legacy.id, revision: edited.revision, row: rowInput(3, 6) }, actors.foreman), { code: "REVIEW_FORBIDDEN" });
  scenario = savedScenario; resetFixture();
  console.log("Equipment smoke self-test passed: lifecycle, ownership, approved edits, hours cap, marks and publish isolation.");
  process.exit(0);
}
const config = {
  configFile: false, envDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  build: { outDir: await mkdtemp(join(tmpdir(), "equipment-report-smoke-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/equipment-report-smoke.html", import.meta.url)) } },
  plugins: [react(), { name: "isolated-equipment-report-api", configurePreviewServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/excel-preview") { request.url = `/equipment-report-smoke.html${url.search}`; return next(); }
      if (!["/api/equipment-report", "/api/equipment-timesheet", "/api/table-order", "/__smoke/catalog", "/__smoke/status", "/__smoke/reset"].includes(url.pathname)) return next();
      try {
        let body = {};
        if (request.method === "POST") { let raw = ""; for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) fail("Запрос слишком большой.", 413); } try { body = raw ? JSON.parse(raw) : {}; } catch { fail("Некорректный JSON."); } }
        if (url.pathname === "/__smoke/catalog") return json(response, { today: TODAY, site, units, shifts: directories.shiftId, zones: directories.zoneId, mainWorkTypes: directories.mainWorkTypeId, subworkTypes: directories.subworkTypeId, scenario });
        if (url.pathname === "/__smoke/reset" && request.method === "POST") { if (body.scenario !== undefined) { if (!SCENARIOS.includes(body.scenario)) fail("Неизвестный сценарий."); scenario = body.scenario; } resetFixture(); return json(response, { reset: true, scenario }); }
        if (url.pathname === "/__smoke/status") return json(response, { today: TODAY, yesterday: YESTERDAY, scenario, requestCounts, byDate: balancesByDate(), approvedEntryCount: entries.size,
          reports: [...reports.values()].map(({ id, ownerUserId, status, revision, workDate, rows }) => ({ id, ownerUserId, status, revision, workDate, rowCount: rows.length })),
          materializedHours: [...entries.values()].reduce((sum, entry) => sum + entry.hours, 0) });
        const actor = requestActor(request);
        if (url.pathname === "/api/equipment-timesheet") { if (request.method !== "GET") fail("Табель стенда доступен только для чтения.", 405); return json(response, { siteId: site.id, month: TODAY.slice(0, 7), units, entries: timesheetEntries(), marks: availabilityMarks, canEdit: false }); }
        if (url.pathname === "/api/table-order") {
          const key = String(actor.id); let ids = orders.get(key) ?? [];
          if ((body.scope ?? url.searchParams.get("scope")) !== equipmentReportOrderScope || Number(body.siteId ?? url.searchParams.get("siteId")) !== site.id) fail("Некорректный справочник порядка строк.");
          if (request.method === "POST") {
            const allowed = new Set(availableOrderIds(actor));
            if (body.action === "remap") ids = remapEquipmentReportOrder(ids, body.aliases, allowed);
            else {
              const combined = [...new Set([...ids.filter(id => allowed.has(id) || isEquipmentReportOrderId(id)), ...availableOrderIds(actor), ...(body.displayedIds ?? [])])];
              if (![...(body.movingIds ?? []), ...(body.targetId ? [body.targetId] : [])].every(id => isEquipmentReportOrderId(id) && (allowed.has(id) || !/\/(?:approved|report)-/.test(id)))) fail("Нет доступа к перемещаемым строкам.", 403);
              ids = moveEquipmentReportRows(combined, body);
            }
            orders.set(key, ids);
          }
          return json(response, { ids, canWrite: true, hasSavedOrder: orders.has(key) });
        }
        assertEquipmentReportSiteAccess(actor, Number(body.siteId ?? url.searchParams.get("siteId")) || site.id);
        if (request.method === "POST") {
          if (body.action === "validate-submissions") { requestCounts.validation++; return json(response, validateSubmissions(body, actor)); }
          if (body.action === "save") requestCounts.save++;
          if (body.action === "submit") requestCounts.submit++;
          const result = mutateReport(body, actor); requestCounts.mutations++;
          return json(response, result);
        }
        if (request.method !== "GET") fail("Метод не поддерживается.", 405);
        if (Number(url.searchParams.get("siteId")) !== site.id) fail("Проект не найден.", 404);
        const from = url.searchParams.get("from"), to = url.searchParams.get("to");
        const inRange = row => (!from || row.workDate >= from) && (!to || row.workDate <= to);
        return json(response, { reports: visibleReports(actor).filter(inRange).sort((a, b) => b.workDate.localeCompare(a.workDate)), entries: [...entries.values()].filter(inRange).filter(entry => actor.role !== "foreman" || entry.responsibleUserId === actor.id), canReview: canReviewEquipmentReport(actor), availabilityMarks, from, to });
      } catch (error) { return json(response, { error: error.message, code: error.code ?? "FIXTURE_ERROR", details: error.details }, error.status ?? 500); }
    });
  } }],
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
if (!buildOnly) (await preview(config)).printUrls();
