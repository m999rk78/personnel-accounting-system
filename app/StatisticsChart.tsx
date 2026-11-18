"use client";

import { AgCharts, BarSeriesModule, CartesianChartModule, CategoryAxisModule, LegendModule, NumberAxisModule, type AgCartesianChartOptions } from "ag-charts-community";
import { useEffect, useRef, useState } from "react";
import { formatStatisticsDate } from "./statisticsPeriod";
import type { StatisticsBreakdownRow, StatisticsGrouping } from "./statisticsTypes";
import { formatTimesheetHours } from "./timesheetFormatting";

export type StatisticsSeries = {
  key: "welders" | "installers" | "other" | "productive" | "downtime";
  name: string;
  color: string;
};

const modules = [CartesianChartModule, BarSeriesModule, CategoryAxisModule, NumberAxisModule, LegendModule];
const fontFamily = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

function shortZone(name: string) {
  return name.length > 18 ? `${name.slice(0, 12)}…${name.slice(-5)}` : name;
}

export function StatisticsChart({ groupBy, rows, series, maxHours }: { groupBy: StatisticsGrouping; rows: StatisticsBreakdownRow[]; series: readonly StatisticsSeries[]; maxHours: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const byDay = groupBy === "day";
  const spacePerCategory = Math.max(1, (chartWidth - 96) / Math.max(1, rows.length));
  const barWidth = Math.max(1, Math.min(32, Math.floor(spacePerCategory * 0.55)));
  const labelRotation = spacePerCategory < (byDay ? 75 : 110) ? -90 : 0;

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setChartWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!container.current || !chartWidth) return;
    const data = rows.map(row => "workDate" in row
      ? { ...row, category: row.workDate, label: formatStatisticsDate(row.workDate) }
      : { ...row, category: String(row.zoneId ?? "unassigned"), label: row.zone });
    const labels = new Map(data.map(row => [row.category, byDay ? row.label : shortZone(row.label)]));
    const options: AgCartesianChartOptions<(typeof data)[number]> = {
      container: container.current,
      data,
      minWidth: 1,
      background: { fill: "#ffffff" },
      padding: { top: 4, right: 12, bottom: 4, left: 8 },
      legend: {
        position: "top",
        spacing: 12,
        item: { label: { color: "#3f3f46", fontFamily, fontSize: 12 }, marker: { size: 10 } },
      },
      axes: {
        x: {
          type: "category", position: "bottom",
          paddingInner: 0.2, paddingOuter: 0.3,
          maxThicknessRatio: 0.45,
          label: { color: "#52525b", fontFamily, fontSize: 11, rotation: labelRotation, minSpacing: 2,
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
        type: "bar", direction: "vertical", stacked: true,
        xKey: "category", xName: byDay ? "Дата" : "Зона", yKey: key, yName: name,
        fill: color, strokeWidth: 0, width: barWidth,
        tooltip: { renderer: ({ datum }) => ({
          heading: datum.label,
          data: [{ label: name, value: `${formatTimesheetHours(datum[key])} ч` }, { label: byDay ? "Всего за день" : "Всего по зоне", value: `${formatTimesheetHours(datum.total)} ч` }],
        }) },
      })),
    };
    const chart = AgCharts.create(options, { modules });
    return () => chart.destroy();
  }, [rows, series, maxHours, byDay, chartWidth, barWidth, labelRotation]);

  return <div ref={container} className="statistics-chart" role="region" aria-label={byDay ? "Столбчатый график часов по дням" : "Столбчатый график часов по зонам"} />;
}
