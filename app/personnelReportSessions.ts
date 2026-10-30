import type { PersonnelReport } from "./personnelReportTypes";

export type PersonnelReportSessions = Record<string, PersonnelReport>;

function validReportDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** A new report retains its own work date even when another day is edited. */
export function personnelReportNewKey(date: string): string {
  if (!validReportDate(date)) throw new Error("Укажите корректную дату отчёта.");
  return `new:${date}`;
}

export function personnelReportNewDate(key: string, today: string): string | null {
  const date = key === "new" ? today : key.startsWith("new:") ? key.slice(4) : "";
  return validReportDate(date) ? date : null;
}

/** A later GET is not permission to rebase an unsaved edit onto a new version. */
export function freezePersonnelReportSessions(current: PersonnelReportSessions, reports: PersonnelReport[], keys: Iterable<string>): PersonnelReportSessions {
  const additions = [...keys].flatMap(key => {
    const report = reports.find(item => String(item.id) === key);
    return report && !current[key] ? [[key, report] as const] : [];
  });
  return additions.length ? { ...current, ...Object.fromEntries(additions) } : current;
}

export function mergePersonnelReportSessions(reports: PersonnelReport[], sessions: PersonnelReportSessions, editedKeys: Iterable<string>): PersonnelReport[] {
  const combined = new Map(reports.map(report => [String(report.id), report]));
  for (const key of editedKeys) if (sessions[key]) combined.set(key, sessions[key]);
  return [...combined.values()].sort((left, right) => right.workDate.localeCompare(left.workDate) || right.id - left.id);
}

export function personnelReportSaveIdentity(key: string, sessions: PersonnelReportSessions, siteId: number, today: string) {
  const report = sessions[key];
  const newDate = personnelReportNewDate(key, today);
  if (!newDate && !report) throw new Error("Не найдена исходная версия черновика. Отмените изменения и откройте отчёт заново.");
  return { siteId: report?.siteId ?? siteId, workDate: report?.workDate ?? newDate!, ...(report ? { reportId: report.id, revision: report.revision } : {}) };
}

/** Select an import's own editable day without silently rebasing dirty edits. */
export function personnelReportImportTarget(reports: PersonnelReport[], sessions: PersonnelReportSessions, siteId: number, userId: number, workDate: string): string {
  const newKey = personnelReportNewKey(workDate);
  const candidates = mergePersonnelReportSessions(reports, sessions, Object.keys(sessions))
    .filter(report => report.siteId === siteId && report.ownerUserId === userId && report.workDate === workDate && report.status !== "approved");
  if (candidates.length > 1) throw new Error(`За ${workDate} найдено несколько незавершённых отчётов. Обновите таблицу и проверьте черновики.`);
  const existing = candidates[0];
  if (!existing) return newKey;
  if (existing.status === "submitted") throw new Error(`Отчёт за ${workDate} уже отправлен на проверку. Сначала снимите его с проверки.`);
  return String(existing.id);
}

export function personnelReportSubmissionTargets(reports: PersonnelReport[], userId: number, today: string, explicitReportId?: number, includedDates?: Iterable<string>) {
  const dates = new Set(includedDates ?? [today]);
  return reports.filter(report => (report.status === "draft" || report.status === "rejected") && (explicitReportId === undefined ? report.ownerUserId === userId && dates.has(report.workDate) : report.id === explicitReportId));
}
