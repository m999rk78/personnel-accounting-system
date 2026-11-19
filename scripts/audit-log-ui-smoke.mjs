// Actual audit UI with synthetic events only. No .env, authentication or database access.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = { actorUserId: 3, actorName: "Алексей Смирнов", actorRole: "engineer", siteId: 2, siteName: "Северный участок", createdAt: "2026-11-18T08:30:00.000Z" };
const employee = { kind: "employee", id: 7, label: "Иван Петров" };
const projects = [{ kind: "project", id: 2, label: "Северный участок" }, { kind: "project", id: 3, label: "Южный участок" }];
const events = [
  { ...base, id: 6, category: "directories", actionKey: "employee.update", entityType: "employee", entityId: "7", summary: "Изменил сотрудника «Иван Петров»", beforeData: null,
    afterData: { requested: { action: "update-employee", employeeId: 7, fullName: "Иван Петров", projectSiteId: 3, assignmentStartDate: "2026-11-18", position: "Монтажник" }, result: { ok: true }, context: { version: 1, references: [employee, ...projects], before: { id: 7, fullName: "Иван Петров", projectSiteId: 2, position: "Монтажник", assignments: [{ siteId: 2, siteName: "Северный участок", startDate: "2026-11-01", endDate: null }] } } } },
  { ...base, id: 5, category: "timesheets", actionKey: "personnel_timesheet.set", entityType: "employee_timesheet", entityId: "7", summary: "Установил отметку «10» в табеле рабочих за 2026-11-16", beforeData: { hours: 8, code: null, note: "", employeeName: "Иван Петров" },
    afterData: { requested: { siteId: 2, employeeId: 7, workDate: "2026-11-16", value: "10", note: "Исправлено по отчёту" }, result: { mark: { hours: 10, code: null, note: "Исправлено по отчёту" } }, context: { version: 1, references: [employee, ...projects] } } },
  { ...base, id: 4, category: "reports", actionKey: "personnel_report.change-date", entityType: "personnel_report_draft", entityId: "43", summary: "Изменил дату отчёта рабочих на 2026-11-16", beforeData: { id: 43, siteId: 2, workDate: "2026-11-18", status: "draft", rows: [{ id: 21, employee_id: 7, hours: 8, note: "", employee_name_snapshot: "Иван Петров" }] },
    afterData: { requested: { action: "change-date", reportId: 43, workDate: "2026-11-16" }, result: { report: { id: 43, siteId: 2, workDate: "2026-11-16", status: "draft", rows: [{ id: 21, employeeId: 7, employeeName: "Иван Петров", hours: 8, note: "" }] } }, context: { version: 1, references: [employee, ...projects] } } },
  { ...base, id: 3, category: "directories", actionKey: "table.reorder", entityType: "table_row_order", entityId: "project-personnel", summary: "Изменил порядок строк таблицы · перемещено: 2", beforeData: null,
    afterData: { requested: { scope: "project-personnel", siteId: 2, movingIds: ["7", "8"], targetId: "9", placement: "before" }, result: { ids: [7, 8, 9] }, context: { version: 1, references: [employee, ...projects], rowLabels: [{ id: "7", label: "Иван Петров", entityKind: "employee", entityId: 7 }, { id: "8", label: "Сергей Иванов", entityKind: "employee", entityId: 8 }, { id: "9", label: "Дмитрий Соколов", entityKind: "employee", entityId: 9 }] } } },
  { ...base, id: 2, category: "directories", actionKey: "employee.delete", entityType: "employee", entityId: "12", summary: "Удалил сотрудников: 1", beforeData: null,
    afterData: { requested: { entity: "employee", ids: [12] }, result: { ok: true }, context: { version: 1, references: [{ kind: "employee", id: 12, label: "Павел Орлов" }], before: { id: 12, fullName: "Павел Орлов", position: "Сварщик", projectSiteId: 2 } } } },
  { ...base, id: 1, category: "timesheets", actionKey: "equipment_timesheet.set", entityType: "equipment_timesheet", entityId: "", summary: "Изменил табель техники за 2026-11-16", beforeData: null,
    afterData: { requested: { siteId: 2, equipmentId: 4, workDate: "2026-11-16", productiveHours: 8, downtimeHours: 0, note: "После ремонта" }, result: { ok: true } } },
];

const config = {
  configFile: false, envDir: false, publicDir: false, logLevel: "warn",
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  build: { outDir: await mkdtemp(join(tmpdir(), "personnel-audit-ui-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/audit-log.html", import.meta.url)) } },
  plugins: [react(), { name: "audit-log-fixture", configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url, "http://localhost").pathname;
      if (!path.startsWith("/api/")) return next();
      const okay = path === "/api/audit-log" && request.method === "GET";
      response.writeHead(okay ? 200 : 403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(okay ? { events } : { error: "Доступны только учебные события журнала" }));
    });
  } }],
  preview: { host: "127.0.0.1", port: Number(process.argv[2] ?? 3192), strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
