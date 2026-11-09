import { createRoot } from "react-dom/client";
import { ExcelExportPreviewPage } from "../../app/ExcelExportPreview";
import { prepareExcelExportPreview, type ExcelExportPreviewPayload } from "../../app/excelExportPreviewStore";
import "../../app/globals.css";

const rows = [["Первый тестовый сотрудник", 6], ["Второй тестовый сотрудник", 0]];
const payload: ExcelExportPreviewPayload = {
  version: 1, title: "Изолированная проверка копирования", description: "Только вымышленные данные",
  fileName: "test-selection.xlsx", headers: ["ФИО", "Часы"], rows,
  workbook: { kind: "table", sheetName: "Тест", workbookTitle: "Тест", rows },
};
const query = prepareExcelExportPreview(payload).split("?")[1];
const payloadUrl = new URLSearchParams(query).get("payload");
history.replaceState({}, "", `${location.pathname}?${query}`);
// No real API or external request is reachable from this fixture.
window.fetch = async input => String(input) === payloadUrl
  ? Response.json(payload)
  : Response.json({ error: "Запрос заблокирован тестовым стендом." }, { status: 403 });
createRoot(document.getElementById("root")!).render(<ExcelExportPreviewPage />);
