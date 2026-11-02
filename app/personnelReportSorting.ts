export const personnelReportSortOptions = [
  { label: "Сначала добавленные недавно", columnId: "createdAt", sort: "desc" },
  { label: "Сначала добавленные давно", columnId: "createdAt", sort: "asc" },
  { label: "Сначала изменённые недавно", columnId: "updatedAt", sort: "desc" },
  { label: "Сначала изменённые давно", columnId: "updatedAt", sort: "asc" },
  { label: "По дате отчёта: новые сверху", columnId: "workDate", sort: "desc" },
  { label: "По дате отчёта: старые сверху", columnId: "workDate", sort: "asc" },
  { label: "Ручной порядок внутри даты", columnId: "", sort: null },
] as const;

export const personnelReportImportSortOptions = [
  { label: "Порядок импорта", columnId: "__importOrder", sort: "asc" },
  ...personnelReportSortOptions,
] as const;

export function personnelActivityTime(value: string | undefined, workDate: string) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.parse(`${workDate}T00:00:00Z`) || 0;
}

/** Source rows are newest first; reverse that order for oldest-first batches. */
export function comparePersonnelActivity(leftTime: number, rightTime: number, leftRank: number, rightRank: number) {
  return leftTime - rightTime || rightRank - leftRank;
}
