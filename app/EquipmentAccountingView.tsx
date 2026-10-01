"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EquipmentDailyAgGrid, EquipmentRegistryAgGrid, ProjectEquipmentAgGrid, type GridEquipmentDraft, type GridEquipmentEntry, type GridEquipmentRegistryDraft, type GridEquipmentUnit, type GridProjectEquipmentDraft } from "./AgDataGrids";
import { CustomSelect } from "./CustomSelect";
import { createEquipmentTimesheetXlsx, createTableXlsx, parseEquipmentEntriesXlsx, parseEquipmentRegistryXlsx } from "./placementXlsx";
import { TIMESHEET_ALL_OPTION, TimesheetFilterableHeading, type TimesheetFilterOption } from "./TimesheetColumnFilter";
import { TimesheetCellPopover } from "./TimesheetCellPopover";
import { useTimesheetClipboard, type TimesheetClipboardChange } from "./useTimesheetClipboard";
import { equipmentUnavailableReason, isEquipmentUnavailable } from "./equipmentAvailability";
import { buildEquipmentCarryoverDrafts } from "./equipmentCarryover";

type Option = { id: number; name: string };
type EquipmentUnit = GridEquipmentUnit;
type EquipmentEntry = GridEquipmentEntry & {
  workDate: string;
};
type EquipmentTimesheetMark = {
  equipmentId: number;
  workDate: string;
  productiveHours: number;
  downtimeHours: number;
  note: string;
  updatedBy: string;
};
type EquipmentTimesheetEditor = {
  equipmentId: number;
  workDate: string;
  anchor: HTMLElement;
  mode: "list" | "advanced";
};
type EquipmentTimesheetInlineEditor = { equipmentId: number; workDate: string; rowIndex: number; columnIndex: number; value: string; error: string; selectAll: boolean };
type EquipmentMonthCell = {
  productive: number;
  downtime: number;
  reportProductive: number;
  reportDowntime: number;
  mark?: EquipmentTimesheetMark;
  mismatch: boolean;
};
type EquipmentForemanProgress = { foremanId: number; foremanName: string; status: "not_started" | "draft" | "submitted"; submittedAt: string | null; equipmentCount: number; rowCount: number; hours: number };
type EquipmentPayload = {
  siteId: number;
  siteName: string;
  workDate: string;
  month: string;
  canEditDaily: boolean;
  canEditTimesheet: boolean;
  canManageRegistry: boolean;
  canManageAssignments: boolean;
  currentUserRole: "foreman" | "engineer" | "superadmin";
  currentUserName: string;
  reportSubmitted: boolean;
  foremanProgress: EquipmentForemanProgress[];
  units: EquipmentUnit[];
  availableUnits: EquipmentUnit[];
  sites: Option[];
  entries: EquipmentEntry[];
  marks: EquipmentTimesheetMark[];
  dailyTimesheetMarks: EquipmentTimesheetMark[];
  shifts: Option[];
  zones: Option[];
  mainWorkTypes: Option[];
  subworkTypes: Option[];
  filledDates: string[];
  error?: string;
};
type EquipmentCarryoverPayload = { sourceDate: string | null; entries: EquipmentEntry[]; error?: string };
type EntryDraft = GridEquipmentDraft;
type UnitDraft = GridEquipmentRegistryDraft;
type ProjectUnitDraft = GridProjectEquipmentDraft;
export type EquipmentSection = "daily" | "month" | "registry" | "project";

const MONTH_FORMATTER = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const EQUIPMENT_DAY_FILTERS: TimesheetFilterOption[] = [TIMESHEET_ALL_OPTION, { value: "filled", label: "Есть значение" }, { value: "empty", label: "Нет значения" }, { value: "productive", label: "Есть работа" }, { value: "downtime", label: "Есть простой" }, { value: "manual", label: "Ручная правка" }, { value: "mismatch", label: "Расхождение" }];
const EQUIPMENT_TOTAL_FILTERS: TimesheetFilterOption[] = [TIMESHEET_ALL_OPTION, { value: "positive", label: "Больше нуля" }, { value: "zero", label: "Равно нулю" }];
const EQUIPMENT_TIMESHEET_CODES = [
  { value: "В", label: "Выходной" },
  { value: "ДО", label: "Дополнительный отпуск" },
  { value: "МО", label: "Межвахтовый отдых" },
  { value: "ПЕ", label: "ПЕ" },
  { value: "УВ", label: "УВ" },
  { value: "ПР", label: "Прогул" },
];
const EQUIPMENT_HOUR_OPTIONS = Array.from({ length: 21 }, (_, hours) => ({ value: String(hours), label: `${hours} ч.` }));
const EQUIPMENT_MARK_OPTIONS = [
  ...Array.from({ length: 20 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} ч. работы`, group: "productive" as const })),
  ...Array.from({ length: 20 }, (_, index) => ({ value: `П ${index + 1}`, label: `П ${index + 1} — ${index + 1} ч. простоя`, group: "downtime" as const })),
];

function shiftDate(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function toDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function recentDateKeys(endDate: string, count = 14) {
  const end = parseDateKey(endDate);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (count - index - 1));
    return toDateKey(date);
  });
}

function shortDate(value: string) {
  const date = parseDateKey(value);
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(parseDateKey(value));
}

function parseEquipmentClipboardHours(rawValue: string) {
  const value = rawValue.trim().toLocaleUpperCase("ru-RU");
  if (!value) return { clear: true, productiveHours: 0, downtimeHours: 0 };
  const downtimeOnly = value.match(/^П\s*(\d{1,2})$/);
  if (downtimeOnly) {
    const downtimeHours = Number(downtimeOnly[1]);
    if (downtimeHours > 20) throw new Error(`Значение «${rawValue}» превышает допустимые 20 часов за сутки.`);
    return { clear: false, productiveHours: 0, downtimeHours };
  }
  const match = value.match(/^(\d{1,2})(?:\s*[/+;]\s*(\d{1,2}))?$/);
  if (!match) throw new Error("Недопустимое значение. Используйте часы работы, «П 2» для простоя или формат «8/2» для работы и простоя.");
  const productiveHours = Number(match[1]);
  const downtimeHours = Number(match[2] ?? 0);
  if (productiveHours > 20 || downtimeHours > 20 || productiveHours + downtimeHours > 20) {
    throw new Error(`Значение «${rawValue}» превышает допустимые 20 часов за сутки.`);
  }
  return { clear: false, productiveHours, downtimeHours };
}

function formatEquipmentHours(productiveHours: number, downtimeHours: number) {
  if (downtimeHours > 0) return productiveHours > 0 ? `${productiveHours}/${downtimeHours}` : `П ${downtimeHours}`;
  return String(productiveHours);
}

function EquipmentTimesheetMarkList({ value, canReset, disabled, onChoose, onClose }: {
  value: string;
  canReset: boolean;
  disabled: boolean;
  onChoose: (value: string) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => [
    ...EQUIPMENT_MARK_OPTIONS,
    ...(canReset ? [{ value: "", label: "Вернуть значение из отчёта", group: "reset" as const }] : []),
  ], [canReset]);
  const initialIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => optionButtons.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  function moveActive(offset: number) {
    setActiveIndex((current) => (current + offset + options.length) % options.length);
  }

  return <div className="custom-select-options timesheet-mark-options equipment-mark-options" role="listbox" aria-label="Значение табеля техники">
    {options.map((option, index) => {
      const selected = Boolean(option.value) && option.value === value;
      return <button
        ref={(element) => { optionButtons.current[index] = element; }}
        key={option.value || "reset"}
        type="button"
        role="option"
        aria-selected={selected}
        className={[
          "custom-select-option",
          selected ? "selected" : "",
          activeIndex === index ? "active" : "",
          option.group === "downtime" && options[index - 1]?.group !== "downtime" ? "equipment-mark-downtime-start" : "",
          option.group === "reset" ? "timesheet-mark-reset-option" : "",
        ].filter(Boolean).join(" ")}
        disabled={disabled}
        tabIndex={activeIndex === index ? 0 : -1}
        onMouseEnter={() => setActiveIndex(index)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        onClick={() => onChoose(option.value)}
      >
        <span>{option.label}</span>
        {selected && <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>}
      </button>;
    })}
  </div>;
}

function EquipmentMonthPicker({ value, current, onChange }: { value: string; current: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(() => Number(value.slice(0, 4)));
  const root = useRef<HTMLDivElement>(null);
  const selectedYear = Number(value.slice(0, 4));
  const selectedMonth = Number(value.slice(5, 7));
  const currentYear = Number(current.slice(0, 4));
  const currentMonth = Number(current.slice(5, 7));
  const monthNames = useMemo(() => Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))).replace(".", "")), []);
  const valueLabel = titleCase(MONTH_FORMATTER.format(new Date(`${value}-01T00:00:00Z`)));

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [open]);

  function toggle() {
    if (!open) setVisibleYear(selectedYear);
    setOpen((current) => !current);
  }

  function selectMonth(monthNumber: number) {
    const next = `${visibleYear}-${String(monthNumber).padStart(2, "0")}`;
    onChange(next);
    setOpen(false);
  }

  return <div className="timesheet-month-picker" ref={root}>
    <button type="button" className="timesheet-month-picker-trigger" aria-label={`Выбрать месяц, сейчас ${valueLabel}`} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
      <span>{valueLabel}</span>
      <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></svg>
    </button>
    {open && <div className="calendar-popover timesheet-month-popover" role="dialog" aria-label="Выбор месяца табеля">
      <div className="calendar-heading"><button type="button" onClick={() => setVisibleYear((year) => year - 1)} aria-label="Предыдущий год">‹</button><strong>{visibleYear}</strong><button type="button" onClick={() => setVisibleYear((year) => year + 1)} aria-label="Следующий год">›</button></div>
      <div className="timesheet-month-grid">{monthNames.map((name, index) => {
        const monthNumber = index + 1;
        const selected = visibleYear === selectedYear && monthNumber === selectedMonth;
        const isCurrent = visibleYear === currentYear && monthNumber === currentMonth;
        return <button type="button" key={name} className={[selected ? "selected" : "", isCurrent ? "current" : ""].filter(Boolean).join(" ")} onClick={() => selectMonth(monthNumber)}>{name}</button>;
      })}</div>
      {value !== current && <button type="button" className="timesheet-month-current" onClick={() => { onChange(current); setOpen(false); }}>Текущий месяц</button>}
    </div>}
  </div>;
}

function EquipmentReportDateNavigation({ dates, value, today, filledDates, onChange, onRangeChange }: { dates: string[]; value: string; today: string; filledDates: Set<string>; onChange: (value: string) => void; onRangeChange: (rangeEnd: string) => void }) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [rangeMotion, setRangeMotion] = useState<"older" | "newer" | "calendar" | "">("");
  const [visibleMonth, setVisibleMonth] = useState(() => { const selected = parseDateKey(value); return new Date(selected.getFullYear(), selected.getMonth(), 1, 12); });
  const root = useRef<HTMLDivElement>(null);
  const quickDates = useRef<HTMLDivElement>(null);
  const selected = parseDateKey(value);
  const maximum = parseDateKey(today);
  const firstWeekday = (visibleMonth.getDay() + 6) % 7;
  const daysInVisibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday + daysInVisibleMonth }, (_, index) => index < firstWeekday ? null : index - firstWeekday + 1);
  const nextMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1, 12);
  const nextDisabled = nextMonth > new Date(maximum.getFullYear(), maximum.getMonth(), 1, 12);
  const monthTitle = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(visibleMonth);
  const rangeEnd = dates[dates.length - 1] ?? today;

  useEffect(() => {
    if (!calendarOpen) return;
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setCalendarOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setCalendarOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [calendarOpen]);

  useEffect(() => {
    if (quickDates.current) quickDates.current.scrollLeft = quickDates.current.scrollWidth;
  }, [dates]);

  function toggleCalendar() {
    if (!calendarOpen) setVisibleMonth(new Date(selected.getFullYear(), selected.getMonth(), 1, 12));
    setCalendarOpen((open) => !open);
  }

  return <div className="report-date-control" ref={root}>
    <div className="report-date-bar" role="group" aria-label="Дата отчёта техники">
      <button type="button" className="date-step" aria-label="Показать пять более ранних дней" onClick={() => { setRangeMotion("older"); onRangeChange(shiftDate(rangeEnd, -5)); }}>‹</button>
      <div className={["quick-dates", rangeMotion ? `range-${rangeMotion}` : ""].filter(Boolean).join(" ")} ref={quickDates} key={`${dates[0]}-${rangeEnd}`} aria-live="polite">
        {dates.map((date) => {
          const isSelected = date === value;
          const filled = filledDates.has(date);
          const isToday = date === today;
          const className = ["quick-date", isSelected ? "selected" : "", filled ? "filled" : "", isToday ? "today" : ""].filter(Boolean).join(" ");
          const label = `${fullDate(date)}${isToday ? ", сегодня" : ""}${filled ? ", отчёт заполнен" : ", отчёт не заполнен"}`;
          return <button type="button" className={className} key={date} aria-label={label} aria-pressed={isSelected} title={label} onClick={() => onChange(date)}>{shortDate(date)}</button>;
        })}
      </div>
      <button type="button" className="date-step" aria-label="Показать пять более новых дней" disabled={rangeEnd >= today} onClick={() => { setRangeMotion("newer"); onRangeChange(shiftDate(rangeEnd, 5)); }}>›</button>
      <button type="button" className="calendar-trigger" onClick={toggleCalendar} aria-label="Открыть календарь" aria-expanded={calendarOpen}><svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></svg></button>
    </div>
    {calendarOpen && <div className="calendar-popover" role="dialog" aria-label="Выбор даты">
      <div className="calendar-heading"><button type="button" onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1, 12))} aria-label="Предыдущий месяц">‹</button><strong>{monthTitle}</strong><button type="button" disabled={nextDisabled} onClick={() => setVisibleMonth(nextMonth)} aria-label="Следующий месяц">›</button></div>
      <div className="calendar-weekdays">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className="calendar-days">{cells.map((day, index) => day ? (() => {
        const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), day, 12);
        const key = toDateKey(date);
        const disabled = date > maximum;
        const className = [key === value ? "selected" : "", key === today ? "today" : "", filledDates.has(key) ? "filled" : ""].filter(Boolean).join(" ");
        return <button type="button" key={key} disabled={disabled} className={className} onClick={() => { setRangeMotion("calendar"); onChange(key); onRangeChange(key); setCalendarOpen(false); }}>{day}</button>;
      })() : <span key={`empty-${index}`} />)}</div>
    </div>}
  </div>;
}

function shiftMonth(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function titleCase(value: string) {
  return value.charAt(0).toLocaleUpperCase("ru-RU") + value.slice(1);
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
}

function isDowntime(entry: Pick<EquipmentEntry, "subworkTypeName">) {
  return normalize(entry.subworkTypeName).includes("простой");
}

function unitTitle(unit: Pick<EquipmentUnit, "equipmentType" | "brand" | "model" | "registrationNumber">) {
  return [unit.equipmentType, unit.brand, unit.model, unit.registrationNumber && unit.registrationNumber !== "-" ? `• ${unit.registrationNumber}` : ""].filter(Boolean).join(" ");
}

function equipmentCellKey(equipmentId: number, workDate: string) {
  return `${equipmentId}:${workDate}`;
}

function matchesEquipmentDayFilter(filters: string[], value?: EquipmentMonthCell) {
  if (filters.length === 0) return true;
  const hasValue = Boolean(value && (value.productive || value.downtime || value.mark));
  return filters.some((filter) => {
    if (filter === "filled") return hasValue;
    if (filter === "empty") return !hasValue;
    if (filter === "productive") return Number(value?.productive ?? 0) > 0;
    if (filter === "downtime") return Number(value?.downtime ?? 0) > 0;
    if (filter === "manual") return Boolean(value?.mark);
    return filter === "mismatch" && Boolean(value?.mismatch);
  });
}

function matchesEquipmentTotalFilter(filters: string[], value: number) {
  if (filters.length === 0) return true;
  return filters.some((filter) => filter === "positive" ? value > 0 : filter === "zero" && value === 0);
}

function emptyEntry(payload: EquipmentPayload | null): EntryDraft {
  return {
    key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `equipment-${Date.now()}-${Math.random()}`,
    equipmentId: "",
    shiftId: payload?.shifts[0] ? String(payload.shifts[0].id) : "",
    zoneId: "",
    mainWorkTypeId: "",
    subworkTypeId: "",
    hours: "10",
    note: "",
  };
}

const emptyUnit = (): UnitDraft => ({ key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `equipment-unit-${Date.now()}-${Math.random()}`, organization: "", equipmentType: "", brand: "", model: "", registrationNumber: "", note: "", projectSiteId: "" });

export function EquipmentAccountingView({ siteId, initialDate, today, mode }: { siteId: number; initialDate: string; today: string; mode: EquipmentSection }) {
  const section = mode;
  const [workDate, setWorkDate] = useState(initialDate);
  const [reportRangeEnd, setReportRangeEnd] = useState(initialDate);
  const [month, setMonth] = useState(initialDate.slice(0, 7));
  const [payload, setPayload] = useState<EquipmentPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [entryDrafts, setEntryDrafts] = useState<EntryDraft[]>([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<number[]>([]);
  const [selectedEntryDraftKeys, setSelectedEntryDraftKeys] = useState<string[]>([]);
  const [previousDayReport, setPreviousDayReport] = useState<{ key: string; date: string; entries: EquipmentEntry[] } | null>(null);
  const [unitDrafts, setUnitDrafts] = useState<UnitDraft[]>([]);
  const [selectedUnitIds, setSelectedUnitIds] = useState<number[]>([]);
  const [unitFullRowEditIds, setUnitFullRowEditIds] = useState<number[]>([]);
  const [visibleUnitIds, setVisibleUnitIds] = useState<number[] | null>(null);
  const [projectUnitDrafts, setProjectUnitDrafts] = useState<ProjectUnitDraft[]>([]);
  const [selectedProjectUnitIds, setSelectedProjectUnitIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [equipmentNameFilter, setEquipmentNameFilter] = useState<string[]>([]);
  const [organizationFilter, setOrganizationFilter] = useState<string[]>([]);
  const [monthDayFilters, setMonthDayFilters] = useState<Record<string, string[]>>({});
  const [productiveTotalFilter, setProductiveTotalFilter] = useState<string[]>([]);
  const [downtimeTotalFilter, setDowntimeTotalFilter] = useState<string[]>([]);
  const [equipmentTotalFilter, setEquipmentTotalFilter] = useState<string[]>([]);
  const [timesheetEditor, setTimesheetEditor] = useState<EquipmentTimesheetEditor | null>(null);
  const [timesheetInlineEditor, setTimesheetInlineEditor] = useState<EquipmentTimesheetInlineEditor | null>(null);
  const [timesheetProductive, setTimesheetProductive] = useState("0");
  const [timesheetDowntime, setTimesheetDowntime] = useState("0");
  const [timesheetNote, setTimesheetNote] = useState("");
  const [savingTimesheetMark, setSavingTimesheetMark] = useState(false);
  const [timesheetEditorError, setTimesheetEditorError] = useState("");
  const [timesheetInfoOpen, setTimesheetInfoOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dailyFileInput = useRef<HTMLInputElement>(null);
  const initializedCarryoverSession = useRef<string | null>(null);
  const timesheetInlineInput = useRef<HTMLInputElement>(null);
  const timesheetInlineEquipmentId = timesheetInlineEditor?.equipmentId;
  const timesheetInlineWorkDate = timesheetInlineEditor?.workDate;
  const timesheetInlineSelectAll = timesheetInlineEditor?.selectAll ?? false;

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const recentDates = useMemo(() => recentDateKeys(reportRangeEnd), [reportRangeEnd]);

  useEffect(() => {
    const targetId = section === "daily" ? "equipment-report-actions" : section === "registry" ? "equipment-registry-actions" : section === "month" ? "equipment-timesheet-actions" : "";
    const task = window.setTimeout(() => setHeaderActionsTarget(targetId ? document.getElementById(targetId) : null), 0);
    return () => window.clearTimeout(task);
  }, [section]);

  useEffect(() => {
    if (!timesheetEditor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingTimesheetMark) setTimesheetEditor(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [savingTimesheetMark, timesheetEditor]);

  useEffect(() => {
    setTimesheetEditor(null);
    setTimesheetInlineEditor(null);
  }, [month, section]);

  useEffect(() => {
    if (timesheetInlineEquipmentId === undefined || !timesheetInlineWorkDate) return;
    const frame = requestAnimationFrame(() => {
      timesheetInlineInput.current?.focus({ preventScroll: true });
      if (timesheetInlineSelectAll) timesheetInlineInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [timesheetInlineEquipmentId, timesheetInlineSelectAll, timesheetInlineWorkDate]);

  useEffect(() => {
    if (!timesheetInfoOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setTimesheetInfoOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [timesheetInfoOpen]);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const scope = section === "registry" ? "global" : section === "project" ? "assignments" : "project";
      const viewMode = section === "month" ? "timesheet" : section;
      const rangeQuery = section === "daily" ? `&rangeStart=${recentDates[0]}&rangeEnd=${reportRangeEnd}` : "";
      fetch(`/api/equipment?siteId=${siteId}&date=${workDate}&month=${month}&scope=${scope}&view=${viewMode}&section=${section}${rangeQuery}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace("/login");
          return null;
        }
        const result = await response.json() as EquipmentPayload;
        if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить учёт техники.");
        return result;
      })
      .then((result) => { if (result) setPayload(result); })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить учёт техники.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [month, recentDates, reloadKey, reportRangeEnd, section, siteId, workDate]);

  useEffect(() => {
    if (section !== "daily" || workDate !== today || payload?.workDate !== workDate || payload.currentUserRole !== "foreman" || !payload.canEditDaily) return;
    const key = `${siteId}:${workDate}`;
    if (payload.reportSubmitted) {
      setPreviousDayReport({ key, date: "", entries: [] });
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/equipment?siteId=${siteId}&date=${workDate}&month=${month}&scope=carryover&view=daily&section=daily`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace("/login");
          return null;
        }
        const result = await response.json() as EquipmentCarryoverPayload;
        if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить последний отчёт техники.");
        return result;
      })
      .then((result) => {
        if (result) setPreviousDayReport({ key, date: result.sourceDate ?? "", entries: result.entries });
      })
      .catch((carryError: unknown) => {
        if (carryError instanceof DOMException && carryError.name === "AbortError") return;
        setPreviousDayReport({ key, date: "", entries: [] });
        setError(carryError instanceof Error ? carryError.message : "Не удалось загрузить последний отчёт техники.");
      });
    return () => controller.abort();
  }, [month, payload?.canEditDaily, payload?.currentUserRole, payload?.reportSubmitted, payload?.workDate, section, siteId, today, workDate]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/equipment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, ...body }),
    });
    if (response.status === 401) {
      window.location.replace("/login");
      throw new Error("Требуется авторизация.");
    }
    const result = await response.json() as { error?: string; imported?: number; skipped?: number; mark?: EquipmentTimesheetMark; deleted?: boolean };
    if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить изменения.");
    return result;
  }, [siteId]);

  function changeWorkDate(next: string) {
    initializedCarryoverSession.current = null;
    setWorkDate(next);
    setMonth(next.slice(0, 7));
    setEntryDrafts([]);
    setSelectedEntryIds([]);
    setSelectedEntryDraftKeys([]);
    setPreviousDayReport(null);
  }

  function changeReportRange(nextEnd: string) {
    setReportRangeEnd(nextEnd > today ? today : nextEnd);
  }

  function openEntry(entry?: EquipmentEntry, changes: Partial<EntryDraft> = {}) {
    setNotice("");
    setError("");
    setSelectedEntryIds([]);
    setSelectedEntryDraftKeys([]);
    setEntryDrafts((current) => {
      if (!entry) return [...current, emptyEntry(payload)];
      const existing = current.find((draft) => draft.id === entry.id);
      const base: EntryDraft = existing ?? {
        key: `equipment-entry-${entry.id}`,
        id: entry.id,
        equipmentId: String(entry.equipmentId),
        shiftId: String(entry.shiftId),
        zoneId: String(entry.zoneId),
        mainWorkTypeId: String(entry.mainWorkTypeId),
        subworkTypeId: String(entry.subworkTypeId),
        hours: String(entry.hours),
        note: entry.note,
        revision: entry.revision,
      };
      return [...current.filter((draft) => draft.id !== entry.id), { ...base, ...changes }];
    });
  }

  function patchEntryDraft(key: string, changes: Partial<EntryDraft>) {
    setEntryDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
  }

  function resetEntryDrafts() {
    setSelectedEntryIds([]);
    setSelectedEntryDraftKeys([]);
    if (payload && previousDayReport?.key === `${siteId}:${workDate}` && previousDayReport.entries.length && !payload.reportSubmitted) {
      setEntryDrafts(buildEquipmentCarryoverDrafts(payload, previousDayReport.entries));
    } else {
      setEntryDrafts([]);
    }
    setError("");
  }

  function removeSelectedEntryDrafts() {
    const selected = new Set(selectedEntryDraftKeys);
    setEntryDrafts((current) => current.filter((draft) => !selected.has(draft.key)));
    setSelectedEntryDraftKeys([]);
    setNotice("Выбранная техника исключена из сегодняшнего отчёта.");
  }

  async function saveEntries() {
    if (!entryDrafts.length) return;
    const invalid = entryDrafts.find((draft) => !draft.equipmentId || !draft.shiftId || !draft.zoneId || !draft.mainWorkTypeId || !draft.subworkTypeId || !/^([1-9]|10)$/.test(draft.hours));
    if (invalid) {
      setError("Заполните технику, смену, зону, работу, вид подработ и часы от 1 до 10 во всех редактируемых строках.");
      return;
    }
    const unavailable = entryDrafts.find((draft) => blockedDailyEquipment.has(Number(draft.equipmentId)));
    if (unavailable) {
      setError(`Техника недоступна по табелю: ${blockedDailyEquipment.get(Number(unavailable.equipmentId))}. Выберите другую технику или исправьте отметку в табеле.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      for (const draft of entryDrafts) await post({ action: "save-entry", workDate, ...draft });
      await post({ action: "submit-daily-report", workDate });
      setEntryDrafts([]);
      setSelectedEntryDraftKeys([]);
      setNotice(payload?.currentUserRole === "foreman" ? "Ваша часть отчёта техники сохранена." : "Отчёт техники за день принят.");
      reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить запись.");
    } finally {
      setSaving(false);
    }
  }

  async function submitDailyReport() {
    setSaving(true);
    setError("");
    try {
      await post({ action: "submit-daily-report", workDate });
      setNotice(payload?.currentUserRole === "foreman" ? "Ваша часть отчёта техники сохранена." : "Отчёт техники за день принят.");
      reload();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось сохранить отчёт техники.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedEntries() {
    if (!selectedEntryIds.length || !window.confirm(`Удалить выбранные строки (${selectedEntryIds.length}) из ежедневного отчёта?`)) return;
    setSaving(true);
    setError("");
    try {
      await Promise.all(selectedEntryIds.map((id) => post({ action: "delete-entry", id })));
      setSelectedEntryIds([]);
      setNotice("Выбранные строки удалены.");
      reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить выбранные строки.");
    } finally {
      setSaving(false);
    }
  }

  function openUnit(unit: EquipmentUnit, changes: Partial<UnitDraft> = {}) {
    setSelectedUnitIds([]);
    setUnitDrafts((current) => {
      if (current.some((draft) => !draft.id)) return current;
      const existing = current.find((draft) => draft.id === unit.id);
      if (existing) return current.map((draft) => draft.id === unit.id ? { ...draft, ...changes } : draft);
      return [...current, { key: `equipment-unit-${unit.id}`, id: unit.id, organization: unit.organization, equipmentType: unit.equipmentType, brand: unit.brand, model: unit.model, registrationNumber: unit.registrationNumber, note: unit.note, projectSiteId: unit.assignedSiteId ? String(unit.assignedSiteId) : "", ...changes }];
    });
    setNotice("");
  }

  function patchUnitDraft(key: string, changes: Partial<UnitDraft>) {
    setUnitDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }

  function editSelectedUnits() {
    const selected = (payload?.units ?? []).filter((unit) => selectedUnitIds.includes(unit.id));
    setUnitDrafts(selected.map((unit) => ({ key: `equipment-unit-${unit.id}`, id: unit.id, organization: unit.organization, equipmentType: unit.equipmentType, brand: unit.brand, model: unit.model, registrationNumber: unit.registrationNumber, note: unit.note, projectSiteId: unit.assignedSiteId ? String(unit.assignedSiteId) : "" })));
    setUnitFullRowEditIds(selected.map((unit) => unit.id));
    setSelectedUnitIds([]);
    setError("");
    setNotice("");
  }

  function cancelUnitEditing() {
    setUnitDrafts([]);
    setUnitFullRowEditIds([]);
    setError("");
    setNotice("");
  }

  async function saveUnits() {
    if (!unitDrafts.length) return;
    const invalidIndex = unitDrafts.findIndex((draft) => !draft.organization.trim() || !draft.equipmentType.trim() || !draft.model.trim());
    if (invalidIndex >= 0) {
      setError(`Строка ${invalidIndex + 1}: заполните организацию, тип техники и модель.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      for (const draft of unitDrafts) await post({ action: "save-unit", ...draft });
      const added = unitDrafts.filter((draft) => !draft.id).length;
      const updated = unitDrafts.length - added;
      setUnitDrafts([]);
      setUnitFullRowEditIds([]);
      setVisibleUnitIds(null);
      setNotice([added ? `Добавлено: ${added}` : "", updated ? `обновлено: ${updated}` : ""].filter(Boolean).join(", ") + ".");
      reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить технику.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedUnits() {
    if (!selectedUnitIds.length || !window.confirm(`Удалить выбранные единицы техники (${selectedUnitIds.length}) из активного реестра? История отчётов сохранится.`)) return;
    setSaving(true);
    setError("");
    try {
      for (const id of selectedUnitIds) await post({ action: "delete-unit", id });
      setSelectedUnitIds([]);
      setVisibleUnitIds(null);
      setNotice("Выбранная техника удалена из активного реестра.");
      reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось изменить реестр.");
    } finally {
      setSaving(false);
    }
  }

  function patchProjectUnitDraft(key: string, changes: Partial<ProjectUnitDraft>) {
    setProjectUnitDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }

  async function assignProjectUnits() {
    if (!projectUnitDrafts.length) return;
    const assigned = new Set((payload?.units ?? []).map((unit) => unit.id));
    for (let index = 0; index < projectUnitDrafts.length; index += 1) {
      const equipmentId = Number(projectUnitDrafts[index].equipmentId);
      if (!equipmentId) { setError(`Строка ${index + 1}: выберите технику из общего реестра.`); return; }
      if (assigned.has(equipmentId)) { setError(`Строка ${index + 1}: техника уже добавлена в проект или выбрана выше.`); return; }
      assigned.add(equipmentId);
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      for (let index = 0; index < projectUnitDrafts.length; index += 1) {
        const draft = projectUnitDrafts[index];
        await post({ action: "assign-unit-project", equipmentId: Number(draft.equipmentId) });
        setProjectUnitDrafts((current) => current.filter((item) => item.key !== draft.key));
      }
      setNotice(`Добавлено техники в проект: ${projectUnitDrafts.length}. Предыдущие назначения выбранной техники завершены.`);
      reload();
    } catch (assignmentError) {
      reload();
      setError(assignmentError instanceof Error ? assignmentError.message : "Не удалось добавить технику в проект.");
    } finally {
      setSaving(false);
    }
  }

  async function removeSelectedProjectUnits() {
    if (!selectedProjectUnitIds.length || !window.confirm(`Убрать выбранную технику (${selectedProjectUnitIds.length}) из проекта? Общие карточки и история отчётов сохранятся.`)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      for (const equipmentId of selectedProjectUnitIds) await post({ action: "remove-unit-project", equipmentId });
      const count = selectedProjectUnitIds.length;
      setSelectedProjectUnitIds([]);
      setNotice(`Убрано техники из проекта: ${count}.`);
      reload();
    } catch (assignmentError) {
      setError(assignmentError instanceof Error ? assignmentError.message : "Не удалось изменить состав техники проекта.");
    } finally {
      setSaving(false);
    }
  }

  async function importRegistry(file: File) {
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const units = await parseEquipmentRegistryXlsx(file);
      const result = await post({ action: "import-units", units });
      setVisibleUnitIds(null);
      setNotice(`Реестр загружен: ${result.imported ?? units.length} ед.`);
      reload();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Не удалось импортировать реестр.");
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function importEntries(file: File) {
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const entries = await parseEquipmentEntriesXlsx(file);
      const result = await post({ action: "import-entries", entries });
      const latestDate = entries.map((entry) => entry.workDate).sort().at(-1);
      if (latestDate) {
        changeWorkDate(latestDate);
        changeReportRange(latestDate);
      }
      setNotice(`Расстановка загружена: ${result.imported ?? 0} строк${result.skipped ? `, уже существовало: ${result.skipped}` : ""}.`);
      reload();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Не удалось импортировать расстановку.");
    } finally {
      setImporting(false);
      if (dailyFileInput.current) dailyFileInput.current.value = "";
    }
  }

  const dailyEntries = useMemo(() => (payload?.entries ?? []).filter((entry) => entry.workDate === workDate), [payload?.entries, workDate]);
  const blockedDailyEquipment = useMemo(() => new Map((payload?.dailyTimesheetMarks ?? [])
    .filter(isEquipmentUnavailable)
    .map((mark) => [mark.equipmentId, equipmentUnavailableReason(mark)])), [payload?.dailyTimesheetMarks]);
  const filledDates = useMemo(() => new Set(payload?.filledDates ?? []), [payload?.filledDates]);
  const dailySummary = useMemo(() => dailyEntries.reduce((summary, entry) => {
    summary.total += Number(entry.hours);
    if (isDowntime(entry)) summary.downtime += Number(entry.hours);
    else summary.productive += Number(entry.hours);
    summary.units.add(entry.equipmentId);
    return summary;
  }, { total: 0, productive: 0, downtime: 0, units: new Set<number>() }), [dailyEntries]);
  const carryoverSessionKey = `${siteId}:${workDate}`;
  const equipmentCarryoverMode = section === "daily" && workDate === today && payload?.workDate === workDate
    && payload.currentUserRole === "foreman" && payload.canEditDaily;
  const previousDayLoading = Boolean(equipmentCarryoverMode && previousDayReport?.key !== carryoverSessionKey);
  const carriedEntryDrafts = entryDrafts.filter((draft) => draft.carriedFromPreviousDay);
  const hasEquipmentCarryoverSource = Boolean(equipmentCarryoverMode && !payload?.reportSubmitted && previousDayReport?.date && previousDayReport.entries.length);
  const showEquipmentCarryover = Boolean(hasEquipmentCarryoverSource && carriedEntryDrafts.length);

  useEffect(() => {
    if (!equipmentCarryoverMode || loading || previousDayLoading || !payload || previousDayReport?.key !== carryoverSessionKey) return;
    if (payload.reportSubmitted) {
      setEntryDrafts([]);
      setSelectedEntryDraftKeys([]);
      initializedCarryoverSession.current = carryoverSessionKey;
      return;
    }
    if (initializedCarryoverSession.current === carryoverSessionKey) return;
    initializedCarryoverSession.current = carryoverSessionKey;
    const carried = buildEquipmentCarryoverDrafts(payload, previousDayReport.entries);
    setEntryDrafts((current) => [...carried, ...current.filter((draft) => !draft.carriedFromPreviousDay)]);
    setSelectedEntryDraftKeys([]);
  }, [carryoverSessionKey, equipmentCarryoverMode, loading, payload, previousDayLoading, previousDayReport]);

  const monthUnits = useMemo(() => {
    const units = new Map<number, EquipmentUnit>((payload?.units ?? []).map((unit) => [unit.id, unit]));
    for (const entry of payload?.entries ?? []) {
      if (!units.has(entry.equipmentId)) units.set(entry.equipmentId, entry);
    }
    return Array.from(units.values());
  }, [payload?.entries, payload?.units]);
  const monthDays = useMemo(() => Array.from({ length: daysInMonth(month) }, (_, index) => index + 1), [month]);
  const monthReportByCell = useMemo(() => {
    const values = new Map<string, { productive: number; downtime: number }>();
    for (const entry of payload?.entries ?? []) {
      const key = equipmentCellKey(entry.equipmentId, entry.workDate);
      const value = values.get(key) ?? { productive: 0, downtime: 0 };
      if (isDowntime(entry)) value.downtime += Number(entry.hours);
      else value.productive += Number(entry.hours);
      values.set(key, value);
    }
    return values;
  }, [payload?.entries]);
  const timesheetMarksByCell = useMemo(() => new Map((payload?.marks ?? []).map((mark) => [equipmentCellKey(mark.equipmentId, mark.workDate), mark])), [payload?.marks]);
  const equipmentNames = useMemo(() => Array.from(new Set(monthUnits.map(unitTitle).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru", { numeric: true })), [monthUnits]);
  const equipmentOrganizations = useMemo(() => Array.from(new Set(monthUnits.map((unit) => unit.organization).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru")), [monthUnits]);
  const selectedEquipmentName = equipmentNameFilter.filter((value) => equipmentNames.includes(value));
  const selectedOrganization = organizationFilter.filter((value) => equipmentOrganizations.includes(value));
  const monthRows = useMemo(() => monthUnits.map((unit) => {
      const byDate = new Map<string, EquipmentMonthCell>();
      let productive = 0;
      let downtime = 0;
      for (const day of monthDays) {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const key = equipmentCellKey(unit.id, date);
        const report = monthReportByCell.get(key) ?? { productive: 0, downtime: 0 };
        const mark = timesheetMarksByCell.get(key);
        if (!mark && report.productive === 0 && report.downtime === 0) continue;
        const effectiveProductive = mark ? Number(mark.productiveHours) : report.productive;
        const effectiveDowntime = mark ? Number(mark.downtimeHours) : report.downtime;
        productive += effectiveProductive;
        downtime += effectiveDowntime;
        byDate.set(date, {
          productive: effectiveProductive,
          downtime: effectiveDowntime,
          reportProductive: report.productive,
          reportDowntime: report.downtime,
          mark,
          mismatch: Boolean(mark) && (effectiveProductive !== report.productive || effectiveDowntime !== report.downtime),
        });
      }
      return { unit, byDate, productive, downtime, total: productive + downtime };
    }).filter((row) => {
      if (selectedEquipmentName.length > 0 && !selectedEquipmentName.includes(unitTitle(row.unit))) return false;
      if (selectedOrganization.length > 0 && !selectedOrganization.includes(row.unit.organization)) return false;
      if (!matchesEquipmentTotalFilter(productiveTotalFilter, row.productive)) return false;
      if (!matchesEquipmentTotalFilter(downtimeTotalFilter, row.downtime)) return false;
      if (!matchesEquipmentTotalFilter(equipmentTotalFilter, row.total)) return false;
      for (const day of monthDays) {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        if (!matchesEquipmentDayFilter(monthDayFilters[date] ?? [], row.byDate.get(date))) return false;
      }
      return true;
    }).sort((left, right) => unitTitle(left.unit).localeCompare(unitTitle(right.unit), "ru")),
  [downtimeTotalFilter, equipmentTotalFilter, month, monthDayFilters, monthDays, monthReportByCell, monthUnits, productiveTotalFilter, selectedEquipmentName, selectedOrganization, timesheetMarksByCell]);

  const registryUnits = payload?.units ?? [];
  const monthSummary = useMemo(() => monthRows.reduce((summary, row) => ({ productive: summary.productive + row.productive, downtime: summary.downtime + row.downtime, total: summary.total + row.total }), { productive: 0, downtime: 0, total: 0 }), [monthRows]);
  const monthActiveFilterCount = Number(selectedEquipmentName.length > 0) + Number(selectedOrganization.length > 0) + Number(productiveTotalFilter.length > 0) + Number(downtimeTotalFilter.length > 0) + Number(equipmentTotalFilter.length > 0) + monthDays.reduce((count, day) => count + Number((monthDayFilters[`${month}-${String(day).padStart(2, "0")}`] ?? []).length > 0), 0);
  const monthDayTotals = useMemo(() => new Map(monthDays.map((day) => {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    return [date, monthRows.reduce((total, row) => total + (row.byDate.get(date)?.productive ?? 0) + (row.byDate.get(date)?.downtime ?? 0), 0)];
  })), [month, monthDays, monthRows]);
  const editingTimesheetUnit = timesheetEditor ? monthUnits.find((unit) => unit.id === timesheetEditor.equipmentId) : undefined;
  const editingTimesheetReport = timesheetEditor ? monthReportByCell.get(equipmentCellKey(timesheetEditor.equipmentId, timesheetEditor.workDate)) ?? { productive: 0, downtime: 0 } : { productive: 0, downtime: 0 };
  const editingTimesheetMark = timesheetEditor ? timesheetMarksByCell.get(equipmentCellKey(timesheetEditor.equipmentId, timesheetEditor.workDate)) : undefined;
  const productiveHours = Number(timesheetProductive);
  const downtimeHours = Number(timesheetDowntime);
  const timesheetValueValid = /^\d+$/.test(timesheetProductive) && /^\d+$/.test(timesheetDowntime)
    && Number.isInteger(productiveHours) && Number.isInteger(downtimeHours)
    && productiveHours >= 0 && productiveHours <= 20
    && downtimeHours >= 0 && downtimeHours <= 20
    && productiveHours + downtimeHours <= 20;
  const referencesReady = Boolean(payload?.units.length && payload.shifts.length && payload.zones.length && payload.mainWorkTypes.length && payload.subworkTypes.length);
  const {
    shellRef: timesheetClipboardShellRef,
    status: timesheetClipboardStatus,
    cellClass: timesheetClipboardCellClass,
    cellHandlers: timesheetClipboardCellHandlers,
    shellHandlers: timesheetClipboardShellHandlers,
    rememberUndo: rememberEquipmentTimesheetUndo,
    activeCell: timesheetClipboardActiveCell,
    focusCell: focusEquipmentTimesheetCell,
  } = useTimesheetClipboard({
    rowCount: monthRows.length,
    columnCount: monthDays.length,
    resetKey: `${section}:${month}:${monthRows.map((row) => row.unit.id).join("|")}`,
    getValue: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = monthDays[columnIndex];
      if (!row || !day) return "";
      const value = row.byDate.get(`${month}-${String(day).padStart(2, "0")}`);
      if (!value) return "";
      return formatEquipmentHours(value.productive, value.downtime);
    },
    getUndoValue: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = monthDays[columnIndex];
      if (!row || !day) return "";
      const mark = timesheetMarksByCell.get(equipmentCellKey(row.unit.id, `${month}-${String(day).padStart(2, "0")}`));
      if (!mark) return "";
      return formatEquipmentHours(mark.productiveHours, mark.downtimeHours);
    },
    getUndoNote: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = monthDays[columnIndex];
      if (!row || !day) return "";
      return timesheetMarksByCell.get(equipmentCellKey(row.unit.id, `${month}-${String(day).padStart(2, "0")}`))?.note ?? "";
    },
    canPaste: (rowIndex, columnIndex) => Boolean(payload?.canEditTimesheet && monthRows[rowIndex] && monthDays[columnIndex]),
    onPaste: pasteEquipmentTimesheetCells,
    canDelete: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = monthDays[columnIndex];
      if (!payload?.canEditTimesheet || !row || !day) return false;
      const workDate = `${month}-${String(day).padStart(2, "0")}`;
      return timesheetMarksByCell.has(equipmentCellKey(row.unit.id, workDate));
    },
    onDelete: pasteEquipmentTimesheetCells,
    onActivate: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = monthDays[columnIndex];
      if (row && day) openTimesheetInlineEditor(row.unit.id, `${month}-${String(day).padStart(2, "0")}`, rowIndex, columnIndex);
    },
    onType: (rowIndex, columnIndex, _anchor, value) => {
      void _anchor;
      const row = monthRows[rowIndex];
      const day = monthDays[columnIndex];
      if (row && day) openTimesheetInlineEditor(row.unit.id, `${month}-${String(day).padStart(2, "0")}`, rowIndex, columnIndex, value);
    },
  });

  useEffect(() => {
    if (!timesheetInlineEditor) return;
    if (!timesheetClipboardActiveCell
      || timesheetClipboardActiveCell.rowIndex !== timesheetInlineEditor.rowIndex
      || timesheetClipboardActiveCell.columnIndex !== timesheetInlineEditor.columnIndex) setTimesheetInlineEditor(null);
  }, [timesheetClipboardActiveCell, timesheetInlineEditor]);

  function openTimesheetEditor(equipmentId: number, editorWorkDate: string, anchor: HTMLElement) {
    if (!payload?.canEditTimesheet) return;
    if (timesheetEditor?.equipmentId === equipmentId && timesheetEditor.workDate === editorWorkDate) {
      if (!savingTimesheetMark) closeTimesheetEditorAndRestoreFocus();
      return;
    }
    if (savingTimesheetMark) return;
    const key = equipmentCellKey(equipmentId, editorWorkDate);
    const report = monthReportByCell.get(key) ?? { productive: 0, downtime: 0 };
    const mark = timesheetMarksByCell.get(key);
    setTimesheetInlineEditor(null);
    setTimesheetEditor({ equipmentId, workDate: editorWorkDate, anchor, mode: "list" });
    setTimesheetProductive(String(mark?.productiveHours ?? report.productive));
    setTimesheetDowntime(String(mark?.downtimeHours ?? report.downtime));
    setTimesheetNote(mark?.note ?? "");
    setTimesheetEditorError("");
  }

  function openTimesheetInlineEditor(equipmentId: number, editorWorkDate: string, rowIndex: number, columnIndex: number, typedValue?: string) {
    if (!payload?.canEditTimesheet) return;
    const row = monthRows.find((item) => item.unit.id === equipmentId);
    const value = row?.byDate.get(editorWorkDate);
    setTimesheetEditor(null);
    setTimesheetInlineEditor({
      equipmentId,
      workDate: editorWorkDate,
      rowIndex,
      columnIndex,
      value: typedValue ?? (value ? formatEquipmentHours(value.productive, value.downtime) : ""),
      error: "",
      selectAll: typedValue === undefined,
    });
  }

  function restoreEquipmentTimesheetFocus() {
    requestAnimationFrame(() => timesheetClipboardShellRef.current?.focus({ preventScroll: true }));
  }

  function closeTimesheetEditorAndRestoreFocus() {
    setTimesheetEditor(null);
    restoreEquipmentTimesheetFocus();
  }

  async function persistEquipmentTimesheetMark(target: { equipmentId: number; workDate: string }, value: { clear: boolean; productiveHours: number; downtimeHours: number; note: string }) {
    if (!payload) throw new Error("Табель техники ещё не загружен.");
    setSavingTimesheetMark(true);
    const previousMark = timesheetMarksByCell.get(equipmentCellKey(target.equipmentId, target.workDate));
    const undoRowIndex = monthRows.findIndex((row) => row.unit.id === target.equipmentId);
    const undoColumnIndex = monthDays.indexOf(Number(target.workDate.slice(8, 10)));
    try {
      const result = await post({
        action: "save-timesheet-mark",
        equipmentId: target.equipmentId,
        workDate: target.workDate,
        ...(value.clear ? { clear: true } : { productiveHours: value.productiveHours, downtimeHours: value.downtimeHours, note: value.note }),
      });
      setPayload((current) => current ? {
        ...current,
        marks: [
          ...current.marks.filter((mark) => equipmentCellKey(mark.equipmentId, mark.workDate) !== equipmentCellKey(target.equipmentId, target.workDate)),
          ...(result.mark ? [result.mark] : []),
        ],
      } : current);
      if (undoRowIndex >= 0 && undoColumnIndex >= 0) rememberEquipmentTimesheetUndo([{ rowIndex: undoRowIndex, columnIndex: undoColumnIndex, value: previousMark ? formatEquipmentHours(previousMark.productiveHours, previousMark.downtimeHours) : "", note: previousMark?.note ?? "" }]);
    } finally {
      setSavingTimesheetMark(false);
    }
  }

  async function saveTimesheetMark(clear = false) {
    if (!timesheetEditor || !payload || (!clear && !timesheetValueValid)) return;
    setTimesheetEditorError("");
    try {
      await persistEquipmentTimesheetMark(timesheetEditor, { clear, productiveHours, downtimeHours, note: timesheetNote });
      closeTimesheetEditorAndRestoreFocus();
    } catch (saveError) {
      setTimesheetEditorError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку табеля.");
    }
  }

  async function saveTimesheetListValue(rawValue: string) {
    if (!timesheetEditor) return;
    setTimesheetEditorError("");
    try {
      const parsed = parseEquipmentClipboardHours(rawValue);
      await persistEquipmentTimesheetMark(timesheetEditor, { ...parsed, note: editingTimesheetMark?.note ?? "" });
      closeTimesheetEditorAndRestoreFocus();
    } catch (saveError) {
      setTimesheetEditorError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку табеля.");
    }
  }

  async function saveTimesheetInlineValue() {
    if (!timesheetInlineEditor) return;
    const normalizedValue = timesheetInlineEditor.value.trim().toLocaleUpperCase("ru-RU");
    let parsed: ReturnType<typeof parseEquipmentClipboardHours>;
    try {
      parsed = parseEquipmentClipboardHours(normalizedValue);
    } catch (validationError) {
      setTimesheetInlineEditor((current) => current ? { ...current, value: normalizedValue, error: validationError instanceof Error ? validationError.message : "Недопустимое значение" } : current);
      return;
    }
    try {
      const mark = timesheetMarksByCell.get(equipmentCellKey(timesheetInlineEditor.equipmentId, timesheetInlineEditor.workDate));
      await persistEquipmentTimesheetMark(timesheetInlineEditor, { ...parsed, note: mark?.note ?? "" });
      setTimesheetInlineEditor(null);
      restoreEquipmentTimesheetFocus();
    } catch (saveError) {
      setTimesheetInlineEditor((current) => current ? { ...current, error: saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку табеля" } : current);
    }
  }

  async function pasteEquipmentTimesheetCells(changes: TimesheetClipboardChange[]) {
    if (!payload?.canEditTimesheet) throw new Error("Недостаточно прав для изменения табеля техники");
    const prepared = changes.map((change) => {
      const row = monthRows[change.rowIndex];
      const day = monthDays[change.columnIndex];
      const workDate = day ? `${month}-${String(day).padStart(2, "0")}` : "";
      if (!row || !workDate) throw new Error("Выбранный диапазон содержит недоступные ячейки");
      return { equipmentId: row.unit.id, workDate, note: change.note ?? "", ...parseEquipmentClipboardHours(change.value) };
    });

    const results = await Promise.all(prepared.map(async (item) => {
      const result = await post({
        action: "save-timesheet-mark",
        equipmentId: item.equipmentId,
        workDate: item.workDate,
        ...(item.clear ? { clear: true } : { productiveHours: item.productiveHours, downtimeHours: item.downtimeHours, note: item.note }),
      });
      return { ...item, mark: result.mark };
    }));

    const changedKeys = new Set(prepared.map((item) => equipmentCellKey(item.equipmentId, item.workDate)));
    setPayload((current) => current ? {
      ...current,
      marks: [
        ...current.marks.filter((mark) => !changedKeys.has(equipmentCellKey(mark.equipmentId, mark.workDate))),
        ...results.flatMap((result) => result.mark ? [result.mark] : []),
      ],
    } : current);
    return results.length;
  }

  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportDailyReport() {
    if (!dailyEntries.length) return;
    const rows = dailyEntries.map((entry) => [
      entry.workDate,
      `${entry.equipmentType} // ${[entry.brand, entry.model].filter(Boolean).join(" ")} // ${entry.registrationNumber || "-"} // ${entry.organization}`,
      entry.organization,
      entry.shiftName,
      entry.zoneName,
      entry.mainWorkTypeName,
      entry.subworkTypeName,
      entry.hours,
      entry.note,
    ]);
    download(createTableXlsx("Отчёт техники", `Отчёт техники — ${payload?.siteName ?? "Объект"}, ${workDate}`, ["Дата", "Уникальное наименование единицы", "Организация", "Смена", "Зона", "Виды основных работ", "Виды подработ", "Часы", "Примечание"], rows), `Отчёт_техники_${siteId}_${workDate}.xlsx`);
  }

  function exportTimesheet() {
    const dates = monthDays.map((day) => `${month}-${String(day).padStart(2, "0")}`);
    const rows = monthRows.map((row) => {
      const dayValues = monthDays.map((day) => {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const value = row.byDate.get(date);
        if (!value) return "";
        if (value.productive && value.downtime) return `${value.productive} / П ${value.downtime}`;
        if (value.downtime) return `П ${value.downtime}`;
        return value.productive || "";
      });
      return {
        equipmentName: unitTitle(row.unit),
        organization: row.unit.organization,
        dailyValues: dayValues,
        productiveHours: row.productive,
        downtimeHours: row.downtime,
        totalHours: row.total,
      };
    });
    download(createEquipmentTimesheetXlsx(
      payload?.siteName ?? "Объект",
      titleCase(MONTH_FORMATTER.format(new Date(`${month}-01T00:00:00Z`))),
      dates,
      rows,
      dates.map((date) => monthDayTotals.get(date) ?? 0),
      monthSummary.productive,
      monthSummary.downtime,
      monthSummary.total,
    ), `Табель_техники_${month}.xlsx`);
  }

  function exportRegistry() {
    if (!registryUnits.length) return;
    download(createTableXlsx("Реестр техники", "Общий реестр техники", ["Организация", "Тип", "Марка", "Модель", "ГРЗ / Инв. №", "Проект", "Примечание"], registryUnits.map((unit) => [unit.organization, unit.equipmentType, unit.brand, unit.model, unit.registrationNumber, unit.assignedSiteName ?? "", unit.note])), "Реестр_техники.xlsx");
  }

  function downloadRegistryTemplate() {
    const rows = Array.from({ length: 25 }, () => ["", "", "", "", "", "", ""]);
    download(createTableXlsx("Реестр техники", "Шаблон реестра техники", ["Организация", "Тип", "Марка", "Модель", "ГРЗ / Инв. №", "Проект", "Примечание"], rows), "Шаблон_реестра_техники.xlsx");
  }

  if (loading && !payload) return <section className="equipment-state"><span className="equipment-state-spinner" /><strong>Загружаем учёт техники…</strong></section>;

  return <section className="equipment-page">
    {section === "daily" && headerActionsTarget && createPortal(<section className="excel-actions" aria-label="Действия с Excel для отчёта техники">
      <button type="button" onClick={exportDailyReport} disabled={!dailyEntries.length}>Экспорт в Excel</button>
      {payload?.canEditDaily && <><button type="button" onClick={() => dailyFileInput.current?.click()} disabled={importing}>{importing ? "Загружаем…" : "Импорт из Excel"}</button><input ref={dailyFileInput} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importEntries(file); }} /></>}
    </section>, headerActionsTarget)}
    {section === "registry" && headerActionsTarget && createPortal(<div className="toolbar-actions" aria-label="Действия с Excel для реестра техники">
      <button type="button" onClick={exportRegistry} disabled={!registryUnits.length}>Экспорт в Excel</button>
      {payload?.canManageRegistry && <><button type="button" onClick={downloadRegistryTemplate}>Скачать шаблон</button><button type="button" onClick={() => fileInput.current?.click()} disabled={importing}>{importing ? "Загружаем…" : "Импорт из Excel"}</button><input ref={fileInput} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importRegistry(file); }} /></>}
    </div>, headerActionsTarget)}
    {section === "month" && headerActionsTarget && createPortal(<div className="excel-actions equipment-timesheet-page-actions">
      {monthActiveFilterCount > 0 && <button type="button" className="timesheet-header-filter-reset" onClick={() => { setEquipmentNameFilter([]); setOrganizationFilter([]); setMonthDayFilters({}); setProductiveTotalFilter([]); setDowntimeTotalFilter([]); setEquipmentTotalFilter([]); }}>Сбросить фильтры <span>{monthActiveFilterCount}</span></button>}
      <button type="button" onClick={exportTimesheet} disabled={loading || monthRows.length === 0}>Экспорт в Excel</button>
      <button type="button" className="equipment-timesheet-info-button" aria-label="Информация" title="Информация" onClick={() => setTimesheetInfoOpen(true)}><span aria-hidden="true">i</span></button>
    </div>, headerActionsTarget)}
    {error && <div className="equipment-message error"><strong>Нужно проверить данные</strong><span>{error}</span><button type="button" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="equipment-message success"><strong>Готово</strong><span>{notice}</span><button type="button" onClick={() => setNotice("")}>×</button></div>}

    {section === "daily" && <>
      <section className="control-strip equipment-report-date-strip">
        <EquipmentReportDateNavigation dates={recentDates} value={workDate} today={today} filledDates={filledDates} onChange={changeWorkDate} onRangeChange={changeReportRange} />
      </section>
      {!referencesReady && payload?.canEditDaily && <div className="equipment-empty-hint"><strong>Сначала заполните справочники</strong><span>Для новой записи нужны техника, смены, зоны, виды работ и подработ.</span></div>}
      <div className="table-card equipment-report-card">
        {payload?.currentUserRole !== "foreman" && Boolean(payload?.foremanProgress.length) && <div className="foreman-report-progress" role="status"><strong>Сдали прорабы: {payload!.foremanProgress.filter((item) => item.status === "submitted").length} из {payload!.foremanProgress.length}</strong><span>{payload!.foremanProgress.map((item) => `${item.foremanName}: ${item.status === "submitted" ? `${item.equipmentCount} ед., ${item.hours} ч.` : item.status === "draft" ? "заполняет" : "не сдал"}`).join(" · ")}</span></div>}
        {showEquipmentCarryover && <div className="foreman-report-progress equipment-carryover-status" role="status"><strong>Подставлена техника из отчёта за {shortDate(previousDayReport!.date)}</strong><span>Проверьте строки, измените данные на сегодня и удалите технику, которая не работала.</span></div>}
        <EquipmentDailyAgGrid entries={dailyEntries} drafts={entryDrafts} units={payload?.units ?? []} dailyTimesheetMarks={payload?.dailyTimesheetMarks ?? []} shifts={payload?.shifts ?? []} zones={payload?.zones ?? []} mainWorkTypes={payload?.mainWorkTypes ?? []} subworkTypes={payload?.subworkTypes ?? []} loading={loading || previousDayLoading} canEdit={Boolean(payload?.canEditDaily)} showResponsibleUser={payload?.currentUserRole !== "foreman"} currentUserName={payload?.currentUserName} selectedIds={selectedEntryIds} selectedDraftKeys={selectedEntryDraftKeys} onEdit={openEntry} onPatchDraft={patchEntryDraft} onSelectionChange={(ids) => { setSelectedEntryIds(ids); if (ids.length) setSelectedEntryDraftKeys([]); }} onDraftSelectionChange={(keys) => { setSelectedEntryDraftKeys(keys); if (keys.length) setSelectedEntryIds([]); }} />
        <div className="table-edit-footer employee-table-footer uniform-footer-actions report-table-footer equipment-report-footer">
          {selectedEntryIds.length > 0 && <div className="employee-selection-bar"><div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedEntryIds.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-action-primary" onClick={() => { const selected = dailyEntries.filter((entry) => selectedEntryIds.includes(entry.id)); selected.forEach((entry) => openEntry(entry)); }} disabled={saving}>Редактировать</button><button type="button" className="employee-action-button employee-action-danger" onClick={() => void deleteSelectedEntries()} disabled={saving}>Удалить строки</button><button type="button" className="employee-action-button clear-selection-button" onClick={() => setSelectedEntryIds([])} disabled={saving}>Снять выделение</button></div></div>}
          {selectedEntryDraftKeys.length > 0 && <div className="employee-selection-bar"><div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано строк: <strong>{selectedEntryDraftKeys.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-action-danger" onClick={removeSelectedEntryDrafts} disabled={saving}>Убрать из отчёта</button><button type="button" className="employee-action-button clear-selection-button" onClick={() => setSelectedEntryDraftKeys([])} disabled={saving}>Снять выделение</button></div></div>}
          {entryDrafts.length > 0 && selectedEntryDraftKeys.length === 0 && <div className="employee-editing-bar"><div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>{showEquipmentCarryover ? "Подготовлено строк" : "Редактируется"}: <strong>{entryDrafts.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-action-primary" onClick={() => openEntry()} disabled={!referencesReady || saving}>Добавить запись</button><button type="button" className="employee-action-button cancel-editing-button" onClick={resetEntryDrafts} disabled={saving}>{hasEquipmentCarryoverSource ? "Вернуть исходный список" : "Отменить редактирование"}</button><button type="button" className="employee-action-button employee-save-button" onClick={() => void saveEntries()} disabled={saving}>{saving ? "Сохраняем…" : payload?.currentUserRole === "foreman" ? "Сохранить мою часть" : "Принять отчёт за день"}</button></div></div>}
          {entryDrafts.length === 0 && selectedEntryIds.length === 0 && selectedEntryDraftKeys.length === 0 && payload?.canEditDaily && !payload.reportSubmitted && <div className="employee-editing-bar roster-save-bar"><div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>{payload.currentUserRole === "foreman" ? "После заполнения сохраните свою часть отчёта" : "Проверьте строки всех прорабов перед принятием отчёта"}</span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-save-button" onClick={() => void submitDailyReport()} disabled={saving}>{saving ? "Сохраняем…" : payload.currentUserRole === "foreman" ? "Сохранить мою часть" : "Принять отчёт за день"}</button></div></div>}
          {entryDrafts.length === 0 && selectedEntryIds.length === 0 && <div className="employee-footer-base">{payload?.canEditDaily && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={() => openEntry()} disabled={!referencesReady || saving}>Добавить запись</button>}<span className="employee-total-count">Всего машино-часов: <strong>{dailySummary.total}</strong></span></div>}
        </div>
      </div>
    </>}

    {section === "month" && <>
      <div className="equipment-timesheet-month-row"><div className="timesheet-month-control equipment-timesheet-month-control" aria-label="Выбор месяца табеля"><button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц">‹</button><EquipmentMonthPicker value={month} current={today.slice(0, 7)} onChange={setMonth} /><button type="button" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Следующий месяц">›</button></div></div>
      {/* The spreadsheet shell must receive focus so native copy and paste events reach it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div ref={timesheetClipboardShellRef} className="timesheet-grid-shell equipment-timesheet-shell timesheet-clipboard-shell" role="application" tabIndex={0} aria-label="Табель техники. Стрелки перемещают выбранную ячейку, Enter или F2 открывают редактирование." {...timesheetClipboardShellHandlers}>{timesheetClipboardStatus && <div className="timesheet-clipboard-status" role="status">{timesheetClipboardStatus}</div>}<table className="timesheet-table equipment-month-table"><thead><tr><th className="timesheet-sticky equipment-number-column" rowSpan={2}>№</th><th className="timesheet-sticky equipment-machine-column" rowSpan={2}><TimesheetFilterableHeading label="Техника" value={selectedEquipmentName} options={[TIMESHEET_ALL_OPTION, ...equipmentNames.map((value) => ({ value, label: value }))]} onChange={setEquipmentNameFilter}>Техника</TimesheetFilterableHeading></th><th className="timesheet-sticky equipment-organization-column" rowSpan={2}><TimesheetFilterableHeading label="Организация" value={selectedOrganization} options={[TIMESHEET_ALL_OPTION, ...equipmentOrganizations.map((value) => ({ value, label: value }))]} onChange={setOrganizationFilter}>Организация</TimesheetFilterableHeading></th><th colSpan={monthDays.length}>Дни месяца</th><th className="timesheet-total-column equipment-work-total" rowSpan={2}><TimesheetFilterableHeading label="Работа" value={productiveTotalFilter} options={EQUIPMENT_TOTAL_FILTERS} onChange={setProductiveTotalFilter}>Работа</TimesheetFilterableHeading></th><th className="timesheet-total-column equipment-idle-total" rowSpan={2}><TimesheetFilterableHeading label="Простой" value={downtimeTotalFilter} options={EQUIPMENT_TOTAL_FILTERS} onChange={setDowntimeTotalFilter}>Простой</TimesheetFilterableHeading></th><th className="timesheet-total-column equipment-all-total" rowSpan={2}><TimesheetFilterableHeading label="Всего" value={equipmentTotalFilter} options={EQUIPMENT_TOTAL_FILTERS} onChange={setEquipmentTotalFilter}>Всего</TimesheetFilterableHeading></th></tr><tr>{monthDays.map((day) => { const date = `${month}-${String(day).padStart(2, "0")}`; const dateObject = new Date(`${date}T00:00:00Z`); const weekend = [0, 6].includes(dateObject.getUTCDay()); const weekday = WEEKDAY_FORMATTER.format(dateObject).replace(".", ""); return <th key={day} className={`${weekend ? "weekend" : ""} ${date === today ? "today" : ""}`}><TimesheetFilterableHeading compact label={`${day} ${weekday}`} value={monthDayFilters[date] ?? []} options={EQUIPMENT_DAY_FILTERS} onChange={(value) => setMonthDayFilters((current) => ({ ...current, [date]: value }))}><span>{day}</span><small>{weekday}</small></TimesheetFilterableHeading></th>; })}</tr></thead>
        <tbody>{monthRows.length ? monthRows.map((row, index) => <tr key={row.unit.id}><td className="timesheet-sticky equipment-number-column">{index + 1}</td><th scope="row" className="timesheet-sticky equipment-machine-column" title={unitTitle(row.unit)}><span>{unitTitle(row.unit)}</span><small>{row.unit.registrationNumber || "Номер не указан"}</small></th><td className="timesheet-sticky equipment-organization-column">{row.unit.organization}</td>{monthDays.map((day) => {
          const date = `${month}-${String(day).padStart(2, "0")}`;
          const value = row.byDate.get(date);
          const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
          const title = value ? [
            `Табель: работа ${value.productive} ч., простой ${value.downtime} ч.`,
            value.mark ? `Отчёт: работа ${value.reportProductive} ч., простой ${value.reportDowntime} ч.` : "",
            value.mark?.note ? `Комментарий: ${value.mark.note}` : "",
            value.mark?.updatedBy ? `Изменил: ${value.mark.updatedBy}` : "",
          ].filter(Boolean).join("\n") : payload?.canEditTimesheet ? "Двойной клик — заполнить часы" : undefined;
          const hasValue = Boolean(value && (value.productive || value.downtime || value.mark));
          const isInlineEditing = timesheetInlineEditor?.equipmentId === row.unit.id && timesheetInlineEditor.workDate === date;
          const isActiveCell = timesheetClipboardActiveCell?.rowIndex === index && timesheetClipboardActiveCell.columnIndex === day - 1;
          return <td
            key={day}
            className={[
              value?.downtime ? "has-downtime" : value?.productive ? "filled" : "",
              value?.mark ? "manual" : "",
              value?.mismatch ? "mismatch" : "",
              payload?.canEditTimesheet ? "editable" : "",
              dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "",
              date === today ? "today" : "",
              date > today ? "future" : "",
              timesheetClipboardCellClass(index, day - 1),
            ].filter(Boolean).join(" ")}
            title={isInlineEditing && timesheetInlineEditor.error ? timesheetInlineEditor.error : title}
            {...timesheetClipboardCellHandlers(index, day - 1)}
            onDoubleClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button, input")) return;
              openTimesheetInlineEditor(row.unit.id, date, index, day - 1);
            }}
          >{isInlineEditing ? <div className={["timesheet-cell-inline-editor", timesheetInlineEditor.error ? "invalid" : ""].filter(Boolean).join(" ")}>
            <input
              ref={timesheetInlineInput}
              value={timesheetInlineEditor.value}
              aria-label={`Значение табеля техники: ${unitTitle(row.unit)}, ${fullDate(date)}`}
              aria-invalid={Boolean(timesheetInlineEditor.error)}
              disabled={savingTimesheetMark}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onChange={(event) => setTimesheetInlineEditor((current) => current ? { ...current, value: event.target.value, error: "", selectAll: false } : current)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveTimesheetInlineValue();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setTimesheetInlineEditor(null);
                  restoreEquipmentTimesheetFocus();
                }
              }}
            />
            {timesheetInlineEditor.error && <span className="timesheet-cell-inline-error" role="alert" title={timesheetInlineEditor.error}>!</span>}
          </div> : <>
            <span className="timesheet-cell-value">{hasValue ? <>{value?.productive || (!value?.downtime && value?.mark ? "0" : null)}{value?.downtime ? <small>П {value.downtime}</small> : null}</> : ""}</span>
            {payload?.canEditTimesheet && isActiveCell && <button
              type="button"
              className="timesheet-cell-dropdown equipment-timesheet-cell-dropdown"
              aria-label={`Выбрать значение: ${unitTitle(row.unit)}, ${fullDate(date)}`}
              aria-expanded={timesheetEditor?.equipmentId === row.unit.id && timesheetEditor.workDate === date}
              title="Выбрать значение из списка"
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                focusEquipmentTimesheetCell(index, day - 1);
                openTimesheetEditor(row.unit.id, date, event.currentTarget);
              }}
            ><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4 6 8l3.5-4Z" /></svg></button>}
          </>}</td>;
        })}<td className="timesheet-total-column equipment-work-total">{row.productive || "—"}</td><td className="timesheet-total-column equipment-idle-total has-difference">{row.downtime || "—"}</td><td className="timesheet-total-column equipment-all-total">{row.total || "—"}</td></tr>) : <tr><td colSpan={monthDays.length + 6}><div className="equipment-table-empty"><strong>В этом месяце данных нет</strong><span>Записи появятся после заполнения ежедневных отчётов техники.</span></div></td></tr>}</tbody>
        {monthRows.length > 0 && <tfoot><tr><th className="timesheet-sticky timesheet-summary-label" colSpan={3}>Итого по дням</th>{monthDays.map((day) => { const date = `${month}-${String(day).padStart(2, "0")}`; return <td key={date}>{monthDayTotals.get(date) || ""}</td>; })}<th className="timesheet-total-column equipment-work-total">{monthSummary.productive}</th><th className="timesheet-total-column equipment-idle-total has-difference">{monthSummary.downtime}</th><th className="timesheet-total-column equipment-all-total">{monthSummary.total}</th></tr></tfoot>}
      </table></div>
      <div className="equipment-timesheet-summary" aria-label={`Итоги за ${titleCase(MONTH_FORMATTER.format(new Date(`${month}-01T00:00:00Z`)))}`}><span className="equipment-timesheet-summary-label">Итоги за месяц</span><span><strong>{monthRows.filter((row) => row.total > 0).length}</strong> ед. техники</span><span className="productive"><strong>{monthSummary.productive} ч.</strong> работы</span><span className="downtime"><strong>{monthSummary.downtime} ч.</strong> простоя</span></div>

      {timesheetInfoOpen && <div className="equipment-reference-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTimesheetInfoOpen(false); }}><section className="equipment-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="equipment-timesheet-reference-title">
        <header><div><span>ТАБЕЛЬ ТЕХНИКИ</span><h2 id="equipment-timesheet-reference-title">Информация и справочник</h2><p>Цвета в таблице и обозначения, которые используются в табеле.</p></div><button type="button" aria-label="Закрыть справочник" onClick={() => setTimesheetInfoOpen(false)}>×</button></header>
        <section className="equipment-reference-section"><h3>Цвета ячеек</h3><div className="equipment-reference-colors">
          <div><i className="work"/><span><strong>Зелёный</strong><small>Работа: учтённые рабочие часы.</small></span></div>
          <div><i className="manual"/><span><strong>Жёлтый</strong><small>Ручная правка: значение изменено в табеле.</small></span></div>
          <div><i className="idle"/><span><strong>Красный</strong><small>Простой: часы простоя. Красная рамка также отмечает расхождение с ежедневным отчётом.</small></span></div>
        </div>{payload?.canEditTimesheet && <p className="equipment-reference-note">Выберите ячейку и сразу вводите значение: «8» — работа, «П 2» — простой, «8/2» — работа и простой. Можно заранее заполнить будущие даты. Отметка только с простоем делает технику недоступной в отчёте за этот день. Стрелка в выделенной ячейке открывает готовые варианты. Сумма за сутки — не более 20 часов.</p>}</section>
        <section className="equipment-reference-section"><h3>Табельные коды рабочих</h3><div className="equipment-reference-codes">{EQUIPMENT_TIMESHEET_CODES.map((code) => <div key={code.value}><strong>{code.value}</strong><span>{code.label}</span></div>)}</div></section>
        <footer><button type="button" onClick={() => setTimesheetInfoOpen(false)}>Понятно</button></footer>
      </section></div>}

      {timesheetEditor && editingTimesheetUnit && <TimesheetCellPopover
        anchor={timesheetEditor.anchor}
        width={timesheetEditor.mode === "list" ? 250 : 320}
        className={timesheetEditor.mode === "list" ? "timesheet-mark-popover" : ""}
        ariaLabel={`Часы техники: ${unitTitle(editingTimesheetUnit)}, ${fullDate(timesheetEditor.workDate)}`}
        onClose={() => { if (!savingTimesheetMark) closeTimesheetEditorAndRestoreFocus(); }}
      >
        {timesheetEditor.mode === "list" ? <EquipmentTimesheetMarkList
          value={formatEquipmentHours(editingTimesheetMark?.productiveHours ?? editingTimesheetReport.productive, editingTimesheetMark?.downtimeHours ?? editingTimesheetReport.downtime)}
          canReset={Boolean(editingTimesheetMark)}
          disabled={savingTimesheetMark}
          onClose={closeTimesheetEditorAndRestoreFocus}
          onChoose={(value) => void saveTimesheetListValue(value)}
        /> : <>
          <div className="timesheet-inline-heading"><div><strong>{unitTitle(editingTimesheetUnit)}</strong><span>{fullDate(timesheetEditor.workDate)}</span></div><button type="button" aria-label="Закрыть список" disabled={savingTimesheetMark} onClick={closeTimesheetEditorAndRestoreFocus}>×</button></div>
          <div className="timesheet-inline-source"><span>Из отчёта</span><strong>{editingTimesheetReport.productive} ч. / {editingTimesheetReport.downtime} ч. простоя</strong></div>
          <div className="equipment-inline-hours">
            <div className="equipment-inline-hour-field"><span>Работа</span><CustomSelect ariaLabel="Рабочие часы" value={timesheetProductive} options={EQUIPMENT_HOUR_OPTIONS} onChange={setTimesheetProductive} /></div>
            <div className="equipment-inline-hour-field"><span>Простой</span><CustomSelect ariaLabel="Часы простоя" value={timesheetDowntime} options={EQUIPMENT_HOUR_OPTIONS} onChange={setTimesheetDowntime} /></div>
          </div>
          <div className={`equipment-inline-total ${timesheetValueValid ? "valid" : "invalid"}`}><span>Всего за сутки</span><strong>{Number.isFinite(productiveHours + downtimeHours) ? productiveHours + downtimeHours : 0} из 20 ч.</strong></div>
          <label className="timesheet-inline-note"><span>Комментарий</span><input maxLength={300} value={timesheetNote} onChange={(event) => setTimesheetNote(event.target.value)} placeholder="Необязательно" /></label>
          {timesheetEditorError && <div className="timesheet-inline-error">{timesheetEditorError}</div>}
          <div className="timesheet-inline-actions">{editingTimesheetMark ? <button type="button" className="reset" disabled={savingTimesheetMark} onClick={() => void saveTimesheetMark(true)}>Из отчёта</button> : <span/>}<button type="button" className="save" disabled={savingTimesheetMark || !timesheetValueValid} onClick={() => void saveTimesheetMark()}>{savingTimesheetMark ? "Сохраняем…" : "Применить"}</button></div>
        </>}
        {timesheetEditor.mode === "list" && timesheetEditorError && <div className="timesheet-inline-error">{timesheetEditorError}</div>}
      </TimesheetCellPopover>}
    </>}

    {section === "registry" && <>
      <EquipmentRegistryAgGrid
        rows={registryUnits}
        drafts={unitDrafts}
        sites={payload?.sites ?? []}
        selectedIds={selectedUnitIds}
        fullRowEditIds={unitFullRowEditIds}
        loading={loading}
        onEdit={openUnit}
        onSelectionChange={(ids) => { setSelectedUnitIds(ids); setNotice(""); setError(""); }}
        onPatchDraft={patchUnitDraft}
        onVisibleIdsChange={(ids) => setVisibleUnitIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
        onValidationError={(message) => { setError(message); setNotice(""); }}
      />
      {payload?.canManageRegistry && <div className="table-edit-footer employee-table-footer uniform-footer-actions equipment-registry-footer">
        {selectedUnitIds.length > 0 && <div className="employee-selection-bar"><div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedUnitIds.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-action-primary" onClick={editSelectedUnits} disabled={saving}>Редактировать</button><button type="button" className="employee-action-button employee-action-danger" onClick={() => void deleteSelectedUnits()} disabled={saving}>Удалить технику</button><button type="button" className="employee-action-button clear-selection-button" onClick={() => { setSelectedUnitIds([]); setNotice(""); setError(""); }} disabled={saving}>Снять выделение</button></div></div>}
        {unitDrafts.length > 0 && <div className="employee-editing-bar"><div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Редактируется: <strong>{unitDrafts.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button cancel-editing-button" onClick={cancelUnitEditing} disabled={saving}>Отменить редактирование</button><button type="button" className="employee-action-button employee-save-button" onClick={() => void saveUnits()} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button></div></div>}
        {unitDrafts.length === 0 && selectedUnitIds.length === 0 && <div className="employee-footer-base"><button type="button" className="secondary-button footer-action-button employee-add-button" onClick={() => { setUnitDrafts((current) => [...current, emptyUnit()]); setNotice(""); setError(""); }}>Добавить технику</button><span className="employee-total-count">Всего техники: <strong>{visibleUnitIds?.length ?? registryUnits.length}</strong></span></div>}
      </div>}
    </>}

    {section === "project" && <>
      <ProjectEquipmentAgGrid
        rows={payload?.units ?? []}
        allUnits={payload?.availableUnits ?? []}
        drafts={projectUnitDrafts}
        selectedIds={selectedProjectUnitIds}
        loading={loading}
        readOnly={!payload?.canManageAssignments}
        onPatchDraft={patchProjectUnitDraft}
        onSelectionChange={(ids) => { setSelectedProjectUnitIds(ids); setError(""); setNotice(""); }}
      />
      {payload?.canManageAssignments && <div className="table-edit-footer employee-table-footer uniform-footer-actions equipment-project-footer">
        {selectedProjectUnitIds.length > 0 && <div className="employee-selection-bar"><div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedProjectUnitIds.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-action-danger" onClick={() => void removeSelectedProjectUnits()} disabled={saving}>Убрать из проекта</button><button type="button" className="employee-action-button clear-selection-button" onClick={() => { setSelectedProjectUnitIds([]); setError(""); setNotice(""); }} disabled={saving}>Снять выделение</button></div></div>}
        {projectUnitDrafts.length > 0 && <div className="employee-editing-bar"><div className="employee-editing-summary"><span aria-hidden="true">＋</span><span>Добавляется: <strong>{projectUnitDrafts.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button cancel-editing-button" onClick={() => { setProjectUnitDrafts([]); setError(""); setNotice(""); }} disabled={saving}>Отменить добавление</button><button type="button" className="employee-action-button employee-save-button" onClick={() => void assignProjectUnits()} disabled={saving}>{saving ? "Сохраняем…" : "Добавить в проект"}</button></div></div>}
        {projectUnitDrafts.length === 0 && selectedProjectUnitIds.length === 0 && <div className="employee-footer-base"><button type="button" className="secondary-button footer-action-button employee-add-button" onClick={() => { setProjectUnitDrafts((current) => [...current, { key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `project-equipment-${Date.now()}-${Math.random()}`, equipmentId: "" }]); setError(""); setNotice(""); }}>Добавить технику в проект</button><span className="employee-total-count">Всего в проекте: <strong>{payload?.units.length ?? 0}</strong></span></div>}
      </div>}
    </>}

  </section>;
}
