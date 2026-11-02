// Isolated, synthetic-only preview. Every supported API changes process memory.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveRowBlock } from "../app/tableRowOrder.ts";

const args = process.argv.slice(2);
const port = Number(args[0] === "--port" ? args[1] : args[0] ?? 3133);
if (!Number.isInteger(port) || port < 1 || port > 65535 || args.length > (args[0] === "--port" ? 2 : 1)) throw new Error("Укажите необязательный --port с номером от 1 до 65535.");
const today = "2026-11-02";
const roster = [
  { id: 1, fullName: "Абаев", employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" },
  { id: 2, fullName: "Петров", employmentType: "ОПР", department: "Тестовый отдел", position: "Сварщик", source: "manual", siteId: 1, siteName: "Учебный проект" },
  { id: 3, fullName: "Зотов", employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" },
];
let importIds = [3, 1, 2];
let importCount = 0;
const reportToken = employeeId => `${today}/report-11-${100 + employeeId}`;
const manual = new Map([
  ["employees", [2, 3, 1]], ["project-personnel", [2, 3, 1]],
  ["personnel-report-rows", [2, 3, 1].map(reportToken)],
]);
function json(response, payload, status = 200) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
async function readBody(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const config = {
  configFile: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  build: { outDir: await mkdtemp(join(tmpdir(), "personnel-import-order-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/personnel-import-order.html", import.meta.url)) } },
  plugins: [react(), {
    name: "isolated-import-order-api",
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
        try {
          if (url.pathname === "/__smoke/status") return json(response, { importIds, importCount, today, manual: Object.fromEntries(manual) });
          if (url.pathname === "/__smoke/import" && request.method === "POST") {
            importIds = [2, 1, 3]; importCount++;
            return json(response, { importIds, importCount });
          }
          if (url.pathname === "/__smoke/reset" && request.method === "POST") {
            importIds = [3, 1, 2]; importCount = 0;
            manual.set("employees", [2, 3, 1]); manual.set("project-personnel", [2, 3, 1]); manual.set("personnel-report-rows", [2, 3, 1].map(reportToken));
            return json(response, { importIds, importCount });
          }
          if (url.pathname === "/api/table-order") {
            const body = request.method === "POST" ? await readBody(request) : {};
            const scope = body.scope ?? url.searchParams.get("scope");
            const siteId = Number(body.siteId ?? url.searchParams.get("siteId"));
            if (!manual.has(scope) || siteId !== 1) return json(response, { error: "Неизвестная тестовая таблица или проект." }, 400);
            if (request.method === "POST") {
              const ids = manual.get(scope);
              if (!Array.isArray(body.movingIds) || body.movingIds.some(id => !ids.includes(id))) return json(response, { error: "В переносе есть неизвестные строки." }, 400);
              manual.set(scope, moveRowBlock(ids, body));
            }
            return json(response, {
              ids: manual.get(scope), canWrite: true, hasSavedOrder: true,
              ...(scope === "personnel-report-rows" ? {} : { importIds, hasImportOrder: true }),
            });
          }
          if (url.pathname === "/api/timesheet" && request.method === "GET") {
            const month = url.searchParams.get("month") ?? today.slice(0, 7);
            return json(response, {
              siteId: 1, siteName: "Учебный проект", month,
              canEdit: false, canCreate: false, canUpdate: false, canDelete: false, employees: roster,
              entries: roster.map(employee => ({ employeeId: employee.id, workDate: `${month}-02`, hours: 8, masters: "Тестовый мастер", zones: "Зона А", reportTracked: true })), marks: [],
            });
          }
          return json(response, { error: "API не подключён к этому изолированному стенду." }, 404);
        } catch (error) { return json(response, { error: error.message }, 400); }
      });
    },
  }],
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
