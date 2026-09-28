"use client";
/* eslint-disable @next/next/no-img-element -- используется оригинальный SVG-логотип из TPS */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DirectoryAgGrid, EmployeeAgGrid, PlacementAgGrid, PositionAgGrid, ProjectAgGrid, ProjectEmployeeAgGrid, UserAgGrid, type GridEntry } from "./AgDataGrids";
import { formatBitrix24Cooldown, remainingBitrix24Cooldown, type Bitrix24Cooldowns } from "./bitrix24Cooldown";
import { CustomSelect } from "./CustomSelect";
import { ProjectCards } from "./ProjectCards";
import { UserAccessCards } from "./UserAccessCards";
import { ROLE_LABELS, canAccessGeneralSettings, canEditGlobalEmployees, canEditGlobalReferences, canEditProjectSettings, canManageBitrix24, canViewAllProjects, type UserRole } from "./roles";

type Option = { id: number; name: string };
type Site = Option & { code: string; timezone: string };
type Employee = { id: number; fullName: string; employmentType: string; department: string; position: string; source: string; bitrix24Stage: string; availabilityStatus: string; syncError: string | null; lastSyncedAt?: string | null; siteId: number | null; siteName: string | null };
type PositionRecord = { id: number; employmentType: string; department: string; position: string };
type AppUser = { id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; status?: "active" | "invited" };
type CurrentUser = { id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null };
type Entry = {
  id: number; siteId: number; workDate: string; employeeId: number; shiftId: number; zoneId: number;
  mainWorkTypeId: number; subworkTypeId: number; note: string; masterId: number; hours: number;
  positionSnapshot: string; employeeName: string; employmentType: string; department: string; shiftName: string;
  zoneName: string; mainWorkTypeName: string; subworkTypeName: string; masterName: string;
};
type DataSet = {
  sites: Site[]; employees: Employee[]; reportEmployees: Employee[]; placementEmployees: Employee[]; projectEmployees: Employee[]; positionCatalog: PositionRecord[]; employmentTypes: Option[]; departments: Option[]; positions: Option[]; shifts: Option[]; zones: Option[]; mainWorkTypes: Option[];
  subworkTypes: Option[]; masters: Option[]; entries: Entry[]; filledDates: string[]; users: AppUser[];
  reportSubmitted: boolean;
  syncStatus?: { id: number; status: string; startedAt: string; completedAt: string | null; summary: string | null; errorText: string | null } | null;
  bitrix24Cooldowns?: Bitrix24Cooldowns;
};
type DraftRow = {
  key: string; roster?: boolean; lockedEmployee?: boolean; carriedFromPreviousDay?: boolean; employeeId: string; employeeQuery: string; shiftId: string; zoneId: string;
  mainWorkTypeId: string; subworkTypeId: string; note: string; masterId: string; hours: string;
};
type View = "placement" | "employees" | "positions" | "projects" | "directories" | "settings" | "projectSettings" | "projectEmployees" | "users";
type UserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; assignedSiteId: string };
type EmployeeDraft = { key: string; id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string };
type EmployeeBulkChanges = { employmentType: string; department: string; position: string; projectSiteId: string };
type ProjectEmployeeDraft = { key: string; employeeId: string; employeeQuery: string };
type PositionDraft = { key: string; id?: number; employmentType: string; department: string; position: string };
type DirectoryEntity = "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";
type DirectoryFocus = "all" | "sites" | DirectoryEntity;
type DirectoryDraft = { key: string; id?: number; entity: DirectoryEntity; name: string; employeeId?: string };
type SiteDraft = { key: string; id?: number; name: string; code: string; timezone: string };

const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const newKey = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
function makeDraft(seed: Partial<DraftRow> = {}): DraftRow {
  return { key: newKey(), employeeId: "", employeeQuery: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", note: "", masterId: "", hours: "10", ...seed };
}
function makeEntryDraft(entry: Entry | GridEntry, lockedEmployee = false): DraftRow {
  return makeDraft({
    key: `entry-${entry.id}`,
    lockedEmployee,
    employeeId: String(entry.employeeId),
    employeeQuery: entry.employeeName,
    shiftId: String(entry.shiftId),
    zoneId: String(entry.zoneId),
    mainWorkTypeId: String(entry.mainWorkTypeId),
    subworkTypeId: String(entry.subworkTypeId),
    note: entry.note,
    masterId: String(entry.masterId),
    hours: String(entry.hours),
  });
}
function makeCarriedDraft(employee: Employee, entry: Entry, data: DataSet, roster: boolean): DraftRow {
  const available = (options: Option[], id: number) => options.some((option) => option.id === id) ? String(id) : "";
  return makeDraft({
    key: `previous-${employee.id}-${entry.id}`,
    roster,
    lockedEmployee: true,
    carriedFromPreviousDay: true,
    employeeId: String(employee.id),
    employeeQuery: employee.fullName,
    shiftId: available(data.shifts, entry.shiftId),
    zoneId: available(data.zones, entry.zoneId),
    mainWorkTypeId: available(data.mainWorkTypes, entry.mainWorkTypeId),
    subworkTypeId: available(data.subworkTypes, entry.subworkTypeId),
    masterId: available(data.masters, entry.masterId),
    hours: String(entry.hours),
    note: entry.note,
  });
}
function buildRosterDraftRows(data: DataSet, previousEntries: Entry[]) {
  if (data.reportSubmitted) return [];
  const savedEmployeeIds = new Set(data.entries.map((entry) => entry.employeeId));
  const employees = new Map(data.reportEmployees.map((employee) => [employee.id, employee]));
  const firstRowByEmployee = new Set<number>();
  return previousEntries.flatMap((entry) => {
    const employee = employees.get(entry.employeeId);
    if (!employee || savedEmployeeIds.has(employee.id)) return [];
    const roster = !firstRowByEmployee.has(employee.id);
    firstRowByEmployee.add(employee.id);
    return [makeCarriedDraft(employee, entry, data, roster)];
  });
}
function draftRowComplete(row: DraftRow) {
  return Boolean(row.employeeId && row.shiftId && row.zoneId && row.mainWorkTypeId && row.subworkTypeId && row.masterId && row.hours);
}
function draftRowHasWorkInput(row: DraftRow) {
  return Boolean(row.shiftId || row.zoneId || row.mainWorkTypeId || row.subworkTypeId || row.masterId || row.hours || row.note.trim());
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}
function directoryExcelHeader(entity: DirectoryEntity) {
  if (entity === "zone") return "Зона";
  if (entity === "mainWorkType") return "Вид работы";
  if (entity === "subworkType") return "Вид подработ";
  if (entity === "master") return "ФИО";
  return "Название";
}
const blankTemplateRows = Array.from({ length: 25 }, () => [""]);
const loadPlacementXlsx = () => import("./placementXlsx");
// Reversible presentation switch: the AG Grid implementation stays mounted in the fallback branch.
const useUserAccessCardLayout = true;
const useProjectCardLayout = true;
// Keep this switch so the checkpoint layout can be restored without changing the report data model.
const useDailyRosterReport = true;

function AppIcon({ name }: { name: "panel" | "calendar" | "pencil" | "trash" | "redo" | "check" | "pin" | "filter" | "user" }) {
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "panel" && <><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></>}
    {name === "calendar" && <><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></>}
    {name === "pencil" && <><path d="M21.2 6.8 7.8 20.2a2 2 0 0 1-.8.5L2.6 22a.5.5 0 0 1-.6-.6L3.3 17a2 2 0 0 1 .5-.8L17.2 2.8a2.8 2.8 0 0 1 4 4Z"/><path d="m15 5 4 4"/></>}
    {name === "trash" && <><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></>}
    {name === "redo" && <><path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h16"/></>}
    {name === "check" && <path d="m20 6-11 11-5-5"/>}
    {name === "pin" && <><path d="M12 17v5M5 8.5l4-4V2h6v2.5l4 4V11H5Z"/><path d="M8 11v3h8v-3"/></>}
    {name === "filter" && <path d="M3 5h18l-7 8v6l-4 2v-8Z"/>}
    {name === "user" && <><circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/></>}
  </svg>;
}

function SidebarChevron({ open }: { open: boolean }) {
  return <svg className={open ? "sidebar-chevron open" : "sidebar-chevron"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m7 9 5 5 5-5" />
  </svg>;
}

function ProjectSwitcher({ sites, value, onChange }: { sites: Site[]; value: number; onChange: (siteId: number) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = sites.find((site) => site.id === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <div className="project-switcher top-project-select" ref={root}>
    <button type="button" className="project-switcher-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label="Выбрать проект"><span>{selected?.name ?? "Выберите проект"}</span><SidebarChevron open={open} /></button>
    {open && <div className="project-switcher-menu" role="listbox" aria-label="Проекты"><div className="project-switcher-caption">Выберите проект</div>{sites.map((site) => <button type="button" role="option" aria-selected={site.id === value} className={site.id === value ? "selected" : ""} key={site.id} onClick={() => { onChange(site.id); setOpen(false); }}><span className="project-switcher-mark">{site.id === value ? "✓" : ""}</span><strong>{site.name}</strong></button>)}</div>}
  </div>;
}

function AdminGridFooter({ addLabel, countLabel, count, deletingCount, deletingLabel, editorOpen, editingExisting = false, pendingCount = 0, saving = false, allowMultiple = false, editSelectionLabel, bulkEditSelectionLabel, cancelEditingLabel = "Отменить редактирование", uniformActions = false, onAdd, onDelete, onEditSelection, onBulkEditSelection, onClearSelection, onCancelEditing, onSave }: { addLabel: string; countLabel: string; count: number; deletingCount: number; deletingLabel: string; editorOpen: boolean; editingExisting?: boolean; pendingCount?: number; saving?: boolean; allowMultiple?: boolean; editSelectionLabel?: string; bulkEditSelectionLabel?: string; cancelEditingLabel?: string; uniformActions?: boolean; onAdd: () => void; onDelete: () => void; onEditSelection?: () => void; onBulkEditSelection?: () => void; onClearSelection?: () => void; onCancelEditing?: () => void; onSave?: () => void }) {
  const showAdd = !editingExisting && deletingCount === 0 && (allowMultiple || !editorOpen);
  if (uniformActions) return <div className="table-edit-footer employee-table-footer uniform-footer-actions">
    {deletingCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{deletingCount}</strong></span></div>
      <div className="employee-selection-actions">
        {onEditSelection && <button type="button" className="employee-action-button employee-action-primary" onClick={onEditSelection} disabled={saving}>{editSelectionLabel ?? "Редактировать"}</button>}
        {onBulkEditSelection && <button type="button" className="employee-action-button bulk-edit-selection-button" onClick={onBulkEditSelection} disabled={saving}>{bulkEditSelectionLabel ?? "Массовое редактирование"}</button>}
        <button type="button" className="employee-action-button employee-action-danger" onClick={onDelete} disabled={saving}>{deletingLabel}</button>
        {onClearSelection && <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>}
      </div>
    </div>}
    {pendingCount > 0 && <div className="employee-editing-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Редактируется: <strong>{pendingCount}</strong></span></div>
      <div className="employee-selection-actions">
        {onCancelEditing && <button type="button" className="employee-action-button cancel-editing-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}
        {onSave && <button type="button" className="employee-action-button employee-save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button>}
      </div>
    </div>}
    <div className="employee-footer-base">
      {showAdd && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>}
      <span className="employee-total-count">{countLabel}: <strong>{count}</strong></span>
    </div>
  </div>;
  return <div className="table-edit-footer employee-table-footer">{showAdd && <button type="button" className="secondary-button footer-action-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>}<div>{deletingCount > 0 && <div className="selection-actions">{onEditSelection && <button type="button" className="save-edits-button" onClick={onEditSelection} disabled={saving}>{`${editSelectionLabel ?? "Редактировать"} (${deletingCount})`}</button>}{onBulkEditSelection && <button type="button" className="save-edits-button" onClick={onBulkEditSelection} disabled={saving}>{`${bulkEditSelectionLabel ?? "Массовое редактирование"} (${deletingCount})`}</button>}<button type="button" className="delete-rows-button" onClick={onDelete} disabled={saving}>{`${deletingLabel} (${deletingCount})`}</button>{onClearSelection && <button type="button" className="secondary-button footer-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Отменить выделение</button>}</div>}<span>{countLabel}: <strong>{count}</strong></span>{pendingCount > 0 && onCancelEditing && <button type="button" className="secondary-button footer-action-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}{pendingCount > 0 && onSave && <button type="button" className="save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : `Сохранить (${pendingCount})`}</button>}</div></div>;
}

function ReportGridFooter({ selectedCount, editingCount, newCount, totalHours, canEdit, saving, onAdd, onEditSelection, onDelete, onClearSelection, onCancelEditing, onSaveEditing, onSaveNew }: { selectedCount: number; editingCount: number; newCount: number; totalHours: number; canEdit: boolean; saving: boolean; onAdd: () => void; onEditSelection: () => void; onDelete: () => void; onClearSelection: () => void; onCancelEditing: () => void; onSaveEditing: () => void; onSaveNew: () => void }) {
  const changedCount = editingCount + newCount;
  return <div className="table-edit-footer employee-table-footer uniform-footer-actions report-table-footer">
    {selectedCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedCount}</strong></span></div>
      <div className="employee-selection-actions">
        <button type="button" className="employee-action-button employee-action-primary" onClick={onEditSelection} disabled={saving}>Редактировать</button>
        <button type="button" className="employee-action-button employee-action-danger" onClick={onDelete} disabled={saving}>Удалить строки</button>
        <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>
      </div>
    </div>}
    {changedCount > 0 && <div className="employee-editing-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Редактируется: <strong>{changedCount}</strong></span></div>
      <div className="employee-selection-actions">
        <button type="button" className="employee-action-button cancel-editing-button" onClick={onCancelEditing} disabled={saving}>Отменить редактирование</button>
        {editingCount > 0 && <button type="button" className="employee-action-button employee-save-button" onClick={onSaveEditing} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button>}
        {newCount > 0 && <button type="button" className="employee-action-button employee-save-button" onClick={onSaveNew} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить новые строки"}</button>}
      </div>
    </div>}
    <div className="employee-footer-base">
      {editingCount === 0 && selectedCount === 0 && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!canEdit}>Добавить запись</button>}
      <span className="employee-total-count">Общее количество часов ОПР: <strong>{totalHours}</strong></span>
    </div>
  </div>;
}

function RosterReportFooter({ completed, total, readyNew, incompleteTouched, selectedCount, totalHours, saving, onAdd, onRemoveSelection, onClearSelection, onReset, onSave }: { completed: number; total: number; readyNew: number; incompleteTouched: number; selectedCount: number; totalHours: number; saving: boolean; onAdd: () => void; onRemoveSelection: () => void; onClearSelection: () => void; onReset: () => void; onSave: () => void }) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const remaining = Math.max(0, total - completed);
  const progressText = !total ? "Сотрудники пока не добавлены" : remaining ? `Осталось заполнить: ${remaining}` : "Все сотрудники заполнены";
  return <div className="table-edit-footer employee-table-footer uniform-footer-actions report-table-footer roster-report-footer">
    {selectedCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedCount}</strong></span></div>
      <div className="employee-selection-actions">
        <button type="button" className="employee-action-button employee-action-danger" onClick={onRemoveSelection} disabled={saving}>Убрать из отчёта</button>
        <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>
      </div>
    </div>}
    <div className="roster-report-progress">
      <div className="roster-progress-copy"><strong>Заполнено сотрудников: {completed} из {total}</strong><span>{progressText}{readyNew ? ` · готово строк: ${readyNew}` : ""}{incompleteTouched ? ` · незавершённых строк: ${incompleteTouched}` : ""}</span></div>
      <div className="roster-progress-track" role="progressbar" aria-label="Заполнение отчёта" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}><span style={{ width: `${percent}%` }} /></div>
      <span className="roster-progress-percent">{percent}%</span>
    </div>
    <div className="employee-editing-bar roster-save-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Проверьте состав и исправьте только изменения за сегодня</span></div>
      <div className="employee-selection-actions">
        <button type="button" className="employee-action-button cancel-editing-button" onClick={onReset} disabled={saving}>Вернуть исходные данные</button>
        <button type="button" className="employee-action-button employee-save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить проверенный отчёт"}</button>
      </div>
    </div>
    <div className="employee-footer-base">
      <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={saving}>Добавить сотрудника</button>
      <span className="employee-total-count">Общее количество часов ОПР: <strong>{totalHours}</strong></span>
    </div>
  </div>;
}

function AdminDeleteConfirmation({ title, text: description, saving, onCancel, onConfirm }: { title: string; text: string; saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2><p>{description}</p><div><button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={onConfirm} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function toDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function moveDate(value: string, days: number) {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function ReportDateNavigation({ dates, value, today, filledDates, onChange, onRangeChange }: { dates: string[]; value: string; today: string; filledDates: Set<string>; onChange: (value: string) => void; onRangeChange: (rangeEnd: string) => void }) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [rangeMotion, setRangeMotion] = useState<"older" | "newer" | "calendar" | "">("");
  const [visibleMonth, setVisibleMonth] = useState(() => { const selected = parseDateKey(value); return new Date(selected.getFullYear(), selected.getMonth(), 1, 12); });
  const root = useRef<HTMLDivElement>(null);
  const quickDates = useRef<HTMLDivElement>(null);
  const selected = parseDateKey(value);
  const maximum = parseDateKey(today);
  const firstWeekday = (visibleMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday + daysInMonth }, (_, index) => index < firstWeekday ? null : index - firstWeekday + 1);
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
    <div className="report-date-bar" role="group" aria-label="Дата отчёта">
      <button type="button" className="date-step" aria-label="Показать пять более ранних дней" onClick={() => { setRangeMotion("older"); onRangeChange(moveDate(rangeEnd, -5)); }}>‹</button>
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
      <button type="button" className="date-step" aria-label="Показать пять более новых дней" disabled={rangeEnd >= today} onClick={() => { setRangeMotion("newer"); onRangeChange(moveDate(rangeEnd, 5)); }}>›</button>
      <button type="button" className="calendar-trigger" onClick={toggleCalendar} aria-label="Открыть календарь" aria-expanded={calendarOpen}><AppIcon name="calendar" /></button>
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

export default function PersonnelApp({ initialToday, currentUser }: { initialToday: string; currentUser: CurrentUser }) {
  const role = currentUser.role;
  const mayEditGlobalEmployees = canEditGlobalEmployees(role);
  const mayAccessGeneralSettings = canAccessGeneralSettings(role);
  const mayEditGlobalReferences = canEditGlobalReferences(role);
  const mayEditProjectSettings = canEditProjectSettings(role);
  const mayManageBitrix24 = canManageBitrix24(role);
  const mayViewAllProjects = canViewAllProjects(role);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reportsOpen, setReportsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [view, setView] = useState<View>("placement");
  const [siteId, setSiteId] = useState(currentUser.assignedSiteId ?? 1);
  const [workDate, setWorkDate] = useState(initialToday);
  const [reportRangeEnd, setReportRangeEnd] = useState(initialToday);
  const [data, setData] = useState<DataSet | null>(null);
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [editingRows, setEditingRows] = useState<{ id: number; row: DraftRow }[]>([]);
  const [previousDayReport, setPreviousDayReport] = useState<{ key: string; date: string; entries: Entry[] } | null>(null);
  const [selectedRosterDraftKeys, setSelectedRosterDraftKeys] = useState<string[]>([]);
  const [visibleEntryIds, setVisibleEntryIds] = useState<number[] | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<number[]>([]);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncingBitrix24, setSyncingBitrix24] = useState(false);
  const [bitrix24Clock, setBitrix24Clock] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [invitationResults, setInvitationResults] = useState<Array<{ email: string; url: string }>>([]);
  const [userDrafts, setUserDrafts] = useState<UserDraft[]>([]);
  const [employeeDrafts, setEmployeeDrafts] = useState<EmployeeDraft[]>([]);
  const [employeePendingDeletes, setEmployeePendingDeletes] = useState<number[]>([]);
  const [employeeFullRowEditIds, setEmployeeFullRowEditIds] = useState<number[]>([]);
  const [employeeDeleteConfirmationOpen, setEmployeeDeleteConfirmationOpen] = useState(false);
  const [employeeBulkEditOpen, setEmployeeBulkEditOpen] = useState(false);
  const [employeeBulkChanges, setEmployeeBulkChanges] = useState<EmployeeBulkChanges>({ employmentType: "", department: "", position: "", projectSiteId: "" });
  const [employeeBulkEditError, setEmployeeBulkEditError] = useState("");
  const [employeeVisibleIds, setEmployeeVisibleIds] = useState<number[] | null>(null);
  const [projectEmployeeDrafts, setProjectEmployeeDrafts] = useState<ProjectEmployeeDraft[]>([]);
  const [projectEmployeePendingDeletes, setProjectEmployeePendingDeletes] = useState<number[]>([]);
  const [projectEmployeeDeleteConfirmationOpen, setProjectEmployeeDeleteConfirmationOpen] = useState(false);
  const [positionDrafts, setPositionDrafts] = useState<PositionDraft[]>([]);
  const [positionPendingDeletes, setPositionPendingDeletes] = useState<number[]>([]);
  const [positionFullRowEditIds, setPositionFullRowEditIds] = useState<number[]>([]);
  const [positionDeleteConfirmationOpen, setPositionDeleteConfirmationOpen] = useState(false);
  const [positionVisibleIds, setPositionVisibleIds] = useState<number[] | null>(null);
  const [directoryDrafts, setDirectoryDrafts] = useState<DirectoryDraft[]>([]);
  const [directoryPendingDeletes, setDirectoryPendingDeletes] = useState<number[]>([]);
  const [directoryDeleteConfirmationOpen, setDirectoryDeleteConfirmationOpen] = useState(false);
  const [siteDrafts, setSiteDrafts] = useState<SiteDraft[]>([]);
  const [userPendingDeletes, setUserPendingDeletes] = useState<number[]>([]);
  const [userFullRowEditIds, setUserFullRowEditIds] = useState<number[]>([]);
  const [userDeleteConfirmationOpen, setUserDeleteConfirmationOpen] = useState(false);
  const [sitePendingDeletes, setSitePendingDeletes] = useState<number[]>([]);
  const [siteFullRowEditIds, setSiteFullRowEditIds] = useState<number[]>([]);
  const [siteDeleteConfirmationOpen, setSiteDeleteConfirmationOpen] = useState(false);
  const [directoryFocus, setDirectoryFocus] = useState<DirectoryFocus>("all");
  const fileInput = useRef<HTMLInputElement>(null);
  const employeeFileInput = useRef<HTMLInputElement>(null);
  const positionFileInput = useRef<HTMLInputElement>(null);
  const projectEmployeeFileInput = useRef<HTMLInputElement>(null);
  const projectDirectoryFileInput = useRef<HTMLInputElement>(null);
  const loadedSiteId = useRef<number | null>(null);
  const loadedWorkDate = useRef<string | null>(null);
  const loadedReportRange = useRef<string | null>(null);
  const initializedRosterSession = useRef<string | null>(null);
  const adminDataLoaded = useRef(false);
  const recentDates = useMemo(() => recentDateKeys(reportRangeEnd), [reportRangeEnd]);
  const reportRangeQuery = `rangeStart=${recentDates[0]}&rangeEnd=${reportRangeEnd}`;
  const filledDates = useMemo(() => new Set(data?.filledDates ?? []), [data?.filledDates]);
  const activeSite = data?.sites.find((site) => site.id === siteId);
  const visibleEmployees = data?.employees ?? [];
  const visibleProjectEmployees = data?.projectEmployees ?? data?.placementEmployees ?? [];
  const visiblePositions = data?.positionCatalog ?? [];
  const visibleUsers = data?.users ?? [];
  const visibleSites = data?.sites ?? [];
  const inspectBitrix24Remaining = remainingBitrix24Cooldown(data?.bitrix24Cooldowns?.inspect.nextAllowedAt, bitrix24Clock);
  const syncBitrix24Remaining = remainingBitrix24Cooldown(data?.bitrix24Cooldowns?.sync.nextAllowedAt, bitrix24Clock);
  const inspectBitrix24Title = inspectBitrix24Remaining > 0
    ? `Повторная проверка будет доступна через ${formatBitrix24Cooldown(inspectBitrix24Remaining)}.`
    : "Проверяет подключение, стадии и объекты в Битрикс24 без изменения данных.";
  const syncBitrix24Title = syncBitrix24Remaining > 0
    ? `Повторная актуализация будет доступна через ${formatBitrix24Cooldown(syncBitrix24Remaining)}.`
    : "Загружает актуальные данные сотрудников из Битрикс24 в систему.";

  useEffect(() => {
    if (!mayManageBitrix24 || view !== "employees") return;
    const refreshTimeout = window.setTimeout(() => setBitrix24Clock(Date.now()), 0);
    const interval = window.setInterval(() => setBitrix24Clock(Date.now()), 60_000);
    const deadlines = [data?.bitrix24Cooldowns?.inspect.nextAllowedAt, data?.bitrix24Cooldowns?.sync.nextAllowedAt]
      .flatMap((value) => value ? [new Date(value).getTime()] : []).filter((value) => Number.isFinite(value) && value > Date.now());
    const timeout = deadlines.length
      ? window.setTimeout(() => setBitrix24Clock(Date.now()), Math.min(...deadlines.map((deadline) => deadline - Date.now())) + 50)
      : undefined;
    return () => { window.clearTimeout(refreshTimeout); window.clearInterval(interval); if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [data?.bitrix24Cooldowns?.inspect.nextAllowedAt, data?.bitrix24Cooldowns?.sync.nextAllowedAt, mayManageBitrix24, view]);
  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&${reportRangeQuery}`, { cache: "no-store" });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as DataSet & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить данные.");
      setData(payload);
      loadedSiteId.current = siteId;
      loadedWorkDate.current = workDate;
      loadedReportRange.current = reportRangeQuery;
      adminDataLoaded.current = true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить данные.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=workspace&${reportRangeQuery}`, { cache: "no-store" });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as DataSet & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить рабочее пространство.");
      setData(payload);
      loadedSiteId.current = siteId;
      loadedWorkDate.current = workDate;
      loadedReportRange.current = reportRangeQuery;
      adminDataLoaded.current = false;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить рабочее пространство.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=entries&${reportRangeQuery}`, { cache: "no-store" });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as Pick<DataSet, "entries" | "filledDates" | "reportSubmitted"> & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить отчёт.");
      setData((current) => current ? { ...current, entries: payload.entries, filledDates: payload.filledDates, reportSubmitted: payload.reportSubmitted } : current);
      loadedWorkDate.current = workDate;
      loadedReportRange.current = reportRangeQuery;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить отчёт.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  useEffect(() => {
    const loader = loadedSiteId.current !== siteId
      ? view === "placement" ? loadWorkspace : loadData
      : view !== "placement" && !adminDataLoaded.current
        ? loadData
        : view === "placement" && (loadedWorkDate.current !== workDate || loadedReportRange.current !== reportRangeQuery)
          ? loadEntries
          : null;
    if (!loader) return;
    const task = window.setTimeout(() => void loader(), 0);
    return () => window.clearTimeout(task);
  }, [siteId, workDate, view, reportRangeQuery, loadData, loadEntries, loadWorkspace]);

  const filteredEntries = data?.entries ?? [];
  const exportEntries = visibleEntryIds === null
    ? filteredEntries
    : filteredEntries.filter((entry) => visibleEntryIds.includes(entry.id));
  const savedOprHours = exportEntries
    .filter((entry) => normalize(entry.employmentType) === "опр")
    .reduce((sum, entry) => sum + entry.hours, 0);
  const pendingCount = draftRows.length;
  const editingCount = editingRows.length;
  const canEditDate = role !== "foreman" || workDate === initialToday;
  const rosterMode = useDailyRosterReport && workDate === initialToday && canEditDate;
  const entryTypeById = new Map(filteredEntries.map((entry) => [entry.id, entry.employmentType]));
  const employeeTypeById = new Map((data?.reportEmployees ?? []).map((employee) => [employee.id, employee.employmentType]));
  const rosterOprHours = [
    ...editingRows.map((item) => ({ row: item.row, employmentType: entryTypeById.get(item.id) ?? "" })),
    ...draftRows.map((row) => ({ row, employmentType: employeeTypeById.get(Number(row.employeeId)) ?? "" })),
  ].filter((item) => draftRowComplete(item.row) && normalize(item.employmentType) === "опр")
    .reduce((sum, item) => sum + Number(item.row.hours), 0);
  const totalOprHours = rosterMode ? rosterOprHours : savedOprHours;
  const completedRosterEmployeeIds = new Set([
    ...filteredEntries.map((entry) => entry.employeeId),
    ...editingRows.filter((item) => draftRowComplete(item.row)).map((item) => Number(item.row.employeeId)),
    ...draftRows.filter(draftRowComplete).map((row) => Number(row.employeeId)),
  ]);
  const rosterEmployeeIds = new Set([...editingRows.map((item) => Number(item.row.employeeId)), ...draftRows.map((row) => Number(row.employeeId))].filter(Boolean));
  const rosterTotal = rosterEmployeeIds.size;
  const rosterCompleted = [...rosterEmployeeIds].filter((employeeId) => completedRosterEmployeeIds.has(employeeId)).length;
  const rosterIncompleteTouched = draftRows.filter((row) => !draftRowComplete(row) && draftRowHasWorkInput(row)).length;
  const rosterReadyNew = draftRows.filter(draftRowComplete).length;
  const rosterCopiedRows = draftRows.filter((row) => row.carriedFromPreviousDay).length;
  const previousDayDate = moveDate(workDate, -1);
  const rosterSessionKey = `${siteId}:${workDate}`;
  const previousDayLoading = rosterMode && previousDayReport?.key !== rosterSessionKey;

  useEffect(() => {
    if (!rosterMode || view !== "placement") return;
    const controller = new AbortController();
    const previousDate = moveDate(workDate, -1);
    const key = `${siteId}:${workDate}`;
    void fetch(`/api/data?siteId=${siteId}&date=${previousDate}&scope=entries&rangeStart=${previousDate}&rangeEnd=${previousDate}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { window.location.replace("/login"); return null; }
        const payload = await response.json() as Pick<DataSet, "entries"> & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить вчерашний отчёт.");
        return payload.entries;
      })
      .then((entries) => { if (entries) setPreviousDayReport({ key, date: previousDate, entries }); })
      .catch((carryError) => {
        if (carryError instanceof DOMException && carryError.name === "AbortError") return;
        setPreviousDayReport({ key, date: previousDate, entries: [] });
        setError(carryError instanceof Error ? carryError.message : "Не удалось загрузить вчерашний отчёт.");
      });
    return () => controller.abort();
  }, [rosterMode, siteId, view, workDate]);

  useEffect(() => {
    if (!rosterMode || view !== "placement" || loading || previousDayLoading || !data || loadedWorkDate.current !== workDate || previousDayReport?.key !== rosterSessionKey) return;
    const rosterSession = rosterSessionKey;
    const preserveManualRows = initializedRosterSession.current === rosterSession;
    initializedRosterSession.current = rosterSession;
    setEditingRows(data.entries.map((entry) => ({ id: entry.id, row: makeEntryDraft(entry, true) })));
    setDraftRows((current) => {
      const initialRows = buildRosterDraftRows(data, previousDayReport.entries);
      if (!preserveManualRows) return initialRows;
      return current;
    });
    setSelectedRosterDraftKeys([]);
    setPendingDeletes([]);
    setDeleteConfirmationOpen(false);
  }, [data, loading, previousDayLoading, previousDayReport, rosterMode, rosterSessionKey, view, workDate]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  }
  function openProfile() {
    setCurrentPassword(""); setNewPassword(""); setRepeatPassword(""); setProfileError(""); setProfileNotice(""); setProfileOpen(true);
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setProfileError(""); setProfileNotice("");
    if (newPassword !== repeatPassword) { setProfileError("Новые пароли не совпадают."); return; }
    setProfileSaving(true);
    try {
      const response = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      const result = await response.json() as { error?: string };
      if (response.status === 401) { window.location.replace("/login"); return; }
      if (!response.ok) throw new Error(result.error ?? "Не удалось изменить пароль.");
      setCurrentPassword(""); setNewPassword(""); setRepeatPassword(""); setProfileNotice("Пароль изменён. Остальные сеансы завершены.");
    } catch (passwordError) {
      setProfileError(passwordError instanceof Error ? passwordError.message : "Не удалось изменить пароль.");
    } finally { setProfileSaving(false); }
  }
  function changeSite(nextSiteId: number) {
    setSiteId(nextSiteId); setDraftRows([]); setEditingRows([]); setPreviousDayReport(null); setSelectedRosterDraftKeys([]); setPendingDeletes([]); setDeleteConfirmationOpen(false);
    setProjectEmployeeDrafts([]); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false);
    setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false);
  }
  function changeWorkDate(nextDate: string) {
    setWorkDate(nextDate); setDraftRows([]); setEditingRows([]); setPreviousDayReport(null); setSelectedRosterDraftKeys([]); setPendingDeletes([]); setDeleteConfirmationOpen(false); setVisibleEntryIds(null);
  }
  function changeReportRange(nextEnd: string) {
    setReportRangeEnd(nextEnd > initialToday ? initialToday : nextEnd);
  }

  function patchDraft(key: string, changes: Partial<DraftRow>) {
    setDraftRows((rows) => rows.map((row) => row.key === key ? { ...row, ...changes } : row));
    setError("");
  }
  function patchEditing(id: number, changes: Partial<DraftRow>) {
    setEditingRows((current) => current.map((item) => item.id === id ? { ...item, row: { ...item.row, ...changes } } : item));
    setError("");
  }
  function startEdit(entry: GridEntry, changes: Partial<DraftRow> = {}) {
    if (!canEditDate || draftRows.length || pendingDeletes.includes(entry.id)) return;
    setPendingDeletes([]);
    setEditingRows((current) => {
      const existing = current.find((item) => item.id === entry.id);
      if (existing) return current.map((item) => item.id === entry.id ? { ...item, row: { ...item.row, ...changes } } : item);
      return [...current, { id: entry.id, row: { ...makeEntryDraft(entry), ...changes } }];
    });
    setNotice("");
  }
  function changeReportSelection(ids: number[]) {
    if (!canEditDate) return;
    setPendingDeletes(ids);
    if (!rosterMode) setEditingRows((current) => current.filter((item) => !ids.includes(item.id)));
    setError("");
    setNotice("");
  }
  function editSelectedReportRows() {
    if (draftRows.length) return;
    const selected = filteredEntries.filter((entry) => pendingDeletes.includes(entry.id));
    if (!selected.length) return;
    const edits = selected.map((entry) => ({
      id: entry.id,
      row: makeEntryDraft(entry),
    }));
    setEditingRows((current) => {
      const selectedIds = new Set(edits.map((item) => item.id));
      return [...current.filter((item) => !selectedIds.has(item.id)), ...edits];
    });
    setPendingDeletes([]);
    setError("");
    setNotice(`Открыто редактирование строк: ${selected.length}.`);
  }
  function cancelReportEditing() {
    if (rosterMode && data) {
      setEditingRows(data.entries.map((entry) => ({ id: entry.id, row: makeEntryDraft(entry, true) })));
      setDraftRows(buildRosterDraftRows(data, previousDayReport?.key === rosterSessionKey ? previousDayReport.entries : []));
    } else {
      setEditingRows([]);
      setDraftRows([]);
    }
    setSelectedRosterDraftKeys([]);
    setPendingDeletes([]);
    setError("");
    setNotice("");
  }
  function addRow(seed: Partial<DraftRow> = {}) {
    if (!canEditDate || (!rosterMode && editingRows.length)) return;
    setDraftRows((rows) => [...rows, makeDraft(seed)]);
    setNotice("");
  }
  function removeSelectedRosterRows() {
    if (selectedRosterDraftKeys.length) {
      const selected = new Set(selectedRosterDraftKeys);
      setDraftRows((rows) => rows.filter((row) => !selected.has(row.key)));
      setSelectedRosterDraftKeys([]);
    }
    if (pendingDeletes.length) setDeleteConfirmationOpen(true);
    setError("");
    setNotice("");
  }
  function payload(row: DraftRow) {
    return { siteId, workDate, employeeId: Number(row.employeeId), shiftId: Number(row.shiftId), zoneId: Number(row.zoneId), mainWorkTypeId: Number(row.mainWorkTypeId), subworkTypeId: Number(row.subworkTypeId), masterId: Number(row.masterId), hours: Number(row.hours), note: row.note };
  }
  function validateRows(rows: DraftRow[]) {
    const invalid = rows.findIndex((row) => !row.employeeId || !row.shiftId || !row.zoneId || !row.mainWorkTypeId || !row.subworkTypeId || !row.masterId || !row.hours);
    if (invalid >= 0) throw new Error(`Строка ${invalid + 1}: заполните все обязательные поля.`);
  }
  async function savePending() {
    if (!pendingCount) return;
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows(draftRows);
      if (draftRows.length) {
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: draftRows.map(payload) }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить новые строки.");
      }
      const count = pendingCount;
      setDraftRows([]); setNotice(`Добавлено записей: ${count}`);
      await loadEntries();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить данные."); }
    finally { setSaving(false); }
  }
  async function saveRosterReport() {
    const incompleteTouched = draftRows.filter((row) => !draftRowComplete(row) && draftRowHasWorkInput(row));
    if (incompleteTouched.length) {
      const first = draftRows.indexOf(incompleteTouched[0]) + filteredEntries.length + 1;
      setError(`Строка ${first}: заполните смену, зону, работу, вид подработ, мастера и часы либо очистите строку.`);
      return;
    }
    const newRows = draftRows.filter(draftRowComplete);
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows(editingRows.map((item) => item.row));
      validateRows(newRows);
      const response = await fetch("/api/data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: editingRows.map((item) => ({ id: item.id, ...payload(item.row) })),
          newEntries: newRows.map(payload),
          finalizeReport: { siteId, workDate },
        }),
      });
      const result = await response.json() as { error?: string; updatedCount?: number; createdCount?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить отчёт.");
      const updated = result.updatedCount ?? editingRows.length;
      const created = result.createdCount ?? newRows.length;
      setDraftRows([]);
      setSelectedRosterDraftKeys([]);
      const summary = [created ? `добавлено строк: ${created}` : "", updated ? `обновлено строк: ${updated}` : ""].filter(Boolean).join(", ");
      setNotice(summary ? summary.replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU")) : "Отчёт сохранён без рабочих за этот день.");
      await loadEntries();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отчёт."); }
    finally { setSaving(false); }
  }
  async function saveEditing() {
    if (!editingRows.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows(editingRows.map((item) => item.row));
      const response = await fetch("/api/data", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: editingRows.map((item) => ({ id: item.id, ...payload(item.row) })) }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить изменения.");
      const count = result.count ?? editingRows.length;
      setEditingRows([]); setNotice(`Изменено записей: ${count}`); await loadEntries();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить изменения."); }
    finally { setSaving(false); }
  }
  async function deletePendingEntries() {
    if (!pendingDeletes.length) return;
    const count = pendingDeletes.length;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: pendingDeletes }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось удалить выбранные строки.");
      setPendingDeletes([]); setDeleteConfirmationOpen(false); setNotice(`Удалено строк: ${count}`); await loadEntries();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить выбранные строки."); }
    finally { setSaving(false); }
  }
  function patchUserDraft(key: string, changes: Partial<UserDraft>) {
    setUserDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }
  function editUserRow(user: AppUser, changes: Partial<UserDraft> = {}) {
    setUserPendingDeletes([]);
    setUserDrafts((current) => {
      if (current.some((draft) => !draft.id)) return current;
      const existing = current.find((draft) => draft.id === user.id);
      if (existing) return current.map((draft) => draft.id === user.id ? { ...draft, ...changes } : draft);
      return [...current, { key: `user-${user.id}`, id: user.id, fullName: user.fullName, email: user.email, role: user.role, assignedSiteId: user.assignedSiteId ? String(user.assignedSiteId) : "", ...changes }];
    });
    setNotice("");
  }
  function changeUserSelection(ids: number[]) {
    setUserPendingDeletes(ids);
    setUserDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id)));
    setUserFullRowEditIds((current) => current.filter((id) => !ids.includes(id)));
    setNotice("");
  }
  function editSelectedUserRows() {
    if (userDrafts.some((draft) => !draft.id)) return;
    const selected = visibleUsers.filter((user) => userPendingDeletes.includes(user.id));
    selected.forEach((user) => editUserRow(user));
    setUserFullRowEditIds((current) => [...new Set([...current, ...selected.map((user) => user.id)])]);
    setUserPendingDeletes([]);
    setNotice(selected.length ? `Открыто редактирование пользователей: ${selected.length}.` : "");
  }
  function cancelUserEditing() {
    setUserDrafts([]);
    setUserFullRowEditIds([]);
    setError("");
    setNotice("");
  }
  async function saveUsers() {
    if (!userDrafts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const editedIds = new Set(userDrafts.flatMap((draft) => draft.id ? [draft.id] : []));
      const usedEmails = new Set(visibleUsers.filter((user) => !editedIds.has(user.id)).map((user) => normalize(user.email)));
      userDrafts.forEach((draft, index) => {
        const email = draft.email.trim().toLocaleLowerCase();
        if (!draft.fullName.trim() || !/^\S+@\S+\.\S+$/.test(email) || (draft.role === "foreman" && !Number(draft.assignedSiteId))) throw new Error(`Строка ${index + 1}: заполните ФИО, корректный email, роль и проект прораба.`);
        if (usedEmails.has(normalize(email))) throw new Error(`Строка ${index + 1}: пользователь с email «${email}» уже есть в списке.`);
        usedEmails.add(normalize(email));
      });
      const invitations: Array<{ email: string; url: string }> = [];
      for (let index = 0; index < userDrafts.length; index += 1) {
        const draft = userDrafts[index];
        const response = await fetch("/api/data", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: draft.id ? "update-user" : "create-user", userId: draft.id, fullName: draft.fullName, email: draft.email, role: draft.role, assignedSiteId: draft.role === "foreman" ? Number(draft.assignedSiteId) : null }) });
        const result = await response.json() as { error?: string; invitationUrl?: string; emailSent?: boolean };
        if (!response.ok) throw new Error(`Строка ${index + 1}: ${result.error ?? "не удалось сохранить пользователя"}.`);
        if (result.invitationUrl && !result.emailSent) {
          invitations.push({ email: draft.email, url: result.invitationUrl });
          setInvitationResults([...invitations]);
        }
        setUserDrafts((current) => current.filter((item) => item.key !== draft.key));
        if (draft.id) setUserFullRowEditIds((current) => current.filter((id) => id !== draft.id));
      }
      const added = userDrafts.filter((draft) => !draft.id).length;
      const updated = userDrafts.length - added;
      setInvitationResults(invitations);
      setNotice([added ? `добавлено: ${added}` : "", updated ? `изменено: ${updated}` : "", invitations.length ? `ссылок приглашения: ${invitations.length}` : ""].filter(Boolean).join(", ").replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU")));
      await loadData();
    } catch (userError) { await loadData(); setError(userError instanceof Error ? userError.message : "Не удалось сохранить пользователей."); }
    finally { setSaving(false); }
  }
  async function deletePendingUsers() {
    if (!userPendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      for (const id of userPendingDeletes) {
        const response = await fetch(`/api/data?entity=user&id=${id}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось удалить пользователя.");
      }
      const count = userPendingDeletes.length;
      setUserPendingDeletes([]); setUserDeleteConfirmationOpen(false); setNotice(`Удалено пользователей: ${count}`); await loadData();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить пользователей."); }
    finally { setSaving(false); }
  }
  function patchEmployeeDraft(key: string, changes: Partial<EmployeeDraft>) {
    setEmployeeDrafts((current) => current.map((draft) => {
      if (draft.key !== key) return draft;
      const nextDraft = { ...draft, ...changes };
      if (changes.position === undefined) return nextDraft;
      const catalogPosition = (data?.positionCatalog ?? []).find((item) => normalize(item.position) === normalize(changes.position ?? ""));
      return catalogPosition ? { ...nextDraft, employmentType: catalogPosition.employmentType, department: catalogPosition.department } : nextDraft;
    }));
    setError("");
  }
  function editSelectedEmployeeRows() {
    if (employeeDrafts.some((draft) => !draft.id)) return;
    const selected = visibleEmployees.filter((employee) => employeePendingDeletes.includes(employee.id));
    if (!selected.length) return;
    const edits = selected.map((employee) => ({ key: `employee-${employee.id}`, id: employee.id, fullName: employee.fullName, employmentType: employee.employmentType, department: employee.department, position: employee.position, projectSiteId: employee.siteId ? String(employee.siteId) : "" } satisfies EmployeeDraft));
    setEmployeeDrafts((current) => {
      const selectedIds = new Set(edits.map((draft) => draft.id));
      return [...current.filter((draft) => !draft.id || !selectedIds.has(draft.id)), ...edits];
    });
    setEmployeeFullRowEditIds((current) => [...new Set([...current, ...selected.map((employee) => employee.id)])]);
    setEmployeePendingDeletes([]);
    setEmployeeBulkEditOpen(false);
    setError("");
    setNotice(`Открыто редактирование сотрудников: ${selected.length}.`);
  }
  function cancelEmployeeDraft(key: string) {
    const employeeId = employeeDrafts.find((draft) => draft.key === key)?.id;
    setEmployeeDrafts((current) => current.filter((draft) => draft.key !== key));
    if (employeeId) setEmployeeFullRowEditIds((current) => current.filter((id) => id !== employeeId));
  }
  function cancelEmployeeEditing() {
    setEmployeeDrafts([]);
    setEmployeeFullRowEditIds([]);
    setEmployeeBulkEditOpen(false);
    setEmployeeBulkEditError("");
    setError("");
    setNotice("");
  }
  function openEmployeeBulkEdit() {
    if (!employeePendingDeletes.length) return;
    setEmployeeBulkChanges({ employmentType: "", department: "", position: "", projectSiteId: "" });
    setEmployeeBulkEditError("");
    setEmployeeBulkEditOpen(true);
  }
  function applyEmployeeBulkEdit() {
    const hasChanges = Object.values(employeeBulkChanges).some(Boolean);
    if (!hasChanges) { setEmployeeBulkEditError("Выберите хотя бы одно поле, которое нужно изменить."); return; }
    const selected = visibleEmployees.filter((employee) => employeePendingDeletes.includes(employee.id));
    if (!selected.length) { setEmployeeBulkEditError("Выбранные сотрудники не найдены в текущей таблице."); return; }
    try {
      const validPositionCombinations = new Set((data?.positionCatalog ?? []).map((item) => normalize(`${item.employmentType}|${item.department}|${item.position}`)));
      const updates = selected.map((employee) => {
        const employmentType = employeeBulkChanges.employmentType || employee.employmentType;
        const department = employeeBulkChanges.department || employee.department;
        const position = employeeBulkChanges.position || employee.position;
        if (!validPositionCombinations.has(normalize(`${employmentType}|${department}|${position}`))) throw new Error(`Для сотрудника «${employee.fullName}» сочетание «${employmentType} / ${department} / ${position}» отсутствует в справочнике должностей.`);
        return { key: `employee-${employee.id}`, id: employee.id, fullName: employee.fullName, employmentType, department, position, projectSiteId: employeeBulkChanges.projectSiteId || (employee.siteId ? String(employee.siteId) : "") } satisfies EmployeeDraft;
      });
      setEmployeeDrafts((current) => {
        const selectedIds = new Set(updates.map((draft) => draft.id));
        return [...current.filter((draft) => !draft.id || !selectedIds.has(draft.id)), ...updates];
      });
      setEmployeePendingDeletes([]);
      setEmployeeBulkEditOpen(false);
      setEmployeeBulkEditError("");
      setError("");
      setNotice(`Подготовлено изменений для сотрудников: ${updates.length}. Проверьте таблицу и нажмите «Сохранить».`);
    } catch (bulkError) {
      setEmployeeBulkEditError(bulkError instanceof Error ? bulkError.message : "Не удалось подготовить изменения.");
    }
  }
  async function saveEmployees() {
    if (!employeeDrafts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const editedIds = new Set(employeeDrafts.flatMap((draft) => draft.id ? [draft.id] : []));
      const usedNames = new Set(visibleEmployees.filter((employee) => !editedIds.has(employee.id)).map((employee) => normalize(employee.fullName)));
      const validEmploymentTypes = new Set((data?.employmentTypes ?? []).map((option) => normalize(option.name)));
      const validDepartments = new Set((data?.departments ?? []).map((option) => normalize(option.name)));
      const validPositions = new Set((data?.positions ?? []).map((option) => normalize(option.name)));
      const validSites = new Set((data?.sites ?? []).map((site) => site.id));
      const validPositionCombinations = new Set((data?.positionCatalog ?? []).map((item) => normalize(`${item.employmentType}|${item.department}|${item.position}`)));
      employeeDrafts.forEach((draft, index) => {
        if (!draft.fullName.trim() || !draft.employmentType.trim() || !draft.department.trim() || !draft.position.trim() || !Number(draft.projectSiteId)) throw new Error(`Строка ${index + 1}: заполните ФИО, тип, отдел, должность и проект.`);
        if (!validEmploymentTypes.has(normalize(draft.employmentType))) throw new Error(`Строка ${index + 1}: значение «${draft.employmentType}» не относится к столбцу «Тип».`);
        if (!validDepartments.has(normalize(draft.department))) throw new Error(`Строка ${index + 1}: значение «${draft.department}» не относится к столбцу «Отдел».`);
        if (!validPositions.has(normalize(draft.position))) throw new Error(`Строка ${index + 1}: значение «${draft.position}» не относится к столбцу «Должность».`);
        if (!validSites.has(Number(draft.projectSiteId))) throw new Error(`Строка ${index + 1}: выбранный проект не найден или закрыт.`);
        if (!validPositionCombinations.has(normalize(`${draft.employmentType}|${draft.department}|${draft.position}`))) throw new Error(`Строка ${index + 1}: сочетание типа, отдела и должности отсутствует в справочнике должностей.`);
        const name = normalize(draft.fullName);
        if (usedNames.has(name)) throw new Error(`Строка ${index + 1}: сотрудник «${draft.fullName.trim()}» уже есть в справочнике.`);
        usedNames.add(name);
      });
      for (let index = 0; index < employeeDrafts.length; index += 1) {
        const draft = employeeDrafts[index];
        const response = await fetch("/api/data", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: draft.id ? "update-employee" : "create-employee", employeeId: draft.id, fullName: draft.fullName, employmentType: draft.employmentType, department: draft.department, position: draft.position, projectSiteId: Number(draft.projectSiteId) }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`Строка ${index + 1}: ${result.error ?? "не удалось сохранить сотрудника"}.`);
        setEmployeeDrafts((current) => current.filter((item) => item.key !== draft.key));
        if (draft.id) setEmployeeFullRowEditIds((current) => current.filter((id) => id !== draft.id));
      }
      const added = employeeDrafts.filter((draft) => !draft.id).length;
      const updated = employeeDrafts.length - added;
      setNotice([added ? `добавлено сотрудников: ${added}` : "", updated ? `изменено: ${updated}` : ""].filter(Boolean).join(", ").replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU")));
      await loadData();
    } catch (employeeError) { await loadData(); setError(employeeError instanceof Error ? employeeError.message : "Не удалось сохранить сотрудников."); }
    finally { setSaving(false); }
  }
  async function deletePendingEmployees() {
    if (!employeePendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data?entity=employee", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: employeePendingDeletes }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось удалить выбранных сотрудников.");
      const count = result.count ?? employeePendingDeletes.length;
      setEmployeePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setNotice(`Удалено сотрудников: ${count}`);
      await loadData();
    } catch (employeeError) { await loadData(); setError(employeeError instanceof Error ? employeeError.message : "Не удалось удалить выбранных сотрудников."); }
    finally { setSaving(false); }
  }
  function patchPositionDraft(key: string, changes: Partial<PositionDraft>) {
    setPositionDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }
  function editPositionRow(position: PositionRecord, changes: Partial<PositionDraft> = {}) {
    setPositionPendingDeletes([]);
    setPositionDrafts((current) => {
      if (current.some((draft) => !draft.id)) return current;
      const existing = current.find((draft) => draft.id === position.id);
      if (existing) return current.map((draft) => draft.id === position.id ? { ...draft, ...changes } : draft);
      return [...current, { key: `position-${position.id}`, ...position, ...changes }];
    });
    setNotice("");
  }
  function editSelectedPositionRows() {
    if (positionDrafts.some((draft) => !draft.id)) return;
    const selected = visiblePositions.filter((position) => positionPendingDeletes.includes(position.id));
    selected.forEach((position) => editPositionRow(position));
    setPositionFullRowEditIds((current) => [...new Set([...current, ...selected.map((position) => position.id)])]);
    setPositionPendingDeletes([]);
    setNotice(selected.length ? `Открыто редактирование должностей: ${selected.length}.` : "");
  }
  function cancelPositionEditing() {
    setPositionDrafts([]);
    setPositionFullRowEditIds([]);
    setError("");
    setNotice("");
  }
  async function savePositions() {
    if (!positionDrafts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const editedIds = new Set(positionDrafts.flatMap((draft) => draft.id ? [draft.id] : []));
      const used = new Set(visiblePositions.filter((position) => !editedIds.has(position.id)).map((position) => normalize(`${position.employmentType}|${position.department}|${position.position}`)));
      const validEmploymentTypes = new Set((data?.employmentTypes ?? []).map((option) => normalize(option.name)));
      const validDepartments = new Set((data?.departments ?? []).map((option) => normalize(option.name)));
      positionDrafts.forEach((draft, index) => {
        if (!draft.employmentType.trim() || !draft.department.trim() || !draft.position.trim()) throw new Error(`Строка ${index + 1}: заполните тип, отдел и должность.`);
        if (!validEmploymentTypes.has(normalize(draft.employmentType))) throw new Error(`Строка ${index + 1}: значение «${draft.employmentType}» не относится к столбцу «Тип».`);
        if (!validDepartments.has(normalize(draft.department))) throw new Error(`Строка ${index + 1}: значение «${draft.department}» не относится к столбцу «Отдел».`);
        const value = normalize(`${draft.employmentType}|${draft.department}|${draft.position}`);
        if (used.has(value)) throw new Error(`Строка ${index + 1}: такая должность уже есть в списке.`);
        used.add(value);
      });
      for (let index = 0; index < positionDrafts.length; index += 1) {
        const draft = positionDrafts[index];
        const response = await fetch("/api/data", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: draft.id ? "update-position" : "create-position", positionId: draft.id, employmentType: draft.employmentType, department: draft.department, position: draft.position }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`Строка ${index + 1}: ${result.error ?? "не удалось сохранить должность"}.`);
        setPositionDrafts((current) => current.filter((item) => item.key !== draft.key));
        if (draft.id) setPositionFullRowEditIds((current) => current.filter((id) => id !== draft.id));
      }
      const added = positionDrafts.filter((draft) => !draft.id).length;
      const updated = positionDrafts.length - added;
      setNotice([added ? `добавлено должностей: ${added}` : "", updated ? `изменено: ${updated}` : ""].filter(Boolean).join(", ").replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU"))); await loadData();
    } catch (positionError) { await loadData(); setError(positionError instanceof Error ? positionError.message : "Не удалось сохранить должности."); }
    finally { setSaving(false); }
  }
  async function deletePendingPositions() {
    if (!positionPendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      for (const id of positionPendingDeletes) {
        const response = await fetch(`/api/data?entity=position&id=${id}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось удалить должность.");
      }
      const count = positionPendingDeletes.length;
      setPositionPendingDeletes([]); setPositionDeleteConfirmationOpen(false); setNotice(`Удалено должностей: ${count}`); await loadData();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить должности."); }
    finally { setSaving(false); }
  }
  async function exportEmployees() {
    if (!data) return;
    const { createTableXlsx } = await loadPlacementXlsx();
    const employees = employeeVisibleIds === null ? visibleEmployees : visibleEmployees.filter((employee) => employeeVisibleIds.includes(employee.id));
    download(createTableXlsx("Сотрудники", "Список сотрудников", ["ФИО", "Тип", "Отдел", "Должность", "Проект", "Стадия в Битрикс24"], employees.map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position, employee.siteName ?? "", employee.bitrix24Stage ?? ""])), "Сотрудники.xlsx");
  }
  async function synchronizeEmployeesWithBitrix24() {
    setSyncingBitrix24(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync-bitrix24" }) });
      const result = await response.json() as { error?: string; sourceReceived?: number; received?: number; excluded?: number; added?: number; updated?: number; moved?: number; unavailable?: number; archived?: number; issues?: number; issueMessages?: string[] };
      if (!response.ok) throw new Error(result.error ?? "Не удалось актуализировать сотрудников из Битрикс24.");
      const parts = [
        `прочитано: ${result.sourceReceived ?? 0}`,
        `выбрано: ${result.received ?? 0}`,
        `исключено: ${result.excluded ?? 0}`,
        `добавлено: ${result.added ?? 0}`,
        `обновлено: ${result.updated ?? 0}`,
        `переведено: ${result.moved ?? 0}`,
        `временно недоступно: ${result.unavailable ?? 0}`,
        `архивировано: ${result.archived ?? 0}`,
        `требует внимания: ${result.issues ?? 0}`,
      ];
      await loadData();
      setNotice(`Актуализация завершена — ${parts.join(", ")}.`);
      if (result.issueMessages?.length) setError(`Проверьте данные Битрикс24: ${result.issueMessages.join(" ")}`);
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : "Не удалось актуализировать сотрудников из Битрикс24.";
      await loadData();
      setError(message);
    } finally { setSyncingBitrix24(false); }
  }
  async function inspectBitrix24Connection() {
    setSyncingBitrix24(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "inspect-bitrix24" }) });
      const result = await response.json() as { error?: string; sourceReceived?: number; received?: number; excluded?: number; incomplete?: number; unknownStages?: number; stages?: Array<[string, number]>; projects?: Array<[string, number]>; excludedStages?: Array<[string, number]> };
      if (!response.ok) throw new Error(result.error ?? "Не удалось проверить подключение к Битрикс24.");
      const stages = result.stages?.map(([name, count]) => `${name}: ${count}`).join(", ") || "нет данных";
      const projects = result.projects?.map(([name, count]) => `${name}: ${count}`).join(", ") || "нет данных";
      const excludedStages = result.excludedStages?.map(([name, count]) => `${name}: ${count}`).join(", ") || "нет данных";
      await loadData();
      setNotice(`Проверка только для чтения завершена. Прочитано: ${result.sourceReceived ?? 0}; попадёт в справочник: ${result.received ?? 0}; исключено: ${result.excluded ?? 0}; неполных: ${result.incomplete ?? 0}; неизвестных стадий среди выбранных: ${result.unknownStages ?? 0}. Выбранные стадии: ${stages}. Объекты: ${projects}. Исключённые стадии: ${excludedStages}.`);
    } catch (inspectError) {
      const message = inspectError instanceof Error ? inspectError.message : "Не удалось проверить подключение к Битрикс24.";
      await loadData();
      setError(message);
    } finally { setSyncingBitrix24(false); }
  }
  async function exportPositions() {
    if (!data) return;
    const { createTableXlsx } = await loadPlacementXlsx();
    const positions = positionVisibleIds === null ? visiblePositions : visiblePositions.filter((position) => positionVisibleIds.includes(position.id));
    download(createTableXlsx("Должности", "Список должностей", ["Тип", "Отдел", "Должность"], positions.map((position) => [position.employmentType, position.department, position.position])), "Список_должностей.xlsx");
  }
  async function importEmployees(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, ["ФИО", "Тип", "Отдел", "Должность", "Проект"]);
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-employees", employees: rows.map((row) => ({ fullName: row["ФИО"], employmentType: row["Тип"], department: row["Отдел"], position: row["Должность"], projectCode: row["Проект"] })) }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать сотрудников.");
      setNotice(`Импортировано сотрудников: ${result.count ?? rows.length}`); await loadData();
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать сотрудников."); }
    finally { setImporting(false); if (employeeFileInput.current) employeeFileInput.current.value = ""; }
  }
  async function importPositions(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, ["Тип", "Отдел", "Должность"]);
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-positions", positions: rows.map((row) => ({ employmentType: row["Тип"], department: row["Отдел"], position: row["Должность"] })) }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать должности.");
      setNotice(`Импортировано должностей: ${result.count ?? rows.length}`); await loadData();
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать должности."); }
    finally { setImporting(false); if (positionFileInput.current) positionFileInput.current.value = ""; }
  }
  async function exportProjectEmployees() {
    if (!data) return;
    const { createTableXlsx } = await loadPlacementXlsx();
    download(createTableXlsx("Сотрудники проекта", `Сотрудники проекта — ${activeSite?.name ?? "Проект"}`, ["ФИО", "Тип", "Отдел", "Должность"], visibleProjectEmployees.map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position])), `Сотрудники_${safeFilePart(activeSite?.name ?? "проект")}.xlsx`);
  }
  async function downloadProjectEmployeeTemplate() {
    const { createTableXlsx } = await loadPlacementXlsx();
    download(createTableXlsx("Шаблон", `Шаблон сотрудников проекта — ${activeSite?.name ?? "Проект"}`, ["ФИО"], blankTemplateRows), `Шаблон_сотрудников_${safeFilePart(activeSite?.name ?? "проект")}.xlsx`);
  }
  async function importProjectEmployees(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, ["ФИО"]);
      const uniqueNames = [...new Map(rows.map((row) => [normalize(row["ФИО"]), row["ФИО"].trim()])).values()].filter(Boolean);
      if (!uniqueNames.length) throw new Error("В файле нет заполненных сотрудников.");
      const employeesByName = new Map((data?.employees ?? []).map((employee) => [normalize(employee.fullName), employee]));
      const missing = uniqueNames.filter((name) => !employeesByName.has(normalize(name)));
      if (missing.length) throw new Error(`Сотрудники не найдены в общем справочнике: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}.`);
      const assigned = new Set((data?.placementEmployees ?? []).map((employee) => employee.id));
      const employees = uniqueNames.map((name) => employeesByName.get(normalize(name))!).filter((employee) => !assigned.has(employee.id));
      for (const employee of employees) {
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign-employee-project", employeeId: employee.id, siteId }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? `Не удалось добавить сотрудника «${employee.fullName}».`);
      }
      setNotice(employees.length ? `Импортировано сотрудников в проект: ${employees.length}` : "Все сотрудники из файла уже добавлены в проект");
      await loadData();
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать сотрудников проекта."); }
    finally { setImporting(false); if (projectEmployeeFileInput.current) projectEmployeeFileInput.current.value = ""; }
  }
  async function exportProjectDirectory() {
    if (!activeDirectoryGroup) return;
    const { createTableXlsx } = await loadPlacementXlsx();
    if (activeDirectoryGroup.entity === "master") {
      const employeesByName = new Map((data?.placementEmployees ?? []).map((employee) => [normalize(employee.fullName), employee]));
      download(createTableXlsx("Мастера", `Мастера — ${activeSite?.name ?? "Проект"}`, ["ФИО", "Тип", "Отдел", "Должность"], visibleDirectoryItems.map((item) => { const employee = employeesByName.get(normalize(item.name)); return [item.name, employee?.employmentType ?? "", employee?.department ?? "", employee?.position ?? ""]; })), `Мастера_${safeFilePart(activeSite?.name ?? "проект")}.xlsx`);
      return;
    }
    const header = directoryExcelHeader(activeDirectoryGroup.entity);
    download(createTableXlsx(focusedDirectoryTitle, `${focusedDirectoryTitle} — ${activeSite?.name ?? "Проект"}`, [header], visibleDirectoryItems.map((item) => [item.name])), `${safeFilePart(focusedDirectoryTitle)}_${safeFilePart(activeSite?.name ?? "проект")}.xlsx`);
  }
  async function downloadProjectDirectoryTemplate() {
    if (!activeDirectoryGroup) return;
    const { createTableXlsx } = await loadPlacementXlsx();
    const header = directoryExcelHeader(activeDirectoryGroup.entity);
    download(createTableXlsx("Шаблон", `Шаблон: ${focusedDirectoryTitle} — ${activeSite?.name ?? "Проект"}`, [header], blankTemplateRows), `Шаблон_${safeFilePart(focusedDirectoryTitle)}_${safeFilePart(activeSite?.name ?? "проект")}.xlsx`);
  }
  async function importProjectDirectory(file: File) {
    if (!activeDirectoryGroup) return;
    setImporting(true); setError(""); setNotice("");
    try {
      const header = directoryExcelHeader(activeDirectoryGroup.entity);
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, [header]);
      const names = [...new Map(rows.map((row) => [normalize(row[header]), row[header].trim()])).values()].filter(Boolean);
      if (!names.length) throw new Error("В файле нет заполненных значений.");
      const existing = new Set(activeDirectoryGroup.items.map((item) => normalize(item.name)));
      const newNames = names.filter((name) => !existing.has(normalize(name)));
      const employeesByName = new Map((data?.placementEmployees ?? []).map((employee) => [normalize(employee.fullName), employee]));
      if (activeDirectoryGroup.entity === "master") {
        const missing = newNames.filter((name) => !employeesByName.has(normalize(name)));
        if (missing.length) throw new Error(`Мастера не относятся к текущему проекту: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}.`);
      }
      for (const name of newNames) {
        const employee = activeDirectoryGroup.entity === "master" ? employeesByName.get(normalize(name)) : undefined;
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create-directory", entity: activeDirectoryGroup.entity, name: employee?.fullName ?? name, employeeId: employee?.id, siteId }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? `Не удалось добавить значение «${name}».`);
      }
      setNotice(newNames.length ? `Импортировано значений: ${newNames.length}` : "Все значения из файла уже есть в справочнике");
      await loadData();
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать справочник."); }
    finally { setImporting(false); if (projectDirectoryFileInput.current) projectDirectoryFileInput.current.value = ""; }
  }
  function patchProjectEmployeeDraft(key: string, changes: Partial<ProjectEmployeeDraft>) {
    setProjectEmployeeDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }
  async function assignProjectEmployees() {
    if (!projectEmployeeDrafts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const assigned = new Set(visibleProjectEmployees.map((employee) => employee.id));
      projectEmployeeDrafts.forEach((draft, index) => {
        const employeeId = Number(draft.employeeId);
        if (!employeeId) throw new Error(`Строка ${index + 1}: выберите сотрудника из списка.`);
        if (assigned.has(employeeId)) throw new Error(`Строка ${index + 1}: сотрудник уже добавлен в проект или выбран выше.`);
        assigned.add(employeeId);
      });
      for (let index = 0; index < projectEmployeeDrafts.length; index += 1) {
        const draft = projectEmployeeDrafts[index];
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign-employee-project", employeeId: Number(draft.employeeId), siteId }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`Строка ${index + 1}: ${result.error ?? "не удалось добавить сотрудника в проект"}.`);
        setProjectEmployeeDrafts((current) => current.filter((item) => item.key !== draft.key));
      }
      setNotice(`Добавлено сотрудников в проект: ${projectEmployeeDrafts.length}`); await loadData();
    } catch (assignmentError) { await loadData(); setError(assignmentError instanceof Error ? assignmentError.message : "Не удалось добавить сотрудников в проект."); }
    finally { setSaving(false); }
  }
  async function deletePendingProjectEmployees() {
    if (!projectEmployeePendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      for (const employeeId of projectEmployeePendingDeletes) {
        const response = await fetch(`/api/data?entity=employee-assignment&siteId=${siteId}&id=${employeeId}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось убрать сотрудника из проекта.");
      }
      const count = projectEmployeePendingDeletes.length;
      setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false); setNotice(`Убрано сотрудников из проекта: ${count}`); await loadData();
    } catch (assignmentError) { setError(assignmentError instanceof Error ? assignmentError.message : "Не удалось изменить состав проекта."); }
    finally { setSaving(false); }
  }
  function patchDirectoryDraft(key: string, changes: Partial<DirectoryDraft>) {
    setDirectoryDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }
  function editDirectoryItem(item: Option) {
    if (!activeDirectoryGroup || directoryDrafts.some((draft) => !draft.id) || directoryPendingDeletes.includes(item.id)) return;
    setDirectoryPendingDeletes([]);
    setDirectoryDrafts((current) => {
      if (current.some((draft) => draft.id === item.id)) return current;
      const employee = activeDirectoryGroup.entity === "master" ? (data?.placementEmployees ?? []).find((candidate) => normalize(candidate.fullName) === normalize(item.name)) : undefined;
      return [...current, { key: `directory-${item.id}`, id: item.id, entity: activeDirectoryGroup.entity, name: item.name, employeeId: employee ? String(employee.id) : undefined }];
    });
    setNotice("");
  }
  function changeDirectorySelection(ids: number[]) {
    setDirectoryPendingDeletes(ids);
    setDirectoryDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id)));
    setError("");
    setNotice("");
  }
  function editSelectedDirectoryItems() {
    if (directoryDrafts.some((draft) => !draft.id)) return;
    const selected = visibleDirectoryItems.filter((item) => directoryPendingDeletes.includes(item.id));
    if (!activeDirectoryGroup || !selected.length) return;
    const edits = selected.map((item) => {
      const employee = activeDirectoryGroup.entity === "master" ? (data?.placementEmployees ?? []).find((candidate) => normalize(candidate.fullName) === normalize(item.name)) : undefined;
      return { key: `directory-${item.id}`, id: item.id, entity: activeDirectoryGroup.entity, name: item.name, employeeId: employee ? String(employee.id) : undefined } satisfies DirectoryDraft;
    });
    setDirectoryDrafts((current) => {
      const selectedIds = new Set(edits.map((draft) => draft.id));
      return [...current.filter((draft) => !draft.id || !selectedIds.has(draft.id)), ...edits];
    });
    setDirectoryPendingDeletes([]);
    setError("");
    setNotice(`Открыто редактирование значений: ${selected.length}.`);
  }
  function cancelDirectoryEditing() {
    setDirectoryDrafts([]);
    setError("");
    setNotice("");
  }
  function addDirectoryItem() {
    if (!activeDirectoryGroup || directoryDrafts.some((draft) => Boolean(draft.id))) return;
    setDirectoryDrafts((current) => [...current, { key: newKey(), entity: activeDirectoryGroup.entity, name: "" }]);
    setNotice("");
  }
  async function saveDirectoryItems() {
    if (!activeDirectoryGroup || !directoryDrafts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const prepared = directoryDrafts.map((draft, index) => {
        const name = draft.name.trim();
        if (!name) throw new Error(`Строка ${index + 1}: заполните название.`);
        const selectedMaster = draft.entity === "master"
          ? (data?.placementEmployees ?? []).find((employee) => employee.id === Number(draft.employeeId) && normalize(employee.fullName) === normalize(name))
          : undefined;
        if (draft.entity === "master" && !selectedMaster) throw new Error(`Строка ${index + 1}: выберите мастера из сотрудников текущего проекта.`);
        return { directoryId: draft.id, name: selectedMaster?.fullName ?? name, employeeId: selectedMaster?.id };
      });
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save-directory-items", entity: activeDirectoryGroup.entity, siteId, directories: prepared }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить справочник.");
      const added = directoryDrafts.filter((draft) => !draft.id).length;
      const updated = directoryDrafts.length - added;
      setDirectoryDrafts([]); setNotice([added ? `добавлено: ${added}` : "", updated ? `изменено: ${updated}` : ""].filter(Boolean).join(", ").replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU")));
      await loadData();
    } catch (directoryError) { setError(directoryError instanceof Error ? directoryError.message : "Не удалось сохранить справочник."); }
    finally { setSaving(false); }
  }
  async function deletePendingDirectoryItems(entity: DirectoryEntity) {
    if (!directoryPendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      for (const id of directoryPendingDeletes) {
        const response = await fetch(`/api/data?entity=directory&kind=${entity}&siteId=${siteId}&id=${id}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось удалить значение.");
      }
      const count = directoryPendingDeletes.length;
      setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setNotice(`Удалено значений: ${count}`); await loadData();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить значения."); }
    finally { setSaving(false); }
  }
  function patchSiteDraft(key: string, changes: Partial<SiteDraft>) {
    setSiteDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }
  function editSiteRow(site: Site, changes: Partial<SiteDraft> = {}) {
    setSitePendingDeletes([]);
    setSiteDrafts((current) => {
      if (current.some((draft) => !draft.id)) return current;
      const existing = current.find((draft) => draft.id === site.id);
      if (existing) return current.map((draft) => draft.id === site.id ? { ...draft, ...changes } : draft);
      return [...current, { key: `site-${site.id}`, id: site.id, name: site.name, code: site.code, timezone: site.timezone, ...changes }];
    });
    setNotice("");
  }
  function changeSiteSelection(ids: number[]) {
    setSitePendingDeletes(ids);
    setSiteDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id)));
    setSiteFullRowEditIds((current) => current.filter((id) => !ids.includes(id)));
    setNotice("");
  }
  function editSelectedSiteRows() {
    if (siteDrafts.some((draft) => !draft.id)) return;
    const selected = visibleSites.filter((site) => sitePendingDeletes.includes(site.id));
    selected.forEach((site) => editSiteRow(site));
    setSiteFullRowEditIds((current) => [...new Set([...current, ...selected.map((site) => site.id)])]);
    setSitePendingDeletes([]);
    setNotice(selected.length ? `Открыто редактирование проектов: ${selected.length}.` : "");
  }
  function cancelSiteEditing() {
    setSiteDrafts([]);
    setSiteFullRowEditIds([]);
    setError("");
    setNotice("");
  }
  async function saveSites() {
    if (!siteDrafts.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const editedIds = new Set(siteDrafts.flatMap((draft) => draft.id ? [draft.id] : []));
      const usedNames = new Set(visibleSites.filter((site) => !editedIds.has(site.id)).map((site) => normalize(site.name)));
      siteDrafts.forEach((draft, index) => {
        if (!draft.name.trim()) throw new Error(`Строка ${index + 1}: заполните название проекта.`);
        const name = normalize(draft.name);
        if (usedNames.has(name)) throw new Error(`Строка ${index + 1}: проект «${draft.name.trim()}» уже есть в списке.`);
        usedNames.add(name);
      });
      for (let index = 0; index < siteDrafts.length; index += 1) {
        const draft = siteDrafts[index];
        const response = await fetch("/api/data", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: draft.id ? "update-site" : "create-site", siteId: draft.id, name: draft.name }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(`Строка ${index + 1}: ${result.error ?? "не удалось сохранить проект"}.`);
        setSiteDrafts((current) => current.filter((item) => item.key !== draft.key));
        if (draft.id) setSiteFullRowEditIds((current) => current.filter((id) => id !== draft.id));
      }
      const added = siteDrafts.filter((draft) => !draft.id).length;
      const updated = siteDrafts.length - added;
      setNotice([added ? `добавлено проектов: ${added}` : "", updated ? `изменено: ${updated}` : ""].filter(Boolean).join(", ").replace(/^./, (letter) => letter.toLocaleUpperCase("ru-RU")));
      await loadData();
    } catch (siteError) { await loadData(); setError(siteError instanceof Error ? siteError.message : "Не удалось сохранить проекты."); }
    finally { setSaving(false); }
  }
  async function deletePendingSites() {
    if (!sitePendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      for (const id of sitePendingDeletes) {
        const response = await fetch(`/api/data?entity=site&id=${id}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось удалить проект.");
      }
      const count = sitePendingDeletes.length;
      const deletingCurrentSite = sitePendingDeletes.includes(siteId);
      const nextSiteId = data?.sites.find((site) => !sitePendingDeletes.includes(site.id))?.id;
      setSitePendingDeletes([]); setSiteDeleteConfirmationOpen(false); setNotice(`Удалено проектов: ${count}`);
      if (deletingCurrentSite && nextSiteId) setSiteId(nextSiteId);
      else await loadData();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить проекты."); }
    finally { setSaving(false); }
  }
  async function exportExcel() {
    if (!data || !exportEntries.length) return;
    const { createPlacementXlsx } = await loadPlacementXlsx();
    download(createPlacementXlsx(activeSite?.name ?? "Объект", workDate, exportEntries), `Отчёт_персонала_${activeSite?.code ?? siteId}_${workDate}.xlsx`);
  }
  async function downloadTemplate() {
    if (!data) return;
    const { createPlacementTemplateXlsx } = await loadPlacementXlsx();
    download(createPlacementTemplateXlsx(activeSite?.name ?? "Объект", workDate, { employees: data.reportEmployees, shifts: data.shifts.map((item) => item.name), zones: data.zones.map((item) => item.name), mainWorkTypes: data.mainWorkTypes.map((item) => item.name), subworkTypes: data.subworkTypes.map((item) => item.name), masters: data.masters.map((item) => item.name) }), `Шаблон_отчёта_${activeSite?.code ?? siteId}_${workDate}.xlsx`);
  }
  async function importExcel(file: File) {
    if (!data) return;
    setImporting(true); setError(""); setNotice("");
    try {
      const { parsePlacementXlsx } = await loadPlacementXlsx();
      const rows = await parsePlacementXlsx(file);
      const findEmployee = (name: string) => data.reportEmployees.find((item) => normalize(item.fullName) === normalize(name));
      const findOption = (options: Option[], name: string) => options.find((item) => normalize(item.name) === normalize(name));
      const issues: string[] = [];
      const imported = rows.flatMap((row, index) => {
        const employee = findEmployee(row.employeeName); const shift = findOption(data.shifts, row.shiftName); const zone = findOption(data.zones, row.zoneName);
        const main = findOption(data.mainWorkTypes, row.mainWorkTypeName); const subwork = findOption(data.subworkTypes, row.subworkTypeName); const master = findOption(data.masters, row.masterName);
        if (!employee || !shift || !zone || !main || !subwork || !master || !Number.isInteger(Number(row.hours)) || Number(row.hours) < 1 || Number(row.hours) > 10) {
          issues.push(`${index + 1}: ${row.employeeName || "без ФИО"}`); return [];
        }
        return [makeDraft({ employeeId: String(employee.id), employeeQuery: employee.fullName, shiftId: String(shift.id), zoneId: String(zone.id), mainWorkTypeId: String(main.id), subworkTypeId: String(subwork.id), masterId: String(master.id), hours: row.hours, note: row.note })];
      });
      if (!imported.length) throw new Error(issues.length ? `Не удалось сопоставить строки: ${issues.slice(0, 5).join(", ")}.` : "В файле нет заполненных строк.");
      setDraftRows((current) => [...current, ...imported]);
      setNotice(`Из Excel загружено строк: ${imported.length}. Проверьте и нажмите «Сохранить».`);
      if (issues.length) setError(`Пропущено строк: ${issues.length} (${issues.slice(0, 5).join(", ")}). Проверьте названия по справочникам.`);
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось прочитать XLSX."); }
    finally { setImporting(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  const directoryGroups: Array<{ entity: DirectoryEntity; title: string; items: Option[] }> = [
    { entity: "zone", title: "Зоны", items: data?.zones ?? [] },
    { entity: "mainWorkType", title: "Виды работ", items: data?.mainWorkTypes ?? [] },
    { entity: "subworkType", title: "Виды подработ", items: data?.subworkTypes ?? [] },
    { entity: "master", title: "Мастера", items: data?.masters ?? [] },
  ];
  const activeDirectoryGroup = directoryFocus === "all" || directoryFocus === "sites" ? undefined : directoryGroups.find((group) => group.entity === directoryFocus);
  const visibleDirectoryItems = activeDirectoryGroup?.items ?? [];
  const focusedDirectoryTitle = directoryFocus === "sites" ? "Объекты" : directoryFocus === "all" ? "Все справочники" : directoryGroups.find((group) => group.entity === directoryFocus)?.title ?? "Справочник";
  const generalSettingsCards: Array<{ icon: string; title: string; description: string; view?: View; focus?: DirectoryFocus }> = [
    { icon: "С", title: "Сотрудники", description: "Кадровые данные, проекты и стадии сотрудников с актуализацией из Битрикс24.", view: "employees" },
    { icon: "Д", title: "Список должностей", description: "Единая таблица сочетаний «Тип / Отдел / Должность» с импортом и экспортом Excel.", view: "positions" },
    { icon: "П", title: "Пользователи системы и права", description: "Пользователи, роли, права доступа и назначенные проекты.", view: "users" },
    { icon: "П", title: "Проекты", description: "Строительные проекты и управление их названиями.", view: "projects" },
  ];
  const projectSettingsCards: Array<{ icon: string; title: string; description: string; focus?: DirectoryFocus; view?: View }> = [
    { icon: "С", title: "Сотрудники проекта", description: "Состав выбранного проекта без дублирования карточек сотрудников.", view: "projectEmployees" },
    { icon: "З", title: "Зоны", description: "Зоны, доступные только в выбранном проекте.", focus: "zone" },
    { icon: "Р", title: "Виды работ", description: "Работы из одноимённой колонки отчёта выбранного проекта.", focus: "mainWorkType" },
    { icon: "П", title: "Виды подработ", description: "Виды подработ, доступные только в выбранном проекте.", focus: "subworkType" },
    { icon: "М", title: "Мастера", description: "Мастера из одноимённой колонки отчёта выбранного проекта.", focus: "master" },
  ];

  return <main className={sidebarOpen ? "app-shell" : "app-shell sidebar-collapsed"}>
    <aside className="sidebar">
      <div className="brand-project-row"><button type="button" className="brand" onClick={() => { setReportsOpen(true); setView("placement"); }} aria-label="Открыть отчёты" title="Открыть отчёты"><img src="/tps-logo.svg" alt="" /></button>{mayViewAllProjects ? <ProjectSwitcher sites={data?.sites ?? []} value={siteId} onChange={changeSite} /> : <div className="project-fixed-card top-project-select" title={activeSite?.name ?? "Объект"}>{activeSite?.name ?? "Объект"}</div>}</div>
      <nav aria-label="Основная навигация">
        <div className="nav-group">
          <button type="button" className="nav-heading" onClick={() => setReportsOpen((open) => !open)} aria-expanded={reportsOpen} aria-controls="reports-navigation" aria-label={reportsOpen ? "Свернуть раздел «Отчеты»" : "Развернуть раздел «Отчеты»"}><span>Отчеты</span><SidebarChevron open={reportsOpen} /></button>
          {(reportsOpen || !sidebarOpen) && <div className="nav-sub" id="reports-navigation"><button className={view === "placement" ? "nav-item active" : "nav-item"} onClick={() => setView("placement")} aria-label="Рабочие" title="Рабочие"><span>♙</span>Рабочие</button></div>}
        </div>
      </nav>
      <div className="sidebar-bottom"><div className="nav-group settings-group">
        <button type="button" className="nav-heading" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-controls="settings-navigation" aria-label={settingsOpen ? "Свернуть раздел «Настройки»" : "Развернуть раздел «Настройки»"}><span className="nav-heading-icon">⚙</span><span>Настройки</span><SidebarChevron open={settingsOpen} /></button>
        {(settingsOpen || !sidebarOpen) && <div className="nav-sub" id="settings-navigation">
          {mayAccessGeneralSettings && <button className={view === "settings" || view === "users" || view === "employees" || view === "positions" || view === "projects" ? "nav-item active" : "nav-item"} onClick={() => { setView("settings"); setDirectoryFocus("all"); setUserDrafts([]); setUserFullRowEditIds([]); setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setPositionDrafts([]); setPositionFullRowEditIds([]); setSiteDrafts([]); setSiteFullRowEditIds([]); }} aria-label="Общие настройки" title="Общие настройки"><span>▤</span>Общие</button>}
          <button className={view === "projectSettings" || view === "projectEmployees" || view === "directories" ? "nav-item active" : "nav-item"} onClick={() => { setView("projectSettings"); setDirectoryFocus("all"); setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setProjectEmployeeDrafts([]); }} aria-label="Настройки проекта" title="Настройки проекта"><span>▦</span>Настройки проекта</button>
        </div>}
      </div>
        <div className="sidebar-user"><div><strong>{currentUser.fullName}</strong><small>{ROLE_LABELS[role]}</small></div><button className="profile-button" onClick={openProfile} title="Профиль" aria-label="Открыть профиль пользователя"><AppIcon name="user" /></button></div>
      </div>
    </aside>
    <section className="workspace">
      <header className="topbar"><button className="sidebar-trigger" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}><AppIcon name="panel" /></button></header>
      <div className="page-content"><div className="page-heading"><div><h1>{view === "placement" ? "Отчет персонала" : view === "employees" ? "Сотрудники" : view === "settings" ? "Общие настройки" : view === "projectSettings" ? "Настройки проекта" : view === "projectEmployees" ? "Сотрудники проекта" : view === "users" ? "Пользователи системы и права" : view === "positions" ? "Список должностей" : view === "projects" ? "Проекты" : focusedDirectoryTitle}</h1></div>{view === "placement" && <section className="excel-actions" aria-label="Действия с Excel"><button onClick={exportExcel} disabled={!exportEntries.length}>Экспорт в Excel</button><button onClick={downloadTemplate}>Скачать Шаблон</button><button onClick={() => fileInput.current?.click()} disabled={importing}>{importing ? "Загружаем…" : "Загрузить данные из Excel"}</button><input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importExcel(file); }} /></section>}</div>

      {view === "placement" && <>
        <section className="control-strip"><ReportDateNavigation dates={recentDates} value={workDate} today={initialToday} filledDates={filledDates} onChange={changeWorkDate} onRangeChange={changeReportRange} /></section>
        {error && <div className="message error"><strong>Нужно проверить данные</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {notice && <div className="message success"><strong>Готово</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
        <section className="table-card personnel-table-card">
          {rosterMode && <div className={previousDayLoading ? "roster-carryover-banner loading" : "roster-carryover-banner"}>
            <span className="roster-carryover-icon" aria-hidden="true">↶</span>
            <div><strong>{previousDayLoading ? "Подготавливаем сегодняшний отчёт" : data?.reportSubmitted ? `Отчёт за ${shortDate(workDate)} сохранён` : previousDayReport?.entries.length ? `Данные перенесены с ${shortDate(previousDayReport.date)}` : `За ${shortDate(previousDayDate)} сохранённого отчёта нет`}</strong><span>{previousDayLoading ? "Загружаем данные предыдущего дня…" : data?.reportSubmitted ? filteredEntries.length ? `Сохранено строк: ${filteredEntries.length}. Состав можно изменить прямо в таблице.` : "Сохранён пустой отчёт: за этот день рабочие не указаны." : previousDayReport?.entries.length ? `Перенесено строк: ${rosterCopiedRows}. Уберите не вышедших сотрудников и исправьте изменения.` : "Добавьте в отчёт нужных сотрудников из общего справочника."}</span></div>
          </div>}
          <PlacementAgGrid
            entries={filteredEntries}
            draftRows={draftRows}
            editing={editingRows}
            employees={data?.reportEmployees ?? []}
            shifts={data?.shifts ?? []}
            zones={data?.zones ?? []}
            mainWorkTypes={data?.mainWorkTypes ?? []}
            subworkTypes={data?.subworkTypes ?? []}
            masters={data?.masters ?? []}
            loading={loading || (rosterMode && previousDayLoading)}
            canEdit={canEditDate}
            rosterMode={rosterMode}
            pendingDeletes={pendingDeletes}
            selectedDraftKeys={selectedRosterDraftKeys}
            onEdit={startEdit}
            onSelectionChange={changeReportSelection}
            onDraftSelectionChange={setSelectedRosterDraftKeys}
            onPatchDraft={patchDraft}
            onPatchEditing={patchEditing}
            onVisibleEntryIdsChange={(ids) => setVisibleEntryIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
          />
          {rosterMode
            ? <RosterReportFooter completed={rosterCompleted} total={rosterTotal} readyNew={rosterReadyNew} incompleteTouched={rosterIncompleteTouched} selectedCount={pendingDeletes.length + selectedRosterDraftKeys.length} totalHours={totalOprHours} saving={saving} onAdd={() => addRow({ hours: "" })} onRemoveSelection={removeSelectedRosterRows} onClearSelection={() => { setPendingDeletes([]); setSelectedRosterDraftKeys([]); }} onReset={cancelReportEditing} onSave={() => void saveRosterReport()} />
            : <ReportGridFooter selectedCount={pendingDeletes.length} editingCount={editingCount} newCount={pendingCount} totalHours={totalOprHours} canEdit={canEditDate} saving={saving} onAdd={() => addRow()} onEditSelection={editSelectedReportRows} onDelete={() => setDeleteConfirmationOpen(true)} onClearSelection={() => { setPendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={cancelReportEditing} onSaveEditing={() => void saveEditing()} onSaveNew={() => void savePending()} />}
        </section>
      </>}

      {deleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirmation-title"><h2 id="delete-confirmation-title">Удалить выбранные строки?</h2><p>Вы точно хотите удалить строки ({pendingDeletes.length})? Это действие нельзя отменить.</p><div><button type="button" className="secondary-button" onClick={() => setDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEntries()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}

      {view === "settings" && <section className="settings-home"><p className="settings-scope-description">Общие данные используются во всей системе и не зависят от выбранного проекта.</p><div className="settings-grid">{generalSettingsCards.map((card) => <button type="button" key={card.title} onClick={() => { setError(""); setNotice(""); setUserDrafts([]); setUserFullRowEditIds([]); setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setPositionDrafts([]); setPositionFullRowEditIds([]); setDirectoryDrafts([]); setSiteDrafts([]); setSiteFullRowEditIds([]); setInvitationResults([]); setEmployeePendingDeletes([]); setPositionPendingDeletes([]); setUserPendingDeletes([]); setSitePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setEmployeeBulkEditOpen(false); setPositionDeleteConfirmationOpen(false); setUserDeleteConfirmationOpen(false); setSiteDeleteConfirmationOpen(false); if (card.focus) { setDirectoryFocus(card.focus); setView("directories"); } else if (card.view) setView(card.view); }}><span className="settings-card-icon">{card.icon}</span><strong>{card.title}</strong><p>{card.description}</p></button>)}</div></section>}
      {view === "projectSettings" && <section className="settings-home">
        <div className="settings-grid">{projectSettingsCards.map((card) => <button type="button" key={card.title} onClick={() => { setError(""); setNotice(""); setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setProjectEmployeeDrafts([]); if (card.focus) { setDirectoryFocus(card.focus); setView("directories"); } else if (card.view) setView(card.view); }}><span className="settings-card-icon">{card.icon}</span><strong>{card.title}</strong><p>{card.description}</p></button>)}</div>
      </section>}
      {view === "projectEmployees" && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("projectSettings"); setProjectEmployeeDrafts([]); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false); }}>← К настройкам проекта</button><div className="toolbar-actions"><button type="button" onClick={exportProjectEmployees}>Экспорт в Excel</button>{mayEditProjectSettings && <><button type="button" onClick={downloadProjectEmployeeTemplate}>Скачать шаблон</button><button type="button" onClick={() => projectEmployeeFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={projectEmployeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectEmployees(file); }} /></>}</div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <ProjectEmployeeAgGrid rows={visibleProjectEmployees} allEmployees={(data?.employees ?? []).filter((employee) => employee.source !== "bitrix24")} drafts={projectEmployeeDrafts} pendingDeletes={projectEmployeePendingDeletes} readOnly={!mayEditProjectSettings} onPatchDraft={patchProjectEmployeeDraft} onSelectionChange={(ids) => { setProjectEmployeePendingDeletes(ids); setError(""); setNotice(""); }} />
        {mayEditProjectSettings && <AdminGridFooter addLabel="Добавить сотрудника в проект" countLabel="Всего в проекте" count={visibleProjectEmployees.length} deletingCount={projectEmployeePendingDeletes.length} deletingLabel="Убрать из проекта" uniformActions editorOpen={Boolean(projectEmployeeDrafts.length)} pendingCount={projectEmployeeDrafts.length} saving={saving} allowMultiple onAdd={() => { setProjectEmployeeDrafts((current) => [...current, { key: newKey(), employeeId: "", employeeQuery: "" }]); setNotice(""); }} onDelete={() => setProjectEmployeeDeleteConfirmationOpen(true)} onClearSelection={() => { setProjectEmployeePendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={() => { setProjectEmployeeDrafts([]); setError(""); setNotice(""); }} onSave={() => void assignProjectEmployees()} />}
      </section>}
      {mayEditProjectSettings && projectEmployeeDeleteConfirmationOpen && <AdminDeleteConfirmation title="Убрать выбранных сотрудников из проекта?" text={`Сотрудники (${projectEmployeePendingDeletes.length}) исчезнут только из проекта «${activeSite?.name ?? ""}». Их общие карточки и история отчётов сохранятся.`} saving={saving} onCancel={() => setProjectEmployeeDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingProjectEmployees()} />}
      {view === "employees" && <section className="users-settings admin-section employee-section">
        <div className="settings-toolbar">
          <button type="button" className="back-button" onClick={() => { setView("settings"); setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setEmployeePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setEmployeeBulkEditOpen(false); }}>← К настройкам</button>
          <div className="toolbar-actions">{mayManageBitrix24 && <><span className="cooldown-button-wrapper" title={inspectBitrix24Title}><button type="button" onClick={() => void inspectBitrix24Connection()} disabled={syncingBitrix24 || importing || inspectBitrix24Remaining > 0}>{syncingBitrix24 ? "Проверяем…" : "Проверить Битрикс24"}</button></span><span className="cooldown-button-wrapper" title={syncBitrix24Title}><button type="button" className="bitrix-sync-button" onClick={() => void synchronizeEmployeesWithBitrix24()} disabled={syncingBitrix24 || importing || syncBitrix24Remaining > 0}>Актуализировать из Битрикс24</button></span></>}<button type="button" onClick={exportEmployees}>Экспорт в Excel</button>{mayEditGlobalEmployees && <><button type="button" onClick={() => employeeFileInput.current?.click()} disabled={importing || syncingBitrix24}>Импорт из Excel</button><input ref={employeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importEmployees(file); }} /></>}</div>
        </div>
        {data?.syncStatus && <div className={`employee-sync-status ${data.syncStatus.status}`}><span>Последняя актуализация: {new Date(data.syncStatus.completedAt ?? data.syncStatus.startedAt).toLocaleString("ru-RU")}</span><strong>{data.syncStatus.status === "success" ? "Выполнена" : data.syncStatus.status === "failed" ? "Ошибка" : "Выполняется"}</strong></div>}
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
        {notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <EmployeeAgGrid
          rows={visibleEmployees}
          drafts={employeeDrafts}
          employmentTypes={data?.employmentTypes ?? []}
          departments={data?.departments ?? []}
          positions={data?.positions ?? []}
          sites={data?.sites ?? []}
          selectedIds={employeePendingDeletes}
          fullRowEditIds={employeeFullRowEditIds}
          onEdit={(employee, changes = {}) => { setEmployeePendingDeletes([]); setEmployeeDrafts((current) => {
            if (current.some((draft) => !draft.id)) return current;
            const existing = current.find((draft) => draft.id === employee.id);
            if (existing) return current.map((draft) => draft.id === employee.id ? { ...draft, ...changes } : draft);
            return [...current, { key: `employee-${employee.id}`, id: employee.id, fullName: employee.fullName, employmentType: employee.employmentType, department: employee.department, position: employee.position, projectSiteId: employee.siteId ? String(employee.siteId) : "", ...changes }];
          }); setNotice(""); }}
          onSelectionChange={(ids) => { setEmployeePendingDeletes(ids); setEmployeeDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id))); setEmployeeFullRowEditIds((current) => current.filter((id) => !ids.includes(id))); setNotice(""); }}
          onPatchDraft={patchEmployeeDraft}
          onCancelDraft={cancelEmployeeDraft}
          onVisibleIdsChange={(ids) => setEmployeeVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
          onValidationError={(message) => { setError(message); setNotice(""); }}
        />
        <AdminGridFooter addLabel="Добавить сотрудника" countLabel="Всего сотрудников" count={visibleEmployees.length} deletingCount={employeePendingDeletes.length} deletingLabel="Удалить сотрудников" editSelectionLabel="Редактировать" bulkEditSelectionLabel="Массовое редактирование" uniformActions editorOpen={Boolean(employeeDrafts.length)} editingExisting={employeeDrafts.some((draft) => Boolean(draft.id))} pendingCount={employeeDrafts.length} saving={saving} allowMultiple onAdd={() => { setEmployeeDrafts((current) => current.some((draft) => draft.id) ? current : [...current, { key: newKey(), fullName: "", employmentType: "", department: "", position: "", projectSiteId: String(siteId) }]); setNotice(""); }} onDelete={() => setEmployeeDeleteConfirmationOpen(true)} onEditSelection={editSelectedEmployeeRows} onBulkEditSelection={openEmployeeBulkEdit} onClearSelection={() => { setEmployeePendingDeletes([]); setEmployeeBulkEditOpen(false); setEmployeeBulkEditError(""); setNotice(""); }} onCancelEditing={cancelEmployeeEditing} onSave={() => void saveEmployees()} />
      </section>}

      {employeeBulkEditOpen && <div className="confirmation-backdrop employee-bulk-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeBulkEditOpen(false); }}><section className="employee-bulk-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-bulk-edit-title">
        <div className="employee-bulk-edit-heading"><div><h2 id="employee-bulk-edit-title">Массовое редактирование сотрудников</h2><p>Выбрано сотрудников: {employeePendingDeletes.length}. Укажите только те поля, которые нужно изменить у всех отмеченных сотрудников. Остальные значения сохранятся.</p></div><button type="button" className="bulk-edit-close" aria-label="Закрыть массовое редактирование" onClick={() => setEmployeeBulkEditOpen(false)}>×</button></div>
        {employeeBulkEditError && <div className="bulk-edit-error" role="alert">{employeeBulkEditError}</div>}
        <div className="employee-bulk-edit-form">
          <div className="employee-bulk-edit-field"><span>Тип</span><CustomSelect value={employeeBulkChanges.employmentType} ariaLabel="Новый тип для выбранных сотрудников" onChange={(employmentType) => { setEmployeeBulkChanges((current) => ({ ...current, employmentType })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.employmentTypes ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Отдел</span><CustomSelect value={employeeBulkChanges.department} ariaLabel="Новый отдел для выбранных сотрудников" onChange={(department) => { setEmployeeBulkChanges((current) => ({ ...current, department })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.departments ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Должность</span><CustomSelect value={employeeBulkChanges.position} ariaLabel="Новая должность для выбранных сотрудников" onChange={(position) => { setEmployeeBulkChanges((current) => ({ ...current, position })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.positions ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Проект</span><CustomSelect value={employeeBulkChanges.projectSiteId} ariaLabel="Новый проект для выбранных сотрудников" onChange={(projectSiteId) => { setEmployeeBulkChanges((current) => ({ ...current, projectSiteId })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.sites ?? []).map((option) => ({ value: String(option.id), label: option.name }))]} /></div>
        </div>
        <div className="bulk-edit-selection-summary"><strong>Выбрано:</strong><span>{visibleEmployees.filter((employee) => employeePendingDeletes.includes(employee.id)).slice(0, 4).map((employee) => employee.fullName).join(", ")}{employeePendingDeletes.length > 4 ? ` и ещё ${employeePendingDeletes.length - 4}` : ""}</span></div>
        <div className="employee-bulk-edit-actions"><button type="button" className="secondary-button" onClick={() => setEmployeeBulkEditOpen(false)}>Отмена</button><button type="button" className="save-edits-button" onClick={applyEmployeeBulkEdit}>Применить к таблице</button></div>
      </section></div>}

      {employeeDeleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-delete-confirmation-title"><h2 id="employee-delete-confirmation-title">Удалить выбранных сотрудников?</h2><p>Вы точно хотите удалить сотрудников ({employeePendingDeletes.length})? Они исчезнут из активного справочника и проектов, но история ранее созданных отчётов сохранится.</p><div><button type="button" className="secondary-button" onClick={() => setEmployeeDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEmployees()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}
      {view === "positions" && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("settings"); setPositionDrafts([]); setPositionFullRowEditIds([]); setPositionPendingDeletes([]); setPositionDeleteConfirmationOpen(false); }}>← К настройкам</button><div className="toolbar-actions"><button type="button" onClick={exportPositions}>Экспорт в Excel</button>{mayEditGlobalReferences && <><button type="button" onClick={() => positionFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={positionFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPositions(file); }} /></>}</div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <PositionAgGrid rows={visiblePositions} drafts={positionDrafts} employmentTypes={data?.employmentTypes ?? []} departments={data?.departments ?? []} pendingDeletes={positionPendingDeletes} fullRowEditIds={positionFullRowEditIds} readOnly={!mayEditGlobalReferences} onEdit={editPositionRow} onSelectionChange={(ids) => { setPositionPendingDeletes(ids); setPositionDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id))); setPositionFullRowEditIds((current) => current.filter((id) => !ids.includes(id))); setNotice(""); }} onPatchDraft={patchPositionDraft} onVisibleIdsChange={(ids) => setPositionVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)} />
        {mayEditGlobalReferences && <AdminGridFooter addLabel="Добавить должность" countLabel="Всего должностей" count={visiblePositions.length} deletingCount={positionPendingDeletes.length} deletingLabel="Удалить должности" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(positionDrafts.length)} editingExisting={positionDrafts.some((draft) => Boolean(draft.id))} pendingCount={positionDrafts.length} saving={saving} allowMultiple onAdd={() => { setPositionDrafts((current) => current.some((draft) => draft.id) ? current : [...current, { key: newKey(), employmentType: "", department: "", position: "" }]); setNotice(""); }} onDelete={() => setPositionDeleteConfirmationOpen(true)} onEditSelection={editSelectedPositionRows} onClearSelection={() => { setPositionPendingDeletes([]); setNotice(""); }} onCancelEditing={cancelPositionEditing} onSave={() => void savePositions()} />}
      </section>}
      {mayEditGlobalReferences && positionDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные должности?" text={`Вы точно хотите удалить должности (${positionPendingDeletes.length})? Используемые сотрудниками должности удалить нельзя.`} saving={saving} onCancel={() => setPositionDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingPositions()} />}

      {view === "projects" && <section className="users-settings admin-section reference-section project-cards-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("settings"); setSiteDrafts([]); setSiteFullRowEditIds([]); setSitePendingDeletes([]); setSiteDeleteConfirmationOpen(false); }}>← К настройкам</button></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        {useProjectCardLayout
          ? <ProjectCards rows={visibleSites} drafts={siteDrafts} employees={data?.employees ?? []} users={data?.users ?? []} currentSiteId={siteId} selectedIds={sitePendingDeletes} readOnly={!mayEditGlobalReferences} onEdit={editSiteRow} onSelectionChange={changeSiteSelection} onPatchDraft={patchSiteDraft} onCancelEditing={cancelSiteEditing} onSave={() => void saveSites()} saving={saving} />
          : <ProjectAgGrid rows={visibleSites} drafts={siteDrafts} pendingDeletes={sitePendingDeletes} fullRowEditIds={siteFullRowEditIds} onEdit={editSiteRow} onSelectionChange={changeSiteSelection} onPatchDraft={patchSiteDraft} />}
        {mayEditGlobalReferences && <AdminGridFooter addLabel="Добавить проект" countLabel="Всего проектов" count={visibleSites.length} deletingCount={sitePendingDeletes.length} deletingLabel="Удалить проекты" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(siteDrafts.length)} editingExisting={siteDrafts.some((draft) => Boolean(draft.id))} pendingCount={siteDrafts.length} saving={saving} onAdd={() => { setSiteDrafts((current) => current.length ? current : [...current, { key: newKey(), name: "", code: "", timezone: "Europe/Moscow" }]); setNotice(""); }} onDelete={() => setSiteDeleteConfirmationOpen(true)} onEditSelection={editSelectedSiteRows} onClearSelection={() => { setSitePendingDeletes([]); setNotice(""); }} onCancelEditing={cancelSiteEditing} onSave={() => void saveSites()} />}
      </section>}
      {mayEditGlobalReferences && siteDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные проекты?" text={`Вы точно хотите удалить проекты (${sitePendingDeletes.length})? Проекты со связанными сотрудниками, пользователями или отчётами удалить нельзя.`} saving={saving} onCancel={() => setSiteDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingSites()} />}

      {view === "users" && <section className="users-settings admin-section reference-section user-access-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("settings"); setUserDrafts([]); setUserFullRowEditIds([]); setUserPendingDeletes([]); setUserDeleteConfirmationOpen(false); setInvitationResults([]); }}>← К настройкам</button></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        {invitationResults.map((invitation) => <div className="invitation-result" key={invitation.email}><strong>Приглашение для {invitation.email}</strong><span>Передайте эту ссылку пользователю. После настройки почты она будет отправляться автоматически.</span><a href={invitation.url}>{invitation.url}</a></div>)}
        {useUserAccessCardLayout
          ? <UserAccessCards rows={visibleUsers} drafts={userDrafts} sites={data?.sites ?? []} selectedIds={userPendingDeletes} readOnly={!mayEditGlobalReferences} onEdit={editUserRow} onSelectionChange={changeUserSelection} onPatchDraft={patchUserDraft} onCancelEditing={cancelUserEditing} onSave={() => void saveUsers()} saving={saving} />
          : <UserAgGrid rows={visibleUsers} drafts={userDrafts} sites={data?.sites ?? []} pendingDeletes={userPendingDeletes} fullRowEditIds={userFullRowEditIds} onEdit={editUserRow} onSelectionChange={changeUserSelection} onPatchDraft={patchUserDraft} />}
        {mayEditGlobalReferences && <AdminGridFooter addLabel="Добавить пользователя" countLabel="Всего пользователей" count={visibleUsers.length} deletingCount={userPendingDeletes.length} deletingLabel="Удалить пользователей" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(userDrafts.length)} editingExisting={userDrafts.some((draft) => Boolean(draft.id))} pendingCount={userDrafts.length} saving={saving} onAdd={() => { setUserDrafts((current) => current.length ? current : [...current, { key: newKey(), fullName: "", email: "", role: "foreman", assignedSiteId: String(siteId) }]); setNotice(""); }} onDelete={() => setUserDeleteConfirmationOpen(true)} onEditSelection={editSelectedUserRows} onClearSelection={() => { setUserPendingDeletes([]); setNotice(""); }} onCancelEditing={cancelUserEditing} onSave={() => void saveUsers()} />}
      </section>}
      {mayEditGlobalReferences && userDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранных пользователей?" text={`Вы точно хотите удалить пользователей (${userPendingDeletes.length})? Это действие нельзя отменить.`} saving={saving} onCancel={() => setUserDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingUsers()} />}
      {view === "directories" && activeDirectoryGroup && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("projectSettings"); setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); }}>← К настройкам проекта</button><div className="toolbar-actions"><button type="button" onClick={exportProjectDirectory}>Экспорт в Excel</button>{mayEditProjectSettings && <><button type="button" onClick={downloadProjectDirectoryTemplate}>Скачать шаблон</button><button type="button" onClick={() => projectDirectoryFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={projectDirectoryFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectDirectory(file); }} /></>}</div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <DirectoryAgGrid title={focusedDirectoryTitle} rows={visibleDirectoryItems} drafts={directoryDrafts} employees={data?.placementEmployees ?? []} selectEmployee={activeDirectoryGroup.entity === "master"} pendingDeletes={directoryPendingDeletes} readOnly={!mayEditProjectSettings} onEdit={editDirectoryItem} onSelectionChange={changeDirectorySelection} onPatchDraft={patchDirectoryDraft} />
        {mayEditProjectSettings && <AdminGridFooter addLabel={`Добавить: ${focusedDirectoryTitle.toLocaleLowerCase("ru-RU")}`} countLabel="Всего" count={visibleDirectoryItems.length} deletingCount={directoryPendingDeletes.length} deletingLabel="Удалить" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(directoryDrafts.length)} editingExisting={directoryDrafts.some((draft) => Boolean(draft.id))} pendingCount={directoryDrafts.length} saving={saving} allowMultiple onAdd={addDirectoryItem} onDelete={() => setDirectoryDeleteConfirmationOpen(true)} onEditSelection={editSelectedDirectoryItems} onClearSelection={() => { setDirectoryPendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={cancelDirectoryEditing} onSave={() => void saveDirectoryItems()} />}
      </section>}
      {mayEditProjectSettings && directoryDeleteConfirmationOpen && activeDirectoryGroup && <AdminDeleteConfirmation title="Удалить выбранные значения?" text={`Вы точно хотите удалить значения (${directoryPendingDeletes.length}) из справочника «${focusedDirectoryTitle}» проекта «${activeSite?.name ?? ""}»?`} saving={saving} onCancel={() => setDirectoryDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingDirectoryItems(activeDirectoryGroup.entity)} />}
      </div>
    </section>
    {profileOpen && <div className="profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !profileSaving) setProfileOpen(false); }}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="profile-dialog-heading"><div className="profile-avatar"><AppIcon name="user" /></div><div><span>Профиль пользователя</span><h2 id="profile-title">{currentUser.fullName}</h2></div><button type="button" className="profile-close" onClick={() => setProfileOpen(false)} disabled={profileSaving} aria-label="Закрыть профиль">×</button></div>
        <dl className="profile-details"><div><dt>Email</dt><dd>{currentUser.email}</dd></div><div><dt>Роль</dt><dd>{ROLE_LABELS[role]}</dd></div>{role === "foreman" && <div><dt>Проект</dt><dd>{activeSite?.name ?? "Не назначен"}</dd></div>}</dl>
        <form className="profile-password-form" onSubmit={(event) => void changePassword(event)}><h3>Изменить пароль</h3><label><span>Текущий пароль</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label><span>Новый пароль</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><label><span>Повторите новый пароль</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} required /></label>{profileError && <div className="profile-message error" role="alert">{profileError}</div>}{profileNotice && <div className="profile-message success" role="status">{profileNotice}</div>}<button type="submit" className="profile-save" disabled={profileSaving}>{profileSaving ? "Сохраняем…" : "Изменить пароль"}</button></form>
        <button type="button" className="profile-logout" onClick={() => void logout()} disabled={profileSaving}>Выйти из системы</button>
      </section>
    </div>}
  </main>;
}
