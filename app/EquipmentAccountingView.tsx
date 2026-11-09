"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { accessibleProjectIds, hasRestrictedProjectAccess, type ProjectAccess, type UserRole } from "./roles";
import { userVisibleProjects } from "./userAccessModel";
import { useWorkspaceAccess } from "./TableAccessContext";
import { useNativeRowMoves, useWorkspaceTableOrder } from "./TableRowMoves";
import { useTableViewport } from "./useTableViewport";
import { NativeTimesheetPageScroll } from "./NativeTimesheetPageScroll";
import { formatTimesheetHours } from "./timesheetFormatting";
import { createPortal } from "react-dom";
import { EquipmentDailyAgGrid, EquipmentRegistryAgGrid, ProjectEquipmentAgGrid, type GridEquipmentDraft, type GridEquipmentEntry, type GridEquipmentRegistryDraft, type GridEquipmentUnit, type GridProjectEquipmentDraft } from "./LazyDataGrids";
import { workTypeChanges } from "./workTypeHierarchy";
import { CustomSelect } from "./CustomSelect";
import { ExcelActionsMenu } from "./ExcelActionsMenu";
import { openExcelExportPreview } from "./excelExportPreviewStore";
import { createEquipmentPlacementTemplateXlsx, createTableXlsx, parseEquipmentEntriesXlsx, parseEquipmentRegistryXlsx, type EquipmentPlacementExportRow } from "./placementXlsx";
import { downloadExcelFile, excelFileName, excelRowsInOrder } from "./excelFiles";
import { equipmentExcelName } from "./equipmentExcel";
import { TimesheetFilterableHeading, TimesheetFiltersProvider } from "./TimesheetColumnFilter";
import { useTimesheetFilters, type TimesheetFilterColumn } from "./useTimesheetFilters";
import { equipmentTimesheetDayPresets, equipmentTimesheetFilterValue, matchesEquipmentTimesheetDayPreset } from "./equipmentTimesheetFilters";
import { TimesheetCellPopover } from "./TimesheetCellPopover";
import { TimesheetMonthPicker as EquipmentMonthPicker } from "./TimesheetMonthPicker";
import { useTimesheetClipboard, type TimesheetClipboardChange, type TimesheetClipboardSaveContext } from "./useTimesheetClipboard";
import { PERSONNEL_TIMESHEET_CODES as EQUIPMENT_TIMESHEET_CODES } from "./personnelTimesheetValues";
import { useTimesheetBatchSave } from "./useTimesheetBatchSave";
import { TimesheetSaveStatus } from "./TimesheetSaveStatus";
import type { TimesheetSavedResult } from "./timesheetBatchSave";
import { equipmentUnavailableReason, isEquipmentUnavailable } from "./equipmentAvailability";
import { buildEquipmentCarryoverDrafts } from "./equipmentCarryover";
import { useConfirmationDialog } from "./useConfirmationDialog";
import { requestTimesheetMonthChange } from "./timesheetNavigation";
import { createIdlePageRefresh } from "./idlePageRefresh";
import { createImportOrderRank } from "./importOrderSorting";
import "./timesheetEmptyRows.css";
import { useNativeEmptyColumns } from "./useNativeEmptyColumns";
import { useTimesheetColumnResize } from "./useTimesheetColumnResize";
import { useNativeTimesheetColumnMenu } from "./useNativeTimesheetColumnMenu";
import { AdminGridFooter } from "./AdminGridFooter";
import { equipmentRegistryDraft, validateEquipmentAssignmentDrafts, validateEquipmentRegistryDrafts } from "./equipmentDirectorySpreadsheet";

type Option = { id: number; name: string; mainWorkTypeId?: number | null };
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
type EquipmentTimesheetSavedCell = {
  equipmentId: number;
  workDate: string;
  mark?: EquipmentTimesheetMark;
  change: TimesheetClipboardChange;
  undoValue: string;
  undoNote: string;
  context?: TimesheetClipboardSaveContext;
  viewScope?: string;
};
type EquipmentTimesheetEditor = {
  equipmentId: number;
  workDate: string;
  anchor: HTMLElement;
  mode: "list" | "advanced";
};
type EquipmentTimesheetInlineEditor = { session: number; equipmentId: number; workDate: string; rowIndex: number; columnIndex: number; value: string; error: string; selectAll: boolean };
type EquipmentTimesheetEditorMove = { row: number; column: number };
type EquipmentMonthCell = {
  productive: number;
  downtime: number;
  reportProductive: number;
  reportDowntime: number;
  mark?: EquipmentTimesheetMark;
  mismatch: boolean;
};
type EquipmentMonthRow = {
  unit: EquipmentUnit;
  byDate: Map<string, EquipmentMonthCell>;
  productive: number;
  downtime: number;
  total: number;
};
const equipmentMonthRowId = (row: EquipmentMonthRow) => String(row.unit.id);
type EquipmentForemanProgress = { foremanId: number; foremanName: string; status: "not_started" | "draft" | "submitted"; submittedAt: string | null; equipmentCount: number; rowCount: number; hours: number };
type EquipmentPayload = {
  siteId: number;
  siteName: string;
  workDate: string;
  month: string;
  canEditDaily: boolean;
  canCreateDaily: boolean;
  canUpdateDaily: boolean;
  canDeleteDaily: boolean;
  canEditTimesheet: boolean;
  canCreateTimesheet: boolean;
  canUpdateTimesheet: boolean;
  canDeleteTimesheet: boolean;
  canManageRegistry: boolean;
  canCreateRegistry: boolean;
  canUpdateRegistry: boolean;
  canDeleteRegistry: boolean;
  canManageAssignments: boolean;
  canCreateAssignments: boolean;
  canUpdateAssignments: boolean;
  canDeleteAssignments: boolean;
  currentUserRole: UserRole;
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
type EquipmentDeleteTarget = "daily" | "registry" | "project";
export type EquipmentSection = "daily" | "month" | "registry" | "project";

const MONTH_FORMATTER = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
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

function EquipmentTimesheetMarkList({ value, canReset, canWrite, disabled, onChoose, onClose }: {
  value: string;
  canReset: boolean;
  canWrite: boolean;
  disabled: boolean;
  onChoose: (value: string) => void;
  onClose: () => void;
}) {
  const options = useMemo(() => [
    ...(canWrite ? EQUIPMENT_MARK_OPTIONS : []),
    ...(canReset ? [{ value: "", label: "Вернуть значение из отчёта", group: "reset" as const }] : []),
  ], [canReset, canWrite]);
  const optionEnabled = (option: typeof options[number]) => canWrite || option.group === "reset";
  const selectedIndex = options.findIndex((option) => optionEnabled(option) && option.value === value);
  const initialIndex = Math.max(0, selectedIndex >= 0 ? selectedIndex : options.findIndex(optionEnabled));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const optionButtons = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => optionButtons.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  function moveActive(offset: number) {
    setActiveIndex((current) => {
      let next = current;
      for (let index = 0; index < options.length; index += 1) {
        next = (next + offset + options.length) % options.length;
        if (optionEnabled(options[next])) return next;
      }
      return current;
    });
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
        disabled={disabled || (!canWrite && option.group !== "reset")}
        tabIndex={activeIndex === index ? 0 : -1}
        onMouseEnter={() => { if (optionEnabled(option)) setActiveIndex(index); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const enabledIndex = event.key === "Home" ? options.findIndex(optionEnabled) : options.findLastIndex(optionEnabled);
            if (enabledIndex >= 0) setActiveIndex(enabledIndex);
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

function EquipmentDeleteConfirmation({ title, description, saving, onCancel, onConfirm }: { title: string; description: string; saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      <p>{description}</p>
      <div>
        <button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>Отмена</button>
        <button type="button" className="delete-rows-button" onClick={onConfirm} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button>
      </div>
    </section>
  </div>;
}

export function EquipmentAccountingView({ siteId, initialDate, initialMonth, today, mode, currentUserId, currentUserRole, currentUserProjectAccess, onDateChange, onMonthChange, onDirtyChange, onBusyChange }: { siteId: number; initialDate: string; initialMonth?: string; today: string; mode: EquipmentSection; currentUserId?: number; currentUserRole?: UserRole; currentUserProjectAccess?: ProjectAccess; onDateChange?: (date: string) => void; onMonthChange?: (month: string) => void; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const { confirm: confirmMonthChange, dialog: monthChangeDialog } = useConfirmationDialog();
  const section = mode;
  const [workDate, setWorkDate] = useState(initialDate);
  const [reportRangeEnd, setReportRangeEnd] = useState(initialDate);
  const [month, setMonth] = useState(initialMonth ?? initialDate.slice(0, 7));
  const access = useWorkspaceAccess();
  const [loadedPayload, setPayload] = useState<EquipmentPayload | null>(null);
  const payload = useMemo(() => {
    if (!loadedPayload || currentUserRole && loadedPayload.currentUserRole !== currentUserRole) return null;
    const actorRole = currentUserRole ?? loadedPayload.currentUserRole;
    const actor = { role: actorRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess };
    const scopedPayload = { ...loadedPayload, currentUserRole: actorRole, sites: userVisibleProjects(actor, loadedPayload.sites) };
    if (!access) return scopedPayload;
    const capabilities = section === "daily" ? { canCreateDaily: access.create, canUpdateDaily: access.update, canDeleteDaily: access.delete, canEditDaily: access.select }
      : section === "month" ? { canCreateTimesheet: access.create, canUpdateTimesheet: access.update, canDeleteTimesheet: access.delete, canEditTimesheet: access.select }
        : section === "registry" ? { canCreateRegistry: access.create, canUpdateRegistry: access.update, canDeleteRegistry: access.delete, canManageRegistry: access.select }
          : { canCreateAssignments: access.create, canUpdateAssignments: access.update, canDeleteAssignments: access.delete, canManageAssignments: access.select };
    return { ...scopedPayload, ...capabilities };
  }, [loadedPayload, access, section, currentUserRole, currentUserProjectAccess, siteId]);
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
  const [visibleDailyEntryIds, setVisibleDailyEntryIds] = useState<number[] | null>(null);
  const [visibleProjectUnitIds, setVisibleProjectUnitIds] = useState<number[] | null>(null);
  const [visibleUnitIds, setVisibleUnitIds] = useState<number[] | null>(null);
  const [projectUnitDrafts, setProjectUnitDrafts] = useState<ProjectUnitDraft[]>([]);
  const [selectedProjectUnitIds, setSelectedProjectUnitIds] = useState<number[]>([]);
  const [deleteConfirmationTarget, setDeleteConfirmationTarget] = useState<EquipmentDeleteTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [timesheetEditor, setTimesheetEditor] = useState<EquipmentTimesheetEditor | null>(null);
  const [timesheetInlineEditor, setTimesheetInlineEditor] = useState<EquipmentTimesheetInlineEditor | null>(null);
  const [timesheetProductive, setTimesheetProductive] = useState("0");
  const [timesheetDowntime, setTimesheetDowntime] = useState("0");
  const [timesheetNote, setTimesheetNote] = useState("");
  const [savingTimesheetMark, setSavingTimesheetMark] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [timesheetEditorError, setTimesheetEditorError] = useState("");
  const [timesheetInfoOpen, setTimesheetInfoOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const refreshControl = useRef<ReturnType<typeof createIdlePageRefresh> | null>(null);
  const refreshBusy = useRef(true);
  const markWrites = useRef(0);
  const markRevision = useRef(0);
  const activeScope = useRef(`${siteId}:${section}:${month}`);
  const activeScopeVersion = useRef(0);
  const batchSave = useTimesheetBatchSave<EquipmentTimesheetSavedCell>({
    scopeKey: `${siteId}:${section}:${month}`,
    onStart: () => { markWrites.current += 1; markRevision.current += 1; },
    onFinish: () => { markWrites.current -= 1; refreshControl.current?.flush(); },
    onSaved: applySavedEquipmentTimesheetCells,
  });
  const savingBulkTimesheetMarks = batchSave.busy;
  const dirty = Boolean(unitDrafts.length || unitFullRowEditIds.length || projectUnitDrafts.length || section === "daily" && entryDrafts.length || timesheetInlineEditor || timesheetEditor || batchSave.hasFailures);
  const navigationBusy = saving || importing || savingTimesheetMark || savingBulkTimesheetMarks;
  useLayoutEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => { onBusyChange?.(navigationBusy); return () => onBusyChange?.(false); }, [navigationBusy, onBusyChange]);
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dailyFileInput = useRef<HTMLInputElement>(null);
  const initializedCarryoverSession = useRef<string | null>(null);
  const timesheetInlineInput = useRef<HTMLInputElement>(null);
  const timesheetInlineSession = useRef(0);
  const timesheetInlineCancelPending = useRef(false);
  const timesheetInlineSaveInFlight = useRef<{ session: number; promise: Promise<boolean> } | null>(null);
  const timesheetInlineGridFocusPending = useRef(false);
  const timesheetInlineEquipmentId = timesheetInlineEditor?.equipmentId;
  const timesheetInlineWorkDate = timesheetInlineEditor?.workDate;
  const timesheetInlineSelectAll = timesheetInlineEditor?.selectAll ?? false;

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const recentDates = useMemo(() => recentDateKeys(reportRangeEnd), [reportRangeEnd]);

  useLayoutEffect(() => {
    const scope = `${siteId}:${section}:${month}`;
    if (activeScope.current !== scope) { activeScopeVersion.current += 1; timesheetInlineSession.current++; }
    activeScope.current = scope;
    refreshBusy.current = Boolean(section !== "month" || timesheetEditor || timesheetInlineEditor || navigationBusy || loading);
    refreshControl.current?.flush();
  }, [loading, month, navigationBusy, section, siteId, timesheetEditor, timesheetInlineEditor]);

  useEffect(() => {
    const targetId = section === "daily" ? "equipment-report-actions" : section === "registry" ? "equipment-registry-actions" : section === "project" ? "project-equipment-actions" : section === "month" ? "equipment-timesheet-actions" : "";
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
    timesheetInlineSession.current++;
    timesheetInlineCancelPending.current = true;
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
      setRefreshError("");
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
      .then((result) => { if (result && !controller.signal.aborted) setPayload(result); })
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
  }, [month, recentDates, reloadKey, reportRangeEnd, section, siteId, workDate, currentUserRole, currentUserProjectAccess]);

  useEffect(() => {
    if (section !== "month") return;
    const controller = new AbortController();
    const isBusy = () => refreshBusy.current || markWrites.current > 0;
    const control = createIdlePageRefresh({ pageWindow: window, pageDocument: document, isBusy, refresh: async () => {
      const revision = markRevision.current;
      try {
        const response = await fetch(`/api/equipment?siteId=${siteId}&date=${workDate}&month=${month}&scope=project&view=timesheet&section=month`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { window.location.replace("/login"); return; }
        const result = await response.json() as EquipmentPayload;
        if (controller.signal.aborted) return;
        if (response.status === 403 || response.status === 404) {
          setPayload(null);
          setError(result.error ?? "Нет доступа к табелю техники этого проекта.");
          return;
        }
        if (!response.ok) throw new Error(result.error ?? "Не удалось обновить табель техники.");
        if (isBusy() || markRevision.current !== revision) { control.request(); return; }
        setPayload(result);
        setError("");
        setRefreshError("");
      } catch (failure) {
        if (!controller.signal.aborted) setRefreshError(failure instanceof Error ? failure.message : "Не удалось обновить табель техники.");
      }
    } });
    refreshControl.current = control;
    return () => { controller.abort(); control.dispose(); if (refreshControl.current === control) refreshControl.current = null; };
  }, [currentUserProjectAccess, currentUserRole, month, reloadKey, section, siteId, workDate]);

  useEffect(() => {
    if (section !== "daily" || workDate !== today || payload?.workDate !== workDate || payload.currentUserRole !== "foreman" || !payload.canCreateDaily) return;
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
  }, [month, payload?.canCreateDaily, payload?.currentUserRole, payload?.reportSubmitted, payload?.workDate, section, siteId, today, workDate]);

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
    onDateChange?.(next);
    setEntryDrafts([]);
    setSelectedEntryIds([]);
    setSelectedEntryDraftKeys([]);
    setPreviousDayReport(null);
  }

  function changeReportRange(nextEnd: string) {
    setReportRangeEnd(nextEnd > today ? today : nextEnd);
  }

  async function changeMonth(nextMonth: string) {
    await requestTimesheetMonthChange({
      currentMonth: month,
      nextMonth,
      busy: navigationBusy,
      hasPendingEditor: Boolean(timesheetInlineEditor || timesheetEditor || batchSave.hasFailures),
      confirmDiscard: () => confirmMonthChange({ title: "Сменить месяц без сохранения?", description: "В табеле есть несохранённые изменения. При смене месяца они будут отменены, включая ячейки с ошибкой сохранения.", confirmLabel: "Сменить без сохранения" }),
      commit: (confirmedMonth) => {
        setMonth(confirmedMonth);
        onMonthChange?.(confirmedMonth);
      },
    });
  }

  function openEntry(entry?: EquipmentEntry, changes: Partial<EntryDraft> = {}) {
    if (!payload || (entry ? !payload.canUpdateDaily : !payload.canCreateDaily)) return;
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
    setEntryDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...workTypeChanges(draft, changes, payload?.subworkTypes ?? []) } : draft));
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
    if (entryDrafts.some((draft) => draft.id ? !payload?.canUpdateDaily : !payload?.canCreateDaily)) {
      setError(entryDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования строк отчёта техники." : "Недостаточно прав для добавления строк отчёта техники.");
      return;
    }
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
      if (payload?.canUpdateDaily) await post({ action: "submit-daily-report", workDate });
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
    if (!payload?.canDeleteDaily) return;
    if (!selectedEntryIds.length) return;
    setSaving(true);
    setError("");
    try {
      await Promise.all(selectedEntryIds.map((id) => post({ action: "delete-entry", id })));
      setSelectedEntryIds([]);
      setDeleteConfirmationTarget(null);
      setNotice("Выбранные строки удалены.");
      reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить выбранные строки.");
    } finally {
      setSaving(false);
    }
  }

  function openUnit(unit: EquipmentUnit, changes: Partial<UnitDraft> = {}) {
    if (!payload?.canUpdateRegistry) return;
    setUnitDrafts((current) => {
      const existing = current.find((draft) => draft.id === unit.id);
      if (existing) return current.map((draft) => draft.id === unit.id ? { ...draft, ...changes } : draft);
      return [...current, { ...equipmentRegistryDraft(unit), ...changes }];
    });
    setNotice("");
  }

  function patchUnitDraft(key: string, changes: Partial<UnitDraft>) {
    setUnitDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }

  function editSelectedUnits() {
    if (!payload?.canUpdateRegistry) return;
    const selected = (payload?.units ?? []).filter((unit) => selectedUnitIds.includes(unit.id));
    setUnitDrafts(current => [...current, ...selected.filter(unit => !current.some(draft => draft.id === unit.id)).map(equipmentRegistryDraft)]);
    setUnitFullRowEditIds(current => [...new Set([...current, ...selected.map(unit => unit.id)])]);
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
    if (loading || saving || importing) return;
    if (!unitDrafts.length) return;
    if (unitDrafts.some((draft) => draft.id ? !payload?.canUpdateRegistry : !payload?.canCreateRegistry)) {
      setError(unitDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования реестра техники." : "Недостаточно прав для добавления техники в реестр.");
      return;
    }
    try {
      validateEquipmentRegistryDrafts(unitDrafts, payload?.units ?? [], { sites: payload?.sites ?? [], requiredSiteId: payload ? accessibleProjectIds({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess }) ?? undefined : undefined }, undefined, true);
    } catch (validationError) { setError(validationError instanceof Error ? validationError.message : "Проверьте заполнение реестра техники."); return; }
    setSaving(true);
    setError("");
    try {
      for (const draft of unitDrafts) {
        await post({ action: "save-unit", ...draft });
        // A later row can fail. Do not replay already acknowledged creates on
        // retry (especially for users who can create but cannot update units).
        setUnitDrafts(current => current.filter(item => item.key !== draft.key));
        if (draft.id) setUnitFullRowEditIds(current => current.filter(id => id !== draft.id));
      }
      const added = unitDrafts.filter((draft) => !draft.id).length;
      const updated = unitDrafts.length - added;
      setUnitDrafts([]);
      setUnitFullRowEditIds([]);
      setVisibleUnitIds(null);
      setNotice([added ? `Добавлено: ${added}` : "", updated ? `обновлено: ${updated}` : ""].filter(Boolean).join(", ") + ".");
      reload();
    } catch (saveError) {
      // Re-read confirmed server state while retaining every unsaved draft.
      // A failed refresh must not hide the original save error or clear input.
      try {
        const response = await fetch(`/api/equipment?siteId=${siteId}&date=${workDate}&month=${month}&scope=global&view=registry&section=registry`, { cache: "no-store" });
        if (response.status === 401) window.location.replace("/login");
        else if (response.ok) {
          setPayload(await response.json() as EquipmentPayload);
          setVisibleUnitIds(null);
        }
      } catch { /* Keep the last readable snapshot and the failed drafts. */ }
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить технику.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedUnits() {
    if (!payload?.canDeleteRegistry) return;
    if (!selectedUnitIds.length) return;
    setSaving(true);
    setError("");
    try {
      for (const id of selectedUnitIds) await post({ action: "delete-unit", id });
      setSelectedUnitIds([]);
      setDeleteConfirmationTarget(null);
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
    if (!payload?.canCreateAssignments) return;
    if (!projectUnitDrafts.length) return;
    try { validateEquipmentAssignmentDrafts(projectUnitDrafts, payload.availableUnits, payload.units, undefined, true); }
    catch (validationError) { setError(validationError instanceof Error ? validationError.message : "Проверьте выбранную технику."); return; }
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
    if (!payload?.canDeleteAssignments) return;
    if (!selectedProjectUnitIds.length) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      for (const equipmentId of selectedProjectUnitIds) await post({ action: "remove-unit-project", equipmentId });
      const count = selectedProjectUnitIds.length;
      setSelectedProjectUnitIds([]);
      setDeleteConfirmationTarget(null);
      setNotice(`Убрано техники из проекта: ${count}.`);
      reload();
    } catch (assignmentError) {
      setError(assignmentError instanceof Error ? assignmentError.message : "Не удалось изменить состав техники проекта.");
    } finally {
      setSaving(false);
    }
  }

  function requireSavedExcelRows(pending: number) {
    if (!pending && !saving && !importing) return true;
    setError("Сначала сохраните или отмените изменения в таблице и дождитесь завершения операции, затем повторите действие с Excel.");
    return false;
  }

  async function importRegistry(file: File) {
    if (!payload || hasRestrictedProjectAccess({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess })) return;
    setImporting(true);
    setError("");
    setNotice("");
    try {
      if (!requireSavedExcelRows(unitDrafts.length + unitFullRowEditIds.length)) return;
      const units = await parseEquipmentRegistryXlsx(file);
      if (!units.length) throw new Error("В файле нет заполненных строк реестра техники.");
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
      if (!requireSavedExcelRows(entryDrafts.length)) return;
      const entries = await parseEquipmentEntriesXlsx(file);
      if (!entries.length) throw new Error("В файле нет заполненных строк отчёта техники.");
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
  const dailyExportHeaders = ["Дата", "Уникальное наименование единицы", "Смена", "Зона", "Вид работы", "Подвид работы", "Примечание", "Часы"];
  const dailyExportEntries = useMemo(() => excelRowsInOrder(dailyEntries, visibleDailyEntryIds), [dailyEntries, visibleDailyEntryIds]);
  const dailyExportWorkbookRows = useMemo<EquipmentPlacementExportRow[]>(() => dailyExportEntries.map((entry) => ({
    workDate: entry.workDate,
    equipmentName: equipmentExcelName(entry),
    shiftName: entry.shiftName,
    zoneName: entry.zoneName,
    mainWorkTypeName: entry.mainWorkTypeName,
    subworkTypeName: entry.subworkTypeName,
    note: entry.note,
    hours: entry.hours,
  })), [dailyExportEntries]);
  const dailyExportRows = useMemo(() => dailyExportWorkbookRows.map((entry) => [entry.workDate, entry.equipmentName, entry.shiftName, entry.zoneName, entry.mainWorkTypeName, entry.subworkTypeName, entry.note, entry.hours]), [dailyExportWorkbookRows]);
  const dailyExportFileName = excelFileName("Отчёт техники", [payload?.siteName, workDate]);
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
    && payload.currentUserRole === "foreman" && payload.canCreateDaily;
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

  const rowOrder = useWorkspaceTableOrder();
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
  const unfilteredMonthRows = useMemo<EquipmentMonthRow[]>(() => monthUnits.map((unit) => {
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
    }), [month, monthDays, monthReportByCell, monthUnits, timesheetMarksByCell]);
  const orderedMonthRows = useMemo(() => rowOrder?.order(unfilteredMonthRows, row => row.unit.id) ?? unfilteredMonthRows, [rowOrder, unfilteredMonthRows]);
  const monthFilterColumns = useMemo<readonly TimesheetFilterColumn<EquipmentMonthRow>[]>(() => [
    { colId: "equipment", headerName: "Техника", getValue: row => unitTitle(row.unit) },
    { colId: "organization", headerName: "Организация", getValue: row => row.unit.organization },
    ...monthDays.map(day => {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      return {
        colId: date, headerName: fullDate(date), kind: "number" as const,
        getValue: (row: EquipmentMonthRow) => equipmentTimesheetFilterValue(row.byDate.get(date)),
        presets: equipmentTimesheetDayPresets.map(preset => ({ ...preset, matches: (row: EquipmentMonthRow) => matchesEquipmentTimesheetDayPreset(preset.value, row.byDate.get(date)) })),
      };
    }),
    { colId: "productive", headerName: "Работа", kind: "number", getValue: row => row.productive },
    { colId: "downtime", headerName: "Простой", kind: "number", getValue: row => row.downtime },
    { colId: "total", headerName: "Всего", kind: "number", getValue: row => row.total },
  ], [month, monthDays]);
  const monthImportRank = useMemo(() => createImportOrderRank(unfilteredMonthRows, rowOrder?.importIds ?? [], row => row.unit.id), [unfilteredMonthRows, rowOrder?.importIds]);
  const monthFilters = useTimesheetFilters({ rows: orderedMonthRows, columns: monthFilterColumns, getRowId: equipmentMonthRowId, resetKey: `equipment:${siteId}:${month}`, presentation: "checklist", includeConditions: false, importOrder: {
    rank: monthImportRank, activation: rowOrder?.importOrderRevision ?? 0, ready: rowOrder?.ready ?? false, defaultSort: Boolean(rowOrder?.hasImportOrder && !rowOrder.hasSavedOrder),
  } });
  // Filter units by each day's value without collapsing the other month columns.
  const visibleMonthDays = monthDays;
  const visibleDaysKey = visibleMonthDays.join("|");
  const monthRows = monthFilters.rows;

  const registryUnits = payload?.units ?? [];
  const monthSummary = useMemo(() => monthRows.reduce((summary, row) => ({ productive: summary.productive + row.productive, downtime: summary.downtime + row.downtime, total: summary.total + row.total }), { productive: 0, downtime: 0, total: 0 }), [monthRows]);
  const monthRowMoves = useNativeRowMoves(rowOrder, monthFilters.isActive, Boolean(timesheetEditor || timesheetInlineEditor || navigationBusy || loading || section !== "month"), { key: `${siteId}:${month}`, ids: monthRows.map(row => row.unit.id) });
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
  const referencesReady = Boolean(payload?.units.length && payload.shifts.length && payload.zones.length && payload.mainWorkTypes.length && payload.subworkTypes.some(child => payload.mainWorkTypes.some(parent => child.mainWorkTypeId === parent.id)));
  const monthRowOrderKey = useMemo(() => `${siteId}:${section}:${month}:${monthRows.map((row) => row.unit.id).join("|")}:days=${visibleDaysKey}`, [siteId, section, month, monthRows, visibleDaysKey]);
  const clipboardViewScope = useRef(monthRowOrderKey);
  useLayoutEffect(() => { clipboardViewScope.current = monthRowOrderKey; }, [monthRowOrderKey]);
  const pinnedEquipmentId = timesheetInlineEditor?.equipmentId ?? timesheetEditor?.equipmentId;
  const monthViewport = useTableViewport(monthRows.length, monthRowOrderKey, section === "month" && !loading,
    pinnedEquipmentId === undefined ? undefined : monthRows.findIndex((row) => row.unit.id === pinnedEquipmentId));
  const monthColumnResize = useTimesheetColumnResize(monthViewport.shellRef, {
    kind: "equipment", dayCount: monthDays.length, dayNumbers: visibleMonthDays, enabled: section === "month" && Boolean(payload),
  });
  const monthClipboardColumnIndexes = monthColumnResize.columnIds.map(id => ({ number: -3, equipment: -2, organization: -1, productive: visibleMonthDays.length, downtime: visibleMonthDays.length + 1, total: visibleMonthDays.length + 2 }[id] ?? visibleMonthDays.indexOf(Number(id.slice(4)))));
  const {
    shellRef: timesheetClipboardShellRef,
    status: timesheetClipboardStatus,
    cellClass: timesheetClipboardCellClass,
    cellHandlers: timesheetClipboardCellHandlers,
    shellHandlers: timesheetClipboardShellHandlers,
    rememberUndo: rememberEquipmentTimesheetUndo,
    activeCell: timesheetClipboardActiveCell,
    headersSelected: timesheetClipboardHeadersSelected,
    focusCell: focusEquipmentTimesheetCell,
    contextMenu: timesheetClipboardContextMenu,
    forgetUndo: forgetEquipmentTimesheetUndo,
    notify: notifyEquipmentTimesheetClipboard,
  } = useTimesheetClipboard({
    hasSelectedRows: monthRowMoves.hasSelection,
    onClearRowSelection: monthRowMoves.clearSelection,
    escapeBlocked: Boolean(timesheetEditor || timesheetInlineEditor || monthFilters.context.openColumnId),
    shellRef: monthViewport.shellRef,
    ensureRowVisible: monthViewport.ensureRowVisible,
    getContextActions: (rowIndex, close) => { const row = monthRows[rowIndex]; return row ? monthRowMoves.getActions(row.unit.id, close) : []; },
    rowCount: monthRows.length,
    columnCount: visibleMonthDays.length,
    columnIndexes: monthClipboardColumnIndexes,
    resetKey: `${monthRowOrderKey}:columns=${monthClipboardColumnIndexes.join(",")}`,
    getHeader: columnIndex => {
      const label = { [-3]: "№", [-2]: "Техника", [-1]: "Организация", [visibleMonthDays.length]: "Работа", [visibleMonthDays.length + 1]: "Простой", [visibleMonthDays.length + 2]: "Всего" }[columnIndex];
      return label ?? `${String(visibleMonthDays[columnIndex]).padStart(2, "0")}.${month.slice(5, 7)}.${month.slice(0, 4)}`;
    },
    getValue: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      if (!row) return "";
      if (columnIndex === -3) return String(rowIndex + 1);
      if (columnIndex === -2) return unitTitle(row.unit);
      if (columnIndex === -1) return row.unit.organization || "";
      if (columnIndex >= visibleMonthDays.length) return String([row.productive, row.downtime, row.total][columnIndex - visibleMonthDays.length] || "—");
      const day = visibleMonthDays[columnIndex];
      if (!day) return "";
      const value = row.byDate.get(`${month}-${String(day).padStart(2, "0")}`);
      if (!value) return "";
      return formatEquipmentHours(value.productive, value.downtime);
    },
    getUndoValue: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = visibleMonthDays[columnIndex];
      if (!row || !day) return "";
      const mark = timesheetMarksByCell.get(equipmentCellKey(row.unit.id, `${month}-${String(day).padStart(2, "0")}`));
      if (!mark) return "";
      return formatEquipmentHours(mark.productiveHours, mark.downtimeHours);
    },
    getUndoNote: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = visibleMonthDays[columnIndex];
      if (!row || !day) return "";
      return timesheetMarksByCell.get(equipmentCellKey(row.unit.id, `${month}-${String(day).padStart(2, "0")}`))?.note ?? "";
    },
    canPaste: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = visibleMonthDays[columnIndex];
      if (!payload || !row || !day || navigationBusy || loading) return false;
      const workDate = `${month}-${String(day).padStart(2, "0")}`;
      const existingMark = timesheetMarksByCell.has(equipmentCellKey(row.unit.id, workDate));
      return existingMark ? payload.canUpdateTimesheet || payload.canDeleteTimesheet : payload.canCreateTimesheet;
    },
    onPaste: pasteEquipmentTimesheetCells,
    canDelete: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = visibleMonthDays[columnIndex];
      if (!payload?.canDeleteTimesheet || !row || !day || navigationBusy || loading) return false;
      const workDate = `${month}-${String(day).padStart(2, "0")}`;
      const key = equipmentCellKey(row.unit.id, workDate);
      return timesheetMarksByCell.has(key) || batchSave.getCellState(key)?.state === "error";
    },
    onDelete: pasteEquipmentTimesheetCells,
    onActivate: (rowIndex, columnIndex) => {
      const row = monthRows[rowIndex];
      const day = visibleMonthDays[columnIndex];
      if (row && day) openTimesheetInlineEditor(row.unit.id, `${month}-${String(day).padStart(2, "0")}`, rowIndex, columnIndex);
    },
    onType: (rowIndex, columnIndex, _anchor, value) => {
      void _anchor;
      const row = monthRows[rowIndex];
      const day = visibleMonthDays[columnIndex];
      if (row && day) openTimesheetInlineEditor(row.unit.id, `${month}-${String(day).padStart(2, "0")}`, rowIndex, columnIndex, value);
    },
  });

  useNativeEmptyColumns(timesheetClipboardShellRef, section === "month" && Boolean(payload));
  const timesheetColumnContextMenu = useNativeTimesheetColumnMenu(timesheetClipboardShellRef, {
    month, scope: `equipment:${siteId}:${month}`, enabled: section === "month" && Boolean(payload) && !loading, columns: monthFilters.columnActions, widths: monthColumnResize.headerActions,
  });
  useEffect(() => {
    if (timesheetInlineEditor || !timesheetInlineGridFocusPending.current) return;
    const frame = requestAnimationFrame(() => {
      timesheetInlineGridFocusPending.current = false;
      timesheetClipboardShellRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [timesheetClipboardShellRef, timesheetInlineEditor]);

  async function openTimesheetEditor(equipmentId: number, editorWorkDate: string, anchor: HTMLElement) {
    if (savingBulkTimesheetMarks || loading) return;
    const existingMark = timesheetMarksByCell.has(equipmentCellKey(equipmentId, editorWorkDate));
    if (!payload || (existingMark ? !payload.canUpdateTimesheet && !payload.canDeleteTimesheet : !payload.canCreateTimesheet)) return;
    if (timesheetEditor?.equipmentId === equipmentId && timesheetEditor.workDate === editorWorkDate) {
      if (!savingTimesheetMark) closeTimesheetEditorAndRestoreFocus();
      return;
    }
    if (savingTimesheetMark && !timesheetInlineSaveInFlight.current) return;
    const previousSession = timesheetInlineSession.current;
    const previousViewScope = clipboardViewScope.current;
    if (timesheetInlineEditor && !await saveTimesheetInlineValue(undefined, false)) {
      timesheetInlineInput.current?.focus({ preventScroll: true });
      return;
    }
    if (timesheetInlineSession.current !== previousSession || clipboardViewScope.current !== previousViewScope) return;
    timesheetInlineSession.current++;
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

  async function openTimesheetInlineEditor(equipmentId: number, editorWorkDate: string, rowIndex: number, columnIndex: number, typedValue?: string) {
    if (savingBulkTimesheetMarks || loading) return;
    const existingMark = timesheetMarksByCell.has(equipmentCellKey(equipmentId, editorWorkDate));
    if (!payload || (existingMark ? !payload.canUpdateTimesheet : !payload.canCreateTimesheet)) return;
    if (savingTimesheetMark && !timesheetInlineSaveInFlight.current) return;
    if (timesheetInlineEditor?.equipmentId === equipmentId && timesheetInlineEditor.workDate === editorWorkDate) {
      timesheetInlineInput.current?.focus({ preventScroll: true });
      return;
    }
    const previousSession = timesheetInlineSession.current;
    const previousViewScope = clipboardViewScope.current;
    if (timesheetInlineEditor && !await saveTimesheetInlineValue(undefined, false)) {
      timesheetInlineInput.current?.focus({ preventScroll: true });
      return;
    }
    if (timesheetInlineSession.current !== previousSession || clipboardViewScope.current !== previousViewScope) return;
    const row = monthRows.find((item) => item.unit.id === equipmentId);
    const value = row?.byDate.get(editorWorkDate);
    timesheetInlineCancelPending.current = false;
    setTimesheetEditor(null);
    setTimesheetInlineEditor({
      session: ++timesheetInlineSession.current,
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
    if (savingBulkTimesheetMarks) throw new Error("Дождитесь завершения сохранения ячеек.");
    const requestScope = `${payload.siteId}:month:${payload.month}`;
    const requestScopeVersion = activeScopeVersion.current;
    if (activeScope.current !== requestScope || target.workDate.slice(0, 7) !== payload.month) throw new Error("Табель обновляется. Дождитесь загрузки выбранного месяца.");
    const existingMark = timesheetMarksByCell.has(equipmentCellKey(target.equipmentId, target.workDate));
    if (value.clear && !existingMark && batchSave.getCellState(equipmentCellKey(target.equipmentId, target.workDate))?.state !== "error") return true;
    if (value.clear && !payload.canDeleteTimesheet) throw new Error("Недостаточно прав для удаления отметки табеля техники.");
    if (!value.clear && existingMark && !payload.canUpdateTimesheet) throw new Error("Недостаточно прав для изменения отметки табеля техники.");
    if (!value.clear && !existingMark && !payload.canCreateTimesheet) throw new Error("Недостаточно прав для добавления отметки табеля техники.");
    markWrites.current += 1;
    markRevision.current += 1;
    setSavingTimesheetMark(true);
    const previousMark = timesheetMarksByCell.get(equipmentCellKey(target.equipmentId, target.workDate));
    const undoRowIndex = monthRows.findIndex((row) => row.unit.id === target.equipmentId);
    const undoColumnIndex = visibleMonthDays.indexOf(Number(target.workDate.slice(8, 10)));
    const undoViewScope = clipboardViewScope.current;
    try {
      const result = await post({
        siteId: payload.siteId,
        action: "save-timesheet-mark",
        equipmentId: target.equipmentId,
        workDate: target.workDate,
        ...(value.clear ? { clear: true } : { productiveHours: value.productiveHours, downtimeHours: value.downtimeHours, note: value.note }),
      });
      if (activeScope.current !== requestScope || activeScopeVersion.current !== requestScopeVersion) return false;
      setPayload((current) => current && activeScopeVersion.current === requestScopeVersion && current.siteId === payload.siteId && current.month === payload.month ? {
        ...current,
        marks: [
          ...current.marks.filter((mark) => equipmentCellKey(mark.equipmentId, mark.workDate) !== equipmentCellKey(target.equipmentId, target.workDate)),
          ...(result.mark ? [result.mark] : []),
        ],
      } : current);
      batchSave.clearCell(equipmentCellKey(target.equipmentId, target.workDate));
      if (clipboardViewScope.current === undoViewScope && undoRowIndex >= 0 && undoColumnIndex >= 0) rememberEquipmentTimesheetUndo([{ rowIndex: undoRowIndex, columnIndex: undoColumnIndex, value: previousMark ? formatEquipmentHours(previousMark.productiveHours, previousMark.downtimeHours) : "", note: previousMark?.note ?? "" }]);
      return true;
    } finally {
      markWrites.current -= 1;
      setSavingTimesheetMark(false);
      refreshControl.current?.flush();
    }
  }

  async function saveTimesheetMark(clear = false) {
    if (!timesheetEditor || !payload || (!clear && !timesheetValueValid)) return;
    const editorScope = activeScope.current;
    const editorScopeVersion = activeScopeVersion.current;
    setTimesheetEditorError("");
    try {
      if (!await persistEquipmentTimesheetMark(timesheetEditor, { clear, productiveHours, downtimeHours, note: timesheetNote })) return;
      closeTimesheetEditorAndRestoreFocus();
    } catch (saveError) {
      if (activeScope.current !== editorScope || activeScopeVersion.current !== editorScopeVersion) return;
      setTimesheetEditorError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку табеля.");
    }
  }

  async function saveTimesheetListValue(rawValue: string) {
    if (!timesheetEditor) return;
    const editorScope = activeScope.current;
    const editorScopeVersion = activeScopeVersion.current;
    setTimesheetEditorError("");
    try {
      const parsed = parseEquipmentClipboardHours(rawValue);
      if (!await persistEquipmentTimesheetMark(timesheetEditor, { ...parsed, note: editingTimesheetMark?.note ?? "" })) return;
      closeTimesheetEditorAndRestoreFocus();
    } catch (saveError) {
      if (activeScope.current !== editorScope || activeScopeVersion.current !== editorScopeVersion) return;
      setTimesheetEditorError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку табеля.");
    }
  }

  async function saveTimesheetInlineValue(valueOverride?: string, returnFocus = true, move?: EquipmentTimesheetEditorMove): Promise<boolean> {
    const target = timesheetInlineEditor;
    if (!target || timesheetInlineCancelPending.current || target.session !== timesheetInlineSession.current) return false;
    const pending = timesheetInlineSaveInFlight.current;
    if (pending) return pending.session === target.session ? pending.promise : false;
    const editorViewScope = clipboardViewScope.current;
    const editorScope = activeScope.current;
    const editorScopeVersion = activeScopeVersion.current;
    const normalizedValue = (valueOverride ?? target.value).trim().toLocaleUpperCase("ru-RU");
    let parsed: ReturnType<typeof parseEquipmentClipboardHours>;
    try {
      parsed = parseEquipmentClipboardHours(normalizedValue);
    } catch (validationError) {
      if (move) notifyEquipmentTimesheetClipboard("Изменение не сохранено: допустимы часы работы, «П 2» для простоя или «8/2» для работы и простоя");
      setTimesheetInlineEditor((current) => current?.session === target.session ? { ...current, value: normalizedValue, error: validationError instanceof Error ? validationError.message : "Недопустимое значение" } : current);
      return false;
    }
    const promise = (async () => {
      try {
        const mark = timesheetMarksByCell.get(equipmentCellKey(target.equipmentId, target.workDate));
        if (!await persistEquipmentTimesheetMark(target, { ...parsed, note: mark?.note ?? "" })) return false;
        if (timesheetInlineSession.current !== target.session) return false;
        if (returnFocus && clipboardViewScope.current === editorViewScope) timesheetInlineGridFocusPending.current = true;
        setTimesheetInlineEditor((current) => current?.session === target.session ? null : current);
        if (move && clipboardViewScope.current === editorViewScope) focusEquipmentTimesheetCell(target.rowIndex + move.row, target.columnIndex + move.column);
        return true;
      } catch (saveError) {
        if (activeScope.current !== editorScope || activeScopeVersion.current !== editorScopeVersion || timesheetInlineSession.current !== target.session) return false;
        setTimesheetInlineEditor((current) => current?.session === target.session ? { ...current, value: normalizedValue, error: saveError instanceof Error ? saveError.message : "Не удалось сохранить отметку табеля" } : current);
        return false;
      }
    })();
    const operation = { session: target.session, promise };
    timesheetInlineSaveInFlight.current = operation;
    void promise.finally(() => { if (timesheetInlineSaveInFlight.current === operation) timesheetInlineSaveInFlight.current = null; });
    return promise;
  }

  function applySavedEquipmentTimesheetCells(saved: TimesheetSavedResult<EquipmentTimesheetSavedCell>[], retry: boolean) {
    const changedKeys = new Set(saved.map(({ job }) => job.key));
    setPayload(current => current && current.siteId === siteId && current.month === month ? {
      ...current,
      marks: [
        ...current.marks.filter(mark => !changedKeys.has(equipmentCellKey(mark.equipmentId, mark.workDate))),
        ...saved.flatMap(({ value }) => value.mark ? [value.mark] : []),
      ],
    } : current);
    if (!retry) return;
    for (const { value } of saved) {
      if (value.viewScope !== undefined && value.viewScope !== clipboardViewScope.current) continue;
      const rowIndex = monthRows.findIndex(row => row.unit.id === value.equipmentId);
      const columnIndex = visibleMonthDays.indexOf(Number(value.workDate.slice(8, 10)));
      if (value.context?.operation === "undo") {
        forgetEquipmentTimesheetUndo(value.context.historyId, [value.change]);
      } else if (rowIndex >= 0 && columnIndex >= 0) {
        rememberEquipmentTimesheetUndo([{ rowIndex, columnIndex, value: value.undoValue, note: value.undoNote }], value.context?.historyId);
      }
    }
  }

  async function pasteEquipmentTimesheetCells(changes: TimesheetClipboardChange[], context?: TimesheetClipboardSaveContext) {
    if (!payload?.canEditTimesheet) throw new Error("Недостаточно прав для изменения табеля техники");
    if (navigationBusy || loading) throw new Error("Дождитесь завершения сохранения и загрузки табеля.");
    if (payload.siteId !== siteId || payload.month !== month) throw new Error("Табель обновляется. Дождитесь загрузки выбранного месяца.");
    const targetSiteId = payload.siteId;
    const prepared = changes.flatMap((change) => {
      const row = monthRows[change.rowIndex];
      const day = visibleMonthDays[change.columnIndex];
      const workDate = day ? `${month}-${String(day).padStart(2, "0")}` : "";
      if (!row || !workDate) throw new Error("Выбранный диапазон содержит недоступные ячейки");
      const key = equipmentCellKey(row.unit.id, workDate);
      const previousMark = timesheetMarksByCell.get(key);
      if (!change.value.trim() && !previousMark && batchSave.getCellState(key)?.state !== "error") return [];
      return [{ key, equipmentId: row.unit.id, workDate, label: `${unitTitle(row.unit)}, ${fullDate(workDate)}`,
        value: change.value, note: change.note ?? "", change,
        undoValue: previousMark ? formatEquipmentHours(previousMark.productiveHours, previousMark.downtimeHours) : "", undoNote: previousMark?.note ?? "" }];
    });
    if (!prepared.length) return { savedChanges: [], failedChanges: [] };
    const preparedViewScope = clipboardViewScope.current;
    const changesByKey = new Map(prepared.map(item => [item.key, item.change]));

    const outcome = await batchSave.run(prepared.map(item => ({
      key: item.key,
      label: item.label,
      value: item.value || "Вернуть значение из отчёта",
      save: async () => {
        const value = parseEquipmentClipboardHours(item.value);
        const existed = timesheetMarksByCell.has(item.key);
        if (value.clear && !payload.canDeleteTimesheet) throw new Error("Недостаточно прав для удаления отметок табеля техники.");
        if (!value.clear && existed && !payload.canUpdateTimesheet) throw new Error("Недостаточно прав для изменения отметок табеля техники.");
        if (!value.clear && !existed && !payload.canCreateTimesheet) throw new Error("Недостаточно прав для добавления отметок табеля техники.");
        const result = await post({
          siteId: targetSiteId,
          action: "save-timesheet-mark",
          equipmentId: item.equipmentId,
          workDate: item.workDate,
          ...(value.clear ? { clear: true } : { productiveHours: value.productiveHours, downtimeHours: value.downtimeHours, note: item.note }),
        });
        return { equipmentId: item.equipmentId, workDate: item.workDate, mark: result.mark,
          change: item.change, undoValue: item.undoValue, undoNote: item.undoNote, context, viewScope: preparedViewScope };
      },
    })));
    return {
      savedChanges: outcome.saved.map(({ value }) => value.change),
      failedChanges: outcome.failed.flatMap(({ job }) => { const change = changesByKey.get(job.key); return change ? [change] : []; }),
    };
  }

  function openDailyExportPreview() {
    if (!requireSavedExcelRows(entryDrafts.length)) return;
    if (!payload) return;
    setError("");
    try {
      openExcelExportPreview({
        version: 1,
        title: "Отчёт техники",
        description: `${payload?.siteName ?? "Объект"} · ${workDate}`,
        fileName: dailyExportFileName,
        headers: dailyExportHeaders,
        rows: dailyExportRows,
        workbook: { kind: "equipment-placement", siteName: payload?.siteName ?? "Объект", rangeStart: workDate, rangeEnd: workDate, rows: dailyExportWorkbookRows },
        source: { kind: "equipment", siteId, siteName: payload.siteName ?? "Объект", initialDate: workDate },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
  }

  function downloadDailyReportTemplate() {
    if (!payload) return;
    setError("");
    try {
      const parentNames = new Map(payload.mainWorkTypes.map((item) => [item.id, item.name]));
      const data = {
        equipmentNames: payload.units.map(equipmentExcelName),
        shifts: payload.shifts.map((item) => item.name),
        zones: payload.zones.map((item) => item.name),
        mainWorkTypes: payload.mainWorkTypes.map((item) => item.name),
        subworkTypes: payload.subworkTypes.map((item) => item.name),
        workTypePairs: payload.subworkTypes.flatMap((item) => {
          const mainWorkTypeName = item.mainWorkTypeId ? parentNames.get(item.mainWorkTypeId) : undefined;
          return mainWorkTypeName ? [{ mainWorkTypeName, subworkTypeName: item.name }] : [];
        }),
      };
      downloadExcelFile(createEquipmentPlacementTemplateXlsx(payload.siteName, workDate, data), excelFileName("Шаблон отчёта техники", [payload.siteName, workDate]));
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Не удалось скачать шаблон отчёта техники.");
    }
  }

  function openTimesheetExportPreview() {
    if (!requireSavedExcelRows(Number(Boolean(timesheetEditor || timesheetInlineEditor || savingTimesheetMark)))) return;
    const dates = monthDays.map((day) => `${month}-${String(day).padStart(2, "0")}`);
    const rows = monthRows.map((row) => {
      const dailyProductiveHours: number[] = [];
      const dailyDowntimeHours: number[] = [];
      const dailyReportHours: number[] = [];
      const dayValues = monthDays.map((day) => {
        const date = `${month}-${String(day).padStart(2, "0")}`;
        const value = row.byDate.get(date);
        dailyProductiveHours.push(value?.productive ?? 0);
        dailyDowntimeHours.push(value?.downtime ?? 0);
        dailyReportHours.push((value?.reportProductive ?? 0) + (value?.reportDowntime ?? 0));
        if (!value) return "";
        if (value.productive && value.downtime) return `${value.productive} / П ${value.downtime}`;
        if (value.downtime) return `П ${value.downtime}`;
        return value.productive || "";
      });
      return {
        equipmentName: equipmentExcelName(row.unit),
        organization: row.unit.organization,
        equipmentType: row.unit.equipmentType,
        registrationNumber: row.unit.registrationNumber,
        dailyValues: dayValues,
        dailyProductiveHours,
        dailyDowntimeHours,
        dailyReportHours,
        productiveHours: row.productive,
        downtimeHours: row.downtime,
        reportHours: dailyReportHours.reduce((sum, value) => sum + value, 0),
        totalHours: row.total,
      };
    });
    const currentMonthLabel = titleCase(MONTH_FORMATTER.format(new Date(`${month}-01T00:00:00Z`)));
    const headers = ["Тип", "Уникальное наименование единицы", "ГРЗ", ...monthDays.map(String), "ЧАСЫ", "ПРОСТОЙ", "РАСТ"];
    const previewRows = rows.map((row) => [
      row.equipmentType,
      row.equipmentName,
      row.registrationNumber,
      ...row.dailyValues,
      row.productiveHours,
      row.downtimeHours,
      row.productiveHours + row.downtimeHours - row.reportHours,
    ]);
    setError("");
    try {
      openExcelExportPreview({
        version: 1,
        title: "Табель техники",
        description: `${payload?.siteName ?? "Объект"} · ${currentMonthLabel}`,
        fileName: excelFileName("Табель техники", [payload?.siteName, month]),
        headers,
        rows: previewRows,
        workbook: {
          kind: "equipment-timesheet",
          siteName: payload?.siteName ?? "Объект",
          monthLabel: currentMonthLabel,
          dates,
          rows,
          dayTotals: dates.map((date) => monthDayTotals.get(date) ?? 0),
          productiveTotal: monthSummary.productive,
          downtimeTotal: monthSummary.downtime,
          totalHours: monthSummary.total,
        },
        source: { kind: "equipment-timesheet", siteId, siteName: payload?.siteName ?? "Объект", initialDate: dates[0] },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
  }

  function openRegistryExportPreview() {
    if (!requireSavedExcelRows(unitDrafts.length + unitFullRowEditIds.length)) return;
    if (!registryUnits.length) return;
    const units = excelRowsInOrder(registryUnits, visibleUnitIds);
    const headers = ["Организация", "Тип", "Марка", "Модель", "ГРЗ / Инв. №", "Проект", "Примечание"];
    const rows = units.map((unit) => [unit.organization, unit.equipmentType, unit.brand, unit.model, unit.registrationNumber, unit.assignedSiteName ?? "", unit.note]);
    setError("");
    try {
      openExcelExportPreview({
        version: 1,
        title: "Реестр техники",
        description: `Строк в выгрузке: ${rows.length}`,
        fileName: excelFileName("Реестр техники"),
        headers,
        rows,
        workbook: { kind: "table", sheetName: "Реестр техники", workbookTitle: "Общий реестр техники", rows },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
  }

  function openProjectEquipmentExportPreview() {
    if (!requireSavedExcelRows(projectUnitDrafts.length)) return;
    const units = excelRowsInOrder(payload?.units ?? [], visibleProjectUnitIds);
    if (!units.length) return;
    const projectName = payload?.siteName ?? "Проект";
    const headers = ["Организация", "Тип", "Марка", "Модель", "ГРЗ / Инв. №", "Примечание"];
    const rows = units.map((unit) => [unit.organization, unit.equipmentType, unit.brand, unit.model, unit.registrationNumber, unit.note]);
    setError("");
    try {
      openExcelExportPreview({
        version: 1,
        title: "Техника проекта",
        description: `${projectName} · строк в выгрузке: ${rows.length}`,
        fileName: excelFileName("Техника проекта", [projectName]),
        headers,
        rows,
        workbook: { kind: "table", sheetName: "Техника проекта", workbookTitle: `Техника проекта — ${projectName}`, rows },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
  }

  function downloadRegistryTemplate() {
    if (!payload || hasRestrictedProjectAccess({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess })) return;
    const rows = Array.from({ length: 25 }, () => ["", "", "", "", "", "", ""]);
    setError("");
    try {
      downloadExcelFile(createTableXlsx("Реестр техники", "Шаблон реестра техники", ["Организация", "Тип", "Марка", "Модель", "ГРЗ / Инв. №", "Проект", "Примечание"], rows), excelFileName("Шаблон реестра техники"));
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Не удалось скачать шаблон реестра техники.");
    }
  }

  if (loading && !payload) return <>{monthFilters.controller}{monthChangeDialog}<section className="equipment-state"><span className="equipment-state-spinner" /><strong>Загружаем учёт техники…</strong></section></>;

  return <section className={["equipment-page", section === "month" ? "timesheet-page" : "", section === "month" ? "equipment-timesheet-page" : ""].filter(Boolean).join(" ")}>
    {monthFilters.controller}
    {monthChangeDialog}
    {section === "daily" && headerActionsTarget && createPortal(<div className="report-heading-controls">
      <div className="report-heading-date"><EquipmentReportDateNavigation dates={recentDates} value={workDate} today={today} filledDates={filledDates} onChange={changeWorkDate} onRangeChange={changeReportRange} /></div>
      <ExcelActionsMenu actions={[
        { label: "Экспорт в Excel", onSelect: openDailyExportPreview, disabled: loading || !dailyExportRows.length },
        ...(payload?.canCreateDaily ? [
          { label: importing ? "Импортируем…" : "Импорт из Excel", onSelect: () => dailyFileInput.current?.click(), disabled: importing },
          { label: "Скачать шаблон", onSelect: downloadDailyReportTemplate, disabled: loading || !payload },
        ] : []),
      ]} />
      <input ref={dailyFileInput} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importEntries(file); }} />
    </div>, headerActionsTarget)}
    {section === "registry" && headerActionsTarget && createPortal(<div className="toolbar-actions" aria-label="Действия с Excel для реестра техники">
      <ExcelActionsMenu actions={[
        { label: "Экспорт в Excel", onSelect: openRegistryExportPreview, disabled: loading || !(visibleUnitIds?.length ?? registryUnits.length) },
        ...(payload?.canCreateRegistry && !hasRestrictedProjectAccess({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess }) ? [
          { label: importing ? "Загружаем…" : "Импорт из Excel", onSelect: () => fileInput.current?.click(), disabled: importing },
          { label: "Скачать шаблон", onSelect: downloadRegistryTemplate },
        ] : []),
      ]} />
      {payload?.canCreateRegistry && !hasRestrictedProjectAccess({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess }) && <input ref={fileInput} hidden type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importRegistry(file); }} />}
    </div>, headerActionsTarget)}
    {section === "project" && headerActionsTarget && createPortal(<div className="toolbar-actions" aria-label="Действия с Excel для техники проекта">
      <ExcelActionsMenu actions={[
        { label: "Экспорт в Excel", onSelect: openProjectEquipmentExportPreview, disabled: loading || !(visibleProjectUnitIds?.length ?? payload?.units.length) },
      ]} />
    </div>, headerActionsTarget)}
    {section === "month" && headerActionsTarget && createPortal(<div className="excel-actions equipment-timesheet-page-actions timesheet-heading-actions">
      {monthFilters.isActive && <button type="button" className="timesheet-header-filter-reset" onClick={monthFilters.reset}>Сбросить фильтры <span>{monthFilters.activeCount}</span></button>}
      <ExcelActionsMenu actions={[
        { label: "Экспорт в Excel", onSelect: openTimesheetExportPreview, disabled: loading || monthRows.length === 0 },
      ]} />
      <button type="button" className="equipment-timesheet-info-button" aria-label="Информация" title="Информация" onClick={() => setTimesheetInfoOpen(true)}><span aria-hidden="true">i</span></button>
    </div>, headerActionsTarget)}
    {error && <div className="equipment-message error"><strong>Нужно проверить данные</strong><span>{error}</span><button type="button" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="equipment-message success"><strong>Готово</strong><span>{notice}</span><button type="button" onClick={() => setNotice("")}>×</button></div>}

    {section === "daily" && <>
      {!referencesReady && payload?.canEditDaily && <div className="equipment-empty-hint"><strong>Сначала заполните справочники</strong><span>Для новой записи нужны техника, смены, зоны и виды работ с назначенными подвидами.</span></div>}
      <div className="table-card equipment-report-card">
        {payload?.currentUserRole !== "foreman" && Boolean(payload?.foremanProgress.length) && <div className="foreman-report-progress" role="status"><strong>Сдали прорабы: {payload!.foremanProgress.filter((item) => item.status === "submitted").length} из {payload!.foremanProgress.length}</strong><span>{payload!.foremanProgress.map((item) => `${item.foremanName}: ${item.status === "submitted" ? `${item.equipmentCount} ед., ${item.hours} ч.` : item.status === "draft" ? "заполняет" : "не сдал"}`).join(" · ")}</span></div>}
        {showEquipmentCarryover && <div className="foreman-report-progress equipment-carryover-status" role="status"><strong>Подставлена техника из отчёта за {shortDate(previousDayReport!.date)}</strong><span>Если всё как вчера, сразу сохраните свою часть. Измените только отличия и удалите технику, которая сегодня не работала.</span></div>}
        <EquipmentDailyAgGrid onVisibleIdsChange={(ids) => setVisibleDailyEntryIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)} entries={dailyEntries} drafts={entryDrafts} units={payload?.units ?? []} dailyTimesheetMarks={payload?.dailyTimesheetMarks ?? []} shifts={payload?.shifts ?? []} zones={payload?.zones ?? []} mainWorkTypes={payload?.mainWorkTypes ?? []} subworkTypes={payload?.subworkTypes ?? []} loading={loading || previousDayLoading} canCreate={Boolean(payload?.canCreateDaily)} canUpdate={Boolean(payload?.canUpdateDaily)} canDelete={Boolean(payload?.canDeleteDaily)} showResponsibleUser={payload?.currentUserRole !== "foreman"} currentUserName={payload?.currentUserName} selectedIds={selectedEntryIds} selectedDraftKeys={selectedEntryDraftKeys} onEdit={openEntry} onPatchDraft={patchEntryDraft} onSelectionChange={(ids) => { setSelectedEntryIds(ids); if (ids.length) setSelectedEntryDraftKeys([]); }} onDraftSelectionChange={(keys) => { setSelectedEntryDraftKeys(keys); if (keys.length) setSelectedEntryIds([]); }} onValidationError={(message) => { setError(message); setNotice(""); }} />
        <div className="table-edit-footer employee-table-footer uniform-footer-actions report-table-footer equipment-report-footer">
          {selectedEntryIds.length > 0 && <div className="employee-selection-bar"><div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedEntryIds.length}</strong></span></div><div className="employee-selection-actions">{payload?.canUpdateDaily && <button type="button" className="employee-action-button employee-action-primary" onClick={() => { const selected = dailyEntries.filter((entry) => selectedEntryIds.includes(entry.id)); selected.forEach((entry) => openEntry(entry)); }} disabled={saving}>Редактировать</button>}{payload?.canDeleteDaily && <button type="button" className="employee-action-button employee-action-danger" onClick={() => setDeleteConfirmationTarget("daily")} disabled={saving}>Удалить строки</button>}<button type="button" className="employee-action-button clear-selection-button" onClick={() => setSelectedEntryIds([])} disabled={saving}>Снять выделение</button></div></div>}
          {selectedEntryDraftKeys.length > 0 && <div className="employee-selection-bar"><div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано строк: <strong>{selectedEntryDraftKeys.length}</strong></span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-action-danger" onClick={removeSelectedEntryDrafts} disabled={saving}>Убрать из отчёта</button><button type="button" className="employee-action-button clear-selection-button" onClick={() => setSelectedEntryDraftKeys([])} disabled={saving}>Снять выделение</button></div></div>}
          {entryDrafts.length > 0 && selectedEntryDraftKeys.length === 0 && <div className="employee-editing-bar"><div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>{showEquipmentCarryover ? "Подготовлено строк" : "Редактируется"}: <strong>{entryDrafts.length}</strong></span></div><div className="employee-selection-actions">{payload?.canCreateDaily && <button type="button" className="employee-action-button employee-action-primary" onClick={() => openEntry()} disabled={!referencesReady || saving}>Добавить запись</button>}<button type="button" className="employee-action-button cancel-editing-button" onClick={resetEntryDrafts} disabled={saving}>{hasEquipmentCarryoverSource ? "Вернуть исходный список" : "Отменить редактирование"}</button><button type="button" className="employee-action-button employee-save-button" onClick={() => void saveEntries()} disabled={saving}>{saving ? "Сохраняем…" : payload?.currentUserRole === "foreman" ? "Сохранить мою часть" : "Сохранить изменения"}</button></div></div>}
          {entryDrafts.length === 0 && selectedEntryIds.length === 0 && selectedEntryDraftKeys.length === 0 && payload?.canUpdateDaily && !payload.reportSubmitted && <div className="employee-editing-bar roster-save-bar"><div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>{payload.currentUserRole === "foreman" ? "После заполнения сохраните свою часть отчёта" : "Проверьте строки всех прорабов перед принятием отчёта"}</span></div><div className="employee-selection-actions"><button type="button" className="employee-action-button employee-save-button" onClick={() => void submitDailyReport()} disabled={saving}>{saving ? "Сохраняем…" : payload.currentUserRole === "foreman" ? "Сохранить мою часть" : "Принять отчёт за день"}</button></div></div>}
          {entryDrafts.length === 0 && selectedEntryIds.length === 0 && <div className="employee-footer-base">{payload?.canCreateDaily && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={() => openEntry()} disabled={!referencesReady || saving}>Добавить запись</button>}<span className="employee-total-count">Всего машино-часов: <strong>{dailySummary.total}</strong></span></div>}
        </div>
      </div>
    </>}

    {section === "month" && <TimesheetFiltersProvider value={monthFilters.context}>
      {refreshError && !error && <div className="equipment-message error" role="status"><strong>Не удалось обновить табель техники</strong><span>{refreshError}</span><button type="button" onClick={() => refreshControl.current?.request()}>Повторить</button></div>}
      <div className="equipment-timesheet-summary timesheet-top-summary" aria-busy={loading} aria-label={`Период и итоги за ${titleCase(MONTH_FORMATTER.format(new Date(`${month}-01T00:00:00Z`)))}`}>
        <div className="timesheet-month-control timesheet-summary-month-control" aria-label="Выбор месяца табеля">
          <button type="button" onClick={() => changeMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц">‹</button>
          <EquipmentMonthPicker value={month} current={today.slice(0, 7)} onChange={changeMonth} />
          <button type="button" onClick={() => changeMonth(shiftMonth(month, 1))} aria-label="Следующий месяц">›</button>
        </div>
        <span><small>Техника в работе</small><strong>{monthRows.filter((row) => row.total > 0).length}</strong></span>
        <span className="productive"><small>Работа</small><strong>{formatTimesheetHours(monthSummary.productive)} ч.</strong></span>
        <span className="downtime"><small>Простой</small><strong>{formatTimesheetHours(monthSummary.downtime)} ч.</strong></span>
        <span className="equipment-total"><small>Всего</small><strong>{formatTimesheetHours(monthSummary.total)} ч.</strong></span>
      </div>
      {monthRowMoves.ui}
      <TimesheetSaveStatus status={batchSave.status} busy={savingBulkTimesheetMarks}
        retryDisabled={savingTimesheetMark || loading || Boolean(timesheetEditor || timesheetInlineEditor)}
        onRetry={() => { void batchSave.retry().catch(failure => notifyEquipmentTimesheetClipboard(failure instanceof Error ? failure.message : "Не удалось повторить сохранение.")); }}
        onDismiss={batchSave.dismiss} />
      {/* The spreadsheet shell must receive focus so native copy and paste events reach it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <NativeTimesheetPageScroll viewportRef={timesheetClipboardShellRef} rowCount={monthRows.length} rowHeight={48} geometryKey={`${monthRowOrderKey}:${loading}`} label="Горизонтальная прокрутка табеля техники"><div ref={timesheetClipboardShellRef} className={["timesheet-grid-shell", "equipment-timesheet-shell", "timesheet-clipboard-shell", timesheetClipboardActiveCell ? "timesheet-selection-active" : "", timesheetClipboardHeadersSelected ? "timesheet-headers-selected" : ""].filter(Boolean).join(" ")} role="application" tabIndex={0} aria-label="Табель техники. Стрелки перемещают выбранную ячейку, Enter или F2 открывают редактирование." {...timesheetClipboardShellHandlers}>{timesheetClipboardContextMenu}{timesheetColumnContextMenu}{timesheetClipboardStatus && <div className="timesheet-clipboard-status" role="status">{timesheetClipboardStatus}</div>}<table className="timesheet-table equipment-month-table timesheet-resizable" style={monthColumnResize.tableStyle} aria-rowcount={monthRows.length + 3}>
        {monthColumnResize.colGroup}
        <thead><tr>
          <th className="timesheet-sticky equipment-number-column" rowSpan={2}>{monthRowMoves.headerCheckbox}{monthColumnResize.handle("number", "№")}</th>
          <th className="timesheet-sticky equipment-machine-column" rowSpan={2}><TimesheetFilterableHeading columnId="equipment" label="Техника">Техника</TimesheetFilterableHeading>{monthColumnResize.handle("equipment", "Техника")}</th>
          <th className="timesheet-sticky equipment-organization-column" rowSpan={2}><TimesheetFilterableHeading columnId="organization" label="Организация">Организация</TimesheetFilterableHeading>{monthColumnResize.handle("organization", "Организация")}</th>
          <th colSpan={visibleMonthDays.length}>Дни месяца</th>
          <th className="timesheet-total-column equipment-work-total" rowSpan={2}><TimesheetFilterableHeading columnId="productive" label="Работа">Работа</TimesheetFilterableHeading>{monthColumnResize.handle("productive", "Работа")}</th>
          <th className="timesheet-total-column equipment-idle-total" rowSpan={2}><TimesheetFilterableHeading columnId="downtime" label="Простой">Простой</TimesheetFilterableHeading>{monthColumnResize.handle("downtime", "Простой")}</th>
          <th className="timesheet-total-column equipment-all-total" rowSpan={2}><TimesheetFilterableHeading columnId="total" label="Всего">Всего</TimesheetFilterableHeading>{monthColumnResize.handle("total", "Всего")}</th>
        </tr><tr>{visibleMonthDays.map((day) => { const date = `${month}-${String(day).padStart(2, "0")}`; const dateObject = new Date(`${date}T00:00:00Z`); const weekend = [0, 6].includes(dateObject.getUTCDay()); const weekday = WEEKDAY_FORMATTER.format(dateObject).replace(".", ""); return <th key={day} className={[weekend ? "weekend" : "", date === today ? "today" : "", date > today ? "future" : ""].filter(Boolean).join(" ")}><TimesheetFilterableHeading columnId={date} compact label={`${day} ${weekday}`}><span>{day}</span><small>{weekday}</small></TimesheetFilterableHeading>{monthColumnResize.handle(`day-${day}`, `${day} ${weekday}`)}</th>; })}</tr></thead>
        <tbody>{monthViewport.top > 0 && <tr className="timesheet-virtual-spacer" aria-hidden="true"><td colSpan={monthColumnResize.columnCount} style={{ height: monthViewport.top }} /></tr>}{monthRows.length ? monthRows.slice(monthViewport.start, monthViewport.end).map((row, offset) => { const index = monthViewport.start + offset; return <tr key={row.unit.id} {...monthRowMoves.rowProps(row.unit.id)} data-virtual-row={index} aria-rowindex={index + 3}>
          <td className={`timesheet-sticky equipment-number-column ${timesheetClipboardCellClass(index, -3)}`} {...timesheetClipboardCellHandlers(index, -3)}>{monthRowMoves.handle(row.unit.id, unitTitle(row.unit), index + 1)}</td>
          <th scope="row" className={`timesheet-sticky equipment-machine-column ${timesheetClipboardCellClass(index, -2)}`} {...timesheetClipboardCellHandlers(index, -2)} title={unitTitle(row.unit)}><span>{unitTitle(row.unit)}</span><small>{row.unit.registrationNumber || "Номер не указан"}</small></th>
          <td className={`timesheet-sticky equipment-organization-column ${timesheetClipboardCellClass(index, -1)}`} {...timesheetClipboardCellHandlers(index, -1)} title={row.unit.organization}>{row.unit.organization}</td>{visibleMonthDays.map((day, columnIndex) => {
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
          const expectedManualMark = Boolean(value?.mark && !value.mismatch && monthReportByCell.has(equipmentCellKey(row.unit.id, date)));
          const isInlineEditing = timesheetInlineEditor?.equipmentId === row.unit.id && timesheetInlineEditor.workDate === date && (value?.mark ? payload?.canUpdateTimesheet : payload?.canCreateTimesheet);
          const isActiveCell = timesheetClipboardActiveCell?.rowIndex === index && timesheetClipboardActiveCell.columnIndex === columnIndex;
          const saveState = batchSave.getCellState(equipmentCellKey(row.unit.id, date));
          return <td
            key={day}
            data-save-state={saveState?.state}
            aria-invalid={saveState?.state === "error" || undefined}
            className={[
              value?.downtime ? "has-downtime" : value?.productive ? "filled" : "",
              value?.mark ? "manual" : "",
              expectedManualMark ? "manual-expected" : "",
              value?.mismatch ? "mismatch" : "",
              payload?.canEditTimesheet ? "editable" : "",
              dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "",
              date === today ? "today" : "",
              date > today ? "future" : "",
              timesheetClipboardCellClass(index, columnIndex),
              saveState ? `timesheet-cell-save-${saveState.state}` : "",
            ].filter(Boolean).join(" ")}
            title={[isInlineEditing && timesheetInlineEditor.error ? timesheetInlineEditor.error : title,
              saveState?.state === "error" ? `Не удалось сохранить «${saveState.value}»: ${saveState.error}` : saveState?.state === "saved" ? "Изменение сохранено" : saveState ? "Сохраняем изменение…" : ""].filter(Boolean).join("\n")}
            {...timesheetClipboardCellHandlers(index, columnIndex)}
            onDoubleClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button, input")) return;
              openTimesheetInlineEditor(row.unit.id, date, index, columnIndex);
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
              onBlur={(event) => {
                if (!timesheetInlineCancelPending.current) void saveTimesheetInlineValue(event.currentTarget.value, false);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                const movement: Record<string, EquipmentTimesheetEditorMove> = {
                  ArrowLeft: { row: 0, column: -1 }, ArrowRight: { row: 0, column: 1 },
                  ArrowUp: { row: -1, column: 0 }, ArrowDown: { row: 1, column: 0 },
                };
                if (movement[event.key]) {
                  event.preventDefault();
                  void saveTimesheetInlineValue(event.currentTarget.value, true, movement[event.key]);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void saveTimesheetInlineValue(event.currentTarget.value);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  timesheetInlineCancelPending.current = true;
                  timesheetInlineSession.current++;
                  timesheetInlineGridFocusPending.current = true;
                  setTimesheetInlineEditor(null);
                }
              }}
            />
            {timesheetInlineEditor.error && <span className="timesheet-cell-inline-error" role="alert" title={timesheetInlineEditor.error}>!</span>}
          </div> : <>
            <span className="timesheet-cell-value">{hasValue ? <>{value?.productive || (!value?.downtime && value?.mark ? "0" : null)}{value?.downtime ? <small>П {value.downtime}</small> : null}</> : ""}</span>
            {payload && (value?.mark ? payload.canUpdateTimesheet || payload.canDeleteTimesheet : payload.canCreateTimesheet) && isActiveCell && <button
              type="button"
              className="timesheet-cell-dropdown equipment-timesheet-cell-dropdown"
              aria-label={`Выбрать значение: ${unitTitle(row.unit)}, ${fullDate(date)}`}
              aria-expanded={timesheetEditor?.equipmentId === row.unit.id && timesheetEditor.workDate === date}
              title="Выбрать значение из списка"
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                focusEquipmentTimesheetCell(index, columnIndex);
                openTimesheetEditor(row.unit.id, date, event.currentTarget);
              }}
            ><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4 6 8l3.5-4Z" /></svg></button>}
          </>}{saveState && !isInlineEditing && <span className="timesheet-cell-save-indicator" aria-hidden="true">{saveState.state === "error" ? "!" : saveState.state === "saved" ? "✓" : "·"}</span>}</td>;
        })}<td className={`timesheet-total-column equipment-work-total ${timesheetClipboardCellClass(index, visibleMonthDays.length)}`} {...timesheetClipboardCellHandlers(index, visibleMonthDays.length)}>{row.productive ? formatTimesheetHours(row.productive) : "—"}</td>
          <td className={`timesheet-total-column equipment-idle-total has-difference ${timesheetClipboardCellClass(index, visibleMonthDays.length + 1)}`} {...timesheetClipboardCellHandlers(index, visibleMonthDays.length + 1)}>{row.downtime ? formatTimesheetHours(row.downtime) : "—"}</td>
          <td className={`timesheet-total-column equipment-all-total ${timesheetClipboardCellClass(index, visibleMonthDays.length + 2)}`} {...timesheetClipboardCellHandlers(index, visibleMonthDays.length + 2)}>{row.total ? formatTimesheetHours(row.total) : "—"}</td></tr>; }) : <tr><td colSpan={monthColumnResize.columnCount}><div className="equipment-table-empty"><strong>В этом месяце данных нет</strong><span>Записи появятся после заполнения ежедневных отчётов техники.</span></div></td></tr>}{monthViewport.bottom > 0 && <tr className="timesheet-virtual-spacer" aria-hidden="true"><td colSpan={monthColumnResize.columnCount} style={{ height: monthViewport.bottom }} /></tr>}{monthRows.length > 0 && <tr className="timesheet-fill-row" aria-hidden="true"><td colSpan={monthColumnResize.columnCount} /></tr>}</tbody>
        {monthRows.length > 0 && <tfoot><tr><th className="timesheet-sticky timesheet-summary-label" colSpan={3}>Итого по дням</th>{visibleMonthDays.map((day) => { const date = `${month}-${String(day).padStart(2, "0")}`; const hours = monthDayTotals.get(date); return <td key={date}>{hours ? formatTimesheetHours(hours) : ""}</td>; })}<th className="timesheet-total-column equipment-work-total">{formatTimesheetHours(monthSummary.productive)}</th><th className="timesheet-total-column equipment-idle-total has-difference">{formatTimesheetHours(monthSummary.downtime)}</th><th className="timesheet-total-column equipment-all-total">{formatTimesheetHours(monthSummary.total)}</th></tr></tfoot>}
      </table></div></NativeTimesheetPageScroll>
      {timesheetInfoOpen && <div className="equipment-reference-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTimesheetInfoOpen(false); }}><section className="equipment-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="equipment-timesheet-reference-title">
        <header><div><span>ТАБЕЛЬ ТЕХНИКИ</span><h2 id="equipment-timesheet-reference-title">Информация и справочник</h2><p>Цвета в таблице и обозначения, которые используются в табеле.</p></div><button type="button" aria-label="Закрыть справочник" onClick={() => setTimesheetInfoOpen(false)}>×</button></header>
        <section className="equipment-reference-section"><h3>Цвета ячеек</h3><div className="equipment-reference-colors">
          <div><i className="work"/><span><strong>Зелёный</strong><small>Рабочие часы из отчёта или ручные часы, совпадающие с отчётом по работе и простою.</small></span></div>
          <div><i className="manual"/><span><strong>Жёлтый</strong><small>Ручная правка без соответствующего отчёта.</small></span></div>
          <div><i className="idle"/><span><strong>Красный</strong><small>Простой: часы простоя. Красная рамка также отмечает расхождение с ежедневным отчётом.</small></span></div>
        </div>{payload?.canEditTimesheet && <p className="equipment-reference-note">Выберите ячейку и сразу вводите значение: «8» — работа, «П 2» — простой, «8/2» — работа и простой. Можно заранее заполнить будущие даты. Отметка только с простоем делает технику недоступной в отчёте за этот день. Стрелка в выделенной ячейке открывает готовые варианты. Сумма за сутки — не более 20 часов.</p>}</section>
        <section className="equipment-reference-section"><h3>Табельные коды рабочих</h3><div className="equipment-reference-codes">{EQUIPMENT_TIMESHEET_CODES.map((code) => <div key={code.value}><strong>{code.value}</strong><span>{code.label}</span></div>)}</div></section>
        <footer><button type="button" onClick={() => setTimesheetInfoOpen(false)}>Понятно</button></footer>
      </section></div>}

      {payload?.canEditTimesheet && timesheetEditor && editingTimesheetUnit && <TimesheetCellPopover
        anchor={timesheetEditor.anchor}
        width={timesheetEditor.mode === "list" ? 250 : 320}
        className={timesheetEditor.mode === "list" ? "timesheet-mark-popover" : ""}
        ariaLabel={`Часы техники: ${unitTitle(editingTimesheetUnit)}, ${fullDate(timesheetEditor.workDate)}`}
        onClose={() => { if (!savingTimesheetMark) closeTimesheetEditorAndRestoreFocus(); }}
      >
        {timesheetEditor.mode === "list" || !(editingTimesheetMark ? payload.canUpdateTimesheet : payload.canCreateTimesheet) ? <EquipmentTimesheetMarkList
          value={formatEquipmentHours(editingTimesheetMark?.productiveHours ?? editingTimesheetReport.productive, editingTimesheetMark?.downtimeHours ?? editingTimesheetReport.downtime)}
          canReset={Boolean(editingTimesheetMark && payload.canDeleteTimesheet)}
          canWrite={Boolean(editingTimesheetMark ? payload?.canUpdateTimesheet : payload?.canCreateTimesheet)}
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
          <div className="timesheet-inline-actions">{editingTimesheetMark && payload.canDeleteTimesheet ? <button type="button" className="reset" disabled={savingTimesheetMark} onClick={() => void saveTimesheetMark(true)}>Из отчёта</button> : <span/>}<button type="button" className="save" disabled={savingTimesheetMark || !timesheetValueValid} onClick={() => void saveTimesheetMark()}>{savingTimesheetMark ? "Сохраняем…" : "Применить"}</button></div>
        </>}
        {timesheetEditor.mode === "list" && timesheetEditorError && <div className="timesheet-inline-error">{timesheetEditorError}</div>}
      </TimesheetCellPopover>}
    </TimesheetFiltersProvider>}

    {section === "registry" && <EquipmentRegistryAgGrid
      rows={registryUnits}
      drafts={unitDrafts}
      sites={payload?.sites ?? []}
      requiredSiteId={payload ? accessibleProjectIds({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess }) ?? undefined : undefined}
      defaultProjectSiteId={payload && hasRestrictedProjectAccess({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess }) ? String(siteId) : ""}
      preferenceScope={{ userId: currentUserId ?? 0 }}
      selectedIds={selectedUnitIds}
      fullRowEditIds={unitFullRowEditIds}
      loading={loading || saving || importing}
      canCreate={Boolean(payload?.canCreateRegistry)}
      canUpdate={Boolean(payload?.canUpdateRegistry)}
      canSelect={Boolean(payload?.canUpdateRegistry || payload?.canDeleteRegistry)}
      onEdit={openUnit}
      onSelectionChange={(ids) => { setSelectedUnitIds(ids); setNotice(""); setError(""); }}
      onPatchDraft={patchUnitDraft}
      onReplaceDrafts={(drafts) => { setUnitDrafts(drafts); setNotice(""); setError(""); }}
      onVisibleIdsChange={(ids) => setVisibleUnitIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
      onValidationError={(message) => { setError(message); setNotice(""); }}
      renderFooter={({ selectedDraftCount, removeSelectedDrafts, clearSelection }) => payload?.canManageRegistry && <AdminGridFooter
        compact allowMultiple addLabel="Добавить технику" countLabel="Всего техники" count={visibleUnitIds?.length ?? registryUnits.length}
        deletingCount={selectedUnitIds.length} deletingLabel="Удалить технику" editSelectionLabel="Редактировать"
        editorOpen={Boolean(unitDrafts.length)} editingExisting={unitDrafts.some(draft => draft.id !== undefined)} pendingCount={unitDrafts.length}
        selectedDraftCount={selectedDraftCount} saving={loading || saving || importing}
        canCreate={payload.canCreateRegistry} canUpdate={payload.canUpdateRegistry} canDelete={payload.canDeleteRegistry}
        onAdd={() => { setUnitDrafts(current => [{ ...emptyUnit(), projectSiteId: hasRestrictedProjectAccess({ role: payload.currentUserRole, assignedSiteId: siteId, projectAccess: currentUserProjectAccess }) ? String(siteId) : "" }, ...current]); setNotice(""); setError(""); }}
        onDelete={() => setDeleteConfirmationTarget("registry")} onEditSelection={editSelectedUnits}
        onClearSelection={() => { clearSelection(); setNotice(""); setError(""); }}
        onRemoveSelectedDrafts={() => { const count = removeSelectedDrafts(); if (count) { setNotice(`Убрано новых строк: ${count}.`); setError(""); } }}
        onCancelEditing={cancelUnitEditing} onSave={() => void saveUnits()}
      />}
    />}

    {section === "project" && <ProjectEquipmentAgGrid
      onVisibleIdsChange={(ids) => setVisibleProjectUnitIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
      rows={payload?.units ?? []}
      allUnits={payload?.availableUnits ?? []}
      drafts={projectUnitDrafts}
      preferenceScope={{ userId: currentUserId ?? 0, siteId }}
      selectedIds={selectedProjectUnitIds}
      loading={loading || saving || importing}
      canCreate={Boolean(payload?.canCreateAssignments)}
      canSelect={Boolean(payload?.canDeleteAssignments)}
      onPatchDraft={patchProjectUnitDraft}
      onReplaceDrafts={(drafts) => { setProjectUnitDrafts(drafts); setNotice(""); setError(""); }}
      onSelectionChange={(ids) => { setSelectedProjectUnitIds(ids); setError(""); setNotice(""); }}
      onValidationError={(message) => { setError(message); setNotice(""); }}
      renderFooter={({ selectedDraftCount, removeSelectedDrafts, clearSelection }) => payload?.canManageAssignments && <AdminGridFooter
        compact allowMultiple addLabel="Добавить технику в проект" countLabel="Всего в проекте" count={visibleProjectUnitIds?.length ?? payload.units.length}
        deletingCount={selectedProjectUnitIds.length} deletingLabel="Убрать из проекта" editorOpen={Boolean(projectUnitDrafts.length)} pendingCount={projectUnitDrafts.length}
        selectedDraftCount={selectedDraftCount} saving={loading || saving || importing} canCreate={payload.canCreateAssignments} canUpdate={false} canDelete={payload.canDeleteAssignments}
        onAdd={() => { setProjectUnitDrafts(current => [{ key: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `project-equipment-${Date.now()}-${Math.random()}`, equipmentId: "" }, ...current]); setNotice(""); setError(""); }}
        onDelete={() => setDeleteConfirmationTarget("project")}
        onClearSelection={() => { clearSelection(); setNotice(""); setError(""); }}
        onRemoveSelectedDrafts={() => { const count = removeSelectedDrafts(); if (count) { setNotice(`Убрано новых строк: ${count}.`); setError(""); } }}
        onCancelEditing={() => { setProjectUnitDrafts([]); setNotice(""); setError(""); }} onSave={() => void assignProjectUnits()}
      />}
    />}

    {deleteConfirmationTarget === "daily" && <EquipmentDeleteConfirmation title="Удалить выбранные строки?" description={`Строки (${selectedEntryIds.length}) будут удалены из ежедневного отчёта техники. Это действие нельзя отменить.`} saving={saving} onCancel={() => setDeleteConfirmationTarget(null)} onConfirm={() => void deleteSelectedEntries()} />}
    {deleteConfirmationTarget === "registry" && <EquipmentDeleteConfirmation title="Удалить выбранную технику?" description={`Выбранная техника (${selectedUnitIds.length}) исчезнет из активного реестра и проектов. История ранее созданных отчётов сохранится.`} saving={saving} onCancel={() => setDeleteConfirmationTarget(null)} onConfirm={() => void deleteSelectedUnits()} />}
    {deleteConfirmationTarget === "project" && <EquipmentDeleteConfirmation title="Убрать выбранную технику из проекта?" description={`Выбранная техника (${selectedProjectUnitIds.length}) исчезнет только из текущего проекта. Общие карточки и история отчётов сохранятся.`} saving={saving} onCancel={() => setDeleteConfirmationTarget(null)} onConfirm={() => void removeSelectedProjectUnits()} />}

  </section>;
}
