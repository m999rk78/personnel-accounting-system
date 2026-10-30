export type PersonnelReportSubmissionItem = {
  key: string; workDate: string; ownerUserId: number; status: string; rowCount: number;
};

const canSubmit = (item: PersonnelReportSubmissionItem) => (item.status === "draft" || item.status === "rejected") && item.rowCount > 0;

/** All of a foreman's unfinished dates are selected, including previous days. */
export function defaultPersonnelReportSubmissions<T extends PersonnelReportSubmissionItem>(items: T[], userId: number): string[] {
  return items.filter(item => item.ownerUserId === userId && canSubmit(item)).map(item => item.key);
}

/** A send action has an explicit scope and never silently includes another date or owner. */
export function selectPersonnelReportSubmissions<T extends PersonnelReportSubmissionItem>(items: T[], selectedKeys: string[]): T[] {
  if (!selectedKeys.length) throw new Error("Выберите хотя бы один отчёт для отправки.");
  const selected = new Set(selectedKeys);
  const result = items.filter(item => selected.has(item.key) && canSubmit(item));
  if (result.length !== selected.size) throw new Error("Список отчётов изменился. Проверьте выбранные даты и повторите отправку.");
  return result.sort((left, right) => right.workDate.localeCompare(left.workDate));
}

/** Unrelated drafts must never block the review of a submitted report. */
export function personnelReportReviewIssue(reportId: number, editedKeys: Iterable<string>): string | null {
  return new Set(editedKeys).has(String(reportId)) ? "В этом отчёте есть несохранённые изменения. Сохраните или отмените их перед проверкой." : null;
}
