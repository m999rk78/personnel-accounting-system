import type { ExcelExportPreviewPayload } from "./excelExportPreviewStore";

/** One leaf-heading per copied column; merged metadata/filter headings are decorative. */
export function excelPreviewClipboardHeaders(payload: ExcelExportPreviewPayload | null) {
  if (!payload) return [];
  const workbook = payload.workbook;
  if (workbook.kind === "personnel-timesheet" || workbook.kind === "equipment-timesheet") {
    const days = Array.from({ length: Math.max(31, workbook.dates.length) }, (_, index) => workbook.dates[index] ? String(Number(workbook.dates[index].slice(8))) : "");
    return workbook.kind === "personnel-timesheet"
      ? ["Тип", "Отдел", "Фамилия, имя, отчество", "Должность", "Примечание к должности", ...days, "ЧАСЫ", "РАСТ", "Мастер"]
      : ["Тип", "Уникальное наименование единицы", "ГРЗ", ...days, "ЧАСЫ", "ПРОСТОЙ", "РАСТ"];
  }
  return workbook.kind === "placement" || workbook.kind === "equipment-placement" ? payload.headers : ["№", ...payload.headers];
}

/** The same body cells as the preview; decorative template headings are excluded. */
export function excelPreviewClipboardRows(payload: ExcelExportPreviewPayload | null) {
  if (!payload) return [];
  const workbook = payload.workbook;
  if (workbook.kind === "personnel-timesheet") {
    const dayCount = Math.max(31, workbook.dates.length);
    return workbook.rows.map(row => [row.employmentType, row.department, row.fullName, row.position, row.positionNote,
      ...Array.from({ length: dayCount }, (_, index) => row.dailyValues[index] ?? ""), row.timesheetHours,
      row.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР" ? row.timesheetHours - row.reportHours : 0, row.masters]);
  }
  if (workbook.kind === "equipment-timesheet") {
    const dayCount = Math.max(31, workbook.dates.length);
    return workbook.rows.map(row => {
      const parts = row.equipmentName.split("//").map(part => part.trim());
      return [row.equipmentType ?? parts[0] ?? "", row.equipmentName, row.registrationNumber ?? parts[2] ?? "",
        ...Array.from({ length: dayCount }, (_, index) => row.dailyProductiveHours[index] || ""), row.productiveHours,
        row.downtimeHours, row.productiveHours + row.downtimeHours - (row.reportHours ?? row.totalHours)];
    });
  }
  const placement = workbook.kind === "placement" || workbook.kind === "equipment-placement";
  return payload.rows.map((row, rowIndex) => {
    const values = payload.headers.map((_, columnIndex) => {
      const value = row[columnIndex];
      if (placement && columnIndex === 0 && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00Z`));
      }
      return value == null || value === "" ? placement ? "" : "—" : value;
    });
    return placement ? values : [rowIndex + 1, ...values];
  });
}
