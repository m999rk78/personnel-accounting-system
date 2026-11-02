"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { calendarDate, calendarKeyDate, calendarMonthDays, calendarMonthGrid, parseCalendarDate, shiftCalendarMonth } from "./reportDateCalendar";

const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const calendarKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const dateLabel = (date: string) => date.split("-").reverse().join(".");
const todayDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export type ReportDatePickerProps = { workDate: string; onChange: (date: string) => Promise<void>; scopeLabel?: string; disabled?: boolean };

/** Opens directly from a date cell; choosing a day commits it without another form. */
export function ReportDatePicker({ workDate, onChange, scopeLabel, disabled = false }: ReportDatePickerProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const focusDay = useRef(false);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [focusedDate, setFocusedDate] = useState(workDate);
  const [yearText, setYearText] = useState(workDate.slice(0, 4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const pickerId = useId();
  const parts = parseCalendarDate(focusedDate) ?? parseCalendarDate(workDate)!;
  const today = todayDate();
  const blocked = busy || disabled;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = useCallback((restoreFocus = true) => {
    if (busyRef.current) return;
    setOpen(false);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  }, []);
  const reposition = useCallback(() => {
    const source = anchor.current;
    const content = panel.current;
    if (!source || !content) return;
    const rect = source.getBoundingClientRect();
    const width = Math.min(content.offsetWidth, window.innerWidth - 16);
    const height = Math.min(content.offsetHeight, window.innerHeight - 16);
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6);
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top, ready: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, focusedDate, error, busy, reposition]);
  useLayoutEffect(() => {
    if (!open || !position.ready || !focusDay.current) return;
    focusDay.current = false;
    panel.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
  }, [open, position.ready, focusedDate]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) close(false);
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      if (busyRef.current) reposition();
      else close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, close, reposition]);

  const navigate = (date: string | null, keyboard = false) => {
    if (!date || busyRef.current || disabled) return;
    focusDay.current = keyboard;
    setFocusedDate(date);
    setYearText(date.slice(0, 4));
  };
  const select = async (date: string) => {
    if (busyRef.current || disabled) return;
    if (date === workDate) { close(); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      await onChange(date);
      if (mounted.current) {
        setOpen(false);
        // The parent releases its save lock in the same turn. Wait for that
        // disabled attribute to be committed before returning keyboard focus.
        requestAnimationFrame(() => { if (mounted.current) anchor.current?.focus({ preventScroll: true }); });
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Не удалось изменить дату.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <>
    <button ref={anchor} type="button" className="report-date-cell" aria-label={`Изменить дату отчёта: ${dateLabel(workDate)}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? pickerId : undefined} disabled={disabled} title="Выбрать дату" onClick={event => {
      event.stopPropagation();
      if (disabled) return;
      if (open) { close(); return; }
      focusDay.current = true; setFocusedDate(workDate); setYearText(workDate.slice(0, 4)); setError(""); setPosition(current => ({ ...current, ready: false })); setOpen(true);
    }}><span>{dateLabel(workDate)}</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M8 3v4m8-4v4M3 10h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /></svg></button>
    {open && createPortal(<div ref={panel} id={pickerId} role="dialog" tabIndex={-1} aria-modal="false" aria-label="Выбор даты отчёта" aria-busy={busy} className="report-date-popover ag-custom-component-popup" style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}><div role="presentation" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && !anchor.current?.contains(event.relatedTarget)) close(false);
    }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.target instanceof HTMLElement && event.target.dataset.date && calendarKeys.has(event.key)) {
        event.preventDefault();
        navigate(calendarKeyDate(event.target.dataset.date, event.key, event.shiftKey), true);
      }
    }}>
      <div className="report-date-calendar-heading">
        <button type="button" aria-label="Предыдущий месяц" disabled={blocked || !shiftCalendarMonth(focusedDate, -1)} onClick={() => navigate(shiftCalendarMonth(focusedDate, -1))}>‹</button>
        <select aria-label="Месяц" value={parts.month} disabled={blocked} onChange={event => { const month = Number(event.target.value); navigate(calendarDate(parts.year, month, Math.min(parts.day, calendarMonthDays(parts.year, month)))); }}>{monthNames.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select>
        <input type="number" inputMode="numeric" aria-label="Год" min={1} max={9999} value={yearText} disabled={blocked} onChange={event => {
          const value = event.target.value; setYearText(value);
          const year = Number(value);
          if (/^\d{1,4}$/.test(value) && year >= 1 && year <= 9999) setFocusedDate(calendarDate(year, parts.month, Math.min(parts.day, calendarMonthDays(year, parts.month)))!);
        }} onBlur={() => setYearText(String(parts.year))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusedDate}"]`)?.focus(); } }} />
        <button type="button" aria-label="Следующий месяц" disabled={blocked || !shiftCalendarMonth(focusedDate, 1)} onClick={() => navigate(shiftCalendarMonth(focusedDate, 1))}>›</button>
      </div>
      <table className="report-date-calendar-grid" role="grid" aria-label={`${monthNames[parts.month - 1]} ${parts.year}`}><thead><tr>{weekdays.map(day => <th scope="col" key={day}>{day}</th>)}</tr></thead><tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{calendarMonthGrid(parts.year, parts.month).slice(week * 7, week * 7 + 7).map((cell, index) => <td key={cell.date ?? index} aria-selected={cell.date === workDate}>{cell.date && <button type="button" data-date={cell.date} className={`${cell.inMonth ? "" : "is-other-month "}${cell.date === workDate ? "is-selected" : ""}`} tabIndex={cell.date === focusedDate ? 0 : -1} aria-label={dateLabel(cell.date)} aria-current={cell.date === today ? "date" : undefined} disabled={blocked} onClick={() => void select(cell.date!)}>{cell.day}</button>}</td>)}</tr>)}</tbody></table>
      {(busy || scopeLabel) && <div className="report-date-calendar-footer">{busy ? <span role="status">Сохраняем…</span> : <span>{scopeLabel}</span>}</div>}
      {error && <p className="report-date-calendar-error" role="alert">{error}</p>}
    </div></div>, document.body)}
  </>;
}
