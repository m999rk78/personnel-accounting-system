"use client";

import { useMemo, useState } from "react";
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams } from "./GridFilters";
import { gridTheme } from "./gridTheme";
import { SpreadsheetFilterHeader } from "./SpreadsheetFilterHeader";
import type { SpreadsheetSelectionSummary } from "./gridSelectionSummary";
import type { StatisticsSeries } from "./StatisticsChart";
import { formatStatisticsDate } from "./statisticsPeriod";
import type { StatisticsBreakdownRow, StatisticsGrouping, StatisticsHours } from "./statisticsTypes";
import { statisticsClipboardNumber, statisticsClipboardText, type StatisticsCopyTarget } from "./statisticsClipboard";
import { formatTimesheetHours } from "./timesheetFormatting";
import { useTableCopyToast, writeTableClipboardText } from "./useTableCopyToast";

type BreakdownGridRow = StatisticsHours & { kind: "entry"; zoneId?: number | null; zone?: string; workDate?: string };
const gridColumns: ColDef<BreakdownGridRow> = {
  filter: personnelColumnFilter,
  filterParams: { ...personnelFilterParams, presentation: "checklist" },
  headerComponentParams: { innerHeaderComponent: SpreadsheetFilterHeader },
  sortable: true, resizable: true, flex: 1, editable: false,
  suppressHeaderMenuButton: true, suppressHeaderFilterButton: true,
};
const statisticsGridTheme = gridTheme.withParams({ autoHeightMinBodyHeight: 0, cellHorizontalPadding: 8, fontSize: 12, headerFontSize: 12 });
const rowId = ({ workDate, zoneId }: Pick<BreakdownGridRow, "workDate" | "zoneId">) => workDate ?? String(zoneId ?? "unassigned");
function HoursCell({ value }: ICellRendererParams<BreakdownGridRow, number>) {
  return typeof value === "number" ? formatTimesheetHours(value) : "";
}

export function StatisticsBreakdownTable({ groupBy, rows, series, onOpenReports, reportActionLabel }: {
  groupBy: StatisticsGrouping;
  rows: StatisticsBreakdownRow[];
  series: readonly StatisticsSeries[];
  onOpenReports?: (row: StatisticsBreakdownRow) => void;
  reportActionLabel?: string;
}) {
  const byDay = groupBy === "day";
  const scrollable = rows.length > 31;
  const [api, setApi] = useState<GridApi<BreakdownGridRow> | null>(null);
  const [selectionSummary, setSelectionSummary] = useState<SpreadsheetSelectionSummary | null>(null);
  const { copyToast, showCopyToast } = useTableCopyToast();
  const rowData = useMemo<BreakdownGridRow[]>(() => rows.map(row => ({ ...row, kind: "entry" })), [rows]);
  const selectionResetKey = useMemo(() => rows.map(rowId).join(","), [rows]);
  const columns = useMemo<ColDef<BreakdownGridRow>[]>(() => {
    const numeric = (field: StatisticsSeries["key"] | "total", headerName: string, width: number): ColDef<BreakdownGridRow> => ({
      field, headerName, type: "numericColumn", width, minWidth: 72, flex: 0,
      filterParams: { kind: "number" },
      // Clipboard values have no thousands separators; displayed hours keep their familiar spacing.
      valueFormatter: ({ value }) => statisticsClipboardNumber(value), cellRenderer: HoursCell,
    });
    return [
      byDay ? { field: "workDate", headerName: "Дата", minWidth: 124, initialSort: "asc", filterParams: { kind: "date" },
        valueFormatter: ({ value }) => typeof value === "string" ? formatStatisticsDate(value) : "" }
        : { field: "zone", headerName: "Зона", minWidth: 124, tooltipField: "zone", wrapText: true, autoHeight: true, cellClass: "statistics-grid-zone" },
      ...series.map(({ key, name }) => key === "other"
        ? { ...numeric(key, "Прочие", 88), headerTooltip: name }
        : numeric(key, name, key === "installers" ? 120 : 104)),
      { ...numeric("total", "Всего", 88), initialSort: byDay ? undefined : "desc", cellClass: ["ag-right-aligned-cell", "statistics-grid-total"] },
    ];
  }, [byDay, series]);

  async function copy(target: StatisticsCopyTarget) {
    if (!api || api.isDestroyed()) return;
    const text = statisticsClipboardText(api, target);
    if (text === null) { showCopyToast("Нет данных для копирования."); return; }
    try {
      await writeTableClipboardText(text);
      showCopyToast(target.kind === "table" ? "Таблица скопирована с заголовками" : target.kind === "row" ? "Строка скопирована" : "Столбец скопирован с заголовком");
    } catch {
      showCopyToast("Не удалось скопировать. Выделите ячейки и нажмите Ctrl+C или ⌘C.");
    }
  }

  return <section className="statistics-card" aria-labelledby="statistics-grid-heading">
    {copyToast}
    <div className="statistics-card-heading">
      <h2 id="statistics-grid-heading">{byDay ? "Данные по дням" : "Данные по зонам"}</h2>
      <div className="statistics-grid-actions">
        {selectionSummary ? <output className="statistics-selection-sum" aria-label="Сумма выделенных часов" aria-live="polite" title={`Числовых ячеек: ${selectionSummary.count}`}>
          Сумма: <strong>{formatTimesheetHours(Number(selectionSummary.sum.toPrecision(15)))} ч</strong>
        </output> : <span className="statistics-card-note">Часы</span>}
        <button type="button" className="statistics-copy-button" disabled={!api || !rows.length} onClick={() => void copy({ kind: "table" })} title="Скопировать видимые строки с заголовками для вставки в Excel">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></svg>
          Копировать таблицу
        </button>
      </div>
    </div>
    <div className={scrollable ? "statistics-grid statistics-grid-scroll" : "statistics-grid"}>
      <LocalizedGrid<BreakdownGridRow> theme={statisticsGridTheme} rowData={rowData} columnDefs={columns}
        defaultColDef={gridColumns} rowHeight={28} headerHeight={32} domLayout={scrollable ? "normal" : "autoHeight"}
        showSortSummary={false} spreadsheetToolbar={false}
        onSpreadsheetSelectionSummary={setSelectionSummary}
        spreadsheetSelectionResetKey={selectionResetKey}
        getRowId={({ data }) => rowId(data)}
        onGridReady={({ api }) => { setApi(api); api.setGridAriaProperty("label", byDay ? "Часы по дням" : "Часы по зонам"); }}
        getSpreadsheetContextActions={({ row, columnId }) => [
          ...(onOpenReports ? [{ label: reportActionLabel ?? "Перейти в отчёты", onSelect: () => {
            const sourceRow = rows.find(candidate => rowId(candidate) === rowId(row));
            if (sourceRow) onOpenReports(sourceRow);
          } }] : []),
          { label: "Копировать строку", onSelect: () => copy({ kind: "row", rowId: rowId(row) }) },
          { label: "Копировать столбец", onSelect: () => copy({ kind: "column", columnId }) },
        ]} />
    </div>
  </section>;
}
