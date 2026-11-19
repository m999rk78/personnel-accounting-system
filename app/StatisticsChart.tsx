"use client";

import { AgCharts, BarSeriesModule, CartesianChartModule, CategoryAxisModule, LegendModule, NumberAxisModule, type AgCartesianChartOptions, type AgChartInstance } from "ag-charts-community";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { TableContextMenu, type TableContextMenuAction } from "./TableContextMenu";
import { formatStatisticsDate } from "./statisticsPeriod";
import { statisticsClipboardNumber } from "./statisticsClipboard";
import type { StatisticsBreakdownRow, StatisticsGrouping } from "./statisticsTypes";
import { serializeSpreadsheetText } from "./spreadsheetClipboard";
import { formatTimesheetHours } from "./timesheetFormatting";
import "./statisticsChart.css";

export type StatisticsSeries = {
  key: "welders" | "installers" | "other" | "productive" | "downtime";
  name: string;
  color: string;
};

const modules = [CartesianChartModule, BarSeriesModule, CategoryAxisModule, NumberAxisModule, LegendModule];
const fontFamily = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

function rowCategory(row: StatisticsBreakdownRow) {
  return "workDate" in row ? row.workDate : String(row.zoneId ?? "unassigned");
}

function chartTooltip(category: string, seriesId: string, label: string, values: readonly { label: string; value: string }[]) {
  const content = document.createElement("div");
  content.className = "statistics-chart-tooltip";
  content.dataset.statisticsChartTooltip = category;
  content.dataset.statisticsChartSeries = seriesId;
  const heading = document.createElement("strong");
  heading.textContent = label;
  content.append(heading);
  for (const value of values) {
    const line = document.createElement("div");
    const name = document.createElement("span");
    const amount = document.createElement("span");
    name.textContent = value.label;
    amount.textContent = value.value;
    line.append(name, amount);
    content.append(line);
  }
  return content.outerHTML;
}

type ChartContext = { row: StatisticsBreakdownRow; seriesId: string; label: string; x: number; y: number; error?: string };
type ChartStateControl = Pick<AgChartInstance, "getState" | "setState">;

export function StatisticsChart({ groupBy, rows, series, maxHours, onOpenReports, reportActionLabel = "Открыть отчёты" }: {
  groupBy: StatisticsGrouping;
  rows: StatisticsBreakdownRow[];
  series: readonly StatisticsSeries[];
  maxHours: number;
  onOpenReports?: (row: StatisticsBreakdownRow) => void;
  reportActionLabel?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartControl = useRef<ChartStateControl | null>(null);
  const activeDatum = useRef<{ row: StatisticsBreakdownRow; seriesId: string; label: string } | null>(null);
  const menuFrame = useRef<number | null>(null);
  const menuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [context, setContext] = useState<ChartContext | null>(null);
  const byDay = groupBy === "day";
  const spacePerCategory = Math.max(1, (chartWidth - 96) / Math.max(1, rows.length));
  const barWidth = Math.max(1, Math.min(32, Math.floor(spacePerCategory * 0.55)));
  const labelRotation = byDay && spacePerCategory < 75 ? -90 : 0;
  // Reserve room for wrapped names even when many zones share the chart.
  const zoneWidth = rows.reduce((width, row) => "zone" in row ? Math.max(width, row.zone.length * 1.2 + 24) : width, 100);
  const cancelPendingMenu = useCallback(() => {
    if (menuFrame.current !== null) {
      cancelAnimationFrame(menuFrame.current);
      menuFrame.current = null;
    }
    if (menuTimer.current !== null) {
      clearTimeout(menuTimer.current);
      menuTimer.current = null;
    }
  }, []);

  useEffect(() => {
    const keyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") cancelPendingMenu(); };
    document.addEventListener("keydown", keyDown);
    document.addEventListener("pointerdown", cancelPendingMenu);
    window.addEventListener("scroll", cancelPendingMenu, true);
    window.addEventListener("resize", cancelPendingMenu);
    return () => {
      cancelPendingMenu();
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("pointerdown", cancelPendingMenu);
      window.removeEventListener("scroll", cancelPendingMenu, true);
      window.removeEventListener("resize", cancelPendingMenu);
    };
  }, [cancelPendingMenu]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setChartWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!container.current || !chartWidth) return;
    const data = rows.map(row => "workDate" in row
      ? { ...row, category: row.workDate, label: formatStatisticsDate(row.workDate), source: row }
      : { ...row, category: String(row.zoneId ?? "unassigned"), label: row.zone, source: row });
    const labels = new Map(data.map(row => [row.category, row.label]));
    const options: AgCartesianChartOptions<(typeof data)[number]> = {
      container: container.current,
      data,
      dataIdKey: "category",
      minWidth: 1,
      background: { fill: "#ffffff" },
      highlight: { range: "node", mode: "shared" },
      tooltip: { range: "exact", delay: 0, mode: "single" },
      listeners: {
        activeChange: ({ activeItem, datum }) => {
          activeDatum.current = activeItem?.type === "series-node" && datum
            ? { row: datum.source, seriesId: activeItem.seriesId, label: datum.label }
            : null;
        },
      },
      padding: { top: 4, right: 12, bottom: 4, left: 8 },
      legend: {
        position: byDay ? "top" : "top-left",
        spacing: 12,
        item: { label: { color: "#3f3f46", fontFamily, fontSize: 12 }, marker: { size: 10 } },
      },
      axes: {
        x: {
          type: "category", position: "bottom",
          paddingInner: 0.2, paddingOuter: 0.3,
          maxThicknessRatio: 0.45,
          label: { color: "#52525b", fontFamily, fontSize: 11, rotation: labelRotation, minSpacing: 2,
            wrapping: "always", truncate: false,
            formatter: ({ value }) => labels.get(String(value)) ?? String(value) },
        },
        y: {
          type: "number", position: "left", min: 0, max: Math.max(1, maxHours * 1.08),
          title: { text: "Часы", color: "#52525b", fontFamily, fontSize: 12 },
          label: { color: "#52525b", fontFamily, fontSize: 11, formatter: ({ value }) => formatTimesheetHours(Number(value)) },
          gridLine: { style: [{ stroke: "#e8e8ec", lineDash: [4, 4] }] },
        },
      },
      series: series.map(({ key, name, color }) => ({
        id: key, type: "bar", direction: "vertical", stacked: true, nodeClickRange: "exact",
        xKey: "category", xName: byDay ? "Дата" : "Зона", yKey: key, yName: name,
        fill: color, strokeWidth: 0, width: barWidth,
        tooltip: { renderer: ({ datum }) => chartTooltip(datum.category, key, datum.label, [
          ...series.map(item => ({ label: item.name, value: `${formatTimesheetHours(datum[item.key])} ч` })),
          { label: byDay ? "Всего за день" : "Всего по зоне", value: `${formatTimesheetHours(datum.total)} ч` },
        ]) },
      })),
    };
    const chart = AgCharts.create(options, { modules });
    chartControl.current = chart;
    return () => {
      activeDatum.current = null;
      if (chartControl.current === chart) chartControl.current = null;
      cancelPendingMenu();
      chart.destroy();
    };
  }, [rows, series, maxHours, byDay, chartWidth, barWidth, labelRotation, cancelPendingMenu]);

  function openContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = (event.target as HTMLElement).getBoundingClientRect();
    const x = event.clientX || anchor.left + anchor.width / 2;
    const y = event.clientY || anchor.top + anchor.height / 2;
    const keyboard = event.clientX === 0 && event.clientY === 0;
    cancelPendingMenu();
    setContext(null);
    const showMenu = () => {
      menuTimer.current = null;
      const tooltip = [...(container.current?.querySelectorAll<HTMLElement>("[data-statistics-chart-tooltip]") ?? [])]
        .find(node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      const row = tooltip ? rows.find(item => rowCategory(item) === tooltip.dataset.statisticsChartTooltip) : undefined;
      const current = row && tooltip?.dataset.statisticsChartSeries ? { row, seriesId: tooltip.dataset.statisticsChartSeries, label: "workDate" in row ? formatStatisticsDate(row.workDate) : row.zone }
        : keyboard ? activeDatum.current : null;
      if (current && rows.includes(current.row)) setContext({ ...current, x, y });
    };
    // Let AG Charts finish its exact pointer hit test and tooltip update. Its
    // keyboard active item can differ from the datum currently under the pointer.
    menuFrame.current = requestAnimationFrame(() => {
      menuFrame.current = requestAnimationFrame(() => {
        menuFrame.current = null;
        // Tooltips briefly remain visible after leaving a bar. Read only after
        // that grace period so blank plot and legend clicks cannot reuse them.
        if (keyboard) showMenu();
        else menuTimer.current = setTimeout(showMenu, 120);
      });
    });
  }

  const currentContext = context && rows.includes(context.row) ? context : null;
  const contextRow = currentContext?.row;
  const contextSeries = currentContext?.seriesId;
  useEffect(() => {
    const chart = chartControl.current;
    if (!chart || !contextRow || !contextSeries) return;
    void chart.setState({ ...chart.getState(), active: {
      activeItem: { type: "series-node", seriesId: contextSeries, itemId: rowCategory(contextRow) },
      frozen: true,
    } });
    return () => {
      if (chartControl.current === chart) void chart.setState({ ...chart.getState(), active: { frozen: false } });
    };
  }, [contextRow, contextSeries, rows, series, maxHours, byDay, chartWidth, barWidth, labelRotation]);
  const actions: TableContextMenuAction[] = currentContext ? [
    ...(onOpenReports ? [{ label: reportActionLabel, onSelect: () => { setContext(null); onOpenReports(currentContext.row); } }] : []),
    { label: "Скопировать показатели", onSelect: async () => {
      try {
        await navigator.clipboard.writeText(serializeSpreadsheetText([
          [byDay ? "Дата" : "Зона", ...series.map(item => item.name), "Всего"],
          [currentContext.label, ...series.map(item => statisticsClipboardNumber(currentContext.row[item.key])), statisticsClipboardNumber(currentContext.row.total)],
        ]));
        setContext(null);
      } catch {
        setContext(current => current ? { ...current, error: "Не удалось скопировать. Разрешите доступ к буферу обмена." } : null);
      }
    } },
  ] : [];

  return <>
    <div className="statistics-chart-scroll">
      <div ref={container} className="statistics-chart" style={{ minWidth: byDay ? undefined : rows.length * zoneWidth + 96 }} data-context-open={Boolean(currentContext)} role="region" aria-label={byDay ? "Столбчатый график часов по дням" : "Столбчатый график часов по зонам"}
        onContextMenuCapture={openContextMenu} onPointerMoveCapture={cancelPendingMenu}
        onBlurCapture={cancelPendingMenu}
        onPointerLeave={() => { activeDatum.current = null; cancelPendingMenu(); }} />
    </div>
    {currentContext && <TableContextMenu x={currentContext.x} y={currentContext.y} value={currentContext.label}
      caption={`${byDay ? "Всего за день" : "Всего по зоне"} · ${formatTimesheetHours(currentContext.row.total)} ч`}
      ariaLabel="Действия с графиком статистики" error={currentContext.error} actions={actions} onClose={() => setContext(null)} />}
  </>;
}
