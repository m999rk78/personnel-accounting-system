"use client";

import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { gridLocaleRu } from "./gridLocaleRu";
import { gridTheme } from "./gridTheme";
import { StatisticsChart, type StatisticsSeries } from "./StatisticsChart";
import { StatisticsPeriodPicker } from "./StatisticsPeriodPicker";
import type { StatisticsKind, StatisticsRow } from "./statisticsTypes";
import { formatTimesheetHours } from "./timesheetFormatting";
import "./statistics.css";

const tabNames: Record<StatisticsKind, string> = { personnel: "Персонал", equipment: "Техника" };
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
const gridColumns: ColDef<StatisticsRow> = { sortable: true, resizable: true, flex: 1, suppressHeaderMenuButton: true };
const statisticsGridTheme = gridTheme.withParams({ autoHeightMinBodyHeight: 0, cellHorizontalPadding: 8, fontSize: 12, headerFontSize: 12 });
type Period = { from: string; to: string };
type Result = { key: string; rows: StatisticsRow[] } | { key: string; error: string };

export type StatisticsViewProps = {
  siteId: number;
  today: string;
  kind: StatisticsKind;
  availableKinds: readonly StatisticsKind[];
  onSelectKind: (kind: StatisticsKind) => void;
};

function hours(value: number) { return `${formatTimesheetHours(value)} ч`; }

function StatisticsTotals({ series, rows }: { series: readonly StatisticsSeries[]; rows: StatisticsRow[] | null }) {
  const totals = useMemo(() => rows?.reduce((result, row) => {
    result.total += row.total;
    for (const { key } of series) result[key] += row[key];
    return result;
  }, { total: 0, welders: 0, installers: 0, other: 0, productive: 0, downtime: 0 }), [series, rows]);

  return <dl className="statistics-totals" aria-label="Итоги по зонам">
    <div className="statistics-total statistics-total-all"><dt>Всего часов</dt><dd>{totals ? hours(totals.total) : "—"}</dd></div>
    {series.map(({ key, name, color }) => <div className="statistics-total" key={key}>
      <dt><i style={{ backgroundColor: color }} aria-hidden="true" />{key === "other" ? "Прочие" : name}</dt>
      <dd>{totals ? hours(totals[key]) : "—"}</dd>
    </div>)}
  </dl>;
}

function StatisticsResults({ series, rows }: { series: readonly StatisticsSeries[]; rows: StatisticsRow[] }) {
  const maxHours = useMemo(() => rows.reduce((max, row) => Math.max(max, row.total), 0), [rows]);
  const columns = useMemo<ColDef<StatisticsRow>[]>(() => {
    const numeric = (field: StatisticsSeries["key"] | "total", headerName: string, width: number): ColDef<StatisticsRow> => ({
      field, headerName, type: "numericColumn", width, minWidth: 72, flex: 0,
      valueFormatter: ({ value }) => typeof value === "number" ? formatTimesheetHours(value) : "",
    });
    return [
      { field: "zone", headerName: "Зона", minWidth: 124, tooltipField: "zone" },
      ...series.map(({ key, name }) => key === "other"
        ? { ...numeric(key, "Прочие", 80), headerTooltip: name }
        : numeric(key, name, key === "installers" ? 116 : 96)),
      { ...numeric("total", "Всего", 88), initialSort: "desc", cellClass: ["ag-right-aligned-cell", "statistics-grid-total"] },
    ];
  }, [series]);
  return <div className="statistics-results">
    <section className="statistics-card" aria-labelledby="statistics-chart-heading">
      <div className="statistics-card-heading">
        <h2 id="statistics-chart-heading">Часы по зонам</h2>
        <span className="statistics-card-note">Зон в выборке {formatTimesheetHours(rows.length)}</span>
      </div>
      <StatisticsChart rows={rows} series={series} maxHours={maxHours} />
    </section>

    <section className="statistics-card" aria-labelledby="statistics-grid-heading">
      <div className="statistics-card-heading"><h2 id="statistics-grid-heading">Данные по зонам</h2><span className="statistics-card-note">Часы</span></div>
      <div className="statistics-grid">
        <AgGridReact<StatisticsRow> theme={statisticsGridTheme} localeText={gridLocaleRu} rowData={rows} columnDefs={columns}
          defaultColDef={gridColumns} rowHeight={28} headerHeight={32} domLayout="autoHeight"
          getRowId={({ data }) => String(data.zoneId ?? "unassigned")} onGridReady={({ api }) => api.setGridAriaProperty("label", "Часы по зонам")} />
      </div>
    </section>
  </div>;
}

export function StatisticsView({ siteId, today, kind, availableKinds, onSelectKind }: StatisticsViewProps) {
  const tabId = useId();
  const [period, setPeriod] = useState<Period>(() => ({ from: `${today.slice(0, 7)}-01`, to: today }));
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [zoneSearch, setZoneSearch] = useState({ requestKey: "", text: "" });
  const query = new URLSearchParams({ siteId: String(siteId), kind, ...period }).toString();
  const requestKey = `${query}:${refresh}`;
  const current = result?.key === requestKey ? result : null;
  const rows = current && "rows" in current ? current.rows : null;
  const search = zoneSearch.requestKey === requestKey ? zoneSearch.text : "";
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    return query ? rows?.filter(row => row.zone.toLocaleLowerCase("ru-RU").includes(query)) ?? null : rows;
  }, [rows, search]);
  const series = seriesByKind[kind];
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/statistics?${query}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { rows?: StatisticsRow[]; error?: string };
        if (!response.ok || !Array.isArray(payload.rows)) throw new Error(payload.error || "Не удалось загрузить статистику.");
        if (!controller.signal.aborted) setResult({ key: requestKey, rows: payload.rows });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: requestKey, error: error instanceof Error && error.message.startsWith("Нет доступа") ? error.message : "Не удалось загрузить статистику." });
      }
    }
    void load();
    return () => controller.abort();
  }, [query, requestKey]);

  function selectPeriod(value: Period) {
    setPeriod(value);
    setRefresh(current => current + 1);
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = availableKinds.length;
    const next = event.key === "ArrowRight" ? (index + 1) % count
      : event.key === "ArrowLeft" ? (index + count - 1) % count
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = availableKinds[next];
    document.getElementById(`${tabId}-${target}`)?.focus();
    onSelectKind(target);
  }

  return <div className="statistics-view">
    <header className="page-heading workspace-page-heading statistics-heading">
      <div className="page-heading-title"><h1>Статистика</h1></div>
      <div className="statistics-tabs" role="tablist" aria-label="Вид статистики">
        {availableKinds.map((tab, index) => <button key={tab} id={`${tabId}-${tab}`} type="button" role="tab"
          aria-selected={kind === tab} aria-controls={`${tabId}-panel`} tabIndex={kind === tab ? 0 : -1}
          onClick={() => onSelectKind(tab)} onKeyDown={event => moveTab(event, index)}>{tabNames[tab]}</button>)}
      </div>
      <label className="statistics-zone-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
        <input type="search" aria-label="Поиск зоны" placeholder="Поиск зоны" value={search} disabled={!rows?.length}
          onChange={event => setZoneSearch({ requestKey, text: event.target.value })} />
      </label>
    </header>

    <div className="statistics-panel" id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${kind}`}>
      <div className="statistics-toolbar">
        <StatisticsPeriodPicker period={period} today={today} onChange={selectPeriod} />
        <StatisticsTotals series={series} rows={visibleRows} />
      </div>

      <div className="statistics-data" aria-busy={!current}>
        {!current ? <div className="statistics-empty" role="status">Загружаем статистику…</div>
          : "error" in current ? <div className="statistics-empty"><p role="alert">{current.error}</p><button type="button" className="secondary-button" onClick={() => setRefresh(current => current + 1)}>Повторить</button></div>
          : visibleRows?.length ? <StatisticsResults key={requestKey} series={series} rows={visibleRows} />
          : <div className="statistics-empty" role="status">{current.rows.length ? "Зоны не найдены." : "За выбранный период нет подтверждённых отчётов."}</div>}
      </div>
    </div>
  </div>;
}
