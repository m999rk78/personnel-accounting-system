"use client";

import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { StatisticsChart, type StatisticsSeries } from "./StatisticsChart";
import { StatisticsPeriodPicker } from "./StatisticsPeriodPicker";
import { statisticsPeriodQuery, statisticsPresetRange, type StatisticsPeriodSelection } from "./statisticsPeriod";
import { StatisticsBreakdownTable } from "./StatisticsZoneTable";
import type { ReportSourceFilter } from "./reportSourceFilter";
import type { StatisticsBreakdownRow, StatisticsGrouping, StatisticsKind } from "./statisticsTypes";
import { formatTimesheetHours } from "./timesheetFormatting";
import "./statistics.css";

const tabNames: Record<StatisticsKind, string> = { personnel: "Персонал", equipment: "Техника" };
const groupings = ["zone", "day"] as const;
const groupingNames: Record<StatisticsGrouping, string> = { zone: "По зонам", day: "По дням" };
const seriesByKind: Record<StatisticsKind, readonly StatisticsSeries[]> = {
  personnel: [
    { key: "welders", name: "Сварщики", color: "#285fc2" },
    { key: "installers", name: "Монтажники", color: "#bf4946" },
    { key: "other", name: "Прочие сотрудники", color: "#6b7280" },
  ],
  equipment: [
    { key: "productive", name: "Работа", color: "#26734d" },
    { key: "downtime", name: "Простой", color: "#a56a15" },
  ],
};
type Result = { key: string; rows: StatisticsBreakdownRow[] } | { key: string; error: string };

export type StatisticsViewProps = {
  siteId: number;
  today: string;
  kind: StatisticsKind;
  availableKinds: readonly StatisticsKind[];
  onSelectKind: (kind: StatisticsKind) => void;
  onOpenReports?: (source: ReportSourceFilter) => void;
};

function hours(value: number) { return `${formatTimesheetHours(value)} ч`; }

function StatisticsTotals({ series, rows }: { series: readonly StatisticsSeries[]; rows: StatisticsBreakdownRow[] | null }) {
  const totals = useMemo(() => rows?.reduce((result, row) => {
    result.total += row.total;
    for (const { key } of series) result[key] += row[key];
    return result;
  }, { total: 0, welders: 0, installers: 0, other: 0, productive: 0, downtime: 0 }), [series, rows]);

  return <dl className="statistics-totals" aria-label="Итоги по выборке">
    <div className="statistics-total statistics-total-all"><dt>Всего часов</dt><dd>{totals ? hours(totals.total) : "—"}</dd></div>
    {series.map(({ key, name, color }) => <div className="statistics-total" key={key}>
      <dt><i style={{ backgroundColor: color }} aria-hidden="true" />{key === "other" ? "Прочие" : name}</dt>
      <dd>{totals ? hours(totals[key]) : "—"}</dd>
    </div>)}
  </dl>;
}

function moveTab<T extends string>(event: KeyboardEvent<HTMLButtonElement>, index: number, tabs: readonly T[], id: string, select: (tab: T) => void) {
  const count = tabs.length;
  const next = event.key === "ArrowRight" ? (index + 1) % count
    : event.key === "ArrowLeft" ? (index + count - 1) % count
    : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : -1;
  if (next < 0) return;
  event.preventDefault();
  const target = tabs[next];
  document.getElementById(`${id}-${target}`)?.focus();
  select(target);
}

export function StatisticsView({ siteId, today, kind, availableKinds, onSelectKind, onOpenReports }: StatisticsViewProps) {
  const tabId = useId();
  const groupTabId = `${tabId}-group`;
  const [groupBy, setGroupBy] = useState<StatisticsGrouping>("zone");
  const byDay = groupBy === "day";
  const [period, setPeriod] = useState<StatisticsPeriodSelection>(() => ({ preset: "month", range: statisticsPresetRange("month", today) }));
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [zoneSearch, setZoneSearch] = useState({ requestKey: "", text: "" });
  const [tableRows, setTableRows] = useState<{ source: StatisticsBreakdownRow[]; search: string; filtered: StatisticsBreakdownRow[] } | null>(null);
  const scopeQuery = new URLSearchParams({ siteId: String(siteId), kind, ...statisticsPeriodQuery(period) }).toString();
  const query = byDay ? `${scopeQuery}&groupBy=day` : scopeQuery;
  const requestKey = `${query}:${refresh}`;
  const current = result?.key === requestKey ? result : null;
  const rows = current && "rows" in current ? current.rows : null;
  const search = !byDay && zoneSearch.requestKey === scopeQuery ? zoneSearch.text : "";
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    return query ? rows?.filter(row => "zone" in row && row.zone.toLocaleLowerCase("ru-RU").includes(query)) ?? null : rows;
  }, [rows, search]);
  const filteredRows = tableRows?.source === rows && tableRows.search === search ? tableRows.filtered : visibleRows;
  const updateFilteredRows = useCallback((filtered: StatisticsBreakdownRow[]) => {
    if (!rows) return;
    setTableRows(current => current?.source === rows && current.search === search && current.filtered.length === filtered.length && filtered.every((row, index) => row === current.filtered[index])
      ? current : { source: rows, search, filtered });
  }, [rows, search]);
  const clearSearch = useCallback(() => setZoneSearch({ requestKey: scopeQuery, text: "" }), [scopeQuery]);
  const maxHours = useMemo(() => filteredRows?.reduce((max, row) => Math.max(max, row.total), 0) ?? 0, [filteredRows]);
  const series = seriesByKind[kind];
  const reportActionLabel = kind === "personnel" ? "Открыть отчёт персонала" : "Открыть отчёт техники";
  const openReports = onOpenReports ? (row: StatisticsBreakdownRow) => {
    const source = "workDate" in row
      ? { from: row.workDate, to: row.workDate }
      : { ...(period.preset === "all" ? {} : period.range), zoneId: row.zoneId };
    onOpenReports(source);
  } : undefined;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/statistics?${query}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { rows?: StatisticsBreakdownRow[]; error?: string };
        if (!response.ok || !Array.isArray(payload.rows)) throw new Error(payload.error || "Не удалось загрузить статистику.");
        if (!controller.signal.aborted) setResult({ key: requestKey, rows: payload.rows });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: requestKey, error: error instanceof Error && error.message.startsWith("Нет доступа") ? error.message : "Не удалось загрузить статистику." });
      }
    }
    void load();
    return () => controller.abort();
  }, [query, requestKey]);

  return <div className="statistics-view">
    <header className="page-heading workspace-page-heading statistics-heading">
      <div className="page-heading-title"><h1>Статистика</h1></div>
      <div className="statistics-tabs" role="tablist" aria-label="Вид статистики">
        {availableKinds.map((tab, index) => <button key={tab} id={`${tabId}-${tab}`} type="button" role="tab"
          aria-selected={kind === tab} aria-controls={`${tabId}-panel`} tabIndex={kind === tab ? 0 : -1}
          onClick={() => onSelectKind(tab)} onKeyDown={event => moveTab(event, index, availableKinds, tabId, onSelectKind)}>{tabNames[tab]}</button>)}
      </div>
      {!byDay && <label className="statistics-zone-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
        <input type="search" aria-label="Поиск зоны" placeholder="Поиск зоны" value={search} disabled={!rows?.length}
          onChange={event => setZoneSearch({ requestKey: scopeQuery, text: event.target.value })} />
      </label>}
    </header>

    <div className="statistics-panel" id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${kind}`}>
      <div className="statistics-toolbar">
        <StatisticsPeriodPicker selection={period} today={today} onChange={setPeriod} />
        <StatisticsTotals series={series} rows={filteredRows} />
      </div>

      <div className="statistics-data">
        <div className="statistics-card statistics-card-heading statistics-breakdown-heading">
          <h2 id={`${groupTabId}-heading`}>{byDay ? "Часы по дням" : "Часы по зонам"}</h2>
          <div className="statistics-tabs statistics-group-tabs" role="tablist" aria-label="Группировка статистики">
            {groupings.map((group, index) => <button key={group} id={`${groupTabId}-${group}`} type="button" role="tab"
              aria-selected={groupBy === group} aria-controls={`${groupTabId}-panel`} tabIndex={groupBy === group ? 0 : -1}
              onClick={() => setGroupBy(group)} onKeyDown={event => moveTab(event, index, groupings, groupTabId, setGroupBy)}>{groupingNames[group]}</button>)}
          </div>
          {!!rows?.length && <span className="statistics-card-note">{byDay ? "Дней" : "Зон"} в выборке {formatTimesheetHours(filteredRows?.length ?? 0)}</span>}
        </div>
        <div className="statistics-results" id={`${groupTabId}-panel`} role="tabpanel" aria-labelledby={`${groupTabId}-${groupBy}`} aria-busy={!current}>
          <section className="statistics-card statistics-breakdown-chart" aria-labelledby={`${groupTabId}-heading`}>
            {!current ? <div className="statistics-empty" role="status">Загружаем статистику…</div>
              : "error" in current ? <div className="statistics-empty"><p role="alert">{current.error}</p><button type="button" className="secondary-button" onClick={() => setRefresh(current => current + 1)}>Повторить</button></div>
              : filteredRows?.length ? <StatisticsChart groupBy={groupBy} rows={filteredRows} series={series} maxHours={maxHours} onOpenReports={openReports} reportActionLabel={reportActionLabel} />
              : <div className="statistics-empty" role="status">{visibleRows?.length ? "По выбранным фильтрам нет данных." : current.rows.length ? "Зоны не найдены." : "За выбранный период нет подтверждённых отчётов."}</div>}
          </section>
          {!!rows?.length && <StatisticsBreakdownTable key={requestKey} groupBy={groupBy} rows={rows} series={series} zoneSearch={search} onFilteredRowsChange={updateFilteredRows} onClearFilters={clearSearch} onOpenReports={openReports} reportActionLabel={reportActionLabel} />}
        </div>
      </div>
    </div>
  </div>;
}
