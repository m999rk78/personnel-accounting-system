import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgGridProvider } from "ag-grid-react";
import { AllCommunityModule } from "ag-grid-community";
import { TimesheetView } from "../../app/TimesheetView";
import { EquipmentAccountingView } from "../../app/EquipmentAccountingView";
import "../../app/globals.css";

const employees = Array.from({ length: 120 }, (_, index) => ({
  id: index + 1, fullName: `Тестовый сотрудник ${String(index + 1).padStart(3, "0")}`,
  employmentType: "ИТР", department: "Тестовый участок", position: "Инженер",
}));
const units = employees.map(({ id }) => ({ id, organization: "Тестовая организация", equipmentType: "Кран", brand: "Тест", model: `Модель ${String(id).padStart(3, "0")}`, registrationNumber: `ТЕСТ-${id}`, note: "" }));
const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
let blockedWrites = 0;

window.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  if (request.method !== "GET") {
    blockedWrites++;
    const output = document.querySelector("[data-fixture-writes]");
    if (output) output.textContent = String(blockedWrites);
    return Response.json({ error: "Изолированный стенд: запись отключена" }, { status: 405 });
  }
  const url = new URL(request.url);
  if (url.pathname === "/api/timesheet") return Response.json({
    siteId: 1, siteName: "Изолированный проект", month: "2026-10", employees,
    entries: employees.flatMap(employee => dates.map((workDate, index) => ({ employeeId: employee.id, workDate, hours: 4 + (employee.id + index) % 7, masters: "Тестовый ответственный", zones: "Тестовая зона" }))),
    marks: [], canEdit: true, canCreate: true, canUpdate: true, canDelete: true,
  });
  if (url.pathname === "/api/equipment") return Response.json({
    siteId: 1, siteName: "Изолированный проект", month: "2026-10", workDate: "2026-10-21", units,
    sites: [], entries: [], marks: units.flatMap(unit => dates.map((workDate, index) => ({ equipmentId: unit.id, workDate, productiveHours: 4 + (unit.id + index) % 7, downtimeHours: index === 1 ? 1 : 0, note: "Тестовая отметка", updatedBy: "Тестовый пользователь" }))),
    dailyTimesheetMarks: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], foremanProgress: [], filledDates: [],
    currentUserRole: "superadmin", currentUserName: "Проверка", canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true,
  });
  return Response.json({ error: "Неизвестный запрос стенда" }, { status: 404 });
};

function Fixture() {
  const [kind, setKind] = useState<"workers" | "equipment">("workers");
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16 }}>
    <nav style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
      <strong>Изолированный стенд: 120 строк, рабочие данные не используются</strong>
      <button onClick={() => setKind("workers")}>Табель персонала</button>
      <button onClick={() => setKind("equipment")}>Табель техники</button>
      <span>Попыток записи: <output aria-label="Попыток записи" data-fixture-writes>0</output></span>
    </nav>
    <div className="timesheet-workspace-page" style={{ flex: 1, minHeight: 0 }}>
      <div id={kind === "workers" ? "personnel-timesheet-actions" : "equipment-timesheet-actions"} />
      {kind === "workers" ? <TimesheetView siteId={1} initialMonth="2026-10" today="2026-10-21" />
        : <EquipmentAccountingView siteId={1} initialDate="2026-10-21" initialMonth="2026-10" today="2026-10-21" mode="month" />}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllCommunityModule]}><Fixture /></AgGridProvider>);
