// Local browser QA only. No environment files, real accounts, databases, or external APIs.
// Start: node --experimental-strip-types scripts/employee-spreadsheet-smoke.mjs
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveRowBlock } from "../app/tableRowOrder.ts";

const sites = [
  { id: 1, name: "Учебный проект А", code: "TEST-A", timezone: "Europe/Moscow" },
  { id: 2, name: "Учебный проект Б", code: "TEST-B", timezone: "Europe/Moscow" },
];
const positionCatalog = [
  { id: 1, employmentType: "ОПР", department: "МУТТ", position: "Монтажник" },
  { id: 2, employmentType: "ОПР", department: "МУСК", position: "Сварщик" },
  { id: 3, employmentType: "ИТР", department: "ПТО", position: "Инженер" },
];
const options = (key) => [...new Set(positionCatalog.map((item) => item[key]))].map((name, index) => ({ id: index + 1, name }));
const makeEmployees = () => Array.from({ length: 80 }, (_, index) => {
  const id = index + 1;
  const position = positionCatalog[index % positionCatalog.length];
  const site = sites[index % sites.length];
  const flag = ({ 8: "mismatch", 19: "missing_in_bitrix", 36: "dismissed_in_bitrix", 51: "mismatch" })[id] ?? null;
  return {
    id, sortOrder: index + 1, fullName: `Тестовый сотрудник ${String(id).padStart(3, "0")}`,
    employmentType: position.employmentType, department: position.department, position: position.position,
    source: flag ? "bitrix24" : "manual", bitrix24Id: flag ? `synthetic-${id}` : null,
    siteId: site.id, siteName: site.name, projectCodes: site.code,
    availabilityStatus: "active", bitrix24Stage: "На объекте", syncError: null,
    lastSyncedAt: flag ? "2026-11-06T06:00:00.000Z" : null,
    bitrixCheckStatus: flag,
    bitrixCheckDetails: flag ? "Синтетическое предупреждение для проверки таблицы." : null,
    bitrixCheckAcknowledged: false,
  };
});

let employees = makeEmployees();
let nextId = 81;
let orderSaved = false;
let failureSaves = 0;
let saveDelayMs = 0;
const requests = new Map();
const mutations = [];
const saveAttempts = [];
const modes = new Set(["full", "readonly", "createonly", "restricted"]);
const visibleEmployees = (mode) => mode === "restricted" ? employees.filter((employee) => employee.siteId === 1) : employees;
const visibleSites = (mode) => mode === "restricted" ? sites.slice(0, 1) : sites;
const canUpdate = (mode) => mode === "full" || mode === "restricted";
const remember = (list, item) => { list.push(item); if (list.length > 30) list.shift(); };
const send = (response, payload, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
};
const readBody = async (request) => {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Fixture request is too large.");
  }
  return raw ? JSON.parse(raw) : {};
};
const tableOrder = (mode) => ({
  ids: visibleEmployees(mode).map((employee) => employee.id), canWrite: canUpdate(mode), hasSavedOrder: orderSaved,
  importIds: visibleEmployees(mode).map((employee) => employee.id).sort((left, right) => left - right), hasImportOrder: true,
});
const dataSet = (mode, siteId) => {
  const visible = visibleEmployees(mode);
  return {
    sites: visibleSites(mode), employees: visible,
    projectEmployees: visible.filter((employee) => employee.siteId === siteId),
    placementEmployees: visible.filter((employee) => employee.siteId === siteId),
    reportEmployees: visible.filter((employee) => employee.siteId === siteId),
    positionCatalog, employmentTypes: options("employmentType"), departments: options("department"), positions: options("position"),
    projectStats: visibleSites(mode).map((site) => ({ siteId: site.id, employeeCount: visible.filter((employee) => employee.siteId === site.id).length, foremanCount: 0 })),
    users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [],
    reportSubmitted: false, syncStatus: null,
    bitrix24Cooldowns: { inspect: { nextAllowedAt: null, remainingSeconds: 0 }, sync: { nextAllowedAt: null, remainingSeconds: 0 } },
  };
};
const controlPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Проверка сотрудников</title>
<style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 20px;color:#202124}a,button{display:inline-block;margin:6px;padding:10px 14px}button{cursor:pointer}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}</style>
<h1>Изолированная проверка сотрудников</h1><p>Только синтетические данные в памяти. После перезапуска стенда изменения исчезнут.</p>
<nav>${[...modes].map((mode) => `<a target="employee-${mode}" href="/settings/general/employees?mode=${mode}">${mode}</a>`).join("")}</nav>
<p><button id="fail">Ошибка следующего сохранения</button><button id="reset">Сбросить тестовые данные</button><button id="refresh">Обновить состояние</button></p><pre id="state"></pre>
<script>async function refresh(){document.querySelector('#state').textContent=JSON.stringify(await(await fetch('/__smoke/status')).json(),null,2)}
document.querySelector('#fail').onclick=async()=>{await fetch('/__smoke/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({failureSaves:1})});refresh()};
document.querySelector('#reset').onclick=async()=>{await fetch('/__smoke/reset',{method:'POST'});refresh()};document.querySelector('#refresh').onclick=refresh;refresh();</script></html>`;

const config = {
  configFile: false, envDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  plugins: [react(), {
    name: "employee-spreadsheet-memory-api",
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/" || url.pathname === "/__smoke/control") {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          response.end(controlPage); return;
        }
        if (url.pathname === "/tps-logo.svg") {
          response.writeHead(200, { "Content-Type": "image/svg+xml" });
          response.end(await readFile(new URL("../public/tps-logo.svg", import.meta.url))); return;
        }
        if (url.pathname.startsWith("/settings/") || url.pathname.startsWith("/reports/") || url.pathname.startsWith("/timesheets/")) {
          request.url = `/employee-spreadsheet.html${url.search}`; return next();
        }
        if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
        const modeHeader = request.headers["x-employee-smoke-mode"];
        const mode = modes.has(modeHeader) ? modeHeader : "full";
        const requestKey = `${request.method} ${url.pathname}`;
        requests.set(requestKey, (requests.get(requestKey) ?? 0) + 1);
        try {
          if (url.pathname === "/__smoke/status") {
            const employeeId = Number(url.searchParams.get("employeeId"));
            const name = url.searchParams.get("name");
            return send(response, {
              isolated: true, employeeCount: employees.length,
              countsBySite: Object.fromEntries(sites.map((site) => [site.id, employees.filter((employee) => employee.siteId === site.id).length])),
              requests: Object.fromEntries(requests), mutations, saveAttempts, failureSaves, saveDelayMs,
              orderedIds: employees.map((employee) => employee.id),
              ...(employeeId || name ? { employees: employees.filter((employee) => employee.id === employeeId || name && employee.fullName.includes(name)) } : {}),
            });
          }
          if (url.pathname === "/__smoke/reset" && request.method === "POST") {
            employees = makeEmployees(); nextId = 81; orderSaved = false; failureSaves = 0; saveDelayMs = 0;
            mutations.length = 0; saveAttempts.length = 0; requests.clear();
            return send(response, { reset: true, employeeCount: employees.length });
          }
          if (url.pathname === "/__smoke/policy" && request.method === "POST") {
            const body = await readBody(request);
            failureSaves = Math.max(0, Math.min(10, Number(body.failureSaves ?? failureSaves)));
            saveDelayMs = Math.max(0, Math.min(3000, Number(body.saveDelayMs ?? saveDelayMs)));
            return send(response, { failureSaves, saveDelayMs });
          }
          if (url.pathname === "/api/health") return send(response, { status: "ok", isolated: true });
          if (url.pathname === "/api/maintenance/status") return send(response, { maintenance: false, phase: "ready" });
          if (url.pathname === "/api/table-order") {
            const body = request.method === "POST" ? await readBody(request) : {};
            const scope = body.scope ?? url.searchParams.get("scope");
            const siteId = Number(body.siteId ?? url.searchParams.get("siteId"));
            if (scope !== "employees" || !visibleSites(mode).some((site) => site.id === siteId)) return send(response, { error: "Unknown synthetic table scope or project." }, 400);
            if (request.method === "POST") {
              if (!canUpdate(mode)) return send(response, { error: "Нет права изменять порядок сотрудников." }, 403);
              const available = new Set(visibleEmployees(mode).map((employee) => employee.id));
              if (body.action === "remap") return send(response, tableOrder(mode));
              if (!Array.isArray(body.movingIds) || !body.movingIds.length || body.movingIds.some((id) => !available.has(id))) throw new Error("Unknown synthetic rows.");
              if (!["start", "end", "before", "after"].includes(body.placement)) throw new Error("Unknown placement.");
              if (["before", "after"].includes(body.placement) && !available.has(body.targetId)) throw new Error("Unknown synthetic target.");
              if (body.displayedIds && (!Array.isArray(body.displayedIds) || body.displayedIds.some((id) => !available.has(id)))) throw new Error("Unknown displayed rows.");
              const visibleIds = visibleEmployees(mode).map((employee) => employee.id);
              const reordered = moveRowBlock(visibleIds, body);
              let cursor = 0;
              const byId = new Map(employees.map((employee) => [employee.id, employee]));
              employees = employees.map((employee) => available.has(employee.id) ? byId.get(reordered[cursor++]) : employee)
                .map((employee, index) => ({ ...employee, sortOrder: index + 1 }));
              orderSaved = true;
              remember(mutations, { action: "table-order", mode, movingIds: body.movingIds, placement: body.placement, targetId: body.targetId });
            } else if (request.method !== "GET") return send(response, { error: "Unsupported method." }, 405);
            return send(response, tableOrder(mode));
          }
          if (url.pathname === "/api/data") {
            if (request.method === "GET") return send(response, dataSet(mode, Number(url.searchParams.get("siteId") ?? 1)));
            const body = await readBody(request);
            if (request.method === "DELETE" && url.searchParams.get("entity") === "employee") {
              if (!canUpdate(mode)) return send(response, { error: "Нет права удалять сотрудников." }, 403);
              const allowed = new Set(visibleEmployees(mode).map((employee) => employee.id));
              if (!Array.isArray(body.ids) || body.ids.some((id) => !allowed.has(id))) throw new Error("Unknown synthetic employees.");
              employees = employees.filter((employee) => !body.ids.includes(employee.id));
              remember(mutations, { action: "delete-employees", mode, ids: body.ids });
              return send(response, { status: "ok", count: body.ids.length });
            }
            if (["create-employee", "update-employee"].includes(body.action)) {
              const creating = body.action === "create-employee";
              if (mode === "readonly" || !creating && !canUpdate(mode)) return send(response, { error: "Нет права сохранять это изменение." }, 403);
              const current = creating ? null : visibleEmployees(mode).find((employee) => employee.id === body.employeeId);
              if (!creating && !current) return send(response, { error: "Сотрудник недоступен." }, 403);
              const siteId = body.projectSiteId == null || body.projectSiteId === "" ? null : Number(body.projectSiteId);
              if (siteId !== null && !visibleSites(mode).some((site) => site.id === siteId) || mode === "restricted" && siteId !== 1) return send(response, { error: "Проект недоступен." }, 403);
              if (!String(body.fullName ?? "").trim() || !positionCatalog.some((position) => ["employmentType", "department", "position"].every((key) => position[key] === body[key]))) return send(response, { error: "Заполните ФИО и корректную должность." }, 400);
              const fullName = String(body.fullName).trim();
              if (employees.some((employee) => employee.id !== current?.id && employee.fullName.toLocaleLowerCase("ru") === fullName.toLocaleLowerCase("ru"))) return send(response, { error: "Сотрудник с таким ФИО уже существует." }, 409);
              remember(saveAttempts, { action: body.action, mode, employeeId: body.employeeId, fullName });
              if (saveDelayMs) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
              if (failureSaves > 0) { failureSaves--; return send(response, { error: "Проверочная ошибка сохранения. Черновик должен остаться в таблице." }, 503); }
              const saved = {
                ...(current ?? { id: nextId++, sortOrder: employees.length + 1, source: "manual", availabilityStatus: "active", bitrix24Stage: "", syncError: null, bitrixCheckStatus: null }),
                fullName, employmentType: body.employmentType, department: body.department, position: body.position,
                siteId, siteName: sites.find((site) => site.id === siteId)?.name ?? null,
                projectCodes: sites.find((site) => site.id === siteId)?.code ?? null,
              };
              employees = creating ? [...employees, saved] : employees.map((employee) => employee.id === saved.id ? saved : employee);
              remember(mutations, { action: body.action, mode, employeeId: saved.id, fullName, siteId });
              return send(response, { status: "ok", employeeId: saved.id, employee: saved });
            }
            if (body.action === "inspect-bitrix24") {
              if (!canUpdate(mode)) return send(response, { error: "Нет права проверять Битрикс24." }, 403);
              return send(response, { status: "ok", checkedAt: "2026-11-06T06:00:00.000Z", sourceReceived: 80, compared: 80, matched: 80, totalDifferences: 0, differences: [], autoLinkable: 0, needsReview: 0, unmatched: 0 });
            }
            return send(response, { error: "This isolated fixture does not implement that action." }, 400);
          }
          if (url.pathname.endsWith("-report") && request.method === "GET") return send(response, { reports: [], entries: [], canReview: false, availabilityMarks: [] });
          return send(response, { error: "Only the isolated employee fixture API is available." }, 404);
        } catch (error) { return send(response, { error: error instanceof Error ? error.message : String(error) }, 400); }
      });
    },
  }],
  build: {
    outDir: await mkdtemp(join(tmpdir(), "employee-spreadsheet-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/employee-spreadsheet.html", import.meta.url)) },
  },
  preview: { host: "127.0.0.1", port: 3162, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
console.log("Employee spreadsheet QA: http://127.0.0.1:3162/__smoke/control (synthetic data only)");
