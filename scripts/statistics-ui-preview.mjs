// Manual browser QA only: real application, synthetic read-only HTTP responses.
// No browser automation, environment files, database or outgoing service calls.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.argv.find((value, index) => index > 1 && !value.startsWith("--")) ?? 3193);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
const sites = [{ id: 1, name: "Учебный проект статистики", code: "STAT-TEST", timezone: "Europe/Moscow" }];
const zones = [
  { id: 11, name: "73281024/4152-330-ТКМ5 — монтаж технологических трубопроводов северного производственного комплекса" },
  { id: 12, name: "29-36-RD-700/3-ONHP-PI-TK1 — строительная площадка южного участка и вспомогательные сооружения" },
  { id: 13, name: "0012345678901234567890" },
];
const shifts = [{ id: 1, name: "день" }];
const mainWorkTypes = [{ id: 1, name: "Учебные работы" }];
const subworkTypes = [{ id: 1, name: "Монтаж", mainWorkTypeId: 1 }, { id: 2, name: "Простой техники", mainWorkTypeId: 1 }];
const masters = [{ id: 1, name: "Учебный ответственный", employeeId: 1 }];
const peopleGroups = ["welders", "installers", "other"];
const positions = ["Сварщик", "Монтажник", "Подсобный рабочий"];
const employees = zones.flatMap((zone, zoneIndex) => positions.map((position, index) => ({
  id: zoneIndex * 3 + index + 1, fullName: `Учебный сотрудник ${zoneIndex + 1}.${index + 1}`,
  employmentType: "ОПР", department: "Учебный отдел", position, source: "manual",
  siteId: 1, siteName: sites[0].name, availabilityStatus: "active", bitrix24Stage: "", syncError: null,
})));
const units = zones.map((zone, index) => ({ id: index + 1, name: `Учебная машина ${index + 1}`,
  equipmentType: "Учебная техника", model: `ТЕСТ-${index + 1}`, registrationNumber: `TEST-${index + 1}`,
  inventoryNumber: `STAT-${index + 1}`, organization: "Учебная организация", siteId: 1,
  siteName: sites[0].name, availabilityStatus: "active", unavailableFrom: null }));
const personnelRecords = dates.flatMap((workDate, day) => zones.flatMap((zone, area) => peopleGroups.map((group, index) => ({
  workDate, zoneId: zone.id, group, employeeId: area * 3 + index + 1,
  hours: index === 0 ? [2, 3.5, 4, 5][day] + area : index === 1 ? [5, 6, 7.25, 8][day] + area : (day + area) * .5,
}))));
const equipmentRecords = dates.flatMap((workDate, day) => zones.flatMap((zone, area) => [
  { workDate, zoneId: zone.id, group: "productive", equipmentId: area + 1, hours: [6, 7.5, 8, 9][day] + area },
  { workDate, zoneId: zone.id, group: "downtime", equipmentId: area + 1, hours: [2, 1.5, 1, .5][day] },
]));
const inRange = (record, query) => query.get("period") === "all"
  || (!query.has("from") || record.workDate >= query.get("from")) && (!query.has("to") || record.workDate <= query.get("to"));
function statisticsRows(query) {
  const personnel = query.get("kind") === "personnel", byDay = query.get("groupBy") === "day";
  const records = (personnel ? personnelRecords : equipmentRecords).filter(record => inRange(record, query));
  const rows = new Map(), counts = new Map();
  for (const record of records) {
    const key = byDay ? record.workDate : record.zoneId;
    if (!rows.has(key)) rows.set(key, { ...(byDay ? { workDate: key } : { zoneId: key, zone: zones.find(zone => zone.id === key).name }),
      welders: 0, installers: 0, other: 0, productive: 0, downtime: 0, total: 0 });
    const row = rows.get(key);
    row[record.group] += record.hours; row.total += record.hours;
    if (personnel) {
      if (!counts.has(key)) counts.set(key, { total: new Set(), welders: new Set(), installers: new Set(), other: new Set() });
      const people = counts.get(key);
      people.total.add(record.employeeId); people[record.group].add(record.employeeId);
      row.personnelCounts = Object.fromEntries(Object.entries(people).map(([group, ids]) => [group, ids.size]));
    }
  }
  return [...rows.values()].sort(byDay ? (a, b) => a.workDate.localeCompare(b.workDate) : (a, b) => b.total - a.total);
}
function approvedEntry(record, index, personnel) {
  const zone = zones.find(zone => zone.id === record.zoneId);
  const common = { id: index + 1, siteId: 1, workDate: record.workDate, zoneId: zone.id, zoneName: zone.name,
    shiftId: 1, shiftName: "день", mainWorkTypeId: 1, mainWorkTypeName: mainWorkTypes[0].name,
    subworkTypeId: record.group === "downtime" ? 2 : 1, subworkTypeName: record.group === "downtime" ? subworkTypes[1].name : "Монтаж",
    hours: record.hours, note: "Синтетическая запись для проверки статистики", revision: 1,
    responsibleUserId: 1, responsibleUserName: "Учебный ответственный",
    createdAt: `${record.workDate}T10:00:00Z`, updatedAt: `${record.workDate}T10:00:00Z`, rowOrder: index };
  if (personnel) {
    const employee = employees.find(employee => employee.id === record.employeeId);
    return { ...common, employeeId: employee.id, employeeName: employee.fullName, employmentType: employee.employmentType,
      department: employee.department, positionSnapshot: employee.position, masterId: 1, masterName: masters[0].name };
  }
  const unit = units.find(unit => unit.id === record.equipmentId);
  return { ...common, equipmentId: unit.id, equipmentName: unit.name, equipmentType: unit.equipmentType,
    organization: unit.organization, brand: "Учебная марка", model: unit.model, registrationNumber: unit.registrationNumber };
}
const data = { sites, employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
  positionCatalog: employees.map(employee => ({ id: employee.id, employmentType: employee.employmentType, department: employee.department, position: employee.position })),
  employmentTypes: [{ id: 1, name: "ОПР" }], departments: [{ id: 1, name: "Учебный отдел" }],
  positions: positions.map((name, index) => ({ id: index + 1, name })), shifts, zones, mainWorkTypes, subworkTypes, masters,
  users: [{ id: 1, fullName: "Учебный ответственный", email: "statistics@example.invalid", role: "superadmin",
    assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" }],
  entries: [], filledDates: dates, employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false,
  projectStats: [{ siteId: 1, employeeCount: employees.length, foremanCount: 1 }],
  bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } } };

if (process.argv.includes("--check")) {
  for (const kind of ["personnel", "equipment"]) {
    const query = new URLSearchParams({ kind, from: dates[0], to: dates.at(-1) });
    const zones = statisticsRows(query); query.set("groupBy", "day"); const days = statisticsRows(query);
    assert.equal(zones.length, 3); assert.equal(days.length, 4);
    assert.equal(zones.reduce((sum, row) => sum + row.total, 0), days.reduce((sum, row) => sum + row.total, 0));
    if (kind === "personnel") assert.equal(days[0].personnelCounts.total, employees.length);
    query.set("from", "2026-12-01"); query.set("to", "2026-12-31"); assert.deepEqual(statisticsRows(query), []);
  }
  console.log("PASS: synthetic zones, dates, totals, headcounts and empty periods.");
} else {
  const respond = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const fixtureApi = { name: "synthetic-statistics-preview", configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") return respond(response, 405, { error: "Стенд доступен только для чтения. Изменения заблокированы." });
        if (url.pathname === "/api/data") return respond(response, 200, data);
        if (url.pathname === "/api/table-order") return respond(response, 200, { ids: [], canWrite: false, hasSavedOrder: false });
        if (url.pathname === "/api/equipment") return respond(response, 200, {
          siteId: 1, siteName: sites[0].name, units, availableUnits: units, sites, shifts, zones, mainWorkTypes, subworkTypes,
          entries: [], marks: [], dailyTimesheetMarks: [], filledDates: dates, foremanProgress: [], reportSubmitted: false,
          currentUserRole: "superadmin", currentUserName: "Учебный ответственный",
          canEditDaily: false, canCreateDaily: false, canUpdateDaily: false, canDeleteDaily: false,
          canEditTimesheet: false, canCreateTimesheet: false, canUpdateTimesheet: false, canDeleteTimesheet: false,
          canManageRegistry: false, canCreateRegistry: false, canUpdateRegistry: false, canDeleteRegistry: false,
          canManageAssignments: false, canCreateAssignments: false, canUpdateAssignments: false, canDeleteAssignments: false,
        });
        if (url.pathname === "/api/statistics") {
          if (url.searchParams.get("siteId") !== "1" || !["personnel", "equipment"].includes(url.searchParams.get("kind"))
            || url.searchParams.has("groupBy") && !["zone", "day"].includes(url.searchParams.get("groupBy"))) return respond(response, 400, { error: "Некорректный запрос учебной статистики." });
          return respond(response, 200, { rows: statisticsRows(url.searchParams) });
        }
        if (["/api/personnel-report", "/api/equipment-report"].includes(url.pathname)) {
          const personnel = url.pathname === "/api/personnel-report";
          const entries = (personnel ? personnelRecords : equipmentRecords).map((record, index) => approvedEntry(record, index, personnel));
          return respond(response, 200, { reports: [], entries, canReview: false, availabilityMarks: [], from: null, to: null });
        }
        return respond(response, 404, { error: "API отсутствует на изолированном учебном стенде." });
      }
      if (["/", "/statistics/workers", "/statistics/equipment", "/reports/workers", "/reports/equipment"].includes(url.pathname)) {
        response.writeHead(302, { Location: `/workspace-header.html?route=${encodeURIComponent(url.pathname === "/" ? "/statistics/workers" : `${url.pathname}${url.search}`)}` });
        response.end(); return;
      }
      next();
    });
  } };
  const fixtures = new URL("../tests/fixtures/", import.meta.url);
  const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(fixtures), plugins: [react(), fixtureApi],
    build: { outDir: await mkdtemp(join(tmpdir(), "statistics-ui-preview-")), emptyOutDir: false,
      rolldownOptions: { input: fileURLToPath(new URL("workspace-header.html", fixtures)) } },
    preview: { host: "127.0.0.1", port, strictPort: true } };
  await build(config);
  const server = await preview(config);
  server.printUrls();
  console.log(`Statistics QA: http://127.0.0.1:${port}/workspace-header.html?route=%2Fstatistics%2Fworkers`);
}
