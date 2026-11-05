// Multi-page UI preview: synthetic fixtures only, no env files, DB or browser automation.
// Work-types / unified-filters / user-roles fixtures keep their own browser-memory mocks.
// The server supplies checkbox ordering and synthetic confirmation / timesheet data.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveRowBlock } from "../app/tableRowOrder.ts";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { isPersonnelTimesheetValue } from "../app/personnelTimesheetValues.ts";

let port = 3142;
let buildOnly = false;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === "--port") port = Number(process.argv[++index]);
  else if (process.argv[index] === "--build-only") buildOnly = true;
  else throw new Error(`Неизвестный аргумент UI-стенда: ${process.argv[index]}`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт UI-стенда.");
const pages = [
  ["grid-editing", "Редактирование справочников: техника, сотрудники, зоны"],
  ["unified-filters", "Единые фильтры: табели персонала и техники"],
  ["choice-menus", "Длинные списки и края выпадающих меню"],
  ["checkbox-row-drag", "Выбор строк, перенос, права и блокировки"],
  ["work-types", "Виды и подвиды работ: локальный справочник"],
  ["user-roles", "Пользователи, роли и права: изменения в памяти"],
  ["confirmation-dialogs", "Подтверждения ухода с несохранёнными данными"],
  ["excel-actions-menu", "Меню действий Excel"],
];
const sites = [
  { id: 1, name: "Первый тестовый проект", code: "TEST-1", timezone: "Europe/Moscow" },
  { id: 2, name: "Второй тестовый проект", code: "TEST-2", timezone: "Europe/Moscow" },
];
const rightsUsers = [1, 2].map(id => ({ id, fullName: id === 1 ? "Первый пользователь" : "Второй пользователь", email: `user-${id}@example.invalid`, role: "engineer", assignedSiteId: null, assignedSiteName: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer"), customized: false }));
const actor = { id: 1, fullName: "Проверка интерфейса", email: "ui@example.invalid", role: "superadmin", assignedSiteId: null, permissions: rolePermissionTemplate("superadmin"), permissionsCustomized: false };
const dataset = { sites, employees: [], projectEmployees: [], placementEmployees: [], reportEmployees: [], positionCatalog: [], employmentTypes: [], departments: [], positions: [], users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false };
const timesheetEmployees = [{ id: 1, fullName: "Учебный сотрудник", employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник" }];
const timesheetUnits = [{ id: 1, equipmentType: "Экскаватор", brand: "Учебная марка", model: "Тестовая модель", registrationNumber: "ТЕСТ-001", organization: "Учебная организация", note: "" }];
const personnelMarks = new Map();
const equipmentMarks = new Map();
const orders = new Map();
const mutations = [];
const blockedRequests = [];
let delayMs = 0;
const orderScopes = new Set(["fixture-generic", "directory-zone", "equipment", "project-personnel", "project-equipment", "directory-work-types"]);
const availableIds = (scope, siteId) => scope === "directory-work-types"
  ? ["parent-1", "parent-2", "parent-3", "child-11", "child-12", "child-13", "child-14", "child-15"]
  : Array.from({ length: 6 }, (_, index) => (siteId - 1) * 100 + index + 1);
const reportPaths = new Set(["/api/personnel-report", "/api/equipment-report"]);
function json(response, payload, status = 200) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 500_000) throw new Error("Запрос превышает размер тестового стенда.");
  }
  return raw ? JSON.parse(raw) : {};
}
function block(request, response, path) {
  blockedRequests.push({ method: request.method, path });
  return json(response, { error: `Запрос ${request.method} ${path} заблокирован изолированным UI-стендом.` }, 403);
}
const config = {
  configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  build: {
    outDir: await mkdtemp(join(tmpdir(), "personnel-system-ui-")), emptyOutDir: false,
    rolldownOptions: { input: pages.map(([name]) => fileURLToPath(new URL(`../tests/fixtures/${name}.html`, import.meta.url))) },
  },
  plugins: [react(), {
    name: "isolated-system-ui-api",
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        response.setHeader("Content-Security-Policy", "connect-src 'self'; form-action 'self'");
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          return response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Изолированные проверки интерфейса</title><body style="font-family:system-ui;max-width:900px;margin:36px auto;padding:16px"><h1>Проверки интерфейса</h1><p>Только тестовые данные. Рабочая база, внешние API и отправка писем не подключены.</p><ul>${pages.map(([name, title]) => `<li style="margin:14px 0"><a href="/${name}.html">${title}</a></li>`).join("")}</ul><p>В окнах подтверждения можно проверять отмену и уход без сохранения. Сервер не принимает сохранение рабочих сущностей.</p><p><a href="/__system/status">Счётчики тестового сервера</a></p></body></html>`);
        }
        // PersonnelApp uses client-side paths. Reloading those paths must retain
        // the confirmation fixture, not request any application server.
        if (/^\/(?:settings|reports|timesheets)(?:\/|$)/.test(url.pathname)) {
          request.url = `/confirmation-dialogs.html${url.search}`;
          return next();
        }
        if (url.pathname === "/__system/status") return json(response, { orders: Object.fromEntries(orders), mutations, blockedRequests, delayMs });
        if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
        try {
          if (url.pathname === "/__smoke/status") return json(response, { orders: Object.fromEntries(orders), mutations, delayMs });
          if (url.pathname === "/__smoke/reset" && request.method === "POST") {
            orders.clear(); mutations.length = 0;
            return json(response, { reset: true });
          }
          if (url.pathname === "/__smoke/policy" && request.method === "POST") {
            const body = await readBody(request); delayMs = body.slow ? 1500 : 0;
            return json(response, { delayMs });
          }
          const referer = new URL(request.headers.referer ?? "/", "http://127.0.0.1");
          const checkboxFixture = referer.pathname === "/checkbox-row-drag.html";
          if (url.pathname === "/api/table-order" && checkboxFixture) {
            const body = request.method === "POST" ? await readBody(request) : {};
            const scope = body.scope ?? url.searchParams.get("scope");
            const siteId = Number(body.siteId ?? url.searchParams.get("siteId"));
            if (!orderScopes.has(scope) || ![1, 2].includes(siteId)) return block(request, response, url.pathname);
            const key = `${scope}:${siteId}`;
            let ids = orders.get(key)?.ids ?? availableIds(scope, siteId);
            if (request.method === "POST") {
              if (!Array.isArray(body.movingIds) || !body.movingIds.length || body.movingIds.some(id => !ids.includes(id))) throw new Error("Выберите существующие тестовые строки.");
              if (!["start", "end", "before", "after"].includes(body.placement)) throw new Error("Некорректный перенос строк.");
              if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
              ids = moveRowBlock(ids, body);
              orders.set(key, { ids, hasSavedOrder: true });
              mutations.push({ scope, siteId, movingIds: body.movingIds, placement: body.placement, targetId: body.targetId });
            }
            return json(response, { ids, canWrite: true, hasSavedOrder: orders.has(key) });
          }
          // These writes are restricted to the single explicitly synthetic row.
          // They never reach the application server, a database or an external API.
          if (request.method === "POST" && ["/api/timesheet", "/api/equipment"].includes(url.pathname)) {
            const body = await readBody(request);
            const equipment = url.pathname === "/api/equipment";
            if (![1, 2].includes(body.siteId) || !/^2026-\d{2}-\d{2}$/.test(body.workDate ?? "")
              || (equipment ? body.equipmentId !== 1 || body.action !== "save-timesheet-mark" : body.employeeId !== 1)) return block(request, response, url.pathname);
            const key = `${body.siteId}:${body.workDate}`;
            const marks = equipment ? equipmentMarks : personnelMarks;
            let mark;
            if (equipment && !body.clear) {
              if (![body.productiveHours, body.downtimeHours].every(value => Number.isFinite(value) && value >= 0)
                || body.productiveHours + body.downtimeHours > 20) throw new Error("Допустимо не более 20 часов.");
              mark = { equipmentId: 1, workDate: body.workDate, productiveHours: body.productiveHours, downtimeHours: body.downtimeHours, note: body.note ?? "", updatedBy: actor.fullName };
            } else if (!equipment && body.value) {
              if (!isPersonnelTimesheetValue(body.value)) throw new Error("Допустимы 1–10 часов или табельный код.");
              mark = { employeeId: 1, workDate: body.workDate, hours: /^\d+$/.test(body.value) ? Number(body.value) : null, code: /^\d+$/.test(body.value) ? null : body.value, note: body.note ?? "", updatedBy: actor.fullName };
            }
            if (mark) marks.set(key, mark); else marks.delete(key);
            mutations.push({ path: url.pathname, siteId: body.siteId, workDate: body.workDate, mark: mark ?? null });
            return json(response, { mark: mark ?? null, deleted: !mark });
          }
          if (request.method !== "GET") return block(request, response, url.pathname);
          if (url.pathname === "/api/data") return json(response, dataset);
          if (url.pathname === "/api/table-order") return json(response, { ids: [], canWrite: false, hasSavedOrder: false, importIds: [], hasImportOrder: false });
          if (url.pathname === "/api/auth/status") return json(response, { authenticated: true, user: actor });
          if (url.pathname === "/api/timesheet") return json(response, { siteId: Number(url.searchParams.get("siteId") ?? 1), siteName: sites[0].name, month: url.searchParams.get("month"), canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees: timesheetEmployees, entries: [], marks: [...personnelMarks].filter(([key]) => key.startsWith(`${url.searchParams.get("siteId")}:`) && key.includes(`:${url.searchParams.get("month")}-`)).map(([, mark]) => mark) });
          if (url.pathname === "/api/equipment") return json(response, {
            siteId: Number(url.searchParams.get("siteId") ?? 1), siteName: sites[0].name, workDate: url.searchParams.get("date"), month: url.searchParams.get("month"),
            currentUserRole: "superadmin", currentUserName: actor.fullName, reportSubmitted: false, foremanProgress: [],
            canEditDaily: true, canCreateDaily: true, canUpdateDaily: true, canDeleteDaily: true,
            canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true,
            canManageRegistry: true, canCreateRegistry: true, canUpdateRegistry: true, canDeleteRegistry: true,
            canManageAssignments: true, canCreateAssignments: true, canUpdateAssignments: true, canDeleteAssignments: true,
            units: timesheetUnits, availableUnits: timesheetUnits, sites, entries: [], marks: [...equipmentMarks].filter(([key]) => key.startsWith(`${url.searchParams.get("siteId")}:`) && key.includes(`:${url.searchParams.get("month")}-`)).map(([, mark]) => mark), dailyTimesheetMarks: [],
            shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], filledDates: [],
          });
          if (reportPaths.has(url.pathname)) return json(response, { reports: [], entries: [], canReview: true, from: null, to: null, availabilityMarks: [] });
          if (url.pathname === "/api/access-rights") return json(response, { users: rightsUsers, sites, canManage: true, currentUserId: 99 });
          if (url.pathname === "/api/roles") return json(response, { roles: [], canManage: true });
          return block(request, response, url.pathname);
        } catch (error) { return json(response, { error: error.message }, 400); }
      });
    },
  }],
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
if (buildOnly) console.log("System UI fixtures built successfully; preview server was not started.");
else (await preview(config)).printUrls();
