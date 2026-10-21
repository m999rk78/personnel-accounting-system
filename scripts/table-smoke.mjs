// Isolated browser harness: synthetic records only; no database, env file or real API.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const personnelMarks = new Map();
const equipmentMarks = new Map();
const employees = Array.from({ length: 2_000 }, (_, i) => ({ id: i + 1, fullName: `Тестовый сотрудник ${String(i + 1).padStart(4, "0")}`, employmentType: "ОПР", department: i % 2 ? "Отдел А" : "Отдел Б", position: "Тестовая должность" }));
const units = Array.from({ length: 1_000 }, (_, i) => ({ id: i + 1, organization: "Тестовая организация", equipmentType: "Экскаватор", brand: "Тест", model: String(i + 1).padStart(4, "0"), registrationNumber: `ТЕСТ-${i + 1}`, note: "" }));
const outDir = await mkdtemp(join(tmpdir(), "personnel-table-smoke-"));
const config = {
  configFile: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  build: { outDir, emptyOutDir: false },
  plugins: [react(), {
    name: "isolated-table-fixtures",
    configurePreviewServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (!["/api/timesheet", "/api/equipment"].includes(url.pathname)) return next();
        response.setHeader("Content-Type", "application/json");
        const personnel = url.pathname === "/api/timesheet";
        const marks = personnel ? personnelMarks : equipmentMarks;
        if (request.method === "POST") {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw);
          const key = `${body.employeeId ?? body.equipmentId}:${body.workDate}`;
          const clear = personnel ? !body.value : body.clear;
          const mark = personnel
            ? { employeeId: body.employeeId, workDate: body.workDate, hours: /^\d+$/.test(body.value) ? Number(body.value) : null, code: /^\d+$/.test(body.value) ? null : body.value, note: body.note ?? "", updatedBy: "Тест" }
            : { equipmentId: body.equipmentId, workDate: body.workDate, productiveHours: body.productiveHours, downtimeHours: body.downtimeHours, note: body.note ?? "", updatedBy: "Тест" };
          if (clear) marks.delete(key); else marks.set(key, mark);
          response.end(JSON.stringify(clear ? { deleted: true } : { mark }));
          return;
        }
        const month = url.searchParams.get("month") ?? "2026-10";
        const common = { siteId: 1, siteName: "Тестовый проект", month, entries: [], marks: [...marks.values()].filter((mark) => mark.workDate.startsWith(month)) };
        response.end(JSON.stringify(personnel
          ? { ...common, employees, canEdit: true, canCreate: true, canUpdate: true, canDelete: true }
          : { ...common, units, availableUnits: [], sites: [], workDate: `${month}-21`, currentUserRole: "superadmin", currentUserName: "Тест", canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, dailyTimesheetMarks: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], filledDates: [], foremanProgress: [] }));
      });
    },
  }],
  preview: { host: "127.0.0.1", port: 3100, strictPort: true },
};
await build(config);
const server = await preview(config);
server.printUrls();
