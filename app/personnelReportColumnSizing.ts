import { reportColumnWidths, type ReportColumnSizing, type ReportTextMeasure } from "./reportColumnSizing.ts";

/** These bounds apply only to the initial layout; manual resizing remains unrestricted. */
export const PERSONNEL_REPORT_COLUMN_SIZING = {
  workDate: { header: "Дата", min: 125, max: 125, cellPadding: 44 },
  employeeName: { header: "ФИО", min: 280, max: 560, cellPadding: 48 },
  status: { header: "Статус", min: 156, max: 240, cellPadding: 52 },
  responsibleUserName: { header: "Ответственный", min: 240, max: 560, cellPadding: 40 },
  employmentType: { header: "Тип", min: 80, max: 120, cellPadding: 32 },
  department: { header: "Отдел", min: 116, max: 320, cellPadding: 32 },
  position: { header: "Должность", min: 240, max: 720, cellPadding: 40 },
  shift: { header: "Смена", min: 100, max: 180, cellPadding: 44 },
  zone: { header: "Зона", min: 200, max: 600, cellPadding: 44 },
  mainWork: { header: "Вид работы", min: 240, max: 720, cellPadding: 44 },
  subwork: { header: "Подвид работы", min: 240, max: 720, cellPadding: 44 },
  master: { header: "Мастер", min: 240, max: 560, cellPadding: 44 },
  hours: { header: "Часы", min: 84, max: 96, cellPadding: 44 },
  note: { header: "Примечание", min: 240, max: 640, cellPadding: 28 },
} as const satisfies Record<string, ReportColumnSizing>;

export type PersonnelReportSizedColumn = keyof typeof PERSONNEL_REPORT_COLUMN_SIZING;
export type PersonnelReportColumnValues = Readonly<Partial<Record<PersonnelReportSizedColumn, string | number | null>>>;
export type PersonnelReportTextMeasure = ReportTextMeasure;

/** Size from the full report, including rows and columns outside the virtualized viewport. */
export function personnelReportColumnWidths(values: readonly PersonnelReportColumnValues[], measure: PersonnelReportTextMeasure): Record<PersonnelReportSizedColumn, number> {
  return reportColumnWidths(PERSONNEL_REPORT_COLUMN_SIZING, values, measure);
}
