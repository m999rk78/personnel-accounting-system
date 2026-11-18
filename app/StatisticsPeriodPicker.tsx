"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import { CustomSelect } from "./CustomSelect";
import { calendarKeyDate, calendarMonthGrid, parseCalendarDate, shiftCalendarMonth } from "./reportDateCalendar";
import { formatStatisticsDate, parseStatisticsDate, statisticsPresetRange, validateStatisticsRange, type StatisticsDateRange, type StatisticsPeriodPreset, type StatisticsPeriodSelection } from "./statisticsPeriod";
import "./statisticsPeriodPicker.css";

const options: { value: StatisticsPeriodPreset; label: string }[] = [
  { value: "all", label: "За весь период" },
  { value: "week", label: "Текущая неделя" },
  { value: "month", label: "Текущий месяц" },
  { value: "previousMonth", label: "Прошлый месяц" },
  { value: "custom", label: "Свой период…" },
];
const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const monthFormat = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" });

function StatisticsDateField({ id, caption, label, value, today, errorId, onChange, onCommit }: {
  id: string; caption: string; label: string; value: string; today: string; errorId?: string;
  onChange: (value: string) => void; onCommit: (value: string) => void;
}) {
  const field = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const [open, setOpen] = useState(false);
  const [focusedDate, setFocusedDate] = useState(today);
  const currentDate = parseStatisticsDate(value);
  const parts = parseCalendarDate(focusedDate);
  const previousMonth = shiftCalendarMonth(focusedDate, -1);
  const nextMonth = shiftCalendarMonth(focusedDate, 1);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  const place = useCallback(() => {
    const anchor = field.current;
    const panel = popup.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const below = rect.bottom + 6;
    const top = below + panel.offsetHeight <= window.innerHeight - 8 ? below : rect.top - panel.offsetHeight - 6;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - panel.offsetHeight - 8))}px`;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    if (focusDay.current) {
      focusDay.current = false;
      popup.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
    }
  }, [open, focusedDate, place]);

  useEffect(() => {
    if (!open) return;
    const outside = ({ target }: PointerEvent) => {
      if (target instanceof Node && !field.current?.contains(target) && !popup.current?.contains(target)) close();
    };
    const scroll = ({ target }: Event) => {
      if (!(target instanceof Node) || !popup.current?.contains(target)) place();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, place]);

  function closeOnBlur(event: FocusEvent<HTMLElement>) {
    const target = event.relatedTarget;
    if (target instanceof Node && !field.current?.contains(target) && !popup.current?.contains(target)) close();
  }

  const monthTitle = parts ? monthFormat.format(new Date(`${focusedDate.slice(0, 7)}-01T00:00:00Z`)) : "";
  const days = parts ? calendarMonthGrid(parts.year, parts.month) : [];
  const calendarLabel = `${label}: выбрать в календаре`;

  return <div className="statistics-date-field">
    <label htmlFor={id} title={label}>{caption}<span className="sr-only">{` — ${label}`}</span></label>
    <div className="statistics-date-input" ref={field}>
      <input id={id} type="text" inputMode="numeric" autoComplete="off" placeholder="ДД.ММ.ГГГГ"
        value={value} aria-label={label} aria-invalid={Boolean(errorId)} aria-describedby={errorId}
        onChange={event => onChange(event.currentTarget.value)}
        onBlur={event => onCommit(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); onCommit(event.currentTarget.value); }
        }} />
      <button type="button" ref={trigger} aria-label={calendarLabel} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? `${id}-calendar` : undefined} title={calendarLabel} onBlur={closeOnBlur} onClick={() => {
          if (open) { close(); return; }
          setFocusedDate(currentDate ?? today); focusDay.current = true; setOpen(true);
        }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16"/></svg>
      </button>
    </div>
    {open && createPortal(<div className="statistics-period-calendar" id={`${id}-calendar`} ref={popup} role="dialog" aria-label={calendarLabel}
      onBlur={closeOnBlur}>
      <div className="statistics-calendar-heading">
        <button type="button" aria-label="Предыдущий месяц" disabled={!previousMonth} onClick={() => { if (previousMonth) setFocusedDate(previousMonth); }}>‹</button>
        <strong aria-live="polite">{monthTitle}</strong>
        <button type="button" aria-label="Следующий месяц" disabled={!nextMonth} onClick={() => { if (nextMonth) setFocusedDate(nextMonth); }}>›</button>
      </div>
      <div role="grid" aria-label={monthTitle}>
        <div className="statistics-calendar-row statistics-calendar-weekdays" role="row">{weekdays.map(day => <span key={day} role="columnheader">{day}</span>)}</div>
        {Array.from({ length: 6 }, (_, week) => <div className="statistics-calendar-row" role="row" key={week}>
          {days.slice(week * 7, week * 7 + 7).map(({ date, day, inMonth }, index) => date
            ? <div role="gridcell" aria-selected={date === currentDate} key={date}>
              <button type="button" data-date={date} className={inMonth ? "" : "other-month"} tabIndex={date === focusedDate ? 0 : -1}
                aria-label={formatStatisticsDate(date)} aria-current={date === today ? "date" : undefined}
                onKeyDown={event => {
                  const next = calendarKeyDate(date, event.key, event.shiftKey);
                  if (next) { event.preventDefault(); focusDay.current = true; setFocusedDate(next); }
                }}
                onClick={() => { onCommit(formatStatisticsDate(date)); close(true); }}>{day}</button>
            </div>
            : <div key={index} role="gridcell" />)}
        </div>)}
      </div>
    </div>, document.body)}
  </div>;
}

function StatisticsCustomRange({ range, today, onChange }: { range: StatisticsDateRange; today: string; onChange: (range: StatisticsDateRange) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(() => ({ from: formatStatisticsDate(range.from), to: formatStatisticsDate(range.to) }));
  const [error, setError] = useState("");
  function commit(side: keyof StatisticsDateRange, value: string) {
    const next = { ...draft, [side]: value };
    const result = validateStatisticsRange(next);
    if (!result.range) { setDraft(next); setError(result.error); return; }
    const { from, to } = result.range;
    setDraft({ from: formatStatisticsDate(from), to: formatStatisticsDate(to) });
    setError("");
    if (from !== range.from || to !== range.to) onChange(result.range);
  }
  const dateField = (side: keyof StatisticsDateRange, caption: string, label: string) => <StatisticsDateField
    id={`${id}-${side}`} caption={caption} label={label} value={draft[side]} today={today} errorId={error ? `${id}-error` : undefined}
    onChange={value => { setDraft(current => ({ ...current, [side]: value })); setError(""); }}
    onCommit={value => commit(side, value)} />;
  return <div className="statistics-custom-range">
    <div className="statistics-date-fields" role="group" aria-label="Границы своего периода">
      {dateField("from", "С", "Дата начала периода")}
      {dateField("to", "По", "Дата окончания периода")}
    </div>
    {error && <p className="statistics-range-error" role="alert" id={`${id}-error`}>{error}</p>}
  </div>;
}

export function StatisticsPeriodPicker({ selection, today, onChange }: {
  selection: StatisticsPeriodSelection; today: string; onChange: (selection: StatisticsPeriodSelection) => void;
}) {
  const lastCustom = useRef<StatisticsDateRange | null>(null);
  const changeCustom = (range: StatisticsDateRange) => { lastCustom.current = range; onChange({ preset: "custom", range }); };
  return <div className="statistics-period-picker">
    <span className="statistics-period-label">Период</span>
    <CustomSelect ariaLabel="Период статистики" className="statistics-period-select" menuClassName="statistics-period-menu" menuMinWidth={0}
      value={selection.preset} options={options} onChange={value => {
        const preset = value as StatisticsPeriodPreset;
        if (preset === selection.preset) return;
        if (preset === "all") onChange({ preset });
        else if (preset === "custom") changeCustom(lastCustom.current ?? (selection.preset === "all" ? statisticsPresetRange("month", today) : selection.range));
        else onChange({ preset, range: statisticsPresetRange(preset, today) });
      }} />
    {selection.preset === "custom" && <StatisticsCustomRange range={selection.range} today={today} onChange={changeCustom} />}
  </div>;
}
