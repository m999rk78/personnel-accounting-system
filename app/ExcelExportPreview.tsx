"use client";

import { useEffect, useRef, useState } from "react";
import { createEquipmentPlacementXlsx, createEquipmentTimesheetXlsx, createPersonnelTimesheetXlsx, createPlacementXlsx, createTableXlsx, type EquipmentPlacementExportRow } from "./placementXlsx";
import { takeExcelExportPreview, type ExcelExportPreviewPayload } from "./excelExportPreviewStore";
import {
  buildEquipmentTimesheetRange,
  buildPersonnelTimesheetRange,
  monthKeysInRange,
  selectEquipmentTimesheetRange,
  selectPersonnelTimesheetRange,
  type EquipmentTimesheetMonthData,
  type PersonnelTimesheetMonthData,
} from "./timesheetExportRange";

type PersonnelExportEntry = {
  workDate: string;
  employeeName: string;
  employmentType: string;
  department: string;
  positionSnapshot: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  masterName: string;
  hours: number;
  note: string;
};

type EquipmentExportEntry = {
  workDate: string;
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
  organization: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  hours: number;
  note: string;
};

const placementHeaders = ["Дата", "ФИО", "Смена", "Зона", "Виды основных работ", "Виды подработ", "Примечание", "Мастер", "Часы", "Тип - 2"];
const equipmentHeaders = ["Дата", "Уникальное наименование единицы", "Смена", "Зона", "Виды основных работ", "Виды подработ", "Примечание", "Часы"];

function shiftMonth(value: string, offset: number) {
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return shifted.toISOString().slice(0, 7);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T00:00:00Z`));
}

function periodText(start: string, end: string) {
  return start === end ? formatDate(start) : `${formatDate(start)} — ${formatDate(end)}`;
}

function templateDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00Z`));
}

function dateHeaders(dates: string[]) {
  const spansMonths = dates.some((date) => date.slice(0, 7) !== dates[0]?.slice(0, 7));
  return dates.map((date) => spansMonths ? `${date.slice(8)}.${date.slice(5, 7)}` : String(Number(date.slice(8))));
}

function rangeInsideDates(dates: string[], start: string, end: string) {
  return Boolean(dates.length && start >= dates[0] && end <= dates.at(-1)!);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExcelExportPreviewPage() {
  const [payload, setPayload] = useState<ExcelExportPreviewPayload | null>(null);
  const [ready, setReady] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState("");
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [waitingForEnd, setWaitingForEnd] = useState(false);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [rangeError, setRangeError] = useState("");
  const [baseTimesheetPayload, setBaseTimesheetPayload] = useState<ExcelExportPreviewPayload | null>(null);
  const periodPicker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const task = window.setTimeout(() => {
      const loadPreview = async () => {
        const payloadUrl = new URLSearchParams(window.location.search).get("payload") ?? "";
        const preview = payloadUrl ? await takeExcelExportPreview(payloadUrl) : null;
        if (!active) return;
        setPayload(preview);
        const timesheetDates = preview?.workbook.kind === "personnel-timesheet" || preview?.workbook.kind === "equipment-timesheet" ? preview.workbook.dates : [];
        const initialStart = preview?.source?.initialDate ?? timesheetDates[0] ?? "";
        const initialEnd = preview?.source?.initialDate ?? timesheetDates.at(-1) ?? initialStart;
        if (timesheetDates.length) setBaseTimesheetPayload(preview);
        setVisibleMonth(initialStart.slice(0, 7));
        setDraftStart(initialStart);
        setDraftEnd(initialEnd);
        setReady(true);
      };
      void loadPreview();
    }, 0);
    return () => { active = false; window.clearTimeout(task); };
  }, []);

  useEffect(() => {
    if (!calendarOpen) return;
    const close = (event: PointerEvent) => { if (periodPicker.current && !periodPicker.current.contains(event.target as Node)) setCalendarOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setCalendarOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [calendarOpen]);

  function downloadFile() {
    if (!payload) return;
    setDownloadError("");
    try {
      let blob: Blob;
      if (payload.workbook.kind === "placement") {
        blob = createPlacementXlsx(payload.workbook.siteName, payload.workbook.rangeStart, payload.workbook.rangeEnd, payload.workbook.rows);
      } else if (payload.workbook.kind === "equipment-placement") {
        blob = createEquipmentPlacementXlsx(payload.workbook.siteName, payload.workbook.rangeStart, payload.workbook.rangeEnd, payload.workbook.rows);
      } else if (payload.workbook.kind === "table") {
        blob = createTableXlsx(payload.workbook.sheetName, payload.workbook.workbookTitle, payload.headers, payload.workbook.rows);
      } else if (payload.workbook.kind === "personnel-timesheet") {
        blob = createPersonnelTimesheetXlsx(
          payload.workbook.siteName,
          payload.workbook.monthLabel,
          payload.workbook.dates,
          payload.workbook.rows,
          payload.workbook.dayTotals,
          payload.workbook.totalHours,
          payload.workbook.totalDifference,
        );
      } else {
        blob = createEquipmentTimesheetXlsx(
          payload.workbook.siteName,
          payload.workbook.monthLabel,
          payload.workbook.dates,
          payload.workbook.rows,
          payload.workbook.dayTotals,
          payload.workbook.productiveTotal,
          payload.workbook.downtimeTotal,
          payload.workbook.totalHours,
        );
      }
      download(blob, payload.fileName);
      setDownloaded(true);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Не удалось сформировать файл Excel.");
    }
  }

  async function loadExportRange(start: string, end: string) {
    if (!payload) return;
    if (!start || !end || start > end) {
      setRangeError("Проверьте даты начала и окончания периода.");
      return;
    }
    setRangeLoading(true);
    setRangeError("");
    setDownloadError("");
    setDownloaded(false);
    try {
      const suffix = start === end ? start : `${start}_${end}`;
      const originalTimesheet = baseTimesheetPayload;
      if (originalTimesheet?.workbook.kind === "personnel-timesheet") {
        let selected;
        if (rangeInsideDates(originalTimesheet.workbook.dates, start, end)) {
          selected = selectPersonnelTimesheetRange(originalTimesheet.workbook.dates, originalTimesheet.workbook.rows, originalTimesheet.workbook.dayTotals, start, end);
        } else {
          if (originalTimesheet.source?.kind !== "personnel-timesheet") throw new Error("Не удалось определить объект для загрузки другого месяца.");
          const monthPayloads = await Promise.all(monthKeysInRange(start, end).map(async (month) => {
            const query = new URLSearchParams({ siteId: String(originalTimesheet.source!.siteId), month });
            const response = await fetch(`/api/timesheet?${query.toString()}`, { cache: "no-store" });
            const result = await response.json() as PersonnelTimesheetMonthData & { error?: string };
            if (!response.ok) throw new Error(result.error ?? `Не удалось загрузить табель за ${month}.`);
            return result;
          }));
          selected = buildPersonnelTimesheetRange(monthPayloads, start, end);
        }
        const rows = selected.rows.map((row) => [
          row.employmentType,
          row.department,
          row.fullName,
          row.position,
          row.positionNote,
          ...row.dailyValues,
          row.timesheetHours,
          row.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР" ? row.timesheetHours - row.reportHours : 0,
          row.masters,
        ]);
        setPayload({
          ...originalTimesheet,
          description: `${originalTimesheet.workbook.siteName} · ${periodText(start, end)}`,
          fileName: `Табель_рабочих_${suffix}.xlsx`,
          headers: ["Тип", "Отдел", "Фамилия, имя, отчество", "Должность", "Примечание к должности", ...dateHeaders(selected.dates), "ЧАСЫ", "РАСТ", "Мастер"],
          rows,
          workbook: { ...originalTimesheet.workbook, ...selected, monthLabel: periodText(start, end) },
        });
      } else if (originalTimesheet?.workbook.kind === "equipment-timesheet") {
        let selected;
        if (rangeInsideDates(originalTimesheet.workbook.dates, start, end)) {
          selected = selectEquipmentTimesheetRange(originalTimesheet.workbook.dates, originalTimesheet.workbook.rows, originalTimesheet.workbook.dayTotals, start, end);
        } else {
          if (originalTimesheet.source?.kind !== "equipment-timesheet") throw new Error("Не удалось определить объект для загрузки другого месяца.");
          const monthPayloads = await Promise.all(monthKeysInRange(start, end).map(async (month) => {
            const query = new URLSearchParams({ siteId: String(originalTimesheet.source!.siteId), date: `${month}-01`, month, scope: "project", view: "timesheet", section: "month" });
            const response = await fetch(`/api/equipment?${query.toString()}`, { cache: "no-store" });
            const result = await response.json() as EquipmentTimesheetMonthData & { error?: string };
            if (!response.ok) throw new Error(result.error ?? `Не удалось загрузить табель техники за ${month}.`);
            return result;
          }));
          selected = buildEquipmentTimesheetRange(monthPayloads, start, end);
        }
        const rows = selected.rows.map((row) => [
          row.equipmentType ?? "",
          row.equipmentName,
          row.registrationNumber ?? "",
          ...row.dailyProductiveHours.map((value) => value || ""),
          row.productiveHours,
          row.downtimeHours,
          row.productiveHours + row.downtimeHours - (row.reportHours ?? row.totalHours),
        ]);
        setPayload({
          ...originalTimesheet,
          description: `${originalTimesheet.workbook.siteName} · ${periodText(start, end)}`,
          fileName: `Табель_техники_${suffix}.xlsx`,
          headers: ["Тип", "Уникальное наименование единицы", "ГРЗ", ...dateHeaders(selected.dates), "ЧАСЫ", "ПРОСТОЙ", "РАСТ"],
          rows,
          workbook: { ...originalTimesheet.workbook, ...selected, monthLabel: periodText(start, end) },
        });
      } else if (payload.source?.kind === "personnel") {
        const query = new URLSearchParams({ siteId: String(payload.source.siteId), date: start, scope: "export-range", rangeStart: start, rangeEnd: end });
        const response = await fetch(`/api/data?${query.toString()}`, { cache: "no-store" });
        const result = await response.json() as { entries?: PersonnelExportEntry[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить отчёты за выбранный период.");
        const workbookRows = (result.entries ?? []).map((entry) => ({
          workDate: entry.workDate,
          employeeName: entry.employeeName,
          employmentType: entry.employmentType,
          department: entry.department,
          positionSnapshot: entry.positionSnapshot,
          shiftName: entry.shiftName,
          zoneName: entry.zoneName,
          mainWorkTypeName: entry.mainWorkTypeName,
          subworkTypeName: entry.subworkTypeName,
          masterName: entry.masterName,
          hours: entry.hours,
          note: entry.note,
        }));
        const rows = workbookRows.map((entry) => [entry.workDate, entry.employeeName, entry.shiftName, entry.zoneName, entry.mainWorkTypeName, entry.subworkTypeName, entry.note, entry.masterName, entry.hours, entry.positionSnapshot]);
        setPayload({ ...payload, description: `${payload.source.siteName} · ${periodText(start, end)}`, fileName: `Отчёт_персонала_${payload.source.siteCode}_${suffix}.xlsx`, headers: placementHeaders, rows, workbook: { kind: "placement", siteName: payload.source.siteName, rangeStart: start, rangeEnd: end, rows: workbookRows } });
      } else if (payload.source?.kind === "equipment") {
        const query = new URLSearchParams({ siteId: String(payload.source.siteId), date: start, month: start.slice(0, 7), scope: "export-range", rangeStart: start, rangeEnd: end, view: "daily", section: "daily" });
        const response = await fetch(`/api/equipment?${query.toString()}`, { cache: "no-store" });
        const result = await response.json() as { entries?: EquipmentExportEntry[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить отчёты техники за выбранный период.");
        const workbookRows: EquipmentPlacementExportRow[] = (result.entries ?? []).map((entry) => ({
          workDate: entry.workDate,
          equipmentName: `${entry.equipmentType} // ${[entry.brand, entry.model].filter(Boolean).join(" ")} // ${entry.registrationNumber || "-"} // ${entry.organization}`,
          shiftName: entry.shiftName,
          zoneName: entry.zoneName,
          mainWorkTypeName: entry.mainWorkTypeName,
          subworkTypeName: entry.subworkTypeName,
          note: entry.note,
          hours: entry.hours,
        }));
        const rows = workbookRows.map((entry) => [entry.workDate, entry.equipmentName, entry.shiftName, entry.zoneName, entry.mainWorkTypeName, entry.subworkTypeName, entry.note, entry.hours]);
        setPayload({ ...payload, description: `${payload.source.siteName} · ${periodText(start, end)}`, fileName: `Отчёт_техники_${payload.source.siteId}_${suffix}.xlsx`, headers: equipmentHeaders, rows, workbook: { kind: "equipment-placement", siteName: payload.source.siteName, rangeStart: start, rangeEnd: end, rows: workbookRows } });
      } else {
        throw new Error("Для этого файла выбор периода недоступен.");
      }
      setWaitingForEnd(false);
      setCalendarOpen(false);
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : "Не удалось загрузить отчёты за выбранный период.");
    } finally {
      setRangeLoading(false);
    }
  }

  if (!ready) return <main className="excel-preview-page excel-preview-state"><strong>Готовим предпросмотр…</strong></main>;
  if (!payload) return <main className="excel-preview-page excel-preview-state"><strong>Предпросмотр недоступен</strong><p>Вернитесь в отчёт и снова выберите «Excel → Экспорт в Excel».</p><button type="button" className="secondary-button" onClick={() => window.close()}>Закрыть вкладку</button></main>;

  const appliedStart = payload.workbook.kind === "placement" || payload.workbook.kind === "equipment-placement"
    ? payload.workbook.rangeStart
    : payload.workbook.kind === "table"
      ? payload.workbook.rangeStart ?? payload.source?.initialDate ?? ""
      : payload.workbook.dates[0] ?? "";
  const appliedEnd = payload.workbook.kind === "placement" || payload.workbook.kind === "equipment-placement"
    ? payload.workbook.rangeEnd
    : payload.workbook.kind === "table"
      ? payload.workbook.rangeEnd ?? payload.source?.initialDate ?? ""
      : payload.workbook.dates.at(-1) ?? "";
  const originalTimesheetWorkbook = baseTimesheetPayload?.workbook;
  const hasTimesheetWorkbook = originalTimesheetWorkbook?.kind === "personnel-timesheet" || originalTimesheetWorkbook?.kind === "equipment-timesheet";
  const rangeEnabled = Boolean(payload.source) || hasTimesheetWorkbook;
  const calendarMonth = visibleMonth || appliedStart.slice(0, 7);
  const [visibleYear, visibleMonthNumber] = calendarMonth.split("-").map(Number);
  const firstWeekday = calendarMonth ? (new Date(Date.UTC(visibleYear, visibleMonthNumber - 1, 1)).getUTCDay() + 6) % 7 : 0;
  const daysInMonth = calendarMonth ? new Date(Date.UTC(visibleYear, visibleMonthNumber, 0)).getUTCDate() : 0;
  const calendarCells = Array.from({ length: firstWeekday + daysInMonth }, (_, index) => index < firstWeekday ? null : index - firstWeekday + 1);
  const monthTitle = calendarMonth ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${calendarMonth}-01T00:00:00Z`)) : "";
  const placementTemplate = payload.workbook.kind === "placement" || payload.workbook.kind === "equipment-placement";
  const personnelPlacement = payload.workbook.kind === "placement";
  const personnelTimesheetWorkbook = payload.workbook.kind === "personnel-timesheet" ? payload.workbook : null;
  const equipmentTimesheetWorkbook = payload.workbook.kind === "equipment-timesheet" ? payload.workbook : null;
  const timesheetTemplate = Boolean(personnelTimesheetWorkbook || equipmentTimesheetWorkbook);
  const timesheetDates = personnelTimesheetWorkbook?.dates ?? equipmentTimesheetWorkbook?.dates ?? [];
  const timesheetDayCount = Math.max(31, timesheetDates.length);
  const hoursColumn = personnelPlacement ? 8 : 7;
  const templateTotal = placementTemplate ? payload.rows.reduce((sum, row) => sum + Number(row[hoursColumn] || 0), 0) : 0;

  function selectCalendarDay(date: string) {
    setRangeError("");
    if (!waitingForEnd) {
      setDraftStart(date);
      setDraftEnd(date);
      setWaitingForEnd(true);
      return;
    }
    if (date < draftStart) {
      setDraftStart(date);
      setDraftEnd(draftStart);
    } else {
      setDraftEnd(date);
    }
    setWaitingForEnd(false);
  }

  function selectVisibleMonth() {
    if (!calendarMonth) return;
    const monthStart = `${calendarMonth}-01`;
    const monthEnd = `${calendarMonth}-${String(daysInMonth).padStart(2, "0")}`;
    setDraftStart(monthStart);
    setDraftEnd(monthEnd);
    setWaitingForEnd(false);
    setRangeError("");
  }

  return <main className="excel-preview-page">
    <section className="excel-preview-dialog" aria-labelledby="excel-preview-title" aria-describedby="excel-preview-description">
      <header className="excel-preview-header">
        <div className="excel-preview-heading">
          <span className="excel-preview-file-icon" aria-hidden="true">X</span>
          <div>
            <span>Предпросмотр экспорта</span>
            <h1 id="excel-preview-title">{payload.title}</h1>
            <p id="excel-preview-description">{payload.description}</p>
          </div>
        </div>
        <button type="button" className="excel-preview-close" onClick={() => window.close()} aria-label="Закрыть вкладку">×</button>
      </header>

      {rangeEnabled && <section className="excel-preview-period" aria-label="Период выгрузки">
        <div className="excel-preview-period-picker" ref={periodPicker}>
          <span className="excel-preview-period-label">Период выгрузки</span>
          <button type="button" className="excel-preview-period-trigger" aria-haspopup="dialog" aria-expanded={calendarOpen} onClick={() => {
            if (!calendarOpen) {
              setDraftStart(appliedStart);
              setDraftEnd(appliedEnd);
              setVisibleMonth(appliedStart.slice(0, 7));
              setWaitingForEnd(false);
              setRangeError("");
            }
            setCalendarOpen((open) => !open);
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
            <strong>{periodText(appliedStart, appliedEnd)}</strong>
            <svg className="excel-preview-period-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
          </button>
          {calendarOpen && <div className="excel-preview-range-calendar" role="dialog" aria-label="Выбор периода отчёта">
            <div className="excel-preview-calendar-heading"><button type="button" onClick={() => setVisibleMonth(shiftMonth(calendarMonth, -1))} aria-label="Предыдущий месяц">‹</button><strong>{monthTitle}</strong><button type="button" onClick={() => setVisibleMonth(shiftMonth(calendarMonth, 1))} aria-label="Следующий месяц">›</button></div>
            <div className="excel-preview-calendar-weekdays">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="excel-preview-calendar-days">{calendarCells.map((day, index) => day ? (() => {
              const date = `${calendarMonth}-${String(day).padStart(2, "0")}`;
              const rangeStart = draftStart <= draftEnd ? draftStart : draftEnd;
              const rangeEnd = draftStart <= draftEnd ? draftEnd : draftStart;
              const isStart = date === rangeStart;
              const isEnd = date === rangeEnd;
              const inRange = date > rangeStart && date < rangeEnd;
              const className = [inRange ? "in-range" : "", isStart ? "range-start" : "", isEnd ? "range-end" : "", isStart && isEnd ? "range-single" : ""].filter(Boolean).join(" ");
              return <button type="button" key={date} className={className} aria-pressed={inRange || isStart || isEnd} onClick={() => selectCalendarDay(date)}>{day}</button>;
            })() : <span key={`empty-${index}`} />)}</div>
            <div className="excel-preview-calendar-selection"><span>{waitingForEnd ? "Теперь выберите последнюю дату" : draftStart && draftEnd ? periodText(draftStart, draftEnd) : "Выберите даты"}</span></div>
            <div className="excel-preview-calendar-actions"><button type="button" className="excel-preview-calendar-month" onClick={selectVisibleMonth}>Весь месяц</button><button type="button" className="excel-preview-apply-period" onClick={() => void loadExportRange(draftStart, draftEnd)} disabled={rangeLoading || !draftStart || !draftEnd}>{rangeLoading ? "Загружаем…" : "Применить"}</button></div>
            {rangeError && <span className="excel-preview-period-error" role="alert">{rangeError}</span>}
          </div>}
        </div>
      </section>}

      <div className="excel-preview-meta">
        <div><span>Файл</span><strong>{payload.fileName}</strong></div>
        <div><span>Строк</span><strong>{payload.rows.length}</strong></div>
        <div><span>Столбцов</span><strong>{payload.headers.length}</strong></div>
      </div>

      <div className={placementTemplate || timesheetTemplate ? "excel-preview-table-wrap excel-template-preview-wrap" : "excel-preview-table-wrap"}>
        {placementTemplate ? <table className={`excel-template-preview-table ${personnelPlacement ? "personnel" : "equipment"}`}>
          <colgroup>{(personnelPlacement ? [82, 292, 98, 178, 388, 350, 286, 270, 82, 510] : [78, 440, 98, 178, 388, 346, 286, 82]).map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
          <thead>
            {personnelPlacement
              ? <tr className="excel-template-total-row"><th colSpan={7} /><th>ИТОГО ПО ФИЛЬТРУ</th><th>{templateTotal}</th><th /></tr>
              : <tr className="excel-template-total-row"><th colSpan={4} /><th>ИТОГО ПО ФИЛЬТРУ</th><th colSpan={2} /><th>{templateTotal}</th></tr>}
            <tr className="excel-template-header-row">{payload.headers.map((header, index) => <th key={header} className={personnelPlacement && index === payload.headers.length - 1 ? "excel-template-green-header" : ""}>{header}</th>)}</tr>
            <tr className="excel-template-filter-row">{payload.headers.map((header, index) => <th key={`${header}-${index}`} className={personnelPlacement && index === payload.headers.length - 1 ? "excel-template-green-header" : ""}>−</th>)}</tr>
          </thead>
          <tbody>{payload.rows.map((row, rowIndex) => <tr key={rowIndex}>{payload.headers.map((_, columnIndex) => {
            const value = row[columnIndex];
            const rendered = columnIndex === 0 && typeof value === "string" ? templateDate(value) : value;
            return <td key={columnIndex} className={columnIndex === hoursColumn ? "excel-template-hours" : ""} title={value === null || value === undefined ? "" : String(value)}>{rendered === "" || rendered === null || rendered === undefined ? "" : rendered}</td>;
          })}</tr>)}</tbody>
        </table> : personnelTimesheetWorkbook ? <table className="excel-timesheet-preview-table personnel">
          <colgroup>
            <col style={{ width: 104 }} /><col style={{ width: 132 }} /><col style={{ width: 330 }} /><col style={{ width: 350 }} /><col style={{ width: 150 }} />
            {Array.from({ length: timesheetDayCount }, (_, index) => <col key={index} style={{ width: index === 0 ? 46 : 62 }} />)}
            <col style={{ width: 106 }} /><col style={{ width: 106 }} /><col style={{ width: 280 }} />
          </colgroup>
          <thead>
            <tr className="excel-timesheet-header-row">
              {["Тип", "Отдел", "Фамилия, имя, отчество", "Должность", "Примечание к должности"].map((header) => <th key={header}>{header}</th>)}
              {Array.from({ length: timesheetDayCount }, (_, index) => <th key={`date-${index}`} className="excel-timesheet-day">{timesheetDates[index] ? Number(timesheetDates[index].slice(8)) : ""}</th>)}
              <th>ЧАСЫ</th><th>РАСТ</th><th>Мастер</th>
            </tr>
            <tr className="excel-timesheet-filter-row">{Array.from({ length: 8 + timesheetDayCount }, (_, index) => <th key={index}>−</th>)}</tr>
          </thead>
          <tbody>{personnelTimesheetWorkbook.rows.map((row, rowIndex) => {
            const difference = row.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР" ? row.timesheetHours - row.reportHours : 0;
            return <tr key={`${row.fullName}-${rowIndex}`}>
              <td>{row.employmentType}</td><td>{row.department}</td><td>{row.fullName}</td><td>{row.position}</td><td>{row.positionNote}</td>
              {Array.from({ length: timesheetDayCount }, (_, index) => <td key={index} className="excel-timesheet-day">{row.dailyValues[index] ?? ""}</td>)}
              <td className="excel-timesheet-total">{row.timesheetHours}</td><td className={difference ? "excel-timesheet-difference" : "excel-timesheet-total"}>{difference}</td><td>{row.masters}</td>
            </tr>;
          })}</tbody>
        </table> : equipmentTimesheetWorkbook ? <table className="excel-timesheet-preview-table equipment">
          <colgroup>
            <col style={{ width: 150 }} /><col style={{ width: 480 }} /><col style={{ width: 128 }} />
            {Array.from({ length: timesheetDayCount }, (_, index) => <col key={index} style={{ width: index === 0 ? 46 : 62 }} />)}
            <col style={{ width: 106 }} /><col style={{ width: 106 }} /><col style={{ width: 106 }} />
          </colgroup>
          <thead>
            <tr className="excel-timesheet-meta-row"><th>{equipmentTimesheetWorkbook.monthLabel}</th><th>{periodText(timesheetDates[0] ?? "", timesheetDates.at(-1) ?? timesheetDates[0] ?? "")}</th><th>Дни недели:</th>{Array.from({ length: timesheetDayCount }, (_, index) => <th key={index}>{timesheetDates[index] ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", weekday: "short" }).format(new Date(`${timesheetDates[index]}T00:00:00Z`)).replace(".", "") : ""}</th>)}<th colSpan={3} /></tr>
            <tr className="excel-timesheet-spacer-row"><th colSpan={6 + timesheetDayCount} /></tr>
            <tr className="excel-timesheet-header-row"><th>Тип</th><th>Уникальное наименование единицы</th><th>ГРЗ</th>{Array.from({ length: timesheetDayCount }, (_, index) => <th key={index} className="excel-timesheet-day">{timesheetDates[index] ? Number(timesheetDates[index].slice(8)) : ""}</th>)}<th>ЧАСЫ</th><th>ПРОСТОЙ</th><th>РАСТ</th></tr>
            <tr className="excel-timesheet-filter-row">{Array.from({ length: 6 + timesheetDayCount }, (_, index) => <th key={index}>−</th>)}</tr>
          </thead>
          <tbody>{equipmentTimesheetWorkbook.rows.map((row, rowIndex) => {
            const slashParts = row.equipmentName.split("//").map((part) => part.trim());
            const difference = row.productiveHours + row.downtimeHours - (row.reportHours ?? row.totalHours);
            return <tr key={`${row.equipmentName}-${rowIndex}`}>
              <td>{row.equipmentType ?? slashParts[0] ?? ""}</td><td>{row.equipmentName}</td><td>{row.registrationNumber ?? slashParts[2] ?? ""}</td>
              {Array.from({ length: timesheetDayCount }, (_, index) => <td key={index} className="excel-timesheet-day">{row.dailyProductiveHours[index] || ""}</td>)}
              <td className="excel-timesheet-total">{row.productiveHours}</td><td className={row.downtimeHours ? "excel-timesheet-downtime" : "excel-timesheet-total"}>{row.downtimeHours}</td><td className={difference ? "excel-timesheet-difference" : "excel-timesheet-total"}>{difference}</td>
            </tr>;
          })}</tbody>
        </table> : <table className="excel-preview-table">
          <thead><tr><th aria-label="Номер строки">№</th>{payload.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>{payload.rows.map((row, rowIndex) => <tr key={rowIndex}><th scope="row">{rowIndex + 1}</th>{payload.headers.map((_, columnIndex) => {
            const value = row[columnIndex];
            return <td key={columnIndex} title={value === null || value === undefined ? "" : String(value)}>{value === "" || value === null || value === undefined ? <span>—</span> : value}</td>;
          })}</tr>)}</tbody>
        </table>}
      </div>

      <footer className="excel-preview-footer">
        <div>{downloadError ? <span className="excel-preview-error" role="alert">{downloadError}</span> : downloaded ? <span className="excel-preview-success" role="status">Файл скачан. Эту вкладку можно закрыть.</span> : <span>Проверьте данные. Файл не скачается, пока вы не подтвердите экспорт.</span>}</div>
        <div><button type="button" className="secondary-button" onClick={() => window.close()}>Закрыть вкладку</button><button type="button" className="excel-preview-download" onClick={downloadFile} disabled={payload.rows.length === 0}>Скачать Excel</button></div>
      </footer>
    </section>
  </main>;
}
