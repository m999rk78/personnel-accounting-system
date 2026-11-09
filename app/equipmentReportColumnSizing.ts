import { reportColumnWidths, type ReportColumnSizing, type ReportTextMeasure } from "./reportColumnSizing.ts";

/** Initial bounds only: users can resize descriptive columns beyond these limits. */
export const EQUIPMENT_REPORT_COLUMN_SIZING = {
  workDate: { header: "Дата", min: 125, max: 125, cellPadding: 44 },
  equipment: { header: "Техника", min: 280, max: 640, cellPadding: 48 },
  status: { header: "Статус", min: 156, max: 240, cellPadding: 52 },
  responsibleUserName: { header: "Ответственный", min: 240, max: 560, cellPadding: 40 },
  organization: { header: "Организация", min: 160, max: 360, cellPadding: 32 },
  equipmentType: { header: "Тип техники", min: 150, max: 240, cellPadding: 32 },
  brand: { header: "Марка", min: 130, max: 240, cellPadding: 32 },
  model: { header: "Модель", min: 160, max: 420, cellPadding: 32 },
  registrationNumber: { header: "ГРЗ / Инв. №", min: 155, max: 240, cellPadding: 32 },
  shift: { header: "Смена", min: 100, max: 180, cellPadding: 44 },
  zone: { header: "Зона", min: 200, max: 600, cellPadding: 44 },
  mainWork: { header: "Вид работы", min: 240, max: 720, cellPadding: 44 },
  subwork: { header: "Подвид работы", min: 240, max: 720, cellPadding: 44 },
  hours: { header: "Часы", min: 84, max: 96, cellPadding: 44 },
  note: { header: "Примечание", min: 240, max: 640, cellPadding: 28 },
} as const satisfies Record<string, ReportColumnSizing>;

export type EquipmentReportSizedColumn = keyof typeof EQUIPMENT_REPORT_COLUMN_SIZING;
export type EquipmentReportColumnValues = Readonly<Partial<Record<EquipmentReportSizedColumn, string | number | null>>>;

export function equipmentReportColumnWidths(values: readonly EquipmentReportColumnValues[], measure: ReportTextMeasure): Record<EquipmentReportSizedColumn, number> {
  return reportColumnWidths(EQUIPMENT_REPORT_COLUMN_SIZING, values, measure);
}
