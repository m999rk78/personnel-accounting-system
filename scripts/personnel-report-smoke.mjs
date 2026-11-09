// Isolated browser harness. Reports and hours live only in memory; identities
// are synthetic by default or come from an explicitly supplied read-only catalog.
// No environment files, database connections or production API are used.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPersonnelReportHourIssues, inspectPersonnelReportRows, personnelReportRowChanged, validPersonnelReportDate } from "../app/personnelReportWorkflow.ts";
import { parsePersonnelReportDraftSnapshot } from "../app/personnelReportDraftBuffer.ts";
import { groupPersonnelReportDates, isPersonnelReportOrderId, isUnsavedPersonnelReportOrderId, movePersonnelReportRows, remapPersonnelReportOrder } from "../app/personnelReportRowOrder.ts";
import { reconcileRowOrder } from "../app/tableRowOrder.ts";

const TODAY = "2026-10-28";
const YESTERDAY = "2026-10-27";
const scenarios = ["default", "workflow", "conflicts", "tabs", "autosave", "preferences", "defaults"];
let catalogPath;
let portArgument;
let scenario = "default";
const cliArguments = process.argv.slice(2);
for (let index = 0; index < cliArguments.length; index++) {
  const argument = cliArguments[index];
  if (argument === "--catalog-json") {
    catalogPath = cliArguments[++index];
    if (!catalogPath || catalogPath.startsWith("--")) throw new Error("После --catalog-json укажите путь к локальному JSON-каталогу.");
  } else if (argument === "--scenario") {
    scenario = cliArguments[++index];
    if (!scenarios.includes(scenario)) throw new Error("Неизвестный сценарий стенда.");
  } else if (argument === "--port") {
    portArgument = cliArguments[++index];
    if (!portArgument) throw new Error("После --port укажите номер порта.");
  } else if (/^\d+$/.test(argument) && portArgument === undefined) {
    portArgument = argument;
  } else {
    throw new Error(`Неизвестный аргумент стенда: ${argument}`);
  }
}
const previewPort = Number(portArgument ?? process.env.PERSONNEL_SMOKE_PORT ?? 3102);
if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new Error("Порт стенда должен быть целым числом от 1 до 65535.");
// Optional catalog stays in memory and is never copied into source/build output.
const runtimeCatalog = catalogPath ? JSON.parse(await readFile(catalogPath, "utf8")) : null;
const site = runtimeCatalog?.site ?? { id: 1, name: "Учебный проект" };
const people = runtimeCatalog?.employees?.map((employee) => ({ source: "manual", siteId: site.id, siteName: site.name, ...employee })) ?? [
  { id: 1, fullName: "Иван Тестовый", employmentType: "ОПР", department: "Тестовый участок", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" },
  { id: 2, fullName: "Пётр Примеров", employmentType: "ОПР", department: "Тестовый участок", position: "Сварщик", source: "manual", siteId: 1, siteName: "Учебный проект" },
  { id: 3, fullName: "Анна Демонстрационная", employmentType: scenario === "preferences" ? "ОПР" : "ИТР", department: "Тестовый участок", position: "Мастер", source: "manual", siteId: 1, siteName: "Учебный проект" },
  ...(scenario === "autosave" ? Array.from({ length: 8 }, (_, index) => ({ id: index + 4, fullName: `Сотрудник Проверочный ${index + 4}`, employmentType: "ОПР", department: "Тестовый участок", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" })) : []),
  ...(scenario === "defaults" ? Array.from({ length: 30 }, (_, index) => ({ id: index + 4,
    fullName: index === 29 ? "Абдурахманов Магомед Магомедрасулович" : `Сотрудник ${String(index + 4).padStart(2, "0")}`,
    employmentType: "ОПР", department: index === 29 ? "Управление промышленного строительства" : "МУТТ",
    position: index === 29 ? "Ведущий специалист по монтажу технологических трубопроводов" : "Монтажник",
    source: "manual", siteId: 1, siteName: "Учебный проект" })) : []),
];
const directories = {
  shiftId: runtimeCatalog?.shifts ?? [{ id: 1, name: "Дневная" }, { id: 2, name: "Ночная" }],
  zoneId: runtimeCatalog?.zones ?? [{ id: 1, name: "Зона А" }, { id: 2, name: scenario === "defaults" ? "Монтажная зона технологических трубопроводов" : "Зона Б" }],
  mainWorkTypeId: runtimeCatalog?.mainWorkTypes ?? [{ id: 1, name: "Монтаж" }, { id: 2, name: scenario === "defaults" ? "Монтаж наружных технологических трубопроводов высокого давления" : "Подготовка" }],
  subworkTypeId: runtimeCatalog?.subworkTypes ?? [{ id: 1, name: "Установка конструкций", mainWorkTypeId: 1 }, { id: 2, name: scenario === "defaults" ? "Сборка и установка трубопроводных узлов на проектные опоры" : "Подготовка площадки", mainWorkTypeId: 2 }],
  masterId: runtimeCatalog?.masters ?? [{ id: 1, name: "Анна Демонстрационная" }, ...(scenario === "defaults" ? [{ id: 2, name: "Александр Константинович Демонстрационный" }] : [])],
};
const actors = {
  foreman: { id: 10, fullName: "Алексей Тестовый", role: "foreman" },
  foreman2: { id: 11, fullName: "Борис Другая Бригада", role: "foreman" },
  superadmin: { id: 30, fullName: "Администратор Проверки", role: "superadmin" },
  engineer: { id: 20, fullName: "Ирина Проверяющая", role: "engineer" },
};
const reports = new Map();
const entries = new Map();
const draftBuffers = new Map();
const tableOrders = new Map();
const requestCounts = { validation: 0, save: 0, submit: 0, mutations: 0 };
let nextReportId;
let nextRowId;
let nextEntryId;

class FixtureError extends Error {
  constructor(message, status = 400, code = "INVALID_REPORT") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function enrichRow(input, report, previous, rowOrder = 0) {
  const employee = people.find((person) => person.id === input.employeeId);
  const optionName = (field) => directories[field].find((option) => option.id === input[field])?.name ?? "";
  return {
    id: previous?.id ?? nextRowId++, reportId: report.id, siteId: report.siteId, workDate: report.workDate, rowOrder,
    createdAt: previous?.createdAt ?? report.updatedAt,
    updatedAt: previous && !personnelReportRowChanged(previous, input) ? previous.updatedAt : report.updatedAt,
    employeeId: input.employeeId ?? null, shiftId: input.shiftId ?? null,
    zoneId: input.zoneId ?? null, mainWorkTypeId: input.mainWorkTypeId ?? null,
    subworkTypeId: input.subworkTypeId ?? null, masterId: input.masterId ?? null,
    hours: input.hours ?? null, note: input.note?.trim() ?? "",
    employeeName: employee?.fullName ?? "", employmentType: employee?.employmentType ?? "",
    department: employee?.department ?? "", positionSnapshot: employee?.position ?? "",
    shiftName: optionName("shiftId"), zoneName: optionName("zoneId"),
    mainWorkTypeName: optionName("mainWorkTypeId"), subworkTypeName: optionName("subworkTypeId"),
    masterName: optionName("masterId"), approvedEntryId: previous?.approvedEntryId ?? null, approvedEntryRevision: previous?.approvedEntryRevision,
  };
}

function publishEntries(report) {
  for (const row of report.rows) {
    const id = row.approvedEntryId ?? nextEntryId++;
    const revision = (entries.get(id)?.revision ?? 0) + 1;
    entries.set(id, {
      ...row, id, revision, orderRowId: row.id, orderReportId: report.id,
      responsibleUserId: report.ownerUserId, responsibleUserName: report.ownerName,
    });
    row.approvedEntryId = id;
    row.approvedEntryRevision = revision;
  }
}

function resetFixture() {
  reports.clear();
  entries.clear();
  draftBuffers.clear();
  tableOrders.clear();
  for (const key of Object.keys(requestCounts)) requestCounts[key] = 0;
  nextReportId = 102;
  nextRowId = 2000;
  nextEntryId = 3000;
  if (runtimeCatalog || scenario === "autosave") return;
  const historical = {
    id: 101, siteId: site.id, workDate: YESTERDAY,
    ownerUserId: 10, ownerName: actors.foreman.fullName, status: "approved", revision: 3,
    submittedAt: `${YESTERDAY}T16:00:00.000Z`, reviewedAt: `${YESTERDAY}T17:00:00.000Z`,
    reviewedByUserId: 20, reviewedByName: actors.engineer.fullName, reviewComment: "Проверено на тестовых данных",
    createdAt: `${YESTERDAY}T15:00:00.000Z`, updatedAt: `${YESTERDAY}T17:00:00.000Z`, rows: [],
  };
  historical.rows = [1, 2].map((employeeId) => enrichRow({
    employeeId, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1,
    hours: 8, note: "Вчерашняя работа — можно скопировать в сегодняшний черновик",
  }, historical));
  publishEntries(historical);
  reports.set(historical.id, historical);
  if (["workflow", "conflicts", "tabs", "preferences", "defaults"].includes(scenario)) {
    reports.clear(); entries.clear();
    const add = (date, owner, status, members) => {
      const report = { ...historical, id: nextReportId++, workDate: date, ownerUserId: owner.id, ownerName: owner.fullName,
        status, revision: 1, rows: [], submittedAt: null, reviewedAt: null, reviewedByUserId: null, reviewedByName: null, reviewComment: "" };
      report.rows = members.map(([employeeId, hours]) => enrichRow({ employeeId, hours, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, masterId: 1, note: `${date}, бригада ${owner.fullName}` }, report));
      if (status === "approved") publishEntries(report);
      reports.set(report.id, report);
    };
    if (scenario === "defaults") {
      add(TODAY, actors.foreman, "draft", people.filter(person => person.employmentType === "ОПР").map(person => [person.id, 8]));
      const report = [...reports.values()][0], previous = report.rows.at(-1);
      report.rows[report.rows.length - 1] = enrichRow({ employeeId: previous.employeeId, hours: 8, shiftId: 1, zoneId: 2,
        mainWorkTypeId: 2, subworkTypeId: 2, masterId: 2, note: "Перемещение и подготовка строительных материалов на площадке" }, report, previous, report.rows.length - 1);
    } else if (scenario === "preferences") {
      for (const owner of [actors.foreman, actors.foreman2]) {
        add(TODAY, owner, "draft", [[1, 3], [2, 4], [3, 5]]);
        add(YESTERDAY, owner, "draft", [[2, 2], [1, 3], [3, 4]]);
        add("2026-10-26", owner, "approved", [[1, 2], [2, 3], [3, 4]]);
      }
    } else if (scenario === "tabs") {
      // Each foreman has a distinct yesterday's crew and historical personal
      // drafts, so status isolation cannot pass by accidentally matching names.
      for (const [owner, employeeId] of [[actors.foreman, 1], [actors.foreman2, 2]]) {
        add(YESTERDAY, owner, "approved", [[employeeId, 4]]);
        add("2026-10-26", owner, "submitted", [[employeeId, 3]]);
        add("2026-10-25", owner, "draft", [[employeeId, 2]]);
        add("2026-10-24", owner, "rejected", [[employeeId, 1]]);
      }
      add("2026-10-25", actors.engineer, "draft", [[3, 2]]);
    } else if (scenario === "conflicts") {
      for (const date of [TODAY, YESTERDAY]) add(date, actors.foreman, "draft", [[1, 4], [2, 3]]);
      add(TODAY, actors.foreman2, "approved", [[1, 8], [2, 9]]);
      add(YESTERDAY, actors.foreman2, "approved", [[1, 9], [2, 8]]);
    } else {
      for (const date of [TODAY, YESTERDAY, "2026-10-26"]) add(date, actors.foreman, "draft", [[1, 4], [2, 3]]);
      add(YESTERDAY, actors.foreman2, "approved", [[2, 2]]);
      add(TODAY, actors.engineer, "draft", []);
    }
  }
}

function requestActor(request) {
  const role = /(?:^|;\s*)personnel_smoke_role=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
  return actors[role] ?? actors.foreman;
}

function checkRevision(report, revision) {
  if (!Number.isInteger(revision) || revision !== report.revision) {
    throw new FixtureError("Отчёт уже изменён в другой вкладке. Обновите таблицу и повторите действие.", 409, "STALE_REPORT");
  }
}

function checkOwner(report, actor) {
  if (actor.role === "foreman" && report.ownerUserId !== actor.id) {
    throw new FixtureError("Прораб может изменять только свою часть отчёта.", 403, "REPORT_FORBIDDEN");
  }
  if (["draft", "rejected"].includes(report.status) && report.ownerUserId !== actor.id) {
    throw new FixtureError("Черновик доступен только его автору.", 403, "REPORT_FORBIDDEN");
  }
}

function checkRows(rows, complete = false) {
  if (!Array.isArray(rows) || rows.length > 1000) throw new FixtureError("Можно сохранить не более 1000 строк.");
  if (complete && !rows.length) throw new FixtureError("Добавьте хотя бы одну заполненную строку перед отправкой.");
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object") throw new FixtureError(`Строка ${index + 1}: некорректные данные.`);
    const fields = ["employeeId", ...Object.keys(directories), "hours"];
    for (const field of fields) {
      const value = row[field];
      if (value == null) {
        if (complete) throw new FixtureError(`Строка ${index + 1}: заполните сотрудника, смену, зону, работы, мастера и часы.`);
      } else if (!Number.isInteger(value) || value < 1 || (field === "hours" && value > 10)) {
        throw new FixtureError(`Строка ${index + 1}: некорректное значение ${field}.`);
      } else if (field === "employeeId" && !people.some((person) => person.id === value)) {
        throw new FixtureError(`Строка ${index + 1}: сотрудник не найден.`);
      } else if (field in directories && !directories[field].some((option) => option.id === value)) {
        throw new FixtureError(`Строка ${index + 1}: значение справочника не найдено.`);
      }
    }
    if (row.note !== undefined && (typeof row.note !== "string" || row.note.length > 4000)) throw new FixtureError(`Строка ${index + 1}: некорректное примечание.`);
  }
}

function checkHours(report, excluded = []) {
  const usedHours = new Map();
  for (const entry of entries.values()) {
    if (entry.workDate === report.workDate && !excluded.includes(entry.id)) usedHours.set(entry.employeeId, (usedHours.get(entry.employeeId) ?? 0) + entry.hours);
  }
  for (const row of report.rows) {
    const used = usedHours.get(row.employeeId) ?? 0;
    if (used + row.hours > 10) {
      throw new FixtureError(`У сотрудника «${row.employeeName}» уже учтено ${used} ч. Можно добавить не более ${Math.max(0, 10 - used)} ч.`, 409, "HOURS_CONFLICT");
    }
    usedHours.set(row.employeeId, used + row.hours);
  }
}

function validateSubmissions(body, actor) {
  if (body.siteId !== site.id || !Array.isArray(body.reports) || !body.reports.length || body.reports.length > 1000) {
    throw new FixtureError("Укажите проект и выбранные отчёты для проверки.");
  }
  const issues = [];
  for (const candidate of body.reports) {
    if (!candidate || typeof candidate.key !== "string" || !candidate.key || !validPersonnelReportDate(candidate.workDate) || !Array.isArray(candidate.rows)) {
      throw new FixtureError("Некорректные данные выбранного отчёта.");
    }
    const identity = { key: candidate.key, workDate: candidate.workDate };
    const addIssue = (issue) => issues.push({ ...identity, ...issue });
    if (candidate.reportId) {
      const report = reports.get(candidate.reportId);
      if (!report) {
        addIssue({ code: "REPORT_NOT_FOUND", message: "Отчёт больше не существует. Обновите таблицу." });
      } else {
        checkOwner(report, actor);
        if (report.workDate !== candidate.workDate || report.revision !== candidate.revision) addIssue({ code: "STALE_REPORT", message: "Отчёт уже изменён в другой вкладке. Обновите таблицу." });
        if (!["draft", "rejected"].includes(report.status)) addIssue({ code: "REPORT_LOCKED", message: "Отчёт уже отправлен на проверку или подтверждён." });
      }
    }
    const inspected = inspectPersonnelReportRows(candidate.rows, true);
    for (const issue of inspected.issues) addIssue(issue);
    for (const [index, row] of inspected.rows.entries()) {
      const employee = people.find(person => person.id === row.employeeId);
      const rowIdentity = { rowNumbers: [index + 1], ...(employee ? { employeeId: employee.id, employeeName: employee.fullName } : {}) };
      if (row.employeeId !== null && !employee) addIssue({ ...rowIdentity, code: "INVALID_REFERENCE", message: `Строка ${index + 1}: сотрудник не найден в проекте.` });
      for (const field of Object.keys(directories)) {
        if (row[field] !== null && !directories[field].some(option => option.id === row[field])) addIssue({ ...rowIdentity, code: "INVALID_REFERENCE", message: `Строка ${index + 1}: значение справочника ${field} не найдено.` });
      }
      const subwork = directories.subworkTypeId.find(option => option.id === row.subworkTypeId);
      if (subwork && subwork.mainWorkTypeId !== undefined && subwork.mainWorkTypeId !== row.mainWorkTypeId) addIssue({ ...rowIdentity, code: "INVALID_REFERENCE", message: `Строка ${index + 1}: подвид не относится к выбранному виду работ.` });
    }
    const approvedHours = new Map();
    for (const entry of entries.values()) if (entry.workDate === candidate.workDate) approvedHours.set(entry.employeeId, (approvedHours.get(entry.employeeId) ?? 0) + entry.hours);
    // Incomplete unrelated fields must not hide other employees' hour conflicts.
    const countable = inspected.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.employeeId !== null && row.hours !== null);
    const employeeNames = new Map(people.map(person => [person.id, person.fullName]));
    for (const issue of collectPersonnelReportHourIssues(countable.map(({ row }) => row), approvedHours, employeeNames)) {
      addIssue({ ...issue, rowNumbers: issue.rowNumbers?.map(number => countable[number - 1].index + 1) });
    }
  }
  return { issues };
}

function mutateReport(body, actor) {
  const now = new Date().toISOString();
  if (["change-date", "change-entry-date"].includes(body.action)) {
    if (!["foreman", "engineer", "superadmin"].includes(actor.role)) throw new FixtureError("Нет права изменять отчёты.", 403, "REPORT_FORBIDDEN");
    if (!validPersonnelReportDate(body.workDate) || body.workDate.startsWith("0000-")) throw new FixtureError("Укажите корректную дату отчёта.");
    if (body.action === "change-entry-date") {
      if (!["engineer", "superadmin"].includes(actor.role)) throw new FixtureError("Изменить дату подтверждённой записи может инженер.", 403, "REPORT_FORBIDDEN");
      const previous = entries.get(body.entryId);
      if (!previous || body.siteId !== site.id || previous.siteId !== body.siteId) throw new FixtureError("Подтверждённая запись не найдена.", 404, "ENTRY_NOT_FOUND");
      if (previous.orderReportId) throw new FixtureError("Измените дату отчёта целиком.", 409, "STALE_REPORT");
      checkRevision(previous, body.revision);
      if (previous.workDate === body.workDate) return previous;
      checkHours({ workDate: body.workDate, rows: [previous] }, [previous.id]);
      const entry = { ...previous, workDate: body.workDate, updatedAt: now, revision: previous.revision + 1 };
      entries.set(entry.id, entry);
      return entry;
    }
    const current = reports.get(body.reportId);
    if (!current || current.siteId !== site.id) throw new FixtureError("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
    checkOwner(current, actor);
    checkRevision(current, body.revision);
    if (actor.role === "foreman" && !["draft", "rejected"].includes(current.status)) throw new FixtureError("Этот отчёт может исправить инженер.", 409, "REPORT_LOCKED");
    if (current.workDate === body.workDate) return current;
    if (current.status !== "approved" && [...reports.values()].some(item => item.id !== current.id && item.siteId === current.siteId && item.ownerUserId === current.ownerUserId && item.status !== "approved" && item.workDate === body.workDate)) throw new FixtureError("На выбранную дату уже есть отчёт этого прораба.", 409, "REPORT_EXISTS");
    const linked = current.rows.map(row => row.approvedEntryId ? entries.get(row.approvedEntryId) : undefined);
    if (current.status === "approved" && linked.some(entry => !entry || entry.workDate !== current.workDate || entry.siteId !== current.siteId)) throw new FixtureError("Подтверждённые строки уже изменены.", 409, "STALE_REPORT");
    if (["submitted", "approved"].includes(current.status)) checkHours({ ...current, workDate: body.workDate }, linked.filter(Boolean).map(entry => entry.id));
    const report = { ...structuredClone(current), workDate: body.workDate, updatedAt: now, revision: current.revision + 1 };
    report.rows = report.rows.map((row, index) => ({ ...row, workDate: body.workDate, updatedAt: now, ...(linked[index] ? { approvedEntryRevision: linked[index].revision + 1 } : {}) }));
    if (report.status === "approved") for (const entry of linked) entries.set(entry.id, { ...entry, workDate: body.workDate, updatedAt: now, revision: entry.revision + 1 });
    reports.set(report.id, report);
    return report;
  }
  if (body.action === "save") {
    if (body.siteId !== site.id || !/^\d{4}-\d{2}-\d{2}$/.test(body.workDate ?? "")) throw new FixtureError("Некорректный проект или дата.");
    checkRows(body.rows);
    let report = body.reportId ? reports.get(body.reportId) : [...reports.values()].find((candidate) => candidate.ownerUserId === actor.id && candidate.workDate === body.workDate);
    if (body.reportId && !report) throw new FixtureError("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
    if (report) {
      report = structuredClone(report);
      checkOwner(report, actor);
      checkRevision(report, body.revision);
      if (actor.role === "foreman" && !["draft", "rejected"].includes(report.status)) throw new FixtureError("Отчёт уже отправлен на проверку или утверждён. Редактирование закрыто.", 409, "REPORT_LOCKED");
      if (["submitted", "approved"].includes(report.status)) {
        checkRows(body.rows, true);
        if (report.status === "approved") for (const row of body.rows) if (row.id) {
          const previous = report.rows.find(previous => previous.id === row.id);
          if (previous && row.approvedEntryRevision !== previous.approvedEntryRevision) throw new FixtureError("Запись изменена в другой вкладке.", 409, "STALE_REPORT");
        }
        checkHours({ ...report, rows: body.rows }, report.status === "approved" ? report.rows.map(row => row.approvedEntryId) : []);
      }
      report.revision++;
      report.updatedAt = now;
    } else {
      report = {
        id: nextReportId++, siteId: site.id, workDate: body.workDate,
        ownerUserId: actor.id, ownerName: actor.fullName, status: "draft", revision: 1,
        submittedAt: null, reviewedAt: null, reviewedByUserId: null, reviewedByName: null,
        reviewComment: "", createdAt: now, updatedAt: now, rows: [],
      };
    }
    const previousEntryIds = report.rows.map(row => row.approvedEntryId).filter(Boolean);
    report.rows = body.rows.map((row, index) => enrichRow(row, report, report.rows.find(previous => previous.id === row.id), index));
    if (report.status === "approved") {
      for (const id of previousEntryIds) if (!report.rows.some(row => row.approvedEntryId === id)) entries.delete(id);
      publishEntries(report);
    }
    reports.set(report.id, report);
    return report;
  }
  const report = reports.get(body.reportId);
  if (!report) throw new FixtureError("Отчёт не найден.", 404, "REPORT_NOT_FOUND");
  checkOwner(report, actor);
  checkRevision(report, body.revision);
  if (["approve", "reject"].includes(body.action) && !["engineer", "superadmin"].includes(actor.role)) throw new FixtureError("Подтвердить или вернуть отчёт может только инженер.", 403, "REVIEW_FORBIDDEN");
  if (body.action === "submit" && ["draft", "rejected"].includes(report.status)) {
    checkRows(report.rows, true);
    checkHours(report);
    report.status = "submitted";
    report.submittedAt = now;
    report.reviewedAt = null;
    report.reviewedByUserId = null;
    report.reviewedByName = null;
    report.reviewComment = "";
  } else if (body.action === "approve" && report.status === "submitted") {
    checkRows(report.rows, true);
    checkHours(report);
    publishEntries(report);
    report.status = "approved";
    report.reviewedAt = now;
    report.reviewedByUserId = actor.id;
    report.reviewedByName = actor.fullName;
    report.reviewComment = body.comment?.trim() ?? "";
  } else if (body.action === "reject" && report.status === "submitted") {
    if (!body.comment?.trim()) throw new FixtureError("Укажите причину возврата отчёта.");
    report.status = "rejected";
    report.reviewedAt = now;
    report.reviewedByUserId = actor.id;
    report.reviewedByName = actor.fullName;
    report.reviewComment = body.comment.trim();
  } else if (body.action === "reopen" && report.status === "submitted") {
    report.status = "draft";
  } else {
    throw new FixtureError("Состояние отчёта уже изменилось. Обновите таблицу.", 409, "INVALID_TRANSITION");
  }
  report.revision++;
  report.updatedAt = now;
  return report;
}

function timesheetEntries() {
  const grouped = new Map();
  for (const row of entries.values()) {
    const key = `${row.employeeId}:${row.workDate}`;
    const existing = grouped.get(key) ?? { employeeId: row.employeeId, workDate: row.workDate, hours: 0, masters: [], zones: [] };
    existing.hours += row.hours;
    if (!existing.masters.includes(row.masterName)) existing.masters.push(row.masterName);
    if (!existing.zones.includes(row.zoneName)) existing.zones.push(row.zoneName);
    grouped.set(key, existing);
  }
  return [...grouped.values()].map((row) => ({ ...row, masters: row.masters.join(", "), zones: row.zones.join(", ") }));
}

function balancesByDate() {
  const dates = new Set([...reports.values(), ...entries.values()].map((row) => row.workDate));
  return [...dates].sort().reverse().map((workDate) => {
    const datedReports = [...reports.values()].filter((report) => report.workDate === workDate);
    const countRows = (...statuses) => datedReports.filter((report) => statuses.includes(report.status)).reduce((total, report) => total + report.rows.length, 0);
    const approved = [...entries.values()].filter((entry) => entry.workDate === workDate);
    return {
      workDate, reportCount: datedReports.length,
      draftRows: countRows("draft", "rejected"), submittedRows: countRows("submitted"),
      approvedRows: approved.length, approvedHours: approved.reduce((total, entry) => total + entry.hours, 0),
    };
  });
}

function json(response, payload, status = 200) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function visibleOrderIds(actor, siteId) {
  const ids = [
    ...[...reports.values()].filter(report => report.siteId === siteId && report.status !== "approved" &&
      (["draft", "rejected"].includes(report.status) ? report.ownerUserId === actor.id : actor.role !== "foreman" || report.ownerUserId === actor.id))
      .flatMap(report => report.rows.map(row => `${report.workDate}/report-${report.id}-${row.id}`)),
    ...[...entries.values()].filter(entry => entry.siteId === siteId && (actor.role !== "foreman" || entry.responsibleUserId === actor.id))
      .map(entry => `${entry.workDate}/${entry.orderRowId ? `report-${entry.orderReportId}-${entry.orderRowId}` : `approved-${entry.id}`}`),
  ];
  groupPersonnelReportDates(ids, id => id.slice(0, 10));
  return ids;
}

resetFixture();
const config = {
  configFile: false,
  envDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  build: {
    outDir: await mkdtemp(join(tmpdir(), "personnel-report-smoke-")),
    emptyOutDir: false,
    rolldownOptions: { input: [fileURLToPath(new URL("../tests/fixtures/personnel-report-smoke.html", import.meta.url)), fileURLToPath(new URL("../tests/fixtures/work-types.html", import.meta.url)), fileURLToPath(new URL("../tests/fixtures/choice-menus.html", import.meta.url))] },
  },
  plugins: [react(), {
    name: "isolated-personnel-report-api",
    configurePreviewServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/excel-preview") {
          request.url = `/personnel-report-smoke.html${url.search}`;
          return next();
        }
        if (!["/api/personnel-report", "/api/personnel-report-draft", "/api/table-order", "/api/timesheet", "/__smoke/catalog", "/__smoke/status", "/__smoke/reset"].includes(url.pathname)) return next();
        try {
          if (url.pathname === "/__smoke/catalog") {
            return json(response, {
              site, employees: people, shifts: directories.shiftId, zones: directories.zoneId,
              mainWorkTypes: directories.mainWorkTypeId, subworkTypes: directories.subworkTypeId, masters: directories.masterId,
              scenario, runtimeCatalog: Boolean(runtimeCatalog),
            });
          }
          if (url.pathname === "/__smoke/reset" && request.method === "POST") {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const body = raw ? JSON.parse(raw) : {};
            if (body.scenario !== undefined) {
              if (!scenarios.includes(body.scenario) || runtimeCatalog) throw new FixtureError("Сценарий не поддерживается в этом режиме стенда.");
              scenario = body.scenario;
            }
            resetFixture();
            return json(response, { reset: true, scenario });
          }
          if (url.pathname === "/__smoke/status") {
            return json(response, {
              today: TODAY, yesterday: YESTERDAY,
              reports: [...reports.values()].map(({ id, status, revision, workDate, ownerUserId, rows }) => ({ id, status, revision, workDate, ownerUserId, rowCount: rows.length })),
              todayHours: timesheetEntries().filter((entry) => entry.workDate === TODAY).reduce((total, entry) => total + entry.hours, 0),
              yesterdayHours: timesheetEntries().filter((entry) => entry.workDate === YESTERDAY).reduce((total, entry) => total + entry.hours, 0),
              approvedEntryCount: entries.size,
              byDate: balancesByDate(),
              scenario, requestCounts,
            });
          }
          if (url.pathname === "/api/timesheet") {
            if (request.method !== "GET") throw new FixtureError("Табель в этом сценарии доступен только для чтения.", 405);
            const month = url.searchParams.get("month") ?? TODAY.slice(0, 7);
            return json(response, {
              siteId: site.id, siteName: site.name, month,
              canEdit: false, canCreate: false, canUpdate: false, canDelete: false,
              employees: people, entries: timesheetEntries().filter((entry) => entry.workDate.startsWith(month)), marks: [],
            });
          }
          const actor = requestActor(request);
          if (url.pathname === "/api/table-order") {
            let body;
            if (request.method === "POST") {
              let raw = ""; for await (const chunk of request) raw += chunk;
              body = JSON.parse(raw);
            } else if (request.method !== "GET") throw new FixtureError("Метод не поддерживается.", 405);
            const scope = body?.scope ?? url.searchParams.get("scope");
            const siteId = Number(body?.siteId ?? url.searchParams.get("siteId"));
            if (scope !== "personnel-report-rows" || !Number.isSafeInteger(siteId) || siteId < 1) throw new FixtureError("Некорректный порядок строк.");
            const key = `${actor.id}:${siteId}`, saved = tableOrders.get(key);
            const canonical = visibleOrderIds(actor, siteId);
            let ids = reconcileRowOrder([...canonical, ...(saved ?? []).filter(isUnsavedPersonnelReportOrderId)], saved ?? []);
            if (body) {
              if (body.action === "remap") ids = remapPersonnelReportOrder(saved ?? [], body.aliases, new Set(canonical));
              else {
                const displayed = body.displayedIds ?? [];
                if (![...(body.movingIds ?? []), ...displayed, ...(body.targetId ? [body.targetId] : [])].every(isPersonnelReportOrderId)) throw new FixtureError("Некорректная строка переноса.");
                ids = reconcileRowOrder([...canonical, ...ids.filter(isUnsavedPersonnelReportOrderId), ...displayed.filter(isUnsavedPersonnelReportOrderId), ...body.movingIds.filter(isUnsavedPersonnelReportOrderId)], ids);
                ids = movePersonnelReportRows(ids, body);
              }
              tableOrders.set(key, ids);
            }
            groupPersonnelReportDates(ids, id => id.slice(0, 10));
            return json(response, { ids, canWrite: true, hasSavedOrder: tableOrders.has(key), importIds: [], hasImportOrder: false });
          }
          if (url.pathname === "/api/personnel-report-draft") {
            if (request.method === "GET") {
              const siteId = Number(url.searchParams.get("siteId"));
              if (!Number.isSafeInteger(siteId) || siteId < 1) throw new FixtureError("Укажите проект.");
              return json(response, draftBuffers.get(`${actor.id}:${siteId}`) ?? { revision: 0, snapshot: null });
            }
            if (request.method !== "PUT") throw new FixtureError("Метод не поддерживается.", 405);
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const body = JSON.parse(raw);
            if (!Number.isSafeInteger(body.siteId) || body.siteId < 1 || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new FixtureError("Некорректная версия черновика.");
            const snapshot = parsePersonnelReportDraftSnapshot(body.snapshot, actor.id, body.siteId);
            const key = `${actor.id}:${body.siteId}`;
            const current = draftBuffers.get(key) ?? { revision: 0, snapshot: null };
            if (body.revision !== current.revision) return json(response, { error: "Черновик уже изменён в другой вкладке.", code: "DRAFT_BUFFER_CONFLICT", details: current }, 409);
            const nextBuffer = { revision: current.revision + 1, snapshot };
            draftBuffers.set(key, nextBuffer);
            return json(response, nextBuffer);
          }
          if (request.method === "POST") {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            let body;
            try { body = JSON.parse(raw); } catch { throw new FixtureError("Некорректный JSON."); }
            if (body.action === "validate-submissions") {
              requestCounts.validation++;
              return json(response, validateSubmissions(body, actor));
            }
            if (body.action === "save") requestCounts.save++;
            if (body.action === "submit") requestCounts.submit++;
            const report = mutateReport(body, actor);
            requestCounts.mutations++;
            return json(response, body.action === "change-entry-date" ? { entry: report } : { report });
          }
          if (request.method !== "GET") throw new FixtureError("Метод не поддерживается.", 405);
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          const reportSiteId = Number(url.searchParams.get("siteId") ?? site.id);
          const inRange = (row) => row.siteId === reportSiteId && (!from || row.workDate >= from) && (!to || row.workDate <= to);
          return json(response, {
            reports: [...reports.values()].filter(inRange).filter((report) =>
              ["draft", "rejected"].includes(report.status) ? report.ownerUserId === actor.id : actor.role !== "foreman" || report.ownerUserId === actor.id
            ).sort((a, b) => b.workDate.localeCompare(a.workDate)),
            entries: [...entries.values()].filter(inRange).filter((entry) => actor.role !== "foreman" || entry.responsibleUserId === actor.id).sort((a, b) => b.workDate.localeCompare(a.workDate)),
            canReview: ["engineer", "superadmin"].includes(actor.role), from, to,
          });
        } catch (error) {
          return json(response, { error: error.message, code: error.code ?? "FIXTURE_ERROR" }, error.status ?? 500);
        }
      });
    },
  }],
  preview: { host: "127.0.0.1", port: previewPort, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
