// Isolated CUA QA: actual PersonnelApp, synthetic catalogs held only in memory.
// Start: node --experimental-strip-types scripts/catalog-spreadsheet-smoke.mjs
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveRowBlock, reconcileRowOrder } from "../app/tableRowOrder.ts";

const sites = [
  { id: 1, name: "Учебный проект А", code: "TEST-A", timezone: "Europe/Moscow" },
  { id: 2, name: "Учебный проект Б", code: "TEST-B", timezone: "Europe/Moscow" },
];
const modes = new Set(["full", "readonly", "createonly", "restricted"]);
const routes = [
  ["Должности", "/settings/general/positions"], ["Зоны", "/settings/project/zones"],
  ["Мастера", "/settings/project/masters"], ["Сотрудники проекта", "/settings/project/employees"],
  ["Реестр техники", "/settings/general/equipment"], ["Техника проекта", "/settings/project/equipment"],
  ["Виды и подвиды", "/settings/project/work-types"],
];
const normalize = value => String(value ?? "").trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const seed = () => ({
  positions: [
    { id: 1, employmentType: "ОПР", department: "МУТТ", position: "Монтажник" },
    { id: 2, employmentType: "ОПР", department: "МУСК", position: "Сварщик" },
    { id: 3, employmentType: "ИТР", department: "ПТО", position: "Инженер" },
    { id: 4, employmentType: "ВСП", department: "МТО", position: "Механик" },
  ],
  employees: Array.from({ length: 18 }, (_, index) => ({
    id: index + 1, fullName: `Тестовый сотрудник ${String(index + 1).padStart(2, "0")}`,
    employmentType: ["ОПР", "ОПР", "ИТР", "ВСП"][index % 4],
    department: ["МУТТ", "МУСК", "ПТО", "МТО"][index % 4],
    position: ["Монтажник", "Сварщик", "Инженер", "Механик"][index % 4],
    siteId: index < 8 ? 1 : index < 12 ? 2 : null,
  })),
  zones: [1, 2].flatMap(siteId => Array.from({ length: 8 }, (_, index) => ({ id: siteId * 100 + index + 1, siteId, name: `Учебная зона ${siteId}-${index + 1}` }))),
  masters: [{ id: 301, siteId: 1, employeeId: 1, name: "Тестовый сотрудник 01" }, { id: 302, siteId: 1, employeeId: 2, name: "Тестовый сотрудник 02" }, { id: 303, siteId: 2, employeeId: 9, name: "Тестовый сотрудник 09" }],
  parents: [1, 2].flatMap(siteId => ["Подготовительные работы", "Монтаж", "Земляные работы", "Пустой вид"].map((name, index) => ({ id: siteId * 100 + index + 1, siteId, name: `${name} ${siteId}` }))),
  children: [1, 2].flatMap(siteId => Array.from({ length: 12 }, (_, index) => ({ id: siteId * 100 + index + 1, siteId, name: `Учебный подвид ${siteId}-${index + 1}`, mainWorkTypeId: index === 11 ? null : siteId * 100 + index % 3 + 1 }))),
  units: Array.from({ length: 14 }, (_, index) => ({
    id: index + 1, organization: "Учебная организация", equipmentType: ["Экскаватор", "Автокран", "Погрузчик"][index % 3],
    brand: "Тест", model: `Модель ${String(index + 1).padStart(2, "0")}`, registrationNumber: `ТЕСТ-${String(index + 1).padStart(3, "0")}`, note: "Синтетические данные",
    assignedSiteId: index < 6 ? 1 : index < 9 ? 2 : null,
  })),
});
let state = seed();
let nextId = 1000;
let failureSaves = 0;
let saveDelayMs = 0;
const orders = new Map();
const mutations = [];
const attempts = [];
const requests = new Map();
const remember = (list, value) => { list.push(value); if (list.length > 40) list.shift(); };
const visibleSites = mode => mode === "restricted" ? sites.slice(0, 1) : sites;
const may = (mode, resource, action) => {
  if (mode === "full" || action === "view") return true;
  if (mode === "readonly") return false;
  if (mode === "createonly") return action === "create";
  return !["positions", "projects", "system_users", "access_rights"].includes(resource);
};
const assert = (condition, message, status = 400) => { if (!condition) { const error = new Error(message); error.status = status; throw error; } };
const assertProject = (mode, siteId) => assert(visibleSites(mode).some(site => site.id === Number(siteId)), "Проект недоступен.", 403);
const assertMay = (mode, resource, action) => assert(may(mode, resource, action), "Недостаточно прав для этого действия.", 403);
const send = (response, payload, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
};
const bodyOf = async request => {
  let raw = "";
  for await (const chunk of request) { raw += chunk; assert(raw.length < 1_000_000, "Fixture request is too large."); }
  return raw ? JSON.parse(raw) : {};
};
const beginSave = async (mode, action, body) => {
  const count = Array.isArray(body.directories) ? body.directories.length : Array.isArray(body.parents) && Array.isArray(body.children) ? body.parents.length + body.children.length : 1;
  remember(attempts, { mode, action, count });
  if (saveDelayMs) await new Promise(resolve => setTimeout(resolve, saveDelayMs));
  if (failureSaves > 0) { failureSaves--; assert(false, "Проверочная ошибка сохранения. Черновики должны остаться в таблице.", 503); }
};
const optionNames = key => [...new Set(state.positions.map(row => row[key]))].map((name, index) => ({ id: index + 1, name }));
const employeeDto = row => ({ ...row, sortOrder: row.id, source: "manual", bitrix24Stage: "", availabilityStatus: "active", syncError: null, siteName: sites.find(site => site.id === row.siteId)?.name ?? null });
const unitDto = row => ({ ...row, assignedSiteName: sites.find(site => site.id === row.assignedSiteId)?.name ?? null });
const atSite = (collection, siteId) => state[collection].filter(row => row.siteId === siteId);
const dataSet = (mode, siteId, section) => {
  const employees = state.employees.filter(row => mode !== "restricted" || row.siteId === 1 || section === "projectEmployees" && row.siteId === null).map(employeeDto);
  const project = employees.filter(row => row.siteId === siteId);
  return {
    sites: visibleSites(mode), employees, reportEmployees: project, placementEmployees: project, projectEmployees: project,
    positionCatalog: state.positions, employmentTypes: optionNames("employmentType"), departments: optionNames("department"), positions: optionNames("position"),
    zones: atSite("zones", siteId), masters: atSite("masters", siteId), mainWorkTypes: atSite("parents", siteId), subworkTypes: atSite("children", siteId),
    users: [], shifts: [{ id: 1, name: "День" }, { id: 2, name: "Ночь" }], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, syncStatus: null,
    bitrix24Cooldowns: { inspect: { nextAllowedAt: null, remainingSeconds: 0 }, sync: { nextAllowedAt: null, remainingSeconds: 0 } },
  };
};
const canonicalIds = (mode, scope, siteId) => {
  if (scope === "positions") return state.positions.map(row => row.id);
  if (scope === "employees") return state.employees.filter(row => mode !== "restricted" || row.siteId === 1).map(row => row.id);
  if (scope === "project-personnel") return state.employees.filter(row => row.siteId === siteId).map(row => row.id);
  if (scope === "equipment") return state.units.filter(row => mode !== "restricted" || row.assignedSiteId === 1).map(row => row.id);
  if (scope === "project-equipment") return state.units.filter(row => row.assignedSiteId === siteId).map(row => row.id);
  if (scope === "directory-zone" || scope === "directory-master") return atSite(scope === "directory-zone" ? "zones" : "masters", siteId).map(row => row.id);
  if (scope === "directory-work-types") return [...atSite("parents", siteId).map(row => `parent-${row.id}`), ...atSite("children", siteId).map(row => `child-${row.id}`)];
  assert(false, "Unknown synthetic table-order scope.");
};
const scopeResource = scope => ({ positions: "positions", employees: "employees", "project-personnel": "project_employees", equipment: "equipment_registry", "project-equipment": "project_equipment" })[scope] ?? "project_directories";
const equipmentData = (mode, url) => {
  const siteId = Number(url.searchParams.get("siteId") ?? 1);
  assertProject(mode, siteId);
  const global = url.searchParams.get("scope") === "global";
  const units = state.units.filter(row => global ? mode !== "restricted" || row.assignedSiteId === 1 : row.assignedSiteId === siteId).map(unitDto);
  const can = (resource, action) => may(mode, resource, action);
  return {
    siteId, siteName: sites.find(site => site.id === siteId).name, workDate: url.searchParams.get("date") ?? "2026-11-09", month: url.searchParams.get("month") ?? "2026-11",
    canManageRegistry: can("equipment_registry", "create") || can("equipment_registry", "update") || can("equipment_registry", "delete"),
    canCreateRegistry: can("equipment_registry", "create"), canUpdateRegistry: can("equipment_registry", "update"), canDeleteRegistry: can("equipment_registry", "delete"),
    canManageAssignments: can("project_equipment", "create") || can("project_equipment", "update") || can("project_equipment", "delete"),
    canCreateAssignments: can("project_equipment", "create"), canUpdateAssignments: can("project_equipment", "update"), canDeleteAssignments: can("project_equipment", "delete"),
    canEditDaily: false, canCreateDaily: false, canUpdateDaily: false, canDeleteDaily: false, canEditTimesheet: false, canCreateTimesheet: false, canUpdateTimesheet: false, canDeleteTimesheet: false,
    currentUserRole: mode === "full" ? "superadmin" : "engineer", currentUserName: `Проверка справочников (${mode})`, reportSubmitted: false, foremanProgress: [],
    units, availableUnits: state.units.filter(row => row.assignedSiteId !== siteId && (mode !== "restricted" || row.assignedSiteId === null)).map(unitDto), sites: visibleSites(mode),
    entries: [], marks: [], dailyTimesheetMarks: [], filledDates: [], shifts: [{ id: 1, name: "День" }], zones: atSite("zones", siteId), mainWorkTypes: atSite("parents", siteId), subworkTypes: atSite("children", siteId),
  };
};
const controlPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Проверка справочников</title>
<style>body{font:15px system-ui;max-width:1100px;margin:30px auto;padding:0 16px;color:#27272a}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;border-bottom:1px solid #ddd}a,button{display:inline-block;margin:3px;padding:7px 10px}button{cursor:pointer}pre{white-space:pre-wrap;background:#f4f4f5;padding:14px}</style>
<h1>Изолированная проверка справочников</h1><p>Настоящий PersonnelApp. Только синтетические данные в памяти; сервер не читает env и не подключается к БД.</p>
<table><thead><tr><th>Раздел</th>${[...modes].map(mode => `<th>${mode}</th>`).join("")}</tr></thead><tbody>${routes.map(([name, path]) => `<tr><th>${name}</th>${[...modes].map(mode => `<td><a target="catalog-${mode}" href="${path}?mode=${mode}">Открыть</a></td>`).join("")}</tr>`).join("")}</tbody></table>
<p><button id="fail">Ошибка следующего сохранения</button><button id="reset">Сбросить тестовые данные</button><button id="refresh">Обновить состояние</button></p><pre id="state"></pre>
<script>async function refresh(){document.querySelector('#state').textContent=JSON.stringify(await(await fetch('/__smoke/status')).json(),null,2)}
document.querySelector('#fail').onclick=async()=>{await fetch('/__smoke/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({failureSaves:1})});refresh()};document.querySelector('#reset').onclick=async()=>{await fetch('/__smoke/reset',{method:'POST'});refresh()};document.querySelector('#refresh').onclick=refresh;refresh();</script></html>`;

const config = {
  configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  plugins: [react(), {
    name: "catalog-spreadsheet-memory-api",
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/" || url.pathname === "/__smoke/control") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(controlPage); return; }
        if (url.pathname === "/tps-logo.svg") { response.writeHead(200, { "Content-Type": "image/svg+xml" }); response.end(await readFile(new URL("../public/tps-logo.svg", import.meta.url))); return; }
        if (url.pathname === "/excel-preview" || url.pathname.startsWith("/settings/") || url.pathname.startsWith("/reports/") || url.pathname.startsWith("/timesheets/")) { request.url = `/catalog-spreadsheet.html${url.search}`; return next(); }
        if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
        const header = request.headers["x-catalog-smoke-mode"];
        const mode = modes.has(header) ? header : "full";
        const requestKey = `${request.method} ${url.pathname}`;
        requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);
        try {
          if (url.pathname === "/__smoke/status") {
            const collection = url.searchParams.get("collection");
            return send(response, { isolated: true, counts: Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, rows.length])), requests: Object.fromEntries(requests), mutations, attempts, failureSaves, saveDelayMs, orders: Object.fromEntries(orders), ...(collection && Object.hasOwn(state, collection) ? { records: state[collection] } : {}) });
          }
          if (url.pathname === "/__smoke/reset" && request.method === "POST") { state = seed(); nextId = 1000; failureSaves = 0; saveDelayMs = 0; orders.clear(); mutations.length = 0; attempts.length = 0; requests.clear(); return send(response, { reset: true }); }
          if (url.pathname === "/__smoke/policy" && request.method === "POST") { const body = await bodyOf(request); failureSaves = Math.max(0, Math.min(10, Number(body.failureSaves ?? failureSaves))); saveDelayMs = Math.max(0, Math.min(3000, Number(body.saveDelayMs ?? saveDelayMs))); return send(response, { failureSaves, saveDelayMs }); }
          if (url.pathname === "/api/health") return send(response, { status: "ok", isolated: true });
          if (url.pathname === "/api/maintenance/status") return send(response, { maintenance: false, phase: "ready" });
          if (url.pathname === "/api/table-order") {
            const body = request.method === "POST" ? await bodyOf(request) : {};
            const siteId = Number(body.siteId ?? url.searchParams.get("siteId"));
            assertProject(mode, siteId);
            const scope = body.scope ?? url.searchParams.get("scope");
            const available = canonicalIds(mode, scope, siteId);
            const resource = scopeResource(scope);
            const canWrite = may(mode, resource, "update") || resource === "project_employees" && may(mode, resource, "create");
            const key = `${mode === "restricted" ? "restricted" : "all"}:${scope}:${["positions", "employees", "equipment"].includes(scope) ? "global" : siteId}`;
            let ids = reconcileRowOrder(available, orders.get(key) ?? []);
            if (request.method === "POST") {
              assert(canWrite, "Нет права изменять порядок строк.", 403);
              assert(Array.isArray(body.movingIds) && body.movingIds.length && body.movingIds.every(id => available.includes(id)), "Unknown synthetic rows.");
              assert(["start", "end", "before", "after"].includes(body.placement), "Unknown placement.");
              assert(!["before", "after"].includes(body.placement) || available.includes(body.targetId), "Unknown synthetic target.");
              assert(body.displayedIds === undefined || Array.isArray(body.displayedIds) && body.displayedIds.every(id => available.includes(id)), "Unknown displayed rows.");
              ids = moveRowBlock(ids, body); orders.set(key, ids); remember(mutations, { mode, action: "table-order", scope, siteId, movingIds: body.movingIds });
            } else assert(request.method === "GET", "Unsupported method.", 405);
            return send(response, { ids, canWrite, hasSavedOrder: orders.has(key), importIds: ["employees", "project-personnel"].includes(scope) ? available : [], hasImportOrder: ["employees", "project-personnel"].includes(scope) });
          }
          if (url.pathname === "/api/data") {
            if (request.method === "GET") { const siteId = Number(url.searchParams.get("siteId") ?? 1); assertProject(mode, siteId); return send(response, dataSet(mode, siteId, url.searchParams.get("section"))); }
            const body = await bodyOf(request);
            if (["create-position", "update-position"].includes(body.action)) {
              const creating = body.action === "create-position";
              assertMay(mode, "positions", creating ? "create" : "update");
              assert(creating || state.positions.some(row => row.id === body.positionId), "Должность не найдена.");
              assert(["employmentType", "department", "position"].every(key => normalize(body[key])), "Заполните тип, отдел и должность.");
              assert(!state.positions.some(row => row.id !== body.positionId && ["employmentType", "department", "position"].every(key => normalize(row[key]) === normalize(body[key]))), "Такая должность уже существует.", 409);
              await beginSave(mode, body.action, body);
              const row = { id: creating ? nextId++ : body.positionId, employmentType: body.employmentType.trim(), department: body.department.trim(), position: body.position.trim() };
              state.positions = creating ? [...state.positions, row] : state.positions.map(item => item.id === row.id ? row : item);
              remember(mutations, { mode, action: body.action, id: row.id, position: row.position }); return send(response, { status: "ok", id: row.id });
            }
            if (body.action === "assign-employee-project") {
              assertMay(mode, "project_employees", "create"); const siteId = Number(body.siteId); assertProject(mode, siteId);
              const row = state.employees.find(item => item.id === body.employeeId); assert(row, "Сотрудник не найден.");
              assert(mode !== "restricted" || row.siteId === null || row.siteId === 1, "Сотрудник другого проекта недоступен.", 403);
              assert(row.siteId !== siteId, "Сотрудник уже назначен в проект.");
              await beginSave(mode, body.action, body); row.siteId = siteId; remember(mutations, { mode, action: body.action, employeeId: row.id, siteId }); return send(response, { status: "ok" });
            }
            if (["save-directory-items", "create-directory", "update-directory"].includes(body.action)) {
              const siteId = Number(body.siteId); assertProject(mode, siteId);
              const collection = ({ zone: "zones", master: "masters" })[body.entity]; assert(collection, "Unknown synthetic directory.");
              const items = body.directories ?? [{ directoryId: body.directoryId, name: body.name, employeeId: body.employeeId }];
              assert(Array.isArray(items) && items.length && items.length <= 500, "Укажите строки справочника.");
              const changed = new Set(items.map(item => item.directoryId));
              const names = new Set(atSite(collection, siteId).filter(row => !changed.has(row.id)).map(row => normalize(row.name)));
              for (const item of items) {
                assertMay(mode, "project_directories", item.directoryId == null ? "create" : "update");
                assert(item.directoryId == null || atSite(collection, siteId).some(row => row.id === item.directoryId), "Запись не найдена в проекте.");
                assert(normalize(item.name) && !names.has(normalize(item.name)), "Укажите непустое уникальное название."); names.add(normalize(item.name));
                if (collection === "masters") assert(state.employees.some(row => row.id === item.employeeId && row.siteId === siteId && normalize(row.fullName) === normalize(item.name)), "Выберите мастера из сотрудников проекта.");
              }
              await beginSave(mode, body.action, body);
              for (const item of items) { const row = { id: item.directoryId ?? nextId++, name: item.name.trim(), siteId, ...(collection === "masters" ? { employeeId: item.employeeId } : {}) }; const found = state[collection].findIndex(existing => existing.id === row.id); if (found < 0) state[collection].push(row); else state[collection][found] = row; }
              remember(mutations, { mode, action: body.action, entity: body.entity, siteId, count: items.length }); return send(response, { status: "ok", count: items.length });
            }
            if (request.method === "DELETE") {
              const entity = url.searchParams.get("entity"); const id = Number(url.searchParams.get("id")); const siteId = Number(url.searchParams.get("siteId") ?? 1);
              if (entity === "position") { assertMay(mode, "positions", "delete"); state.positions = state.positions.filter(row => row.id !== id); }
              else if (entity === "directory") { assertMay(mode, "project_directories", "delete"); assertProject(mode, siteId); const collection = ({ zone: "zones", master: "masters" })[url.searchParams.get("kind")]; assert(collection, "Unknown synthetic directory."); state[collection] = state[collection].filter(row => row.id !== id || row.siteId !== siteId); }
              else if (entity === "employee-assignment") { assertMay(mode, "project_employees", "delete"); assertProject(mode, siteId); const employee = state.employees.find(row => row.id === id && row.siteId === siteId); assert(employee, "Назначение не найдено."); employee.siteId = null; }
              else assert(false, "Unsupported synthetic deletion.");
              remember(mutations, { mode, action: "delete", entity, id, siteId }); return send(response, { status: "ok" });
            }
            assert(false, "This isolated fixture does not implement that data action.");
          }
          if (url.pathname === "/api/equipment") {
            if (request.method === "GET") return send(response, equipmentData(mode, url));
            assert(request.method === "POST", "Unsupported method.", 405);
            const body = await bodyOf(request); const siteId = Number(body.siteId); assertProject(mode, siteId);
            if (body.action === "save-unit") {
              assertMay(mode, "equipment_registry", body.id == null ? "create" : "update");
              const current = body.id == null ? null : state.units.find(row => row.id === body.id); assert(body.id == null || current, "Техника не найдена.");
              assert(mode !== "restricted" || !current || current.assignedSiteId === 1, "Техника недоступна.", 403);
              const assignedSiteId = body.projectSiteId ? Number(body.projectSiteId) : null;
              if (assignedSiteId !== null) assertProject(mode, assignedSiteId); assert(mode !== "restricted" || assignedSiteId === 1, "Выберите разрешённый проект.", 403);
              assert(["organization", "equipmentType", "model"].every(key => normalize(body[key])), "Заполните организацию, тип и модель.");
              assert(!normalize(body.registrationNumber) || !state.units.some(row => row.id !== body.id && normalize(row.registrationNumber) === normalize(body.registrationNumber)), "Этот номер уже есть в реестре.", 409);
              await beginSave(mode, body.action, body);
              const row = { id: current?.id ?? nextId++, organization: body.organization.trim(), equipmentType: body.equipmentType.trim(), brand: String(body.brand ?? "").trim(), model: body.model.trim(), registrationNumber: String(body.registrationNumber ?? "").trim(), note: String(body.note ?? ""), assignedSiteId };
              state.units = current ? state.units.map(item => item.id === row.id ? row : item) : [...state.units, row]; remember(mutations, { mode, action: body.action, id: row.id, assignedSiteId }); return send(response, { status: "ok", id: row.id });
            }
            if (["assign-unit-project", "remove-unit-project", "delete-unit"].includes(body.action)) {
              const removing = body.action !== "assign-unit-project"; assertMay(mode, body.action === "delete-unit" ? "equipment_registry" : "project_equipment", removing ? "delete" : "create");
              const row = state.units.find(unit => unit.id === (body.id ?? body.equipmentId)); assert(row, "Техника не найдена.");
              assert(mode !== "restricted" || row.assignedSiteId === null || row.assignedSiteId === 1, "Техника другого проекта недоступна.", 403);
              await beginSave(mode, body.action, body);
              if (body.action === "delete-unit") state.units = state.units.filter(unit => unit.id !== row.id); else row.assignedSiteId = removing ? null : siteId;
              remember(mutations, { mode, action: body.action, id: row.id, siteId }); return send(response, { status: "ok" });
            }
            assert(false, "This isolated fixture does not implement that equipment action.");
          }
          if (url.pathname === "/api/work-types") {
            assert(request.method === "POST", "Unsupported method.", 405);
            const body = await bodyOf(request); const siteId = Number(body.siteId); assertProject(mode, siteId);
            if (body.action === "save") {
              assert(Array.isArray(body.parents) && Array.isArray(body.children) && body.parents.length + body.children.length <= 500, "Укажите строки справочника.");
              const parentIds = new Set(atSite("parents", siteId).map(row => row.id)); const parentKeys = new Set(body.parents.filter(row => row.id == null).map(row => row.clientKey));
              for (const [collection, rows] of [["parents", body.parents], ["children", body.children]]) {
                const changed = new Set(rows.map(row => row.id));
                const names = new Set(atSite(collection, siteId).filter(row => !changed.has(row.id)).map(row => JSON.stringify([collection === "children" ? row.mainWorkTypeId : null, normalize(row.name)])));
                for (const row of rows) {
                  assertMay(mode, "project_directories", row.id == null ? "create" : "update");
                  const original = row.id == null ? null : atSite(collection, siteId).find(item => item.id === row.id); assert(row.id == null || original, "Запись не найдена в проекте.");
                  assert(normalize(row.name) && row.name.trim().length <= 240, "Укажите название от 1 до 240 символов.");
                  if (original && row.originalName !== undefined) assert(original.name === row.originalName, "Запись изменена другим пользователем.", 409);
                  if (collection === "children") assert(row.parentKey ? parentKeys.has(row.parentKey) : row.parentId == null ? row.id != null : parentIds.has(row.parentId), "Выберите существующий или новый вид работы.");
                  const key = JSON.stringify([collection === "children" ? row.parentKey ?? row.parentId ?? null : null, normalize(row.name)]); assert(!names.has(key), "Такое название уже существует.", 409); names.add(key);
                }
              }
              await beginSave(mode, body.action, body);
              const parentKeyIds = new Map(); const result = { parents: [], children: [] };
              for (const item of body.parents) { const row = { id: item.id ?? nextId++, name: item.name.trim(), siteId }; parentKeyIds.set(item.clientKey, row.id); const index = state.parents.findIndex(parent => parent.id === row.id); if (index < 0) state.parents.push(row); else state.parents[index] = row; result.parents.push({ clientKey: item.clientKey, id: row.id }); }
              for (const item of body.children) { const row = { id: item.id ?? nextId++, name: item.name.trim(), siteId, mainWorkTypeId: item.parentKey ? parentKeyIds.get(item.parentKey) : item.parentId ?? null }; const index = state.children.findIndex(child => child.id === row.id); if (index < 0) state.children.push(row); else state.children[index] = row; result.children.push({ clientKey: item.clientKey, id: row.id }); }
              remember(mutations, { mode, action: "save-work-types", siteId, parentCount: result.parents.length, childCount: result.children.length }); return send(response, result);
            }
            if (body.action === "archive") {
              assertMay(mode, "project_directories", "delete"); assert(Array.isArray(body.parents) && Array.isArray(body.children), "Выберите строки.");
              assert(body.parents.every(id => atSite("parents", siteId).some(row => row.id === id)) && body.children.every(id => atSite("children", siteId).some(row => row.id === id)), "Запись не найдена в проекте.");
              const removedParents = new Set(body.parents); const removedChildren = new Set(atSite("children", siteId).filter(row => body.children.includes(row.id) || removedParents.has(row.mainWorkTypeId)).map(row => row.id));
              state.parents = state.parents.filter(row => row.siteId !== siteId || !removedParents.has(row.id)); state.children = state.children.filter(row => row.siteId !== siteId || !removedChildren.has(row.id));
              remember(mutations, { mode, action: "archive-work-types", siteId, parentCount: removedParents.size, childCount: removedChildren.size }); return send(response, { count: removedParents.size + removedChildren.size });
            }
            assert(false, "This isolated fixture does not implement that work-type action.");
          }
          if (url.pathname.endsWith("-report") && request.method === "GET") return send(response, { reports: [], entries: [], canReview: false, availabilityMarks: [] });
          return send(response, { error: "Only the isolated catalog fixture API is available." }, 404);
        } catch (error) { return send(response, { error: error instanceof Error ? error.message : String(error) }, error.status ?? 400); }
      });
    },
  }],
  build: { outDir: await mkdtemp(join(tmpdir(), "catalog-spreadsheet-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/catalog-spreadsheet.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3164, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
console.log("Catalog spreadsheet QA: http://127.0.0.1:3164/__smoke/control (synthetic data only)");
