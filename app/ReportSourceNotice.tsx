import { formatStatisticsDate } from "./statisticsPeriod";
import type { ReportSourceFilter } from "./reportSourceFilter";

export function ReportSourceNotice({ source, zones, personnel, onClear }: {
  source: ReportSourceFilter;
  zones: readonly { id: number; name: string }[];
  personnel?: boolean;
  onClear?: () => void;
}) {
  const period = source.from && source.to
    ? source.from === source.to ? formatStatisticsDate(source.from) : `${formatStatisticsDate(source.from)} — ${formatStatisticsDate(source.to)}`
    : "За весь период";
  const zone = source.zoneId === null ? "Без зоны" : zones.find(zone => zone.id === source.zoneId)?.name ?? "Выбранная зона";
  return <div className="personnel-report-focused-caption" role="status">
    <span>Из статистики · {period}{source.zoneId !== undefined && ` · ${zone}`}{personnel && " · ОПР"}</span>
    {onClear && <button type="button" onClick={onClear}>Показать все подтверждённые</button>}
  </div>;
}
