export type ReportSourceFilter = {
  from?: string;
  to?: string;
  zoneId?: number | null;
};

export function reportRowMatchesSource(row: { workDate: string; entry?: { zoneId?: number | null }; draft?: { zoneId: string } }, source: ReportSourceFilter | undefined) {
  if (!source) return true;
  const zoneId = row.draft ? Number(row.draft.zoneId) || null : row.entry?.zoneId || null;
  return (!source.from || row.workDate >= source.from)
    && (!source.to || row.workDate <= source.to)
    && (source.zoneId === undefined || zoneId === source.zoneId);
}

export function isStatisticsPersonnel(employmentType: string | undefined) {
  return employmentType?.trim().toLocaleUpperCase("ru-RU") === "ОПР";
}
