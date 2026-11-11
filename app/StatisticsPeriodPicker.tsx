"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { createPortal } from "react-dom";
import { calendarKeyDate, calendarMonthGrid, parseCalendarDate, shiftCalendarDate, shiftCalendarMonth } from "./reportDateCalendar";
import { STATISTICS_MAX_RANGE_DAYS } from "./statisticsTypes";
import "./statisticsPeriodPicker.css";

type Period = { from: string; to: string };

const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const monthFormat = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" });
const dateText = (date: string) => date.split("-").reverse().join(".");
const periodText = ({ from, to }: Period) => from === to ? dateText(from) : `${dateText(from)} — ${dateText(to)}`;

export function StatisticsPeriodPicker({ period, today, onChange }: { period: Period; today: string; onChange: (period: Period) => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(period);
  const [awaitingEnd, setAwaitingEnd] = useState(false);
  const [focusedDate, setFocusedDate] = useState(period.from);
  const { year, month } = parseCalendarDate(focusedDate) ?? parseCalendarDate(today)!;
  const monthTitle = monthFormat.format(new Date(`${focusedDate.slice(0, 7)}-01T00:00:00Z`));
  const lastDay = shiftCalendarDate(draft.from, STATISTICS_MAX_RANGE_DAYS - 1);
  const rangeError = lastDay && draft.to > lastDay ? `Выберите период до ${STATISTICS_MAX_RANGE_DAYS} дней.` : "";
  const previousMonth = shiftCalendarMonth(focusedDate, -1);
  const nextMonth = shiftCalendarMonth(focusedDate, 1);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  const reposition = useCallback(() => {
    const button = trigger.current;
    const panel = popup.current;
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : rect.top - height - 6;
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    panel.style.visibility = "visible";
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    if (!focusDay.current) return;
    focusDay.current = false;
    popup.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
  }, [open, focusedDate, awaitingEnd, rangeError, reposition]);

  useEffect(() => {
    if (!open) return;
    const outside = ({ target }: PointerEvent) => {
      if (target instanceof Node && !trigger.current?.contains(target) && !popup.current?.contains(target)) close(false);
    };
    const scroll = ({ target }: Event) => {
      if (!(target instanceof Node) || !popup.current?.contains(target)) reposition();
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

  function closeOnBlur(event: FocusEvent<HTMLElement>) {
    const target = event.relatedTarget;
    if (target instanceof Node && !trigger.current?.contains(target) && !popup.current?.contains(target)) close(false);
  }

  function selectDay(date: string) {
    focusDay.current = true;
    setFocusedDate(date);
    if (!awaitingEnd) setDraft({ from: date, to: date });
    else setDraft(date < draft.from ? { from: date, to: draft.from } : { from: draft.from, to: date });
    setAwaitingEnd(!awaitingEnd);
  }

  const days = calendarMonthGrid(year, month);

  return <div className="statistics-period-picker">
    <button ref={trigger} type="button" className="excel-preview-period-trigger" aria-label="Период статистики" aria-describedby={`${id}-value`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onBlur={closeOnBlur} onClick={() => {
        if (open) { close(); return; }
        setDraft(period);
        setAwaitingEnd(false);
        setFocusedDate(period.from);
        focusDay.current = true;
        setOpen(true);
      }} onKeyDown={event => { if (open && event.key === "Escape") { event.preventDefault(); close(); } }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
      <strong id={`${id}-value`}>{periodText(period)}</strong>
      <svg className="excel-preview-period-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
    </button>

    {open && createPortal(<div ref={popup} id={id} className="excel-preview-range-calendar statistics-period-calendar" role="dialog" aria-label="Выбор периода статистики">
      <div role="presentation" onBlur={closeOnBlur} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        const date = event.target instanceof HTMLElement && event.target.dataset.date;
        const next = date ? calendarKeyDate(date, event.key, event.shiftKey) : null;
        if (next) { event.preventDefault(); focusDay.current = true; setFocusedDate(next); }
      }}>
        <div className="excel-preview-calendar-heading">
          <button type="button" aria-label="Предыдущий месяц" disabled={!previousMonth} onClick={() => { if (previousMonth) setFocusedDate(previousMonth); }}>‹</button>
          <strong aria-live="polite">{monthTitle}</strong>
          <button type="button" aria-label="Следующий месяц" disabled={!nextMonth} onClick={() => { if (nextMonth) setFocusedDate(nextMonth); }}>›</button>
        </div>

        <div role="grid" aria-label={monthTitle} aria-multiselectable="true">
          <div role="row" className="excel-preview-calendar-weekdays">{weekdays.map(day => <span key={day} role="columnheader">{day}</span>)}</div>
          {Array.from({ length: 6 }, (_, week) => <div role="row" className="excel-preview-calendar-days" key={week}>
            {days.slice(week * 7, week * 7 + 7).map(({ date, day, inMonth }, index) => {
              if (!date) return <div role="gridcell" key={index} />;
              const start = date === draft.from;
              const end = date === draft.to;
              const between = date > draft.from && date < draft.to;
              const className = [!inMonth && "other-month", start && "range-start", end && "range-end", start && end && "range-single", between && "in-range"].filter(Boolean).join(" ");
              return <div role="gridcell" aria-selected={start || end || between} key={date}>
                <button type="button" data-date={date} className={className} tabIndex={date === focusedDate ? 0 : -1} aria-label={dateText(date)}
                  aria-current={date === today ? "date" : undefined} onClick={() => selectDay(date)}>{day}</button>
              </div>;
            })}
          </div>)}
        </div>

        <div className="excel-preview-calendar-selection" role="status">{awaitingEnd ? "Выберите конец периода или примените один день." : periodText(draft)}</div>
        {rangeError && <p className="excel-preview-period-error" role="alert">{rangeError}</p>}
        <div className="excel-preview-calendar-actions">
          <button type="button" className="excel-preview-calendar-month" onClick={() => close()}>Отмена</button>
          <button type="button" className="excel-preview-apply-period" disabled={Boolean(rangeError)} onClick={() => { close(); onChange(draft); }}>Применить</button>
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
