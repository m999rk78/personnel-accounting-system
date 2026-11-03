// Build and serve a disposable fixture. No database, env files or browser driver.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 3144);
let startsAt = 0;
let endsAt = 0;
let writes = 0;
const marks = new Map();
const json = (response, body, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
const maintenance = () => Date.now() >= startsAt && Date.now() < endsAt;
const config = {
  configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  build: { outDir: await mkdtemp(join(tmpdir(), "personnel-maintenance-ui-")), rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/maintenance.html", import.meta.url)) } },
  plugins: [react(), { name: "maintenance-fixture", configurePreviewServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
      if (url.pathname === "/__smoke/start" && request.method === "POST") { startsAt = Date.now() + 3000; endsAt = startsAt + 120000; return json(response, { scheduled: true }); }
      if (url.pathname === "/__smoke/stats") return json(response, { writes });
      if (url.pathname === "/api/maintenance/status") return json(response, { maintenance: maintenance(), phase: maintenance() ? "maintenance" : "ready", retryAfterSeconds: 5 });
      if (maintenance()) { response.setHeader("X-Personnel-Maintenance", "1"); return json(response, { code: "MAINTENANCE", maintenance: true, error: "Ведутся технические работы" }, 503); }
      if (url.pathname === "/api/table-order" && request.method === "GET") return json(response, { ids: [], canWrite: false, hasSavedOrder: false, importIds: [], hasImportOrder: false });
      if (url.pathname === "/api/timesheet" && request.method === "GET") return json(response, { siteId: 1, siteName: "Учебный проект", month: "2026-11", canEdit: true, canCreate: true, canUpdate: true, canDelete: true, employees: [{ id: 1, fullName: "Учебный сотрудник", employmentType: "ОПР", department: "Монтаж", position: "Монтажник" }], entries: [], marks: [...marks.values()] });
      if (url.pathname === "/api/timesheet" && request.method === "POST") {
        let raw = ""; for await (const chunk of request) { raw += chunk; if (raw.length > 5000) return json(response, { error: "Слишком большой запрос" }, 413); }
        const body = JSON.parse(raw);
        if (body.siteId !== 1 || body.employeeId !== 1 || !/^2026-11-\d{2}$/.test(body.workDate) || !/^(?:[1-9]|10)$/.test(body.value)) return json(response, { error: "Допустимы только учебные часы" }, 400);
        writes++;
        const mark = { employeeId: 1, workDate: body.workDate, hours: Number(body.value), code: null, note: "", updatedBy: "Проверка" };
        marks.set(body.workDate, mark); return json(response, { mark });
      }
      return json(response, { error: "Остальные запросы заблокированы учебным стендом" }, 403);
    });
  } }],
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
