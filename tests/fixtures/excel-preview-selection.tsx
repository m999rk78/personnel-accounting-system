import { createRoot } from "react-dom/client";
import { ExcelExportPreviewPage } from "../../app/ExcelExportPreview";
import { prepareExcelExportPreview, type ExcelExportPreviewPayload } from "../../app/excelExportPreviewStore";
import "../../app/globals.css";

const rows = [["Первый тестовый сотрудник", 6], ["Второй тестовый сотрудник", 0]];
let payload: ExcelExportPreviewPayload = {
  version: 1, title: "Изолированная проверка копирования", description: "Только вымышленные данные",
  fileName: "test-selection.xlsx", headers: ["ФИО", "Часы"], rows,
  workbook: { kind: "table", sheetName: "Тест", workbookTitle: "Тест", rows },
};
const kind = new URLSearchParams(location.search).get("kind");
if (kind === "personnel-timesheet") payload = { ...payload, workbook: {
  kind, siteName: "Учебный", monthLabel: "Ноябрь", dates: ["2026-11-01", "2026-11-02"],
  rows: [{ employmentType: "ОПР", department: "Учебный", fullName: "Тестовый сотрудник", position: "Монтажник", positionNote: "",
    dailyValues: [6, 0], dailyTimesheetHours: [6, 0], dailyReportHours: [4, 0], dailyMasters: ["", ""], timesheetHours: 6, reportHours: 4, masters: "Тестовый мастер" }],
  dayTotals: [6, 0], totalHours: 6, totalDifference: 2,
} };
if (kind === "equipment-timesheet") payload = { ...payload, workbook: {
  kind, siteName: "Учебный", monthLabel: "Ноябрь", dates: ["2026-11-01", "2026-11-02", "2026-11-03"],
  rows: [{ equipmentName: "Кран // Тест // А001", organization: "Учебная", equipmentType: "Кран", registrationNumber: "А001", dailyValues: ["6 / П 2", "П 8", 0],
    dailyProductiveHours: [6, 0, 0], dailyDowntimeHours: [2, 8, 0], productiveHours: 6, downtimeHours: 10, totalHours: 16, reportHours: 16 }],
  dayTotals: [8, 8, 0], productiveTotal: 6, downtimeTotal: 10, totalHours: 16,
} };
if (kind === "placement" || kind === "equipment-placement") payload = { ...payload,
  headers: kind === "placement" ? ["Дата", "ФИО", "Смена", "Зона", "Вид работы", "Подвид", "Примечание", "Мастер", "Часы", "Тип"] : ["Дата", "Техника", "Смена", "Зона", "Вид работы", "Подвид", "Примечание", "Часы"],
  rows: kind === "placement" ? [["2026-11-01", "Тестовый сотрудник", "День", "Зона 1", "Работа", "Подвид", "", "Мастер", 6, "ОПР"]] : [["2026-11-01", "Тестовая техника", "День", "Зона 1", "Работа", "Подвид", "", 6]],
  workbook: { kind, siteName: "Учебный", rangeStart: "2026-11-01", rangeEnd: "2026-11-01", rows: [] },
};
const query = prepareExcelExportPreview(payload).split("?")[1];
const payloadUrl = new URLSearchParams(query).get("payload");
history.replaceState({}, "", `${location.pathname}?${query}`);
// No real API or external request is reachable from this fixture.
window.fetch = async input => String(input) === payloadUrl
  ? Response.json(payload)
  : Response.json({ error: "Запрос заблокирован тестовым стендом." }, { status: 403 });
createRoot(document.getElementById("root")!).render(<ExcelExportPreviewPage />);
