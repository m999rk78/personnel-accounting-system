"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { TimesheetCellPopover } from "./TimesheetCellPopover";

const MONTH_LABEL = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_NAMES = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))).replace(".", ""));

/** Both timesheets use a portal: the compact summary bar deliberately clips its contents. */
export function TimesheetMonthPicker({ value, current, onChange }: { value: string; current: string; onChange: (value: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [visibleYear, setVisibleYear] = useState(() => Number(value.slice(0, 4)));
  const [choosingYear, setChoosingYear] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const selectedYear = Number(value.slice(0, 4));
  const selectedMonth = Number(value.slice(5, 7));
  const currentYear = Number(current.slice(0, 4));
  const currentMonth = Number(current.slice(5, 7));
  const formatted = MONTH_LABEL.format(new Date(`${value}-01T12:00:00Z`));
  const valueLabel = formatted.charAt(0).toLocaleUpperCase("ru-RU") + formatted.slice(1);
  const firstYear = Math.min(9988, Math.max(1, Math.floor(visibleYear / 12) * 12));
  const years = Array.from({ length: 12 }, (_, index) => firstYear + index);

  useEffect(() => {
    if (!anchor) return;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector<HTMLButtonElement>("[data-picker-option].selected") ?? panel.current?.querySelector<HTMLButtonElement>("[data-picker-option]"))?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [anchor, choosingYear]);

  useEffect(() => {
    if (!anchor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAnchor(null);
      requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [anchor]);

  function close(restoreFocus = false) {
    setAnchor(null);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  function chooseMonth(month: string) {
    onChange(month);
    close(true);
  }

  function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const options = [...(panel.current?.querySelectorAll<HTMLButtonElement>("[data-picker-option]") ?? [])];
    const index = options.indexOf(event.currentTarget);
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 } as Record<string, number>)[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : step === undefined ? -1 : (index + step + options.length) % options.length;
    if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
  }

  return <div className="timesheet-month-picker">
    <button ref={trigger} type="button" className="timesheet-month-picker-trigger" aria-label={`Выбрать месяц, сейчас ${valueLabel}`} aria-expanded={Boolean(anchor)} aria-haspopup="dialog" onClick={event => {
      if (anchor) close();
      else { setVisibleYear(selectedYear); setChoosingYear(false); setAnchor(event.currentTarget); }
    }}>
      <span>{valueLabel}</span>
      <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></svg>
    </button>
    {anchor && <TimesheetCellPopover anchor={anchor} width={280} className="timesheet-month-popover" ariaLabel="Выбор месяца табеля" onClose={() => close()}>
      <div ref={panel} role="group" aria-label="Календарь табеля">
        <div className="calendar-heading">
          <button type="button" disabled={choosingYear ? firstYear <= 1 : visibleYear <= 1} onClick={() => setVisibleYear(year => Math.max(1, year - (choosingYear ? 12 : 1)))} aria-label={choosingYear ? "Предыдущие годы" : "Предыдущий год"}>‹</button>
          <button type="button" className="timesheet-year-trigger" aria-label={choosingYear ? "Вернуться к выбору месяца" : `Выбрать год, сейчас ${visibleYear}`} aria-expanded={choosingYear} onClick={() => setChoosingYear(open => !open)}>
            <span>{choosingYear ? `${firstYear} — ${firstYear + 11}` : visibleYear}</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={choosingYear ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"}/></svg>
          </button>
          <button type="button" disabled={choosingYear ? firstYear + 11 >= 9999 : visibleYear >= 9999} onClick={() => setVisibleYear(year => Math.min(9999, year + (choosingYear ? 12 : 1)))} aria-label={choosingYear ? "Следующие годы" : "Следующий год"}>›</button>
        </div>
        <div className="timesheet-month-grid" aria-label={choosingYear ? "Выбор года" : `Месяцы ${visibleYear} года`}>
          {choosingYear ? years.map(year => <button type="button" data-picker-option onKeyDown={moveFocus} key={year} className={[year === selectedYear ? "selected" : "", year === currentYear ? "current" : ""].filter(Boolean).join(" ")} aria-pressed={year === selectedYear} onClick={() => { setVisibleYear(year); setChoosingYear(false); }}>{year}</button>)
            : MONTH_NAMES.map((name, index) => <button type="button" data-picker-option onKeyDown={moveFocus} key={name} className={[visibleYear === selectedYear && index + 1 === selectedMonth ? "selected" : "", visibleYear === currentYear && index + 1 === currentMonth ? "current" : ""].filter(Boolean).join(" ")} aria-pressed={visibleYear === selectedYear && index + 1 === selectedMonth} onClick={() => chooseMonth(`${String(visibleYear).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}`)}>{name}</button>)}
        </div>
        {value !== current && <button type="button" className="timesheet-month-current" onClick={() => chooseMonth(current)}>Текущий месяц</button>}
      </div>
    </TimesheetCellPopover>}
  </div>;
}
