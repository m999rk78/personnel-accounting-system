"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createPersonnelTimesheetXlsx } from "./placementXlsx";
import { TIMESHEET_ALL_OPTION, TimesheetFilterableHeading, type TimesheetFilterOption, type TimesheetSortOption } from "./TimesheetColumnFilter";
import { TimesheetCellPopover } from "./TimesheetCellPopover";
import { useTimesheetClipboard, type TimesheetClipboardChange } from "./useTimesheetClipboard";

type TimesheetEmployee = {
  id: number;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
};

type TimesheetEntry = {
  employeeId: number;
  workDate: string;
  hours: number;
  masters: string;
  zones: string;
};

type TimesheetMark = {
  employeeId: number;
  workDate: string;
  hours: number | null;
  code: string | null;
  note: string;
  updatedBy: string;
};

type TimesheetPayload = {
  siteId: number;
  siteName: string;
  month: string;
  canEdit: boolean;
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  marks: TimesheetMark[];
  error?: string;
};

type EditorCell = { employeeId: number; workDate: string; anchor: HTMLElement };
type InlineEditorCell = { employeeId: number; workDate: string; rowIndex: number; columnIndex: number; value: string; error: string; selectAll: boolean };
type EmployeeSortMode = "type-opr-last" | "type-opr-first" | "type-asc" | "type-desc" | "department-asc" | "department-desc" | "employee-asc" | "employee-desc" | "position-asc" | "position-desc";

const MONTH_FORMATTER = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DATE_FORMATTER = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const TIMESHEET_CODES = [
  { value: "В", label: "Выходной" },
  { value: "ДО", label: "Дополнительный отпуск" },
  { value: "МО", label: "Межвахтовый отдых" },
  { value: "ПЕ", label: "ПЕ" },
  { value: "УВ", label: "УВ" },
  { value: "ПР", label: "Прогул" },
] as const;
const CODE_VALUES = new Set(TIMESHEET_CODES.map((code) => code.value));
const TIMESHEET_MARK_OPTIONS = [
  ...Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} ч.` })),
  ...TIMESHEET_CODES.map((code) => ({ value: code.value, label: `${code.value} — ${code.label}` })),
];
const TIMESHEET_VALUE_FILTERS: TimesheetFilterOption[] = [TIMESHEET_ALL_OPTION, { value: "filled", label: "Есть значение" }, { value: "empty", label: "Нет значения" }, { value: "manual", label: "Ручная правка" }, { value: "mismatch", label: "Расхождение" }];
const TIMESHEET_TOTAL_FILTERS: TimesheetFilterOption[] = [TIMESHEET_ALL_OPTION, { value: "positive", label: "Больше нуля" }, { value: "zero", label: "Равно нулю" }];
const TIMESHEET_DIFFERENCE_FILTERS: TimesheetFilterOption[] = [TIMESHEET_ALL_OPTION, { value: "mismatch", label: "Есть расхождение" }, { value: "equal", label: "Без расхождения" }];
const TYPE_SORT_OPTIONS: TimesheetSortOption[] = [
  { value: "type-opr-last", label: "ОПР в конце" },
  { value: "type-opr-first", label: "ОПР в начале" },
  { value: "type-asc", label: "Тип: А → Я" },
  { value: "type-desc", label: "Тип: Я → А" },
];
const DEPARTMENT_SORT_OPTIONS: TimesheetSortOption[] = [{ value: "department-asc", label: "От А до Я ↑" }, { value: "department-desc", label: "От Я до А ↓" }];
const EMPLOYEE_SORT_OPTIONS: TimesheetSortOption[] = [{ value: "employee-asc", label: "От А до Я ↑" }, { value: "employee-desc", label: "От Я до А ↓" }];
const POSITION_SORT_OPTIONS: TimesheetSortOption[] = [{ value: "position-asc", label: "От А до Я ↑" }, { value: "position-desc", label: "От Я до А ↓" }];

function TimesheetMarkList({ value, canReset, disabled, onChoose, onClose }: {
  value: string;
  canReset: boolean;
  disabled: boolean;
  onChoose: (value: string) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => [
    ...TIMESHEET_MARK_OPTIONS,
    ...(canReset ? [{ value: "", label: "Вернуть значение из отчёта", reset: true }] : []),
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

  return <div className="custom-select-options timesheet-mark-options" role="listbox" aria-label="Значение табеля">
    {options.map((option, index) => {
      const selected = Boolean(option.value) && option.value === value;
      return <button
        ref={(element) => { optionButtons.current[index] = element; }}
        key={option.value || "reset"}
        type="button"
        role="option"
        aria-selected={selected}
        className={["custom-select-option", selected ? "selected" : "", activeIndex === index ? "active" : "", "reset" in option && option.reset ? "timesheet-mark-reset-option" : ""].filter(Boolean).join(" ")}
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

function monthDate(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1));
}

function shiftMonth(month: string, amount: number) {
  const value = monthDate(month);
  value.setUTCMonth(value.getUTCMonth() + amount);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function dateForDay(month: string, day: number) {
  return `${month}-${String(day).padStart(2, "0")}`;
}

function monthLabel(month: string) {
  const value = MONTH_FORMATTER.format(monthDate(month));
  return value.charAt(0).toLocaleUpperCase("ru-RU") + value.slice(1);
}

function TimesheetMonthPicker({ value, current, onChange }: { value: string; current: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(() => Number(value.slice(0, 4)));
  const root = useRef<HTMLDivElement>(null);
  const selectedYear = Number(value.slice(0, 4));
  const selectedMonth = Number(value.slice(5, 7));
  const currentYear = Number(current.slice(0, 4));
  const currentMonth = Number(current.slice(5, 7));
  const monthNames = useMemo(() => Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))).replace(".", "")), []);
  const valueLabel = monthLabel(value);

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

function dateLabel(value: string) {
  return DATE_FORMATTER.format(new Date(`${value}T00:00:00Z`));
}

function cellKey(employeeId: number, workDate: string) {
  return `${employeeId}:${workDate}`;
}

function effectiveHours(entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  if (mark?.code) return 0;
  if (mark?.hours !== null && mark?.hours !== undefined) return Number(mark.hours);
  return Number(entry?.hours ?? 0);
}

function markValue(mark: TimesheetMark | undefined, entry: TimesheetEntry | undefined) {
  if (mark?.code) return mark.code;
  if (mark?.hours !== null && mark?.hours !== undefined) return String(mark.hours);
  return entry?.hours ? String(entry.hours) : "";
}

function isReportTracked(employee: TimesheetEmployee) {
  return employee.employmentType.trim().toLocaleUpperCase("ru-RU") === "ОПР";
}

function compareText(left: string, right: string, descending = false) {
  const leftValue = left.trim();
  const rightValue = right.trim();
  if (!leftValue && rightValue) return 1;
  if (leftValue && !rightValue) return -1;
  const result = leftValue.localeCompare(rightValue, "ru", { numeric: true, sensitivity: "base" });
  return descending ? -result : result;
}

function compareEmployees(left: TimesheetEmployee, right: TimesheetEmployee, mode: EmployeeSortMode) {
  if (mode === "type-opr-last" || mode === "type-opr-first") {
    const leftIsOpr = isReportTracked(left);
    const rightIsOpr = isReportTracked(right);
    if (leftIsOpr !== rightIsOpr) return mode === "type-opr-last" ? (leftIsOpr ? 1 : -1) : (leftIsOpr ? -1 : 1);
  }

  let result = 0;
  if (mode.startsWith("type-")) result = compareText(left.employmentType, right.employmentType, mode === "type-desc");
  if (mode.startsWith("department-")) result = compareText(left.department, right.department, mode === "department-desc");
  if (mode.startsWith("employee-")) result = compareText(left.fullName, right.fullName, mode === "employee-desc");
  if (mode.startsWith("position-")) result = compareText(left.position, right.position, mode === "position-desc");
  return result || compareText(left.fullName, right.fullName);
}

function isMismatch(employee: TimesheetEmployee, entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  return isReportTracked(employee) && Boolean(mark) && effectiveHours(entry, mark) !== Number(entry?.hours ?? 0);
}

function matchesDayFilter(filters: string[], employee: TimesheetEmployee, entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  if (filters.length === 0) return true;
  const value = markValue(mark, entry);
  return filters.some((filter) => {
    if (filter === "filled") return Boolean(value);
    if (filter === "empty") return !value;
    if (filter === "manual") return Boolean(mark);
    if (filter === "mismatch") return isMismatch(employee, entry, mark);
    return filter.startsWith("value:") && value === filter.slice(6);
  });
}

function matchesTotalFilter(filters: string[], value: number) {
  if (filters.length === 0) return true;
  return filters.some((filter) => {
    if (filter === "positive") return value > 0;
    if (filter === "zero") return value === 0;
    if (filter === "mismatch") return value !== 0;
    return filter === "equal" && value === 0;
  });
}

function cellDetails(employee: TimesheetEmployee, entry: TimesheetEntry | undefined, mark: TimesheetMark | undefined) {
  const details: string[] = [];
  if (entry) details.push(`Отчёт рабочих: ${entry.hours} ч.`);
  if (entry?.masters) details.push(`Мастер: ${entry.masters}`);
  if (entry?.zones) details.push(`Зона: ${entry.zones}`);
  if (mark) details.push(`Табель: ${mark.code ?? `${mark.hours} ч.`}`);
  if (mark?.note) details.push(`Комментарий: ${mark.note}`);
  if (mark?.updatedBy) details.push(`Изменил: ${mark.updatedBy}`);
  if (isMismatch(employee, entry, mark)) details.push("Есть расхождение с отчётом рабочих");
  return details.join("\n");
}

export function TimesheetView({ siteId, initialMonth, today, onMonthChange }: { siteId: number; initialMonth: string; today: string; onMonthChange?: (month: string) => void }) {
  const [month, setMonth] = useState(initialMonth);
  const [payload, setPayload] = useState<TimesheetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [employmentType, setEmploymentType] = useState<string[]>([]);
  const [department, setDepartment] = useState<string[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState<string[]>([]);
  const [positionFilter, setPositionFilter] = useState<string[]>([]);
  const [dayFilters, setDayFilters] = useState<Record<string, string[]>>({});
  const [timesheetTotalFilter, setTimesheetTotalFilter] = useState<string[]>([]);
  const [reportTotalFilter, setReportTotalFilter] = useState<string[]>([]);
  const [differenceFilter, setDifferenceFilter] = useState<string[]>([]);
  const [employeeSort, setEmployeeSort] = useState<EmployeeSortMode>("type-opr-last");
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLElement | null>(null);
  const [codesOpen, setCodesOpen] = useState(false);
  const [editor, setEditor] = useState<EditorCell | null>(null);
  const [inlineEditor, setInlineEditor] = useState<InlineEditorCell | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const [savingMark, setSavingMark] = useState(false);
  const [editorError, setEditorError] = useState("");
  const inlineEditorEmployeeId = inlineEditor?.employeeId;
  const inlineEditorWorkDate = inlineEditor?.workDate;
  const inlineEditorSelectAll = inlineEditor?.selectAll ?? false;
  const currentMonth = today.slice(0, 7);

  function changeMonth(nextMonth: string) {
    setMonth(nextMonth);
    onMonthChange?.(nextMonth);
  }

  useEffect(() => {
    const task = window.setTimeout(() => setHeaderActionsTarget(document.getElementById("personnel-timesheet-actions")), 0);
    return () => window.clearTimeout(task);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const task = window.setTimeout(() => {
      setLoading(true);
      setError("");
      setEditor(null);
      setInlineEditor(null);
      fetch(`/api/timesheet?siteId=${siteId}&month=${month}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (response.status === 401) {
            window.location.replace("/login");
            return null;
          }
          const result = await response.json() as TimesheetPayload;
          if (!response.ok) throw new Error(result.error ?? "Не удалось сформировать табель.");
          return result;
        })
        .then((result) => { if (result) setPayload(result); })
        .catch((loadError: unknown) => {
          if (loadError instanceof DOMException && loadError.name === "AbortError") return;
          setError(loadError instanceof Error ? loadError.message : "Не удалось сформировать табель.");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [month, reloadKey, siteId]);

  useEffect(() => {
    if (!editor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingMark) setEditor(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editor, savingMark]);

  useEffect(() => {
    if (inlineEditorEmployeeId === undefined || !inlineEditorWorkDate) return;
    const frame = requestAnimationFrame(() => {
      inlineInputRef.current?.focus({ preventScroll: true });
      if (inlineEditorSelectAll) inlineInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [inlineEditorEmployeeId, inlineEditorSelectAll, inlineEditorWorkDate]);

  const days = useMemo(() => Array.from({ length: daysInMonth(month) }, (_, index) => index + 1), [month]);
  const entriesByCell = useMemo(() => new Map((payload?.entries ?? []).map((entry) => [cellKey(entry.employeeId, entry.workDate), entry])), [payload?.entries]);
  const marksByCell = useMemo(() => new Map((payload?.marks ?? []).map((mark) => [cellKey(mark.employeeId, mark.workDate), mark])), [payload?.marks]);
  const employeeById = useMemo(() => new Map((payload?.employees ?? []).map((employee) => [employee.id, employee])), [payload?.employees]);
  const employmentTypes = useMemo(() => Array.from(new Set((payload?.employees ?? []).map((employee) => employee.employmentType).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru")), [payload?.employees]);
  const departments = useMemo(() => Array.from(new Set((payload?.employees ?? []).map((employee) => employee.department).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru")), [payload?.employees]);
  const employeeNames = useMemo(() => Array.from(new Set((payload?.employees ?? []).map((employee) => employee.fullName).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru")), [payload?.employees]);
  const positions = useMemo(() => Array.from(new Set((payload?.employees ?? []).map((employee) => employee.position).filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru")), [payload?.employees]);
  const rowMetricsByEmployee = useMemo(() => new Map((payload?.employees ?? []).map((employee) => {
    let timesheet = 0;
    let reports = 0;
    for (const day of days) {
      const workDate = dateForDay(month, day);
      const entry = entriesByCell.get(cellKey(employee.id, workDate));
      const mark = marksByCell.get(cellKey(employee.id, workDate));
      timesheet += effectiveHours(entry, mark);
      reports += Number(entry?.hours ?? 0);
    }
    return [employee.id, { timesheet, reports, difference: isReportTracked(employee) ? timesheet - reports : 0 }] as const;
  })), [days, entriesByCell, marksByCell, month, payload?.employees]);
  const selectedEmploymentType = employmentType.filter((value) => employmentTypes.includes(value));
  const selectedDepartment = department.filter((value) => departments.includes(value));
  const selectedEmployee = employeeFilter.filter((value) => employeeNames.includes(value));
  const selectedPosition = positionFilter.filter((value) => positions.includes(value));
  const dayFilterOptions = useMemo(() => new Map(days.map((day) => {
    const workDate = dateForDay(month, day);
    const values = new Set<string>();
    for (const employee of payload?.employees ?? []) {
      const value = markValue(marksByCell.get(cellKey(employee.id, workDate)), entriesByCell.get(cellKey(employee.id, workDate)));
      if (value) values.add(value);
    }
    return [workDate, [...TIMESHEET_VALUE_FILTERS, ...Array.from(values).sort((left, right) => left.localeCompare(right, "ru", { numeric: true })).map((value) => ({ value: `value:${value}`, label: `Значение: ${value}` }))]] as const;
  })), [days, entriesByCell, marksByCell, month, payload?.employees]);
  const visibleEmployees = useMemo(() => {
    return (payload?.employees ?? []).filter((employee) => {
      if (selectedEmploymentType.length > 0 && !selectedEmploymentType.includes(employee.employmentType)) return false;
      if (selectedDepartment.length > 0 && !selectedDepartment.includes(employee.department)) return false;
      if (selectedEmployee.length > 0 && !selectedEmployee.includes(employee.fullName)) return false;
      if (selectedPosition.length > 0 && !selectedPosition.includes(employee.position)) return false;
      const metrics = rowMetricsByEmployee.get(employee.id) ?? { timesheet: 0, reports: 0, difference: 0 };
      if (!matchesTotalFilter(timesheetTotalFilter, metrics.timesheet)) return false;
      if (!matchesTotalFilter(reportTotalFilter, metrics.reports)) return false;
      if (!matchesTotalFilter(differenceFilter, metrics.difference)) return false;
      for (const day of days) {
        const workDate = dateForDay(month, day);
        const filter = dayFilters[workDate] ?? [];
        if (!matchesDayFilter(filter, employee, entriesByCell.get(cellKey(employee.id, workDate)), marksByCell.get(cellKey(employee.id, workDate)))) return false;
      }
      return true;
    }).sort((left, right) => compareEmployees(left, right, employeeSort));
  }, [dayFilters, days, differenceFilter, employeeSort, entriesByCell, marksByCell, month, payload?.employees, reportTotalFilter, rowMetricsByEmployee, selectedDepartment, selectedEmployee, selectedEmploymentType, selectedPosition, timesheetTotalFilter]);
  const visibleEmployeeIds = useMemo(() => new Set(visibleEmployees.map((employee) => employee.id)), [visibleEmployees]);
  const visibleEntries = useMemo(() => (payload?.entries ?? []).filter((entry) => visibleEmployeeIds.has(entry.employeeId)), [payload?.entries, visibleEmployeeIds]);

  const {
    rows: reconciliationRows,
    timesheet: reconciliationTimesheet,
    reports: reconciliationReports,
    difference: reconciliationDifference,
  } = useMemo(() => {
    const rows = new Map<number, { timesheet: number; reports: number; difference: number }>();
    const daysWithValues = new Set<string>();
    for (const employee of visibleEmployees) {
      let timesheet = 0;
      let reports = 0;
      for (const day of days) {
        const workDate = dateForDay(month, day);
        const entry = entriesByCell.get(cellKey(employee.id, workDate));
        const mark = marksByCell.get(cellKey(employee.id, workDate));
        const cellTimesheet = effectiveHours(entry, mark);
        timesheet += cellTimesheet;
        reports += Number(entry?.hours ?? 0);
        if (entry || mark) daysWithValues.add(workDate);
      }
      rows.set(employee.id, { timesheet, reports, difference: isReportTracked(employee) ? timesheet - reports : 0 });
    }
    const timesheet = Array.from(rows.values()).reduce((sum, row) => sum + row.timesheet, 0);
    const reports = Array.from(rows.values()).reduce((sum, row) => sum + row.reports, 0);
    return {
      rows,
      timesheet,
      reports,
      difference: Array.from(rows.values()).reduce((sum, row) => sum + row.difference, 0),
      completedDays: daysWithValues.size,
    };
  }, [days, entriesByCell, marksByCell, month, visibleEmployees]);

  const dayTotals = useMemo(() => new Map(days.map((day) => {
    const workDate = dateForDay(month, day);
    let timesheet = 0;
    let reports = 0;
    let difference = 0;
    for (const employee of visibleEmployees) {
      const entry = entriesByCell.get(cellKey(employee.id, workDate));
      const mark = marksByCell.get(cellKey(employee.id, workDate));
      timesheet += effectiveHours(entry, mark);
      reports += Number(entry?.hours ?? 0);
      if (isReportTracked(employee)) difference += effectiveHours(entry, mark) - Number(entry?.hours ?? 0);
    }
    return [workDate, { timesheet, reports, difference }];
  })), [days, entriesByCell, marksByCell, month, visibleEmployees]);

  const employeesWithReports = new Set(visibleEntries.map((entry) => entry.employeeId)).size;
  const activeFilterCount = Number(selectedEmploymentType.length > 0) + Number(selectedDepartment.length > 0) + Number(selectedEmployee.length > 0) + Number(selectedPosition.length > 0) + Number(timesheetTotalFilter.length > 0) + Number(reportTotalFilter.length > 0) + Number(differenceFilter.length > 0) + days.reduce((count, day) => count + Number((dayFilters[dateForDay(month, day)] ?? []).length > 0), 0);

  const editingEmployee = editor ? employeeById.get(editor.employeeId) : undefined;
  const editingMark = editor ? marksByCell.get(cellKey(editor.employeeId, editor.workDate)) : undefined;
  const {
    shellRef: clipboardShellRef,
    status: clipboardStatus,
    cellClass: clipboardCellClass,
    cellHandlers: clipboardCellHandlers,
    shellHandlers: clipboardShellHandlers,
    rememberUndo: rememberTimesheetUndo,
    activeCell: clipboardActiveCell,
    focusCell: focusClipboardCell,
  } = useTimesheetClipboard({
    rowCount: visibleEmployees.length,
    columnCount: days.length,
    resetKey: `${month}:${visibleEmployees.map((employee) => employee.id).join("|")}`,
    getValue: (rowIndex, columnIndex) => {
      const employee = visibleEmployees[rowIndex];
      const day = days[columnIndex];
      if (!employee || !day) return "";
      const workDate = dateForDay(month, day);
      return markValue(marksByCell.get(cellKey(employee.id, workDate)), entriesByCell.get(cellKey(employee.id, workDate)));
    },
    getUndoValue: (rowIndex, columnIndex) => {
      const employee = visibleEmployees[rowIndex];
      const day = days[columnIndex];
      if (!employee || !day) return "";
      const mark = marksByCell.get(cellKey(employee.id, dateForDay(month, day)));
      return mark ? markValue(mark, undefined) : "";
    },
    getUndoNote: (rowIndex, columnIndex) => {
      const employee = visibleEmployees[rowIndex];
      const day = days[columnIndex];
      if (!employee || !day) return "";
      return marksByCell.get(cellKey(employee.id, dateForDay(month, day)))?.note ?? "";
    },
    canPaste: (rowIndex, columnIndex) => Boolean(payload?.canEdit && visibleEmployees[rowIndex] && days[columnIndex]),
    onPaste: pasteTimesheetCells,
    canDelete: (rowIndex, columnIndex) => {
      const employee = visibleEmployees[rowIndex];
      const day = days[columnIndex];
      if (!payload?.canEdit || !employee || !day) return false;
      const workDate = dateForDay(month, day);
      return marksByCell.has(cellKey(employee.id, workDate));
    },
    onDelete: pasteTimesheetCells,
    onActivate: (rowIndex, columnIndex) => {
      const employee = visibleEmployees[rowIndex];
      const day = days[columnIndex];
      if (employee && day) openInlineEditor(employee.id, dateForDay(month, day), rowIndex, columnIndex);
    },
    onType: (rowIndex, columnIndex, _anchor, value) => {
      void _anchor;
      const employee = visibleEmployees[rowIndex];
      const day = days[columnIndex];
      if (employee && day) openInlineEditor(employee.id, dateForDay(month, day), rowIndex, columnIndex, value);
    },
  });

  useEffect(() => {
    if (!inlineEditor) return;
    if (!clipboardActiveCell || clipboardActiveCell.rowIndex !== inlineEditor.rowIndex || clipboardActiveCell.columnIndex !== inlineEditor.columnIndex) setInlineEditor(null);
  }, [clipboardActiveCell, inlineEditor]);

  function openEditor(employeeId: number, workDate: string, anchor: HTMLElement) {
    if (!payload?.canEdit) return;
    if (editor?.employeeId === employeeId && editor.workDate === workDate) {
      if (!savingMark) closeEditorAndRestoreGridFocus();
      return;
    }
    if (savingMark) return;
    setInlineEditor(null);
    setEditor({ employeeId, workDate, anchor });
    setEditorError("");
  }

  function openInlineEditor(employeeId: number, workDate: string, rowIndex: number, columnIndex: number, typedValue?: string) {
    if (!payload?.canEdit) return;
    const entry = entriesByCell.get(cellKey(employeeId, workDate));
    const mark = marksByCell.get(cellKey(employeeId, workDate));
    setEditor(null);
    setInlineEditor({
      employeeId,
      workDate,
      rowIndex,
      columnIndex,
      value: typedValue ?? markValue(mark, entry),
      error: "",
      selectAll: typedValue === undefined,
    });
  }

  function restoreGridFocus() {
    requestAnimationFrame(() => clipboardShellRef.current?.focus({ preventScroll: true }));
  }

  function closeEditorAndRestoreGridFocus() {
    setEditor(null);
    restoreGridFocus();
  }

  async function persistMark(target: { employeeId: number; workDate: string }, value: string, note = "") {
    if (!payload) throw new Error("Табель ещё не загружен.");
    setSavingMark(true);
    const previousMark = marksByCell.get(cellKey(target.employeeId, target.workDate));
    const undoRowIndex = visibleEmployees.findIndex((employee) => employee.id === target.employeeId);
    const undoColumnIndex = days.indexOf(Number(target.workDate.slice(8, 10)));
    try {
      const response = await fetch("/api/timesheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: payload.siteId, employeeId: target.employeeId, workDate: target.workDate, value, note }),
      });
      if (response.status === 401) {
        window.location.replace("/login");
        throw new Error("Требуется авторизация");
      }
      const result = await response.json() as { mark?: TimesheetMark; deleted?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить отметку.");
      setPayload((current) => current ? {
        ...current,
        marks: [
          ...current.marks.filter((mark) => cellKey(mark.employeeId, mark.workDate) !== cellKey(target.employeeId, target.workDate)),
          ...(result.mark ? [result.mark] : []),
        ],
      } : current);
      if (undoRowIndex >= 0 && undoColumnIndex >= 0) rememberTimesheetUndo([{ rowIndex: undoRowIndex, columnIndex: undoColumnIndex, value: previousMark ? markValue(previousMark, undefined) : "", note: previousMark?.note ?? "" }]);
    } finally {
      setSavingMark(false);
    }
  }

  async function saveMark(clear = false, valueOverride?: string) {
    if (!editor) return;
    const nextValue = clear ? "" : valueOverride ?? "";
    setEditorError("");
    try {
      await persistMark(editor, nextValue, marksByCell.get(cellKey(editor.employeeId, editor.workDate))?.note ?? "");
      closeEditorAndRestoreGridFocus();
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку.");
    }
  }

  async function saveInlineEditor() {
    if (!inlineEditor) return;
    const normalizedValue = inlineEditor.value.trim().toLocaleUpperCase("ru-RU");
    const valid = /^([1-9]|10)$/.test(normalizedValue) || CODE_VALUES.has(normalizedValue as typeof TIMESHEET_CODES[number]["value"]);
    if (!valid) {
      setInlineEditor((current) => current ? { ...current, value: normalizedValue, error: "Недопустимое значение" } : current);
      return;
    }
    try {
      const currentMark = marksByCell.get(cellKey(inlineEditor.employeeId, inlineEditor.workDate));
      await persistMark(inlineEditor, normalizedValue, currentMark?.note ?? "");
      setInlineEditor(null);
      restoreGridFocus();
    } catch (saveError) {
      setInlineEditor((current) => current ? { ...current, error: saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку" } : current);
    }
  }

  async function pasteTimesheetCells(changes: TimesheetClipboardChange[]) {
    if (!payload?.canEdit) throw new Error("Недостаточно прав для изменения табеля");
    const prepared = changes.map((change) => {
      const employee = visibleEmployees[change.rowIndex];
      const day = days[change.columnIndex];
      const workDate = day ? dateForDay(month, day) : "";
      const value = change.value.trim().toLocaleUpperCase("ru-RU");
      if (!employee || !workDate) throw new Error("Выбранный диапазон содержит недоступные ячейки");
      if (value && !/^([1-9]|10)$/.test(value) && !CODE_VALUES.has(value as typeof TIMESHEET_CODES[number]["value"])) {
        throw new Error(`Значение «${change.value}» нельзя вставить. Используйте часы 1–10 или табельный код.`);
      }
      return { employeeId: employee.id, workDate, value, note: change.note ?? "" };
    });

    const results = await Promise.all(prepared.map(async (item) => {
      const response = await fetch("/api/timesheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: payload.siteId, employeeId: item.employeeId, workDate: item.workDate, value: item.value, note: item.note }),
      });
      if (response.status === 401) {
        window.location.replace("/login");
        throw new Error("Требуется авторизация");
      }
      const result = await response.json() as { mark?: TimesheetMark; deleted?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось вставить данные табеля");
      return { ...item, mark: result.mark };
    }));

    const changedKeys = new Set(prepared.map((item) => cellKey(item.employeeId, item.workDate)));
    setPayload((current) => current ? {
      ...current,
      marks: [
        ...current.marks.filter((mark) => !changedKeys.has(cellKey(mark.employeeId, mark.workDate))),
        ...results.flatMap((result) => result.mark ? [result.mark] : []),
      ],
    } : current);
    return results.length;
  }

  function exportTimesheet() {
    const dates = days.map((day) => dateForDay(month, day));
    const rows = visibleEmployees.map((employee) => {
      const totals = reconciliationRows.get(employee.id) ?? { timesheet: 0, reports: 0 };
      const masters = new Set<string>();
      const dayValues = days.map((day) => {
        const workDate = dateForDay(month, day);
        const entry = entriesByCell.get(cellKey(employee.id, workDate));
        const mark = marksByCell.get(cellKey(employee.id, workDate));
        for (const master of entry?.masters.split(/[,;]/).map((value) => value.trim()).filter(Boolean) ?? []) masters.add(master);
        return mark?.code ?? mark?.hours ?? entry?.hours ?? "";
      });
      return {
        employmentType: employee.employmentType,
        department: employee.department,
        fullName: employee.fullName,
        position: employee.position,
        positionNote: "",
        dailyValues: dayValues,
        timesheetHours: totals.timesheet,
        reportHours: totals.reports,
        masters: Array.from(masters).join(", "),
      };
    });
    const blob = createPersonnelTimesheetXlsx(
      payload?.siteName ?? "Объект",
      monthLabel(month),
      dates,
      rows,
      dates.map((date) => dayTotals.get(date)?.timesheet ?? 0),
      reconciliationTimesheet,
      reconciliationDifference,
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Табель_рабочих_${month}.xlsx`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return <section className="timesheet-page" aria-label="Табель учёта рабочего времени">
    {headerActionsTarget && createPortal(<div className="excel-actions personnel-timesheet-page-actions">
      {activeFilterCount > 0 && <button type="button" className="timesheet-filter-reset timesheet-header-filter-reset" onClick={() => { setEmploymentType([]); setDepartment([]); setEmployeeFilter([]); setPositionFilter([]); setDayFilters({}); setTimesheetTotalFilter([]); setReportTotalFilter([]); setDifferenceFilter([]); }}>Сбросить фильтры <span>{activeFilterCount}</span></button>}
      <button type="button" className="timesheet-export-button" onClick={exportTimesheet} disabled={loading || visibleEmployees.length === 0}>Экспорт в Excel</button>
      <button type="button" className="timesheet-info-button" aria-label="Информация" title="Информация" onClick={() => setCodesOpen(true)}><span aria-hidden="true">i</span></button>
    </div>, headerActionsTarget)}

    <div className="equipment-timesheet-month-row personnel-timesheet-month-row"><div className="timesheet-month-control equipment-timesheet-month-control personnel-timesheet-month-control" aria-label="Выбор месяца">
      <button type="button" onClick={() => changeMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц">‹</button>
      <TimesheetMonthPicker value={month} current={currentMonth} onChange={changeMonth} />
      <button type="button" onClick={() => changeMonth(shiftMonth(month, 1))} aria-label="Следующий месяц">›</button>
    </div></div>

    {error && <div className="timesheet-state timesheet-state-error"><strong>Не удалось открыть табель</strong><span>{error}</span><button type="button" onClick={() => setReloadKey((value) => value + 1)}>Повторить</button></div>}
    {/* The spreadsheet shell must receive focus so native copy and paste events reach it. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    {!error && <div ref={clipboardShellRef} className="timesheet-grid-shell timesheet-grid-shell-reconciled timesheet-clipboard-shell" role="application" tabIndex={0} aria-busy={loading} aria-label="Табель рабочих. Стрелки перемещают выбранную ячейку, Enter или F2 открывают редактирование." {...clipboardShellHandlers}>
      {clipboardStatus && <div className="timesheet-clipboard-status" role="status">{clipboardStatus}</div>}
      {loading && <div className="timesheet-loading">Формируем табель…</div>}
      {!loading && visibleEmployees.length === 0 && <div className="timesheet-empty"><strong>Нет сотрудников для отображения</strong><span>Измените фильтр или выберите другой месяц.</span></div>}
      {!loading && visibleEmployees.length > 0 && <table className="timesheet-table personnel-timesheet-table">
        <thead>
          <tr>
            <th className="timesheet-sticky timesheet-number-column" rowSpan={2}>№</th>
            <th className="timesheet-sticky timesheet-type-column" rowSpan={2}><TimesheetFilterableHeading label="Тип" value={selectedEmploymentType} options={[TIMESHEET_ALL_OPTION, ...employmentTypes.map((value) => ({ value, label: value }))]} onChange={setEmploymentType} sortValue={employeeSort.startsWith("type-") ? employeeSort : ""} sortOptions={TYPE_SORT_OPTIONS} defaultSortValue="type-opr-last" onSortChange={(value) => setEmployeeSort((value || "type-opr-last") as EmployeeSortMode)}>Тип</TimesheetFilterableHeading></th>
            <th className="timesheet-sticky timesheet-department-column" rowSpan={2}><TimesheetFilterableHeading label="Отдел" value={selectedDepartment} options={[TIMESHEET_ALL_OPTION, ...departments.map((value) => ({ value, label: value }))]} onChange={setDepartment} sortValue={employeeSort.startsWith("department-") ? employeeSort : ""} sortOptions={DEPARTMENT_SORT_OPTIONS} defaultSortValue="type-opr-last" onSortChange={(value) => setEmployeeSort((value || "type-opr-last") as EmployeeSortMode)}>Отдел</TimesheetFilterableHeading></th>
            <th className="timesheet-sticky timesheet-employee-column" rowSpan={2}><TimesheetFilterableHeading label="Сотрудник" value={selectedEmployee} options={[TIMESHEET_ALL_OPTION, ...employeeNames.map((value) => ({ value, label: value }))]} onChange={setEmployeeFilter} sortValue={employeeSort.startsWith("employee-") ? employeeSort : ""} sortOptions={EMPLOYEE_SORT_OPTIONS} defaultSortValue="type-opr-last" onSortChange={(value) => setEmployeeSort((value || "type-opr-last") as EmployeeSortMode)}>Сотрудник</TimesheetFilterableHeading></th>
            <th className="timesheet-sticky timesheet-position-column" rowSpan={2}><TimesheetFilterableHeading label="Должность" value={selectedPosition} options={[TIMESHEET_ALL_OPTION, ...positions.map((value) => ({ value, label: value }))]} onChange={setPositionFilter} sortValue={employeeSort.startsWith("position-") ? employeeSort : ""} sortOptions={POSITION_SORT_OPTIONS} defaultSortValue="type-opr-last" onSortChange={(value) => setEmployeeSort((value || "type-opr-last") as EmployeeSortMode)}>Должность</TimesheetFilterableHeading></th>
            <th colSpan={days.length}>Дни месяца</th>
            <th className="timesheet-total-column timesheet-tabell-total" rowSpan={2}><TimesheetFilterableHeading label="Табель" value={timesheetTotalFilter} options={TIMESHEET_TOTAL_FILTERS} onChange={setTimesheetTotalFilter}>Табель</TimesheetFilterableHeading></th>
            <th className="timesheet-total-column timesheet-report-total" rowSpan={2}><TimesheetFilterableHeading label="Отчёты" value={reportTotalFilter} options={TIMESHEET_TOTAL_FILTERS} onChange={setReportTotalFilter}>Отчёты</TimesheetFilterableHeading></th>
            <th className="timesheet-total-column timesheet-difference-total" rowSpan={2}><TimesheetFilterableHeading label="Разница" value={differenceFilter} options={TIMESHEET_DIFFERENCE_FILTERS} onChange={setDifferenceFilter}>Разница</TimesheetFilterableHeading></th>
          </tr>
          <tr>
            {days.map((day) => {
              const workDate = dateForDay(month, day);
              const weekDay = WEEKDAY_FORMATTER.format(new Date(`${workDate}T00:00:00Z`)).replace(".", "");
              const dayOfWeek = new Date(`${workDate}T00:00:00Z`).getUTCDay();
              return <th key={workDate} className={[dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "", workDate === today ? "today" : "", workDate > today ? "future" : ""].filter(Boolean).join(" ")}><TimesheetFilterableHeading compact label={`${day} ${weekDay}`} value={dayFilters[workDate] ?? []} options={dayFilterOptions.get(workDate) ?? TIMESHEET_VALUE_FILTERS} onChange={(value) => setDayFilters((current) => ({ ...current, [workDate]: value }))}><span>{day}</span><small>{weekDay}</small></TimesheetFilterableHeading></th>;
            })}
          </tr>
        </thead>
        <tbody>
          {visibleEmployees.map((employee, employeeIndex) => {
            const totals = reconciliationRows.get(employee.id) ?? { timesheet: 0, reports: 0, difference: 0 };
            const difference = totals.difference;
            return <tr key={employee.id}>
              <td className="timesheet-sticky timesheet-number-column">{employeeIndex + 1}</td>
              <td className="timesheet-sticky timesheet-type-column"><span className="timesheet-type-badge">{employee.employmentType || "—"}</span></td>
              <td className="timesheet-sticky timesheet-department-column">{employee.department || "—"}</td>
              <th scope="row" className="timesheet-sticky timesheet-employee-column" title={`${employee.fullName}\n${employee.position}`}><span>{employee.fullName}</span><small className="timesheet-employee-meta">{employee.position || "Должность не указана"}</small></th>
              <td className="timesheet-sticky timesheet-position-column" title={employee.position}>{employee.position || "—"}</td>
              {days.map((day) => {
                const workDate = dateForDay(month, day);
                const entry = entriesByCell.get(cellKey(employee.id, workDate));
                const mark = marksByCell.get(cellKey(employee.id, workDate));
                const dayOfWeek = new Date(`${workDate}T00:00:00Z`).getUTCDay();
                const display = mark?.code ?? mark?.hours ?? entry?.hours ?? "";
                const mismatch = isMismatch(employee, entry, mark);
                const isInlineEditing = inlineEditor?.employeeId === employee.id && inlineEditor.workDate === workDate;
                const isActiveCell = clipboardActiveCell?.rowIndex === employeeIndex && clipboardActiveCell.columnIndex === day - 1;
                return <td
                  key={workDate}
                  className={[
                    entry || mark ? "filled" : "",
                    mark ? "manual" : "",
                    mark?.code ? "coded" : "",
                    mismatch ? "mismatch" : "",
                    payload?.canEdit ? "editable" : "",
                    dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "",
                    workDate === today ? "today" : "",
                    workDate > today ? "future" : "",
                    clipboardCellClass(employeeIndex, day - 1),
                  ].filter(Boolean).join(" ")}
                  title={isInlineEditing && inlineEditor.error ? inlineEditor.error : cellDetails(employee, entry, mark)}
                  tabIndex={mismatch ? -1 : undefined}
                  {...clipboardCellHandlers(employeeIndex, day - 1)}
                  onDoubleClick={(event) => {
                    if (event.target instanceof Element && event.target.closest("button, input")) return;
                    openInlineEditor(employee.id, workDate, employeeIndex, day - 1);
                  }}
                >
                  {isInlineEditing ? <div className={["timesheet-cell-inline-editor", inlineEditor.error ? "invalid" : ""].filter(Boolean).join(" ")}>
                    <input
                      ref={inlineInputRef}
                      value={inlineEditor.value}
                      aria-label={`Значение табеля: ${employee.fullName}, ${dateLabel(workDate)}`}
                      aria-invalid={Boolean(inlineEditor.error)}
                      disabled={savingMark}
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onChange={(event) => setInlineEditor((current) => current ? { ...current, value: event.target.value, error: "", selectAll: false } : current)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveInlineEditor();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setInlineEditor(null);
                          restoreGridFocus();
                        }
                      }}
                    />
                    {inlineEditor.error && <span className="timesheet-cell-inline-error" role="alert" title={inlineEditor.error}>!</span>}
                  </div> : <>
                    <span className="timesheet-cell-value">{display}</span>
                    {payload?.canEdit && isActiveCell && <button
                      type="button"
                      className="timesheet-cell-dropdown personnel-timesheet-cell-dropdown"
                      aria-label={`Выбрать значение: ${employee.fullName}, ${dateLabel(workDate)}`}
                      aria-expanded={editor?.employeeId === employee.id && editor.workDate === workDate}
                      title="Выбрать значение из списка"
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        focusClipboardCell(employeeIndex, day - 1);
                        openEditor(employee.id, workDate, event.currentTarget);
                      }}
                    ><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4 6 8l3.5-4Z" /></svg></button>}
                  </>}
                </td>;
              })}
              <td className="timesheet-total-column timesheet-tabell-total">{totals.timesheet || "—"}</td>
              <td className="timesheet-total-column timesheet-report-total">{totals.reports || "—"}</td>
              <td className={`timesheet-total-column timesheet-difference-total ${difference ? "has-difference" : ""}`}>{difference > 0 ? "+" : ""}{difference || "—"}</td>
            </tr>;
          })}
        </tbody>
        <tfoot>
          <tr>
            <th className="timesheet-sticky timesheet-summary-label" colSpan={5}>Итого по дням</th>
            {days.map((day) => {
              const workDate = dateForDay(month, day);
              const totals = dayTotals.get(workDate);
              return <td key={workDate} title={totals?.difference ? `Расхождение ОПР: ${totals.difference > 0 ? "+" : ""}${totals.difference} ч.` : ""}>{totals?.timesheet || ""}</td>;
            })}
            <th className="timesheet-total-column timesheet-tabell-total">{reconciliationTimesheet}</th>
            <th className="timesheet-total-column timesheet-report-total">{reconciliationReports}</th>
            <th className={`timesheet-total-column timesheet-difference-total ${reconciliationDifference ? "has-difference" : ""}`}>{reconciliationDifference > 0 ? "+" : ""}{reconciliationDifference}</th>
          </tr>
        </tfoot>
      </table>}
    </div>}

    {!error && !loading && <div className="personnel-timesheet-summary" aria-label={`Итоги за ${monthLabel(month)}`}><span className="personnel-timesheet-summary-label">Итоги за месяц</span><span><strong>{visibleEmployees.length}</strong> сотрудников</span><span><strong>{employeesWithReports}</strong> с отчётами</span><span className="productive"><strong>{reconciliationTimesheet} ч.</strong> по табелю</span><span className={reconciliationDifference === 0 ? "difference ok" : "difference warning"}><strong>{reconciliationDifference > 0 ? "+" : ""}{reconciliationDifference} ч.</strong> разница</span></div>}

    {codesOpen && <div className="equipment-reference-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCodesOpen(false); }}><section className="equipment-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="personnel-timesheet-reference-title">
      <header><div><span>ТАБЕЛЬ РАБОЧИХ</span><h2 id="personnel-timesheet-reference-title">Информация</h2><p>Цвета и обозначения, используемые в табеле.</p></div><button type="button" aria-label="Закрыть информацию" onClick={() => setCodesOpen(false)}>×</button></header>
      <div className="equipment-reference-section"><h3>Обозначения в таблице</h3><div className="equipment-reference-colors">
        <div><i className="work" /><div><strong>Часы из отчёта</strong><small>Данные, перенесённые из ежедневного отчёта рабочих.</small></div></div>
        <div><i className="manual" /><div><strong>Ручная отметка</strong><small>Значение изменено непосредственно в табеле.</small></div></div>
        <div><i className="idle" /><div><strong>Расхождение ОПР</strong><small>Для сотрудника ОПР табель отличается от сохранённого отчёта. Для остальных типов сотрудников это не считается ошибкой.</small></div></div>
      </div></div>
      <div className="equipment-reference-section"><h3>Табельные коды</h3><div className="equipment-reference-codes">{TIMESHEET_CODES.map((code) => <div key={code.value}><strong>{code.value}</strong><span>{code.label}</span></div>)}</div></div>
      <footer><button type="button" onClick={() => setCodesOpen(false)}>Понятно</button></footer>
    </section></div>}

    {editor && editingEmployee && <TimesheetCellPopover className="timesheet-mark-popover" anchor={editor.anchor} width={250} ariaLabel={`Выбор отметки: ${editingEmployee.fullName}, ${dateLabel(editor.workDate)}`} onClose={() => { if (!savingMark) closeEditorAndRestoreGridFocus(); }}>
      <TimesheetMarkList
        value={String(editingMark?.code ?? editingMark?.hours ?? "")}
        canReset={Boolean(editingMark)}
        disabled={savingMark}
        onClose={closeEditorAndRestoreGridFocus}
        onChoose={(value) => void saveMark(value === "", value)}
      />
      {editorError && <div className="timesheet-inline-error">{editorError}</div>}
    </TimesheetCellPopover>}
  </section>;
}
