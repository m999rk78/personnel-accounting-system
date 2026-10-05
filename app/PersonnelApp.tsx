"use client";
/* eslint-disable @next/next/no-img-element -- используется оригинальный SVG-логотип из TPS */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessRightsView } from "./AccessRightsView";
import { DirectoryAgGrid, EmployeeAgGrid, PlacementAgGrid, PositionAgGrid, ProjectAgGrid, ProjectEmployeeAgGrid, UserAgGrid, type GridEmployeeUsage, type GridEntry, type GridTimesheetMark } from "./AgDataGrids";
import { AuditLogView } from "./AuditLogView";
import { formatBitrix24Cooldown, remainingBitrix24Cooldown, type Bitrix24Cooldowns } from "./bitrix24Cooldown";
import { CustomSelect } from "./CustomSelect";
import { EquipmentAccountingView } from "./EquipmentAccountingView";
import { ExcelActionsMenu } from "./ExcelActionsMenu";
import { openExcelExportPreview } from "./excelExportPreviewStore";
import { hasPermission, type PermissionAction, type PermissionResource, type PermissionSet } from "./permissionModel";
import { ProjectCards } from "./ProjectCards";
import { TimesheetView } from "./TimesheetView";
import { UserAccessCards } from "./UserAccessCards";
import { parseWorkspaceLocation, workspaceUrl, type WorkspaceDirectoryFocus, type WorkspaceView } from "./appRoutes";
import { ROLE_LABELS, canViewAllProjects, type UserRole } from "./roles";

type Option = { id: number; name: string };
type Site = Option & { code: string; timezone: string };
type Employee = { id: number; bitrix24Id?: string | null; fullName: string; employmentType: string; department: string; position: string; source: string; bitrix24Stage: string; availabilityStatus: string; syncError: string | null; lastSyncedAt?: string | null; siteId: number | null; siteName: string | null };
type PositionRecord = { id: number; employmentType: string; department: string; position: string };
type AppUser = { id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; status?: "active" | "invited" };
type CurrentUser = { id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; permissions: PermissionSet; permissionsCustomized: boolean };
type Entry = {
  id: number; siteId: number; workDate: string; employeeId: number; shiftId: number; zoneId: number;
  mainWorkTypeId: number; subworkTypeId: number; note: string; masterId: number; hours: number;
  positionSnapshot: string; employeeName: string; employmentType: string; department: string; shiftName: string;
  zoneName: string; mainWorkTypeName: string; subworkTypeName: string; masterName: string;
  responsibleUserId: number | null; responsibleUserName: string; revision: number;
};
type ForemanProgress = { foremanId: number; foremanName: string; status: "not_started" | "draft" | "submitted"; submittedAt: string | null; employeeCount: number; rowCount: number; hours: number };
type DataSet = {
  sites: Site[]; employees: Employee[]; reportEmployees: Employee[]; placementEmployees: Employee[]; projectEmployees: Employee[]; positionCatalog: PositionRecord[]; employmentTypes: Option[]; departments: Option[]; positions: Option[]; shifts: Option[]; zones: Option[]; mainWorkTypes: Option[];
  subworkTypes: Option[]; masters: Option[]; entries: Entry[]; filledDates: string[]; users: AppUser[];
  reportSubmitted: boolean;
  employeeUsage: GridEmployeeUsage[];
  foremanProgress: ForemanProgress[];
  timesheetMarks: GridTimesheetMark[];
  syncStatus?: { id: number; status: string; startedAt: string; completedAt: string | null; summary: string | null; errorText: string | null } | null;
  bitrix24Cooldowns?: Bitrix24Cooldowns;
};
function emptyDataSet(sites: Site[] = []): DataSet {
  return {
    sites,
    employees: [],
    reportEmployees: [],
    placementEmployees: [],
    projectEmployees: [],
    positionCatalog: [],
    employmentTypes: [],
    departments: [],
    positions: [],
    shifts: [],
    zones: [],
    mainWorkTypes: [],
    subworkTypes: [],
    masters: [],
    entries: [],
    filledDates: [],
    users: [],
    reportSubmitted: false,
    employeeUsage: [],
    foremanProgress: [],
    timesheetMarks: [],
  };
}
type BitrixCheckDifference = { kind: "missing_locally" | "changed" | "outside_scope" | "missing_in_bitrix" | "incomplete" | "unknown_stage"; employeeName: string; details: string; bitrix24Id?: string; suggestedEmployeeIds?: number[] };
type BitrixCheckResult = { status: "ok" | "mismatch"; checkedAt: string; sourceReceived: number; compared: number; matched: number; totalDifferences: number; differences: BitrixCheckDifference[]; autoLinkable: number; needsReview: number; unmatched: number; linked?: number };
const BITRIX_DIFFERENCE_LABELS: Record<BitrixCheckDifference["kind"], string> = {
  missing_locally: "Нет в системе",
  changed: "Данные отличаются",
  outside_scope: "Вне выбранных стадий",
  missing_in_bitrix: "Нет в Битрикс24",
  incomplete: "Не заполнены поля",
  unknown_stage: "Неизвестная стадия",
};
type DraftRow = {
  key: string; roster?: boolean; lockedEmployee?: boolean; carriedFromPreviousDay?: boolean; employeeId: string; employeeQuery: string; shiftId: string; zoneId: string;
  mainWorkTypeId: string; subworkTypeId: string; note: string; masterId: string; hours: string;
};
type ReportDraftSession = {
  draftRows: DraftRow[];
  editingRows: { id: number; row: DraftRow }[];
  selectedRosterDraftKeys: string[];
  pendingDeletes: number[];
};
type View = WorkspaceView;
type UserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; assignedSiteId: string };
type EmployeeDraft = { key: string; id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string };
type EmployeeBulkChanges = { employmentType: string; department: string; position: string; projectSiteId: string };
type ProjectEmployeeDraft = { key: string; employeeId: string; employeeQuery: string };
type PositionDraft = { key: string; id?: number; employmentType: string; department: string; position: string };
type DirectoryEntity = "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";
type DirectoryFocus = WorkspaceDirectoryFocus;
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

type AppIconName = "calendar" | "pencil" | "trash" | "redo" | "check" | "pin" | "filter" | "user" | "report" | "workersReport" | "equipmentReport" | "workersTimesheet" | "equipmentTimesheet" | "settings" | "generalSettings" | "projectSettings";

function AppIcon({ name }: { name: AppIconName }) {
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "calendar" && <><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></>}
    {name === "pencil" && <><path d="M21.2 6.8 7.8 20.2a2 2 0 0 1-.8.5L2.6 22a.5.5 0 0 1-.6-.6L3.3 17a2 2 0 0 1 .5-.8L17.2 2.8a2.8 2.8 0 0 1 4 4Z"/><path d="m15 5 4 4"/></>}
    {name === "trash" && <><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></>}
    {name === "redo" && <><path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h16"/></>}
    {name === "check" && <path d="m20 6-11 11-5-5"/>}
    {name === "pin" && <><path d="M12 17v5M5 8.5l4-4V2h6v2.5l4 4V11H5Z"/><path d="M8 11v3h8v-3"/></>}
    {name === "filter" && <path d="M3 5h18l-7 8v6l-4 2v-8Z"/>}
    {name === "user" && <><circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/></>}
    {name === "report" && <><path d="M6 2h9l4 4v16H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v5h5M8 17v-3M12 17v-6M16 17v-8"/></>}
    {name === "workersReport" && <><path d="M6.5 10a5.5 5.5 0 0 1 11 0M5 10h14M9 10v1.5a3 3 0 0 0 6 0V10M12 4.5V7"/><path d="M4 21a8 8 0 0 1 16 0"/></>}
    {name === "equipmentReport" && <><path d="M5 21h9M8 21V7h3v14M8 9l3 3-3 3 3 3-3 3"/><path d="M3 7h18M8 7l4-4h3l3 4M3 5v4"/><path d="M19 7v7M19 14v2.5a2 2 0 0 1-4 0"/></>}
    {name === "workersTimesheet" && <><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/><circle cx="9" cy="13" r="2"/><path d="M6 19c.4-2 1.4-3 3-3s2.6 1 3 3M15 15l1.5 1.5L20 13"/></>}
    {name === "equipmentTimesheet" && <><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/><circle cx="10" cy="15" r="3"/><path d="M10 11v1M10 18v1M6 15h1M13 15h1M7.2 12.2l.7.7M12.1 17.1l.7.7M12.8 12.2l-.7.7M7.9 17.1l-.7.7M16 16l1.5 1.5L21 14"/></>}
    {name === "settings" && <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4.05v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z"/></>}
    {name === "generalSettings" && <><path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h4M12 12h8"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/><circle cx="10" cy="12" r="2"/></>}
    {name === "projectSettings" && <><path d="M4 21h16M6 21V7l6-3 6 3v14M9 10h2M13 10h2M9 14h2M13 14h2M10 21v-3h4v3"/></>}
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

function AdminGridFooter({ addLabel, countLabel, count, deletingCount, deletingLabel, editorOpen, editingExisting = false, pendingCount = 0, saving = false, allowMultiple = false, canCreate = true, canUpdate = true, canDelete = true, editSelectionLabel, bulkEditSelectionLabel, cancelEditingLabel = "Отменить редактирование", uniformActions = false, onAdd, onDelete, onEditSelection, onBulkEditSelection, onClearSelection, onCancelEditing, onSave }: { addLabel: string; countLabel: string; count: number; deletingCount: number; deletingLabel: string; editorOpen: boolean; editingExisting?: boolean; pendingCount?: number; saving?: boolean; allowMultiple?: boolean; canCreate?: boolean; canUpdate?: boolean; canDelete?: boolean; editSelectionLabel?: string; bulkEditSelectionLabel?: string; cancelEditingLabel?: string; uniformActions?: boolean; onAdd: () => void; onDelete: () => void; onEditSelection?: () => void; onBulkEditSelection?: () => void; onClearSelection?: () => void; onCancelEditing?: () => void; onSave?: () => void }) {
  const showAdd = canCreate && !editorOpen && !editingExisting && deletingCount === 0;
  const canSave = editingExisting ? canUpdate : canCreate;
  if (uniformActions) return <div className="table-edit-footer employee-table-footer uniform-footer-actions">
    {deletingCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{deletingCount}</strong></span></div>
      <div className="employee-selection-actions">
        {onEditSelection && <button type="button" className="employee-action-button employee-action-primary" onClick={onEditSelection} disabled={saving || !canUpdate} title={canUpdate ? undefined : "Нет права редактирования"}>{editSelectionLabel ?? "Редактировать"}</button>}
        {onBulkEditSelection && <button type="button" className="employee-action-button bulk-edit-selection-button" onClick={onBulkEditSelection} disabled={saving || !canUpdate} title={canUpdate ? undefined : "Нет права редактирования"}>{bulkEditSelectionLabel ?? "Массовое редактирование"}</button>}
        <button type="button" className="employee-action-button employee-action-danger" onClick={onDelete} disabled={saving || !canDelete} title={canDelete ? undefined : "Нет права удаления"}>{deletingLabel}</button>
        {onClearSelection && <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>}
      </div>
    </div>}
    {pendingCount > 0 && <div className="employee-editing-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Редактируется: <strong>{pendingCount}</strong></span></div>
      <div className="employee-selection-actions">
        {onCancelEditing && <button type="button" className="employee-action-button cancel-editing-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}
        {canSave && onSave && <button type="button" className="employee-action-button employee-save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button>}
      </div>
    </div>}
    {!editorOpen && deletingCount === 0 && <div className="employee-footer-base">
      {showAdd && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>}
      <span className="employee-total-count">{countLabel}: <strong>{count}</strong></span>
    </div>}
  </div>;
  return <div className="table-edit-footer employee-table-footer">{showAdd && <button type="button" className="secondary-button footer-action-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>}<div>{deletingCount > 0 && <div className="selection-actions">{onEditSelection && <button type="button" className="save-edits-button" onClick={onEditSelection} disabled={saving || !canUpdate} title={canUpdate ? undefined : "Нет права редактирования"}>{`${editSelectionLabel ?? "Редактировать"} (${deletingCount})`}</button>}{onBulkEditSelection && <button type="button" className="save-edits-button" onClick={onBulkEditSelection} disabled={saving || !canUpdate} title={canUpdate ? undefined : "Нет права редактирования"}>{`${bulkEditSelectionLabel ?? "Массовое редактирование"} (${deletingCount})`}</button>}<button type="button" className="delete-rows-button" onClick={onDelete} disabled={saving || !canDelete} title={canDelete ? undefined : "Нет права удаления"}>{`${deletingLabel} (${deletingCount})`}</button>{onClearSelection && <button type="button" className="secondary-button footer-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Отменить выделение</button>}</div>}{!editorOpen && deletingCount === 0 && <span>{countLabel}: <strong>{count}</strong></span>}{pendingCount > 0 && onCancelEditing && <button type="button" className="secondary-button footer-action-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}{pendingCount > 0 && canSave && onSave && <button type="button" className="save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : `Сохранить (${pendingCount})`}</button>}</div></div>;
}

function ReportGridFooter({ selectedCount, editingCount, newCount, totalHours, canCreate, canUpdate, canDelete, saving, onAdd, onEditSelection, onDelete, onClearSelection, onCancelEditing, onSaveEditing, onSaveNew }: { selectedCount: number; editingCount: number; newCount: number; totalHours: number; canCreate: boolean; canUpdate: boolean; canDelete: boolean; saving: boolean; onAdd: () => void; onEditSelection: () => void; onDelete: () => void; onClearSelection: () => void; onCancelEditing: () => void; onSaveEditing: () => void; onSaveNew: () => void }) {
  const changedCount = editingCount + newCount;
  return <div className="table-edit-footer employee-table-footer uniform-footer-actions report-table-footer">
    {selectedCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedCount}</strong></span></div>
      <div className="employee-selection-actions">
        <button type="button" className="employee-action-button employee-action-primary" onClick={onEditSelection} disabled={saving || !canUpdate} title={canUpdate ? undefined : "Нет права редактирования"}>Редактировать</button>
        <button type="button" className="employee-action-button employee-action-danger" onClick={onDelete} disabled={saving || !canDelete} title={canDelete ? undefined : "Нет права удаления"}>Удалить строки</button>
        <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>
      </div>
    </div>}
    {changedCount > 0 && <div className="employee-editing-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Редактируется: <strong>{changedCount}</strong></span></div>
      <div className="employee-selection-actions">
        <button type="button" className="employee-action-button cancel-editing-button" onClick={onCancelEditing} disabled={saving}>Отменить редактирование</button>
        {canUpdate && editingCount > 0 && <button type="button" className="employee-action-button employee-save-button" onClick={onSaveEditing} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button>}
        {canCreate && newCount > 0 && <button type="button" className="employee-action-button employee-save-button" onClick={onSaveNew} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить новые строки"}</button>}
      </div>
    </div>}
    {changedCount === 0 && selectedCount === 0 && <div className="employee-footer-base">
      {canCreate && editingCount === 0 && newCount === 0 && selectedCount === 0 && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd}>Добавить запись</button>}
      <span className="employee-total-count">Общее количество часов ОПР: <strong>{totalHours}</strong></span>
    </div>}
  </div>;
}

function RosterReportFooter({ mode, completed, total, selectedEntryCount, selectedDraftCount, totalHours, saving, editorOpen, showReviewActions, showCarryoverProgress, canCreate, canUpdate, canDelete, onAdd, onEditSelection, onRemoveDraftSelection, onDeleteSelection, onClearSelection, onReset, onSave }: { mode: "foreman" | "engineer"; completed: number; total: number; selectedEntryCount: number; selectedDraftCount: number; totalHours: number; saving: boolean; editorOpen: boolean; showReviewActions: boolean; showCarryoverProgress: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean; onAdd: () => void; onEditSelection: () => void; onRemoveDraftSelection: () => void; onDeleteSelection: () => void; onClearSelection: () => void; onReset: () => void; onSave: () => void }) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const remaining = Math.max(0, total - completed);
  const progressText = remaining ? `Нужно заполнить обязательные поля: ${remaining}` : "Все перенесённые сотрудники готовы к сохранению";
  const selectedCount = selectedEntryCount + selectedDraftCount;
  const selectedSavedEntries = selectedEntryCount > 0;
  const canRemoveSelection = selectedSavedEntries ? canDelete : canCreate;
  const saveLabel = canUpdate ? mode === "foreman" ? "Сохранить мою часть" : "Принять отчёт за день" : "Сохранить новые строки";
  return <div className="table-edit-footer employee-table-footer uniform-footer-actions report-table-footer roster-report-footer">
    {selectedCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{selectedCount}</strong></span></div>
      <div className="employee-selection-actions">
        {selectedSavedEntries && <button type="button" className="employee-action-button employee-action-primary" onClick={onEditSelection} disabled={saving || !canUpdate} title={canUpdate ? undefined : "Нет права редактирования"}>Редактировать</button>}
        <button type="button" className="employee-action-button employee-action-danger" onClick={selectedSavedEntries ? onDeleteSelection : onRemoveDraftSelection} disabled={saving || !canRemoveSelection} title={canRemoveSelection ? undefined : selectedSavedEntries ? "Нет права удаления" : "Нет права добавления"}>Убрать из отчёта</button>
        <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>
      </div>
    </div>}
    {showCarryoverProgress && total > 0 && <div className="roster-report-progress">
      <div className="roster-progress-copy"><strong>Готово к сохранению: {completed} из {total}</strong><span>{progressText}</span></div>
      <div className="roster-progress-track" role="progressbar" aria-label="Готовность перенесённых сотрудников" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}><span style={{ width: `${percent}%` }} /></div>
      <span className="roster-progress-percent">{percent}%</span>
    </div>}
    {showReviewActions && (canCreate || canUpdate) && <div className="employee-editing-bar roster-save-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Если всё как вчера, сразу сохраните. Измените только отличия за сегодня</span></div>
      <div className="employee-selection-actions">
        {editorOpen && canCreate && <button type="button" className="employee-action-button employee-add-button" onClick={onAdd} disabled={saving}>Добавить сотрудника</button>}
        <button type="button" className="employee-action-button cancel-editing-button" onClick={onReset} disabled={saving}>Вернуть исходные данные</button>
        <button type="button" className="employee-action-button employee-save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : saveLabel}</button>
      </div>
    </div>}
    {!editorOpen && selectedCount === 0 && <div className="employee-footer-base">
      {canCreate && !editorOpen && <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={saving}>Добавить сотрудника</button>}
      <span className="employee-total-count">Общее количество часов ОПР: <strong>{totalHours}</strong></span>
    </div>}
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
  const may = useCallback((resource: PermissionResource, action: PermissionAction = "view") => hasPermission(currentUser.permissions, resource, action), [currentUser.permissions]);
  const anyAction = (resource: PermissionResource) => (["create", "update", "delete"] as PermissionAction[]).some((action) => may(resource, action));
  const mayViewWorkersReport = may("workers_report");
  const mayViewEquipmentReport = may("equipment_report");
  const mayViewWorkersTimesheet = may("workers_timesheet");
  const mayViewEquipmentTimesheet = may("equipment_timesheet");
  const mayCreateWorkersReport = may("workers_report", "create");
  const mayUpdateWorkersReport = may("workers_report", "update");
  const mayDeleteWorkersReport = may("workers_report", "delete");
  const mayCreateEmployees = may("employees", "create");
  const mayUpdateEmployees = may("employees", "update");
  const mayDeleteEmployees = may("employees", "delete");
  const mayEditGlobalEmployees = anyAction("employees");
  const mayCreatePositions = may("positions", "create");
  const mayUpdatePositions = may("positions", "update");
  const mayDeletePositions = may("positions", "delete");
  const mayManagePositions = anyAction("positions");
  const mayCreateProjects = may("projects", "create");
  const mayUpdateProjects = may("projects", "update");
  const mayDeleteProjects = may("projects", "delete");
  const mayManageProjects = anyAction("projects");
  const mayCreateSystemUsers = may("system_users", "create");
  const mayUpdateSystemUsers = may("system_users", "update");
  const mayDeleteSystemUsers = may("system_users", "delete");
  const mayManageSystemUsers = anyAction("system_users");
  const mayCreateProjectEmployees = may("project_employees", "create");
  const mayUpdateProjectEmployees = may("project_employees", "update");
  const mayDeleteProjectEmployees = may("project_employees", "delete");
  const mayManageProjectEmployees = anyAction("project_employees");
  const mayCreateProjectDirectories = may("project_directories", "create");
  const mayUpdateProjectDirectories = may("project_directories", "update");
  const mayDeleteProjectDirectories = may("project_directories", "delete");
  const mayManageProjectDirectories = anyAction("project_directories");
  const mayAccessGeneralSettings = (["employees", "equipment_registry", "positions", "system_users", "projects", "audit_log", "access_rights"] as PermissionResource[]).some((resource) => may(resource));
  const mayAccessProjectSettings = (["project_employees", "project_equipment", "project_directories"] as PermissionResource[]).some((resource) => may(resource));
  const mayInspectBitrix24 = may("employees");
  const mayViewAllProjects = canViewAllProjects(role);
  const mayAccessTimesheets = mayViewWorkersTimesheet || mayViewEquipmentTimesheet;
  const [initialLocation] = useState(() => parseWorkspaceLocation(
    typeof window === "undefined" ? "/reports/workers" : window.location.pathname,
    typeof window === "undefined" ? "" : window.location.search,
    initialToday,
  ));
  const viewAllowed = useCallback((candidate: View) => candidate === "placement" ? mayViewWorkersReport
    : candidate === "equipment" ? mayViewEquipmentReport
      : candidate === "timesheet" ? mayViewWorkersTimesheet
        : candidate === "equipmentTimesheet" ? mayViewEquipmentTimesheet
          : candidate === "settings" ? mayAccessGeneralSettings
            : candidate === "employees" ? may("employees")
              : candidate === "equipmentRegistry" ? may("equipment_registry")
                : candidate === "positions" ? may("positions")
                  : candidate === "users" ? may("system_users")
                    : candidate === "projects" ? may("projects")
                      : candidate === "auditLog" ? may("audit_log")
                        : candidate === "accessRights" ? may("access_rights")
                          : candidate === "projectSettings" ? mayAccessProjectSettings
                            : candidate === "projectEmployees" ? may("project_employees")
                              : candidate === "projectEquipment" ? may("project_equipment")
                                : candidate === "directories" ? may("project_directories")
                                  : false, [may, mayAccessGeneralSettings, mayAccessProjectSettings, mayViewEquipmentReport, mayViewEquipmentTimesheet, mayViewWorkersReport, mayViewWorkersTimesheet]);
  const fallbackView = useMemo(() => (["placement", "equipment", "timesheet", "equipmentTimesheet", "projectSettings", "settings"] as View[]).find(viewAllowed) ?? "placement", [viewAllowed]);
  const initialView = viewAllowed(initialLocation.view) ? initialLocation.view : fallbackView;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reportsOpen, setReportsOpen] = useState(true);
  const [timesheetOpen, setTimesheetOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [view, setView] = useState<View>(initialView);
  const [siteId, setSiteId] = useState(currentUser.assignedSiteId ?? 1);
  const [workDate, setWorkDate] = useState(initialLocation.date);
  const [reportRangeEnd, setReportRangeEnd] = useState(initialLocation.date);
  const [selectedMonth, setSelectedMonth] = useState(initialLocation.month);
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
  const [linkingBitrix24, setLinkingBitrix24] = useState(false);
  const [bitrix24Clock, setBitrix24Clock] = useState(() => Date.now());
  const [bitrixCheckResult, setBitrixCheckResult] = useState<BitrixCheckResult | null>(null);
  const [bitrixManualLinks, setBitrixManualLinks] = useState<Record<string, string>>({});
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
  const [directoryFocus, setDirectoryFocus] = useState<DirectoryFocus>(initialView === "directories" ? initialLocation.directoryFocus : "all");
  const fileInput = useRef<HTMLInputElement>(null);
  const employeeFileInput = useRef<HTMLInputElement>(null);
  const positionFileInput = useRef<HTMLInputElement>(null);
  const projectEmployeeFileInput = useRef<HTMLInputElement>(null);
  const projectDirectoryFileInput = useRef<HTMLInputElement>(null);
  const loadedSiteId = useRef<number | null>(null);
  const loadedWorkDate = useRef<string | null>(null);
  const loadedReportRange = useRef<string | null>(null);
  const workspaceDataLoaded = useRef(false);
  const initializedRosterSession = useRef<string | null>(null);
  const reportDraftSessions = useRef(new Map<string, ReportDraftSession>());
  const adminDataLoaded = useRef(false);
  const recentDates = useMemo(() => recentDateKeys(reportRangeEnd), [reportRangeEnd]);
  const reportRangeQuery = `rangeStart=${recentDates[0]}&rangeEnd=${reportRangeEnd}`;
  const filledDates = useMemo(() => new Set(data?.filledDates ?? []), [data?.filledDates]);
  const activeSite = data?.sites.find((site) => site.id === siteId);
  const visibleEmployees = useMemo(() => data?.employees ?? [], [data?.employees]);
  const bitrixAvailableEmployeeOptions = useMemo(() => [{ value: "", label: "Выберите сотрудника" }, ...visibleEmployees.filter((employee) => !employee.bitrix24Id).map((employee) => ({
    value: String(employee.id),
    label: `${employee.fullName} · ${employee.employmentType} / ${employee.department} / ${employee.position}`,
  }))], [visibleEmployees]);
  const visibleProjectEmployees = data?.projectEmployees ?? data?.placementEmployees ?? [];
  const visiblePositions = data?.positionCatalog ?? [];
  const visibleUsers = data?.users ?? [];
  const visibleSites = data?.sites ?? [];
  const inspectBitrix24Remaining = remainingBitrix24Cooldown(data?.bitrix24Cooldowns?.inspect.nextAllowedAt, bitrix24Clock);
  const inspectBitrix24Title = inspectBitrix24Remaining > 0
    ? `Повторная проверка будет доступна через ${formatBitrix24Cooldown(inspectBitrix24Remaining)}.`
    : "Сравнивает связанные карточки с Битрикс24 без изменения справочника.";

  useEffect(() => {
    if (!mayInspectBitrix24 || view !== "employees") return;
    const refreshTimeout = window.setTimeout(() => setBitrix24Clock(Date.now()), 0);
    const interval = window.setInterval(() => setBitrix24Clock(Date.now()), 60_000);
    const deadlines = [data?.bitrix24Cooldowns?.inspect.nextAllowedAt]
      .flatMap((value) => value ? [new Date(value).getTime()] : []).filter((value) => Number.isFinite(value) && value > Date.now());
    const timeout = deadlines.length
      ? window.setTimeout(() => setBitrix24Clock(Date.now()), Math.min(...deadlines.map((deadline) => deadline - Date.now())) + 50)
      : undefined;
    return () => { window.clearTimeout(refreshTimeout); window.clearInterval(interval); if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [data?.bitrix24Cooldowns?.inspect.nextAllowedAt, mayInspectBitrix24, view]);

  useEffect(() => {
    const initialFocus = initialView === "directories" ? initialLocation.directoryFocus : "all";
    const canonicalUrl = workspaceUrl(initialView, initialFocus, initialLocation.date, initialLocation.month);
    if (!initialLocation.recognized || initialView !== initialLocation.view || `${window.location.pathname}${window.location.search}` !== canonicalUrl) {
      window.history.replaceState({}, "", canonicalUrl);
    }

    const restoreLocation = () => {
      const location = parseWorkspaceLocation(window.location.pathname, window.location.search, initialToday);
      const nextView = viewAllowed(location.view) ? location.view : fallbackView;
      const nextFocus = nextView === "directories" ? location.directoryFocus : "all";
      setSelectedMonth(location.month);
      setDirectoryFocus(nextFocus);
      setView(nextView);
      setWorkDate(location.date);
      setReportRangeEnd(location.date);
      setError("");
      setNotice("");
    };

    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [fallbackView, initialLocation, initialToday, initialView, viewAllowed]);

  useEffect(() => {
    const title = view === "placement" ? "Отчёт персонала"
      : view === "equipment" ? "Отчёт техники"
        : view === "timesheet" ? "Табель рабочих"
          : view === "equipmentTimesheet" ? "Табель техники"
            : view === "settings" ? "Общие настройки"
              : view === "projectSettings" ? "Настройки проекта"
                : view === "employees" ? "Сотрудники"
                  : view === "equipmentRegistry" ? "Реестр техники"
                    : view === "positions" ? "Список должностей"
                      : view === "users" ? "Пользователи системы"
                        : view === "projects" ? "Проекты"
                          : view === "auditLog" ? "Журнал действий"
                            : view === "accessRights" ? "Права доступа"
                          : view === "projectEmployees" ? "Сотрудники проекта"
                            : view === "projectEquipment" ? "Техника проекта"
                              : directoryFocus === "zone" ? "Зоны"
                                : directoryFocus === "mainWorkType" ? "Виды работ"
                                  : directoryFocus === "subworkType" ? "Виды подработ"
                                    : "Мастера";
    document.title = `${title} | Учёт персонала`;
  }, [directoryFocus, view]);
  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=settings&${reportRangeQuery}`, { cache: "no-store" });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as DataSet & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить данные.");
      setData(payload);
      loadedSiteId.current = siteId;
      loadedWorkDate.current = workDate;
      loadedReportRange.current = reportRangeQuery;
      adminDataLoaded.current = true;
      workspaceDataLoaded.current = false;
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
      workspaceDataLoaded.current = true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить рабочее пространство.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  const loadNavigation = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=navigation`, { cache: "no-store" });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as Pick<DataSet, "sites"> & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить список проектов.");
      setData(emptyDataSet(payload.sites));
      loadedSiteId.current = siteId;
      loadedWorkDate.current = workDate;
      loadedReportRange.current = reportRangeQuery;
      adminDataLoaded.current = false;
      workspaceDataLoaded.current = false;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить список проектов.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=entries&${reportRangeQuery}`, { cache: "no-store" });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const payload = await response.json() as Pick<DataSet, "entries" | "filledDates" | "reportSubmitted" | "employeeUsage" | "foremanProgress" | "timesheetMarks"> & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить отчёт.");
      setData((current) => current ? { ...current, entries: payload.entries, filledDates: payload.filledDates, reportSubmitted: payload.reportSubmitted, employeeUsage: payload.employeeUsage ?? [], foremanProgress: payload.foremanProgress ?? [], timesheetMarks: payload.timesheetMarks ?? [] } : current);
      loadedWorkDate.current = workDate;
      loadedReportRange.current = reportRangeQuery;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить отчёт.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  useEffect(() => {
    const settingsDataView = view === "employees" || view === "positions" || view === "users" || view === "projects" || view === "projectEmployees" || view === "directories";
    const loader = loadedSiteId.current !== siteId
      ? view === "placement" ? loadWorkspace : settingsDataView ? loadData : loadNavigation
      : settingsDataView && !adminDataLoaded.current
        ? loadData
        : view === "placement" && !workspaceDataLoaded.current
          ? loadWorkspace
          : view === "placement" && (loadedWorkDate.current !== workDate || loadedReportRange.current !== reportRangeQuery)
            ? loadEntries
            : null;
    if (!loader) return;
    const task = window.setTimeout(() => void loader(), 0);
    return () => window.clearTimeout(task);
  }, [siteId, workDate, view, reportRangeQuery, loadData, loadEntries, loadNavigation, loadWorkspace]);

  const filteredEntries = data?.entries ?? [];
  const exportEntries = visibleEntryIds === null
    ? filteredEntries
    : filteredEntries.filter((entry) => visibleEntryIds.includes(entry.id));
  const exportFileName = `Отчёт_персонала_${activeSite?.code ?? siteId}_${workDate}.xlsx`;
  const exportHeaders = ["Дата", "ФИО", "Смена", "Зона", "Виды основных работ", "Виды подработ", "Примечание", "Мастер", "Часы", "Тип - 2"];
  const exportWorkbookRows = exportEntries.map((entry) => ({ workDate: entry.workDate, employeeName: entry.employeeName, employmentType: entry.employmentType, department: entry.department, positionSnapshot: entry.positionSnapshot, shiftName: entry.shiftName, zoneName: entry.zoneName, mainWorkTypeName: entry.mainWorkTypeName, subworkTypeName: entry.subworkTypeName, masterName: entry.masterName, hours: entry.hours, note: entry.note }));
  const exportPreviewRows = exportWorkbookRows.map((entry) => [entry.workDate, entry.employeeName, entry.shiftName, entry.zoneName, entry.mainWorkTypeName, entry.subworkTypeName, entry.note, entry.masterName, entry.hours, entry.positionSnapshot]);
  const savedOprHours = exportEntries
    .filter((entry) => normalize(entry.employmentType) === "опр")
    .reduce((sum, entry) => sum + entry.hours, 0);
  const pendingCount = draftRows.length;
  const editingCount = editingRows.length;
  const canCreateReportDate = mayCreateWorkersReport;
  const canUpdateReportDate = mayUpdateWorkersReport;
  const canDeleteReportDate = mayDeleteWorkersReport;
  const canEditDate = canCreateReportDate || canUpdateReportDate || canDeleteReportDate;
  const rosterMode = useDailyRosterReport && workDate === initialToday && canEditDate;
  const entryTypeById = new Map(filteredEntries.map((entry) => [entry.id, entry.employmentType]));
  const employeeTypeById = new Map((data?.reportEmployees ?? []).map((employee) => [employee.id, employee.employmentType]));
  const editingEntryIds = new Set(editingRows.map((item) => item.id));
  const unchangedRosterOprHours = filteredEntries
    .filter((entry) => !editingEntryIds.has(entry.id) && normalize(entry.employmentType) === "опр")
    .reduce((sum, entry) => sum + entry.hours, 0);
  const rosterOprHours = unchangedRosterOprHours + [
    ...editingRows.map((item) => ({ row: item.row, employmentType: entryTypeById.get(item.id) ?? "" })),
    ...draftRows.map((row) => ({ row, employmentType: employeeTypeById.get(Number(row.employeeId)) ?? "" })),
  ].filter((item) => draftRowComplete(item.row) && normalize(item.employmentType) === "опр")
    .reduce((sum, item) => sum + Number(item.row.hours), 0);
  const totalOprHours = rosterMode ? rosterOprHours : savedOprHours;
  const carriedRowsByEmployee = new Map<string, DraftRow[]>();
  for (const row of draftRows) {
    if (!row.carriedFromPreviousDay || !row.employeeId) continue;
    carriedRowsByEmployee.set(row.employeeId, [...(carriedRowsByEmployee.get(row.employeeId) ?? []), row]);
  }
  const rosterTotal = carriedRowsByEmployee.size;
  const rosterCompleted = [...carriedRowsByEmployee.values()].filter((rows) => rows.every(draftRowComplete)).length;
  const showCarryoverProgress = Boolean(canCreateReportDate && !data?.reportSubmitted && rosterTotal > 0);
  const rosterEditorOpen = editingRows.length > 0 || draftRows.some((row) => !row.carriedFromPreviousDay);
  const rosterSessionKey = `${siteId}:${workDate}`;
  const previousDayLoading = rosterMode && canCreateReportDate && role === "foreman" && previousDayReport?.key !== rosterSessionKey;

  useEffect(() => {
    if (!rosterMode || !canCreateReportDate || view !== "placement") return;
    const key = `${siteId}:${workDate}`;
    if (role !== "foreman") return;
    const controller = new AbortController();
    void fetch(`/api/data?siteId=${siteId}&date=${workDate}&scope=carryover&beforeDate=${workDate}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { window.location.replace("/login"); return null; }
        const payload = await response.json() as Pick<DataSet, "entries"> & { sourceDate?: string | null; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить последний сохранённый отчёт.");
        return { entries: payload.entries, sourceDate: payload.sourceDate ?? "" };
      })
      .then((result) => { if (result) setPreviousDayReport({ key, date: result.sourceDate, entries: result.entries }); })
      .catch((carryError) => {
        if (carryError instanceof DOMException && carryError.name === "AbortError") return;
        setPreviousDayReport({ key, date: "", entries: [] });
        setError(carryError instanceof Error ? carryError.message : "Не удалось загрузить последний сохранённый отчёт.");
      });
    return () => controller.abort();
  }, [canCreateReportDate, role, rosterMode, siteId, view, workDate]);

  useEffect(() => {
    if (!rosterMode || view !== "placement" || loading || previousDayLoading || !data || loadedWorkDate.current !== workDate || (role === "foreman" && previousDayReport?.key !== rosterSessionKey)) return;
    const rosterSession = rosterSessionKey;
    const preserveManualRows = initializedRosterSession.current === rosterSession;
    initializedRosterSession.current = rosterSession;
    if (!preserveManualRows || data.reportSubmitted) {
      setEditingRows([]);
      setSelectedRosterDraftKeys([]);
      setPendingDeletes([]);
    }
    setDraftRows((current) => {
      if (data.reportSubmitted) return [];
      const initialRows = canCreateReportDate ? buildRosterDraftRows(data, role === "foreman" ? previousDayReport?.entries ?? [] : []) : [];
      if (!preserveManualRows) return initialRows;
      return current;
    });
    setDeleteConfirmationOpen(false);
  }, [canCreateReportDate, data, loading, previousDayLoading, previousDayReport, role, rosterMode, rosterSessionKey, view, workDate]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  }
  function openProfile() {
    setCurrentPassword(""); setNewPassword(""); setRepeatPassword(""); setProfileError(""); setProfileNotice(""); setProfileOpen(true);
  }
  function reportDraftSessionKey(nextSiteId = siteId, nextWorkDate = workDate) {
    return `${nextSiteId}:${nextWorkDate}`;
  }
  function rememberCurrentReportDraftSession() {
    const key = reportDraftSessionKey();
    if (!draftRows.length && !editingRows.length && !pendingDeletes.length) {
      reportDraftSessions.current.delete(key);
      return;
    }
    reportDraftSessions.current.set(key, {
      draftRows: draftRows.map((row) => ({ ...row })),
      editingRows: editingRows.map((item) => ({ ...item, row: { ...item.row } })),
      selectedRosterDraftKeys: [...selectedRosterDraftKeys],
      pendingDeletes: [...pendingDeletes],
    });
  }
  function takeReportDraftSession(nextSiteId: number, nextWorkDate: string) {
    const key = reportDraftSessionKey(nextSiteId, nextWorkDate);
    const session = reportDraftSessions.current.get(key);
    reportDraftSessions.current.delete(key);
    if (session) initializedRosterSession.current = key;
    return session;
  }
  function clearCurrentReportDraftSession() {
    reportDraftSessions.current.delete(reportDraftSessionKey());
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
    if (nextSiteId === siteId) return;
    rememberCurrentReportDraftSession();
    const session = takeReportDraftSession(nextSiteId, workDate);
    setSiteId(nextSiteId); setDraftRows(session?.draftRows ?? []); setEditingRows(session?.editingRows ?? []); setPreviousDayReport(null); setSelectedRosterDraftKeys(session?.selectedRosterDraftKeys ?? []); setPendingDeletes(session?.pendingDeletes ?? []); setDeleteConfirmationOpen(false);
    setProjectEmployeeDrafts([]); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false);
    setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false);
  }
  function changeWorkDate(nextDate: string) {
    if (nextDate === workDate) return;
    rememberCurrentReportDraftSession();
    const session = takeReportDraftSession(siteId, nextDate);
    setSelectedMonth(nextDate.slice(0, 7));
    setWorkDate(nextDate); setDraftRows(session?.draftRows ?? []); setEditingRows(session?.editingRows ?? []); setPreviousDayReport(null); setSelectedRosterDraftKeys(session?.selectedRosterDraftKeys ?? []); setPendingDeletes(session?.pendingDeletes ?? []); setDeleteConfirmationOpen(false); setVisibleEntryIds(null);
    if (view === "placement" || view === "equipment") window.history.replaceState({}, "", workspaceUrl(view, directoryFocus, nextDate, nextDate.slice(0, 7)));
  }
  function changeReportRange(nextEnd: string) {
    setReportRangeEnd(nextEnd > initialToday ? initialToday : nextEnd);
  }

  function changeTimesheetMonth(nextMonth: string) {
    setSelectedMonth(nextMonth);
    if (view === "timesheet" || view === "equipmentTimesheet") window.history.replaceState({}, "", workspaceUrl(view, directoryFocus, workDate, nextMonth));
  }

  function navigateTo(nextView: View, nextDirectoryFocus: DirectoryFocus = "all") {
    const allowedView = viewAllowed(nextView) ? nextView : fallbackView;
    const allowedFocus = allowedView === "directories" ? nextDirectoryFocus : "all";
    const url = workspaceUrl(allowedView, allowedFocus, workDate, selectedMonth);
    setDirectoryFocus(allowedFocus);
    setView(allowedView);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState({}, "", url);
    window.scrollTo({ top: 0, behavior: "auto" });
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
    if (!canUpdateReportDate || (role === "foreman" && entry.responsibleUserId !== currentUser.id) || (!rosterMode && draftRows.length) || pendingDeletes.includes(entry.id)) return;
    setPendingDeletes([]);
    setEditingRows((current) => {
      const existing = current.find((item) => item.id === entry.id);
      if (existing) return current.map((item) => item.id === entry.id ? { ...item, row: { ...item.row, ...changes } } : item);
      return [...current, { id: entry.id, row: { ...makeEntryDraft(entry), ...changes } }];
    });
    setNotice("");
  }
  function changeReportSelection(ids: number[]) {
    if (!canUpdateReportDate && !canDeleteReportDate) return;
    setPendingDeletes(ids);
    if (!rosterMode) setEditingRows((current) => current.filter((item) => !ids.includes(item.id)));
    setError("");
    setNotice("");
  }
  function editSelectedReportRows() {
    if (!canUpdateReportDate || draftRows.length) return;
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
    if (rosterMode && canCreateReportDate && data && !data.reportSubmitted) {
      setEditingRows([]);
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
    if (!canCreateReportDate || (!rosterMode && editingRows.length)) return;
    setDraftRows((rows) => [...rows, makeDraft(seed)]);
    setNotice("");
  }
  function removeSelectedRosterDraftRows() {
    const selected = new Set(selectedRosterDraftKeys);
    setDraftRows((rows) => rows.filter((row) => !selected.has(row.key)));
    setSelectedRosterDraftKeys([]);
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
    if (!canCreateReportDate || !pendingCount) return;
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows(draftRows);
      if (draftRows.length) {
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: draftRows.map(payload) }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить новые строки.");
      }
      const count = pendingCount;
      clearCurrentReportDraftSession(); setDraftRows([]); setNotice(`Добавлено записей: ${count}`);
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
    if (editingRows.length && !canUpdateReportDate) {
      setError("Недостаточно прав для редактирования строк отчёта.");
      return;
    }
    if (newRows.length && !canCreateReportDate) {
      setError("Недостаточно прав для добавления строк отчёта.");
      return;
    }
    if (!editingRows.length && !newRows.length && !canUpdateReportDate) return;
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows(editingRows.map((item) => item.row));
      validateRows(newRows);
      const response = await fetch("/api/data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: editingRows.map((item) => ({ id: item.id, revision: data?.entries.find((entry) => entry.id === item.id)?.revision, ...payload(item.row) })),
          newEntries: newRows.map(payload),
          ...(canUpdateReportDate ? role === "foreman" ? { submitOwnReport: { siteId, workDate } } : { finalizeReport: { siteId, workDate } } : {}),
        }),
      });
      const result = await response.json() as { error?: string; updatedCount?: number; createdCount?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить отчёт.");
      const updated = result.updatedCount ?? editingRows.length;
      const created = result.createdCount ?? newRows.length;
      clearCurrentReportDraftSession();
      setDraftRows([]);
      setEditingRows([]);
      setSelectedRosterDraftKeys([]);
      const summary = [created ? `добавлено строк: ${created}` : "", updated ? `обновлено строк: ${updated}` : ""].filter(Boolean).join(", ");
      setNotice(canUpdateReportDate
        ? summary
          ? `${role === "foreman" ? "Ваша часть отчёта сохранена" : "Отчёт за день принят"}: ${summary}.`
          : role === "foreman" ? "Ваша часть отчёта сохранена без рабочих за этот день." : "Отчёт принят без рабочих за этот день."
        : `Новые строки сохранены${created ? `: ${created}` : ""}.`);
      await loadEntries();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить отчёт."); }
    finally { setSaving(false); }
  }
  async function saveEditing() {
    if (!canUpdateReportDate || !editingRows.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows(editingRows.map((item) => item.row));
      const response = await fetch("/api/data", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: editingRows.map((item) => ({ id: item.id, revision: data?.entries.find((entry) => entry.id === item.id)?.revision, ...payload(item.row) })) }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить изменения.");
      const count = result.count ?? editingRows.length;
      clearCurrentReportDraftSession(); setEditingRows([]); setNotice(`Изменено записей: ${count}`); await loadEntries();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить изменения."); }
    finally { setSaving(false); }
  }
  async function deletePendingEntries() {
    if (!canDeleteReportDate || !pendingDeletes.length) return;
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
    if (!mayUpdateSystemUsers) return;
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
    if (!mayUpdateSystemUsers) return;
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
    if (userDrafts.some((draft) => draft.id ? !mayUpdateSystemUsers : !mayCreateSystemUsers)) {
      setError(userDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования пользователей." : "Недостаточно прав для добавления пользователей.");
      return;
    }
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
    if (!mayDeleteSystemUsers || !userPendingDeletes.length) return;
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
    if (!mayUpdateEmployees) return;
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
    if (!mayUpdateEmployees || !employeePendingDeletes.length) return;
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
        const projectSiteId = employeeBulkChanges.projectSiteId === "__unassigned__"
          ? ""
          : employeeBulkChanges.projectSiteId || (employee.siteId ? String(employee.siteId) : "");
        return { key: `employee-${employee.id}`, id: employee.id, fullName: employee.fullName, employmentType, department, position, projectSiteId } satisfies EmployeeDraft;
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
    if (employeeDrafts.some((draft) => draft.id ? !mayUpdateEmployees : !mayCreateEmployees)) {
      setError(employeeDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования сотрудников." : "Недостаточно прав для добавления сотрудников.");
      return;
    }
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
        if (!draft.fullName.trim() || !draft.employmentType.trim() || !draft.department.trim() || !draft.position.trim()) throw new Error(`Строка ${index + 1}: заполните ФИО, тип, отдел и должность.`);
        if (!validEmploymentTypes.has(normalize(draft.employmentType))) throw new Error(`Строка ${index + 1}: значение «${draft.employmentType}» не относится к столбцу «Тип».`);
        if (!validDepartments.has(normalize(draft.department))) throw new Error(`Строка ${index + 1}: значение «${draft.department}» не относится к столбцу «Отдел».`);
        if (!validPositions.has(normalize(draft.position))) throw new Error(`Строка ${index + 1}: значение «${draft.position}» не относится к столбцу «Должность».`);
        if (draft.projectSiteId && !validSites.has(Number(draft.projectSiteId))) throw new Error(`Строка ${index + 1}: выбранный проект не найден или закрыт.`);
        if (!validPositionCombinations.has(normalize(`${draft.employmentType}|${draft.department}|${draft.position}`))) throw new Error(`Строка ${index + 1}: сочетание типа, отдела и должности отсутствует в справочнике должностей.`);
        const name = normalize(draft.fullName);
        if (usedNames.has(name)) throw new Error(`Строка ${index + 1}: сотрудник «${draft.fullName.trim()}» уже есть в справочнике.`);
        usedNames.add(name);
      });
      for (let index = 0; index < employeeDrafts.length; index += 1) {
        const draft = employeeDrafts[index];
        const response = await fetch("/api/data", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: draft.id ? "update-employee" : "create-employee", employeeId: draft.id, fullName: draft.fullName, employmentType: draft.employmentType, department: draft.department, position: draft.position, projectSiteId: draft.projectSiteId ? Number(draft.projectSiteId) : null }) });
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
    if (!mayDeleteEmployees || !employeePendingDeletes.length) return;
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
    if (!mayUpdatePositions) return;
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
    if (!mayUpdatePositions) return;
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
    if (positionDrafts.some((draft) => draft.id ? !mayUpdatePositions : !mayCreatePositions)) {
      setError(positionDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования должностей." : "Недостаточно прав для добавления должностей.");
      return;
    }
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
    if (!mayDeletePositions || !positionPendingDeletes.length) return;
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
  function openSettingsExportPreview(options: { title: string; description: string; fileName: string; sheetName: string; workbookTitle: string; headers: string[]; rows: (string | number)[][] }) {
    setError("");
    try {
      openExcelExportPreview({
        version: 1,
        title: options.title,
        description: options.description,
        fileName: options.fileName,
        headers: options.headers,
        rows: options.rows,
        workbook: { kind: "table", sheetName: options.sheetName, workbookTitle: options.workbookTitle, rows: options.rows },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
  }
  function exportEmployees() {
    if (!data) return;
    const employees = employeeVisibleIds === null ? visibleEmployees : visibleEmployees.filter((employee) => employeeVisibleIds.includes(employee.id));
    const headers = ["ФИО", "Тип", "Отдел", "Должность", "Проект"];
    const rows = employees.map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position, employee.siteName ?? "Без объекта"]);
    openSettingsExportPreview({ title: "Сотрудники", description: `Строк в выгрузке: ${rows.length}`, fileName: "Сотрудники.xlsx", sheetName: "Сотрудники", workbookTitle: "Список сотрудников", headers, rows });
  }
  function showBitrixCheckResult(result: BitrixCheckResult) {
    setBitrixCheckResult(result);
    setBitrixManualLinks(Object.fromEntries(result.differences.flatMap((difference) =>
      difference.kind === "missing_locally" && difference.bitrix24Id && difference.suggestedEmployeeIds?.length === 1
        ? [[difference.bitrix24Id, String(difference.suggestedEmployeeIds[0])]]
        : [])));
  }
  async function inspectBitrix24Connection() {
    setSyncingBitrix24(true); setBitrixCheckResult(null); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "inspect-bitrix24" }) });
      const result = await response.json() as BitrixCheckResult & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось проверить подключение к Битрикс24.");
      await loadData();
      showBitrixCheckResult(result);
    } catch (inspectError) {
      const message = inspectError instanceof Error ? inspectError.message : "Не удалось проверить подключение к Битрикс24.";
      await loadData();
      setError(message);
    } finally { setSyncingBitrix24(false); }
  }
  async function linkBitrix24Employees(links?: Array<{ bitrix24Id: string; employeeId: number }>) {
    setLinkingBitrix24(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link-bitrix24-employees", ...(links ? { links } : {}) }) });
      const result = await response.json() as BitrixCheckResult & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сопоставить сотрудников с Битрикс24.");
      await loadData();
      showBitrixCheckResult(result);
      if (result.linked) setNotice(`Сопоставлено сотрудников с Битрикс24: ${result.linked}.`);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "Не удалось сопоставить сотрудников с Битрикс24.");
    } finally { setLinkingBitrix24(false); }
  }
  function exportPositions() {
    if (!data) return;
    const positions = positionVisibleIds === null ? visiblePositions : visiblePositions.filter((position) => positionVisibleIds.includes(position.id));
    const headers = ["Тип", "Отдел", "Должность"];
    const rows = positions.map((position) => [position.employmentType, position.department, position.position]);
    openSettingsExportPreview({ title: "Должности", description: `Строк в выгрузке: ${rows.length}`, fileName: "Список_должностей.xlsx", sheetName: "Должности", workbookTitle: "Список должностей", headers, rows });
  }
  async function importEmployees(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, ["ФИО", "Тип", "Отдел", "Должность", "Проект"]);
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-employees", employees: rows.map((row) => ({ fullName: row["ФИО"], employmentType: row["Тип"], department: row["Отдел"], position: row["Должность"], projectCode: row["Проект"] })) }) });
      const result = await response.json() as { error?: string; count?: number; unassigned?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать сотрудников.");
      const imported = result.count ?? rows.length;
      setNotice(`Импортировано сотрудников: ${imported}${result.unassigned ? ` · без объекта: ${result.unassigned}` : ""}`); await loadData();
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
  function exportProjectEmployees() {
    if (!data) return;
    const projectName = activeSite?.name ?? "Проект";
    const headers = ["ФИО", "Тип", "Отдел", "Должность"];
    const rows = visibleProjectEmployees.map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position]);
    openSettingsExportPreview({ title: "Сотрудники проекта", description: `${projectName} · строк в выгрузке: ${rows.length}`, fileName: `Сотрудники_${safeFilePart(projectName)}.xlsx`, sheetName: "Сотрудники проекта", workbookTitle: `Сотрудники проекта — ${projectName}`, headers, rows });
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
  function exportProjectDirectory() {
    if (!activeDirectoryGroup) return;
    const projectName = activeSite?.name ?? "Проект";
    if (activeDirectoryGroup.entity === "master") {
      const employeesByName = new Map((data?.placementEmployees ?? []).map((employee) => [normalize(employee.fullName), employee]));
      const headers = ["ФИО", "Тип", "Отдел", "Должность"];
      const rows = visibleDirectoryItems.map((item) => { const employee = employeesByName.get(normalize(item.name)); return [item.name, employee?.employmentType ?? "", employee?.department ?? "", employee?.position ?? ""]; });
      openSettingsExportPreview({ title: "Мастера", description: `${projectName} · строк в выгрузке: ${rows.length}`, fileName: `Мастера_${safeFilePart(projectName)}.xlsx`, sheetName: "Мастера", workbookTitle: `Мастера — ${projectName}`, headers, rows });
      return;
    }
    const header = directoryExcelHeader(activeDirectoryGroup.entity);
    const rows = visibleDirectoryItems.map((item) => [item.name]);
    openSettingsExportPreview({ title: focusedDirectoryTitle, description: `${projectName} · строк в выгрузке: ${rows.length}`, fileName: `${safeFilePart(focusedDirectoryTitle)}_${safeFilePart(projectName)}.xlsx`, sheetName: focusedDirectoryTitle, workbookTitle: `${focusedDirectoryTitle} — ${projectName}`, headers: [header], rows });
  }
  function exportProjects() {
    const headers = ["Проект", "Код", "Часовой пояс"];
    const rows = visibleSites.map((site) => [site.name, site.code, site.timezone]);
    openSettingsExportPreview({ title: "Проекты", description: `Строк в выгрузке: ${rows.length}`, fileName: "Проекты.xlsx", sheetName: "Проекты", workbookTitle: "Список проектов", headers, rows });
  }
  function exportUsers() {
    const siteNames = new Map(visibleSites.map((site) => [site.id, site.name]));
    const headers = ["ФИО", "Email", "Роль", "Проект", "Статус"];
    const rows = visibleUsers.map((user) => [user.fullName, user.email, ROLE_LABELS[user.role], user.assignedSiteId ? siteNames.get(user.assignedSiteId) ?? "Проект не найден" : "Не назначен", user.status === "invited" ? "Приглашён" : "Активен"]);
    openSettingsExportPreview({ title: "Пользователи системы", description: `Строк в выгрузке: ${rows.length}`, fileName: "Пользователи_системы.xlsx", sheetName: "Пользователи", workbookTitle: "Пользователи системы", headers, rows });
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
    if (!mayCreateProjectEmployees || !projectEmployeeDrafts.length) return;
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
    if (!mayDeleteProjectEmployees || !projectEmployeePendingDeletes.length) return;
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
    if (!mayUpdateProjectDirectories) return;
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
    if (!mayUpdateProjectDirectories) return;
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
    if (!mayCreateProjectDirectories) return;
    if (!activeDirectoryGroup || directoryDrafts.some((draft) => Boolean(draft.id))) return;
    setDirectoryDrafts((current) => [...current, { key: newKey(), entity: activeDirectoryGroup.entity, name: "" }]);
    setNotice("");
  }
  async function saveDirectoryItems() {
    if (!activeDirectoryGroup || !directoryDrafts.length) return;
    if (directoryDrafts.some((draft) => draft.id ? !mayUpdateProjectDirectories : !mayCreateProjectDirectories)) {
      setError(directoryDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования справочника." : "Недостаточно прав для добавления значений справочника.");
      return;
    }
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
    if (!mayDeleteProjectDirectories || !directoryPendingDeletes.length) return;
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
    if (!mayUpdateProjects) return;
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
    if (!mayUpdateProjects) return;
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
    if (siteDrafts.some((draft) => draft.id ? !mayUpdateProjects : !mayCreateProjects)) {
      setError(siteDrafts.some((draft) => Boolean(draft.id)) ? "Недостаточно прав для редактирования проектов." : "Недостаточно прав для добавления проектов.");
      return;
    }
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
    if (!mayDeleteProjects || !sitePendingDeletes.length) return;
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
  function openExportPreview() {
    if (!data) return;
    setError("");
    try {
      openExcelExportPreview({
        version: 1,
        title: "Отчёт персонала",
        description: `${activeSite?.name ?? "Объект"} · ${workDate}`,
        fileName: exportFileName,
        headers: exportHeaders,
        rows: exportPreviewRows,
        workbook: { kind: "placement", siteName: activeSite?.name ?? "Объект", rangeStart: workDate, rangeEnd: workDate, rows: exportWorkbookRows },
        source: { kind: "personnel", siteId, siteCode: activeSite?.code ?? String(siteId), siteName: activeSite?.name ?? "Объект", initialDate: workDate },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
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
  const generalSettingsCards: Array<{ icon: string; title: string; description: string; resource: PermissionResource; view?: View; focus?: DirectoryFocus }> = [
    { icon: "С", title: "Сотрудники", description: "Кадровые данные и проекты сотрудников с безопасной проверкой по Битрикс24.", resource: "employees", view: "employees" },
    { icon: "Т", title: "Реестр техники", description: "Единый список техники с назначением на проекты.", resource: "equipment_registry", view: "equipmentRegistry" },
    { icon: "Д", title: "Список должностей", description: "Единая таблица сочетаний «Тип / Отдел / Должность» с импортом и экспортом Excel.", resource: "positions", view: "positions" },
    { icon: "П", title: "Пользователи системы", description: "Учётные записи, приглашения, роли и назначенные проекты.", resource: "system_users", view: "users" },
    { icon: "Д", title: "Права доступа", description: "Индивидуальный доступ к разделам и действиям для каждого пользователя.", resource: "access_rights", view: "accessRights" },
    { icon: "П", title: "Проекты", description: "Строительные проекты и управление их названиями.", resource: "projects", view: "projects" },
    { icon: "Ж", title: "Журнал действий", description: "Кто, когда и какие изменения вносил в отчёты, табели, справочники и настройки.", resource: "audit_log", view: "auditLog" },
  ];
  const projectSettingsCards: Array<{ icon: string; title: string; description: string; resource: PermissionResource; focus?: DirectoryFocus; view?: View }> = [
    { icon: "С", title: "Сотрудники проекта", description: "Состав выбранного проекта без дублирования карточек сотрудников.", resource: "project_employees", view: "projectEmployees" },
    { icon: "Т", title: "Техника проекта", description: "Техника, назначенная выбранному проекту, без дублирования общего реестра.", resource: "project_equipment", view: "projectEquipment" },
    { icon: "З", title: "Зоны", description: "Зоны, доступные только в выбранном проекте.", resource: "project_directories", focus: "zone" },
    { icon: "Р", title: "Виды работ", description: "Работы из одноимённой колонки отчёта выбранного проекта.", resource: "project_directories", focus: "mainWorkType" },
    { icon: "П", title: "Виды подработ", description: "Виды подработ, доступные только в выбранном проекте.", resource: "project_directories", focus: "subworkType" },
    { icon: "М", title: "Мастера", description: "Мастера из одноимённой колонки отчёта выбранного проекта.", resource: "project_directories", focus: "master" },
  ];
  const tableWorkspacePage = view === "placement"
    || view === "equipment"
    || view === "equipmentRegistry"
    || view === "projectEquipment"
    || view === "employees"
    || view === "positions"
    || view === "projectEmployees"
    || view === "directories";
  const pageContentClassName = view === "placement"
    ? "page-content personnel-report-page table-workspace-page"
    : tableWorkspacePage ? "page-content table-workspace-page" : "page-content";

  return <main className={sidebarOpen ? "app-shell" : "app-shell sidebar-collapsed"}>
    <button type="button" className="sidebar-edge-trigger" onClick={() => setSidebarOpen((open) => !open)} aria-controls="primary-sidebar" aria-expanded={sidebarOpen} aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"} title={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={sidebarOpen ? "m14 7-5 5 5 5" : "m10 7 5 5-5 5"}/></svg>
    </button>
    <aside className="sidebar" id="primary-sidebar">
      <div className="brand-project-row"><button type="button" className="brand" onClick={() => { setReportsOpen(true); navigateTo(fallbackView); }} aria-label="Открыть доступный раздел" title="Открыть доступный раздел"><img src="/tps-logo.svg" alt="" /></button>{mayViewAllProjects ? <ProjectSwitcher sites={data?.sites ?? []} value={siteId} onChange={changeSite} /> : <div className="project-fixed-card top-project-select" title={activeSite?.name ?? "Объект"}>{activeSite?.name ?? "Объект"}</div>}</div>
      <div className="sidebar-product-title">Ресурсный отчёт</div>
      <nav aria-label="Основная навигация">
        {(mayViewWorkersReport || mayViewEquipmentReport) && <div className="nav-group">
          <button type="button" className="nav-heading" onClick={() => setReportsOpen((open) => !open)} aria-expanded={reportsOpen} aria-controls="reports-navigation" aria-label={reportsOpen ? "Свернуть раздел «Отчеты»" : "Развернуть раздел «Отчеты»"}><span className="nav-heading-icon"><AppIcon name="report" /></span><span>Отчеты</span><SidebarChevron open={reportsOpen} /></button>
          {(reportsOpen || !sidebarOpen) && <div className="nav-sub" id="reports-navigation">{mayViewWorkersReport && <button className={view === "placement" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("placement")} aria-label="Рабочие" title="Рабочие"><span className="nav-item-icon"><AppIcon name="workersReport" /></span>Рабочие</button>}{mayViewEquipmentReport && <button className={view === "equipment" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("equipment")} aria-label="Техника" title="Техника"><span className="nav-item-icon"><AppIcon name="equipmentReport" /></span>Техника</button>}</div>}
        </div>}
        {mayAccessTimesheets && <div className="nav-group">
          <button type="button" className="nav-heading" onClick={() => setTimesheetOpen((open) => !open)} aria-expanded={timesheetOpen} aria-controls="timesheet-navigation" aria-label={timesheetOpen ? "Свернуть раздел «Табели»" : "Развернуть раздел «Табели»"}><span className="nav-heading-icon"><AppIcon name="calendar" /></span><span>Табели</span><SidebarChevron open={timesheetOpen} /></button>
          {(timesheetOpen || !sidebarOpen) && <div className="nav-sub" id="timesheet-navigation">{mayViewWorkersTimesheet && <button className={view === "timesheet" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("timesheet")} aria-label="Табель рабочих" title="Табель рабочих"><span className="nav-item-icon"><AppIcon name="workersTimesheet" /></span>Рабочие</button>}{mayViewEquipmentTimesheet && <button className={view === "equipmentTimesheet" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("equipmentTimesheet")} aria-label="Табель техники" title="Табель техники"><span className="nav-item-icon"><AppIcon name="equipmentTimesheet" /></span>Техника</button>}</div>}
        </div>}
      </nav>
      <div className="sidebar-bottom"><div className="nav-group settings-group">
        <button type="button" className="nav-heading" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-controls="settings-navigation" aria-label={settingsOpen ? "Свернуть раздел «Настройки»" : "Развернуть раздел «Настройки»"}><span className="nav-heading-icon"><AppIcon name="settings" /></span><span>Настройки</span><SidebarChevron open={settingsOpen} /></button>
        {(settingsOpen || !sidebarOpen) && <div className="nav-sub" id="settings-navigation">
          {mayAccessGeneralSettings && <button className={view === "settings" || view === "users" || view === "employees" || view === "positions" || view === "projects" || view === "equipmentRegistry" || view === "auditLog" || view === "accessRights" ? "nav-item active" : "nav-item"} onClick={() => { navigateTo("settings"); setUserDrafts([]); setUserFullRowEditIds([]); setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setPositionDrafts([]); setPositionFullRowEditIds([]); setSiteDrafts([]); setSiteFullRowEditIds([]); }} aria-label="Общие настройки" title="Общие настройки"><span className="nav-item-icon"><AppIcon name="generalSettings" /></span>Общие</button>}
          {mayAccessProjectSettings && <button className={view === "projectSettings" || view === "projectEmployees" || view === "projectEquipment" || view === "directories" ? "nav-item active" : "nav-item"} onClick={() => { navigateTo("projectSettings"); setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setProjectEmployeeDrafts([]); }} aria-label="Настройки проекта" title="Настройки проекта"><span className="nav-item-icon"><AppIcon name="projectSettings" /></span>Настройки проекта</button>}
        </div>}
      </div>
        <div className="sidebar-user"><div><strong>{currentUser.fullName}</strong><small>{ROLE_LABELS[role]}</small></div><button className="profile-button" onClick={openProfile} title="Профиль" aria-label="Открыть профиль пользователя"><AppIcon name="user" /></button></div>
      </div>
    </aside>
    <section className="workspace">
      <div className={pageContentClassName}><div className={["page-heading", view === "placement" || view === "equipment" ? "report-page-heading" : "", view === "timesheet" || view === "equipmentTimesheet" ? "timesheet-page-heading" : ""].filter(Boolean).join(" ")}>
        <div className="page-heading-title"><h1>{view === "placement" ? "Отчёт персонала" : view === "equipment" ? "Отчёт техники" : view === "timesheet" ? "Табель рабочих" : view === "equipmentTimesheet" ? "Табель техники" : view === "equipmentRegistry" ? "Реестр техники" : view === "projectEquipment" ? "Техника проекта" : view === "employees" ? "Сотрудники" : view === "settings" ? "Общие настройки" : view === "projectSettings" ? "Настройки проекта" : view === "projectEmployees" ? "Сотрудники проекта" : view === "users" ? "Пользователи системы" : view === "positions" ? "Список должностей" : view === "projects" ? "Проекты" : view === "auditLog" ? "Журнал действий" : view === "accessRights" ? "Права доступа" : focusedDirectoryTitle}</h1></div>
        {view === "placement" && <div className="report-heading-controls">
          <div className="report-heading-date"><ReportDateNavigation dates={recentDates} value={workDate} today={initialToday} filledDates={filledDates} onChange={changeWorkDate} onRangeChange={changeReportRange} /></div>
          <ExcelActionsMenu actions={[
            { label: "Экспорт в Excel", onSelect: openExportPreview, disabled: !data },
            ...(mayCreateWorkersReport ? [
              { label: importing ? "Импортируем…" : "Импорт из Excel", onSelect: () => fileInput.current?.click(), disabled: importing },
              { label: "Скачать шаблон", onSelect: downloadTemplate },
            ] : []),
          ]} />
          <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importExcel(file); }} />
        </div>}
        {view === "equipment" && <div id="equipment-report-actions" className="report-heading-portal" />}
        {view === "timesheet" && <div id="personnel-timesheet-actions" className="timesheet-heading-portal" />}
        {view === "equipmentTimesheet" && <div id="equipment-timesheet-actions" className="timesheet-heading-portal" />}
      </div>

      {mayViewWorkersReport && view === "placement" && <>
        {error && <div className="message error"><strong>Нужно проверить данные</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {notice && <div className="message success"><strong>Готово</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
        <section className="table-card personnel-table-card">
          {rosterMode && role !== "foreman" && Boolean(data?.foremanProgress?.length) && <div className="foreman-report-progress" role="status"><strong>Сдали прорабы: {data!.foremanProgress.filter((item) => item.status === "submitted").length} из {data!.foremanProgress.length}</strong><span>{data!.foremanProgress.map((item) => `${item.foremanName}: ${item.status === "submitted" ? `${item.employeeCount} чел., ${item.hours} ч.` : "не сдал"}`).join(" · ")}</span></div>}
          <PlacementAgGrid
            entries={filteredEntries}
            draftRows={draftRows}
            editing={editingRows}
            employees={data?.reportEmployees ?? []}
            employeeUsage={data?.employeeUsage ?? []}
            timesheetMarks={data?.timesheetMarks ?? []}
            shifts={data?.shifts ?? []}
            zones={data?.zones ?? []}
            mainWorkTypes={data?.mainWorkTypes ?? []}
            subworkTypes={data?.subworkTypes ?? []}
            masters={data?.masters ?? []}
            loading={loading || (rosterMode && previousDayLoading)}
            canCreate={canCreateReportDate}
            canUpdate={canUpdateReportDate}
            canDelete={canDeleteReportDate}
            rosterMode={rosterMode}
            showResponsibleUser={role !== "foreman"}
            currentUserName={currentUser.fullName}
            pendingDeletes={pendingDeletes}
            selectedDraftKeys={selectedRosterDraftKeys}
            onEdit={startEdit}
            onSelectionChange={(ids) => { changeReportSelection(ids); if (ids.length) setSelectedRosterDraftKeys([]); }}
            onDraftSelectionChange={(keys) => { setSelectedRosterDraftKeys(keys); if (keys.length) setPendingDeletes([]); }}
            onPatchDraft={patchDraft}
            onPatchEditing={patchEditing}
            onVisibleEntryIdsChange={(ids) => setVisibleEntryIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
          />
          {rosterMode
            ? <RosterReportFooter mode={role === "foreman" ? "foreman" : "engineer"} completed={rosterCompleted} total={rosterTotal} selectedEntryCount={pendingDeletes.length} selectedDraftCount={selectedRosterDraftKeys.length} totalHours={totalOprHours} saving={saving} editorOpen={rosterEditorOpen} showReviewActions={editingRows.length > 0 || draftRows.length > 0 || (canUpdateReportDate && !data?.reportSubmitted)} showCarryoverProgress={showCarryoverProgress} canCreate={canCreateReportDate} canUpdate={canUpdateReportDate} canDelete={canDeleteReportDate} onAdd={() => addRow({ hours: "" })} onEditSelection={editSelectedReportRows} onRemoveDraftSelection={removeSelectedRosterDraftRows} onDeleteSelection={() => setDeleteConfirmationOpen(true)} onClearSelection={() => { setPendingDeletes([]); setSelectedRosterDraftKeys([]); }} onReset={cancelReportEditing} onSave={() => void saveRosterReport()} />
            : <ReportGridFooter selectedCount={pendingDeletes.length} editingCount={editingCount} newCount={pendingCount} totalHours={totalOprHours} canCreate={canCreateReportDate} canUpdate={canUpdateReportDate} canDelete={canDeleteReportDate} saving={saving} onAdd={() => addRow()} onEditSelection={editSelectedReportRows} onDelete={() => setDeleteConfirmationOpen(true)} onClearSelection={() => { setPendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={cancelReportEditing} onSaveEditing={() => void saveEditing()} onSaveNew={() => void savePending()} />}
        </section>
      </>}

      {mayViewWorkersTimesheet && view === "timesheet" && <TimesheetView siteId={siteId} initialMonth={selectedMonth} today={initialToday} onMonthChange={changeTimesheetMonth} />}
      {mayViewEquipmentReport && view === "equipment" && <EquipmentAccountingView key={`equipment-report-${siteId}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} mode="daily" onDateChange={changeWorkDate} />}
      {mayViewEquipmentTimesheet && view === "equipmentTimesheet" && <EquipmentAccountingView key={`equipment-timesheet-${siteId}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} mode="month" onMonthChange={changeTimesheetMonth} />}

      {canDeleteReportDate && deleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirmation-title"><h2 id="delete-confirmation-title">Удалить выбранные строки?</h2><p>Вы точно хотите удалить строки ({pendingDeletes.length})? Это действие нельзя отменить.</p><div><button type="button" className="secondary-button" onClick={() => setDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEntries()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}

      {view === "equipmentRegistry" && may("equipment_registry") && <section className="users-settings admin-section equipment-settings-section"><div className="settings-toolbar"><button type="button" className="back-button" onClick={() => navigateTo("settings")}>← К общим настройкам</button><div className="toolbar-actions" id="equipment-registry-actions" /></div><EquipmentAccountingView key={`equipment-registry-${siteId}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} mode="registry" /></section>}
      {view === "projectEquipment" && may("project_equipment") && <section className="users-settings admin-section equipment-settings-section"><div className="settings-toolbar"><button type="button" className="back-button" onClick={() => navigateTo("projectSettings")}>← К настройкам проекта</button><div className="toolbar-actions" id="project-equipment-actions" /></div><EquipmentAccountingView key={`project-equipment-${siteId}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} mode="project" /></section>}

      {view === "settings" && mayAccessGeneralSettings && <section className="settings-home general-settings-home"><p className="settings-scope-description">Общие данные используются во всей системе и не зависят от выбранного проекта.</p><div className="settings-list">{generalSettingsCards.filter((card) => may(card.resource)).map((card) => <button type="button" className="settings-list-item" key={card.title} onClick={() => { setError(""); setNotice(""); setUserDrafts([]); setUserFullRowEditIds([]); setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setPositionDrafts([]); setPositionFullRowEditIds([]); setDirectoryDrafts([]); setSiteDrafts([]); setSiteFullRowEditIds([]); setInvitationResults([]); setEmployeePendingDeletes([]); setPositionPendingDeletes([]); setUserPendingDeletes([]); setSitePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setEmployeeBulkEditOpen(false); setPositionDeleteConfirmationOpen(false); setUserDeleteConfirmationOpen(false); setSiteDeleteConfirmationOpen(false); if (card.focus) navigateTo("directories", card.focus); else if (card.view) navigateTo(card.view); }}><span className="settings-card-icon">{card.icon}</span><span className="settings-row-copy"><strong>{card.title}</strong><span>{card.description}</span></span><span className="settings-list-arrow" aria-hidden="true">›</span></button>)}</div></section>}

      {view === "auditLog" && may("audit_log") && <AuditLogView onBack={() => navigateTo("settings")} />}
      {view === "accessRights" && may("access_rights") && <AccessRightsView onBack={() => navigateTo("settings")} />}
      {view === "projectSettings" && mayAccessProjectSettings && <section className="settings-home">
        <div className="settings-grid">{projectSettingsCards.filter((card) => may(card.resource)).map((card) => <button type="button" key={card.title} onClick={() => { setError(""); setNotice(""); setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setProjectEmployeeDrafts([]); if (card.focus) navigateTo("directories", card.focus); else if (card.view) navigateTo(card.view); }}><span className="settings-card-icon">{card.icon}</span><strong>{card.title}</strong><p>{card.description}</p></button>)}</div>
      </section>}
      {view === "projectEmployees" && may("project_employees") && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { navigateTo("projectSettings"); setProjectEmployeeDrafts([]); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false); }}>← К настройкам проекта</button><div className="toolbar-actions"><button type="button" onClick={exportProjectEmployees}>Экспорт в Excel</button>{mayCreateProjectEmployees && <><button type="button" onClick={downloadProjectEmployeeTemplate}>Скачать шаблон</button><button type="button" onClick={() => projectEmployeeFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={projectEmployeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectEmployees(file); }} /></>}</div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <ProjectEmployeeAgGrid rows={visibleProjectEmployees} allEmployees={data?.employees ?? []} drafts={projectEmployeeDrafts} pendingDeletes={projectEmployeePendingDeletes} readOnly={!mayCreateProjectEmployees} selectionDisabled={!mayDeleteProjectEmployees} onPatchDraft={patchProjectEmployeeDraft} onSelectionChange={(ids) => { setProjectEmployeePendingDeletes(ids); setError(""); setNotice(""); }} />
        {mayManageProjectEmployees && <AdminGridFooter addLabel="Добавить сотрудника в проект" countLabel="Всего в проекте" count={visibleProjectEmployees.length} deletingCount={projectEmployeePendingDeletes.length} deletingLabel="Убрать из проекта" uniformActions editorOpen={Boolean(projectEmployeeDrafts.length)} pendingCount={projectEmployeeDrafts.length} saving={saving} allowMultiple canCreate={mayCreateProjectEmployees} canUpdate={mayUpdateProjectEmployees} canDelete={mayDeleteProjectEmployees} onAdd={() => { setProjectEmployeeDrafts((current) => [...current, { key: newKey(), employeeId: "", employeeQuery: "" }]); setNotice(""); }} onDelete={() => setProjectEmployeeDeleteConfirmationOpen(true)} onClearSelection={() => { setProjectEmployeePendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={() => { setProjectEmployeeDrafts([]); setError(""); setNotice(""); }} onSave={() => void assignProjectEmployees()} />}
      </section>}
      {mayDeleteProjectEmployees && projectEmployeeDeleteConfirmationOpen && <AdminDeleteConfirmation title="Убрать выбранных сотрудников из проекта?" text={`Сотрудники (${projectEmployeePendingDeletes.length}) исчезнут только из проекта «${activeSite?.name ?? ""}». Их общие карточки и история отчётов сохранятся.`} saving={saving} onCancel={() => setProjectEmployeeDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingProjectEmployees()} />}
      {view === "employees" && may("employees") && <section className="users-settings admin-section employee-section">
        <div className="settings-toolbar">
          <button type="button" className="back-button" onClick={() => { navigateTo("settings"); setBitrixCheckResult(null); setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setEmployeePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setEmployeeBulkEditOpen(false); }}>← К настройкам</button>
          <div className="toolbar-actions">{mayInspectBitrix24 && <span className="cooldown-button-wrapper" title={inspectBitrix24Title}><button type="button" className="bitrix-check-button" onClick={() => void inspectBitrix24Connection()} disabled={syncingBitrix24 || linkingBitrix24 || importing || inspectBitrix24Remaining > 0}>{syncingBitrix24 ? "Проверяем…" : "Проверить с Битрикс24"}</button></span>}<button type="button" onClick={exportEmployees}>Экспорт в Excel</button>{(mayCreateEmployees || mayUpdateEmployees) && <><button type="button" onClick={() => employeeFileInput.current?.click()} disabled={importing || syncingBitrix24 || linkingBitrix24}>Импорт из Excel</button><input ref={employeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importEmployees(file); }} /></>}</div>
        </div>
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
          readOnly={!mayUpdateEmployees}
          selectionDisabled={!mayUpdateEmployees && !mayDeleteEmployees}
          onEdit={(employee, changes = {}) => { setEmployeePendingDeletes([]); setEmployeeDrafts((current) => {
            if (!mayUpdateEmployees) return current;
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
        {mayEditGlobalEmployees && <AdminGridFooter addLabel="Добавить сотрудника" countLabel="Всего сотрудников" count={visibleEmployees.length} deletingCount={employeePendingDeletes.length} deletingLabel="Удалить сотрудников" editSelectionLabel="Редактировать" bulkEditSelectionLabel="Массовое редактирование" uniformActions editorOpen={Boolean(employeeDrafts.length)} editingExisting={employeeDrafts.some((draft) => Boolean(draft.id))} pendingCount={employeeDrafts.length} saving={saving} allowMultiple canCreate={mayCreateEmployees} canUpdate={mayUpdateEmployees} canDelete={mayDeleteEmployees} onAdd={() => { setEmployeeDrafts((current) => current.some((draft) => draft.id) ? current : [...current, { key: newKey(), fullName: "", employmentType: "", department: "", position: "", projectSiteId: "" }]); setNotice(""); }} onDelete={() => setEmployeeDeleteConfirmationOpen(true)} onEditSelection={editSelectedEmployeeRows} onBulkEditSelection={openEmployeeBulkEdit} onClearSelection={() => { setEmployeePendingDeletes([]); setEmployeeBulkEditOpen(false); setEmployeeBulkEditError(""); setNotice(""); }} onCancelEditing={cancelEmployeeEditing} onSave={() => void saveEmployees()} />}
      </section>}

      {bitrixCheckResult && <div className="bitrix-check-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !linkingBitrix24) setBitrixCheckResult(null); }}><section className={`bitrix-check-dialog ${bitrixCheckResult.status}`} role="dialog" aria-modal="true" aria-labelledby="bitrix-check-title">
        <div className="bitrix-check-heading"><span className="bitrix-check-icon" aria-hidden="true">{bitrixCheckResult.status === "ok" ? "✓" : "!"}</span><div><small>{bitrixCheckResult.linked ? "СОПОСТАВЛЕНИЕ ВЫПОЛНЕНО" : "ПРОВЕРКА БЕЗ ИЗМЕНЕНИЯ ДАННЫХ"}</small><h2 id="bitrix-check-title">{bitrixCheckResult.status === "ok" ? "Всё в порядке" : "Найдены расхождения"}</h2><p>{bitrixCheckResult.linked ? `Сохранено связей: ${bitrixCheckResult.linked}. Кадровые данные, проекты, отчёты и табели не изменялись.` : bitrixCheckResult.status === "ok" ? "Связанные карточки сотрудников совпадают с данными Битрикс24." : "Проверка нашла отличия и возможные совпадения. Автоматически связываются только полностью совпадающие карточки."}</p></div><button type="button" className="bitrix-check-close" aria-label="Закрыть результат проверки" onClick={() => setBitrixCheckResult(null)} disabled={linkingBitrix24}>×</button></div>
        <div className="bitrix-check-stats"><div><span>Прочитано</span><strong>{bitrixCheckResult.sourceReceived}</strong></div><div><span>Сравнено</span><strong>{bitrixCheckResult.compared}</strong></div><div><span>Совпадает</span><strong>{bitrixCheckResult.matched}</strong></div><div><span>Расхождений</span><strong>{bitrixCheckResult.totalDifferences}</strong></div></div>
        {bitrixCheckResult.status === "mismatch" && <div className="bitrix-check-differences">{bitrixCheckResult.differences.map((difference, index) => {
          const selectedEmployeeId = difference.bitrix24Id ? bitrixManualLinks[difference.bitrix24Id] ?? "" : "";
          const canLinkManually = mayUpdateEmployees && bitrixCheckResult.autoLinkable === 0 && difference.kind === "missing_locally" && Boolean(difference.bitrix24Id);
          return <article key={`${difference.kind}-${difference.employeeName}-${index}`}><div><strong>{difference.employeeName}</strong><span>{difference.details}</span>{canLinkManually && <div className="bitrix-manual-link"><CustomSelect searchable className="bitrix-manual-select" value={selectedEmployeeId} ariaLabel={`Сотрудник системы для ${difference.employeeName}`} onChange={(employeeId) => setBitrixManualLinks((current) => ({ ...current, [difference.bitrix24Id!]: employeeId }))} options={bitrixAvailableEmployeeOptions} /><button type="button" disabled={!selectedEmployeeId || linkingBitrix24} onClick={() => void linkBitrix24Employees([{ bitrix24Id: difference.bitrix24Id!, employeeId: Number(selectedEmployeeId) }])}>{linkingBitrix24 ? "Сопоставляем…" : "Сопоставить"}</button></div>}</div><em>{BITRIX_DIFFERENCE_LABELS[difference.kind]}</em></article>;
        })}{bitrixCheckResult.totalDifferences > bitrixCheckResult.differences.length && <p>Показаны первые {bitrixCheckResult.differences.length} из {bitrixCheckResult.totalDifferences} расхождений.</p>}</div>}
        {error && <div className="bitrix-link-error" role="alert">{error}</div>}
        <div className="bitrix-check-footer"><span>{bitrixCheckResult.autoLinkable > 0 ? `Найдено точных совпадений: ${bitrixCheckResult.autoLinkable}. Будет сохранена только связь с ID Битрикс24 — карточки и история не изменятся.` : bitrixCheckResult.needsReview || bitrixCheckResult.unmatched ? `Требуют ручной проверки: ${bitrixCheckResult.needsReview + bitrixCheckResult.unmatched}. Выберите соответствующего сотрудника непосредственно в строке.` : "Сотрудники, добавленные вручную или через Excel, не изменялись."}</span><div>{mayUpdateEmployees && bitrixCheckResult.autoLinkable > 0 && <button type="button" className="bitrix-auto-link-button" onClick={() => void linkBitrix24Employees()} disabled={linkingBitrix24}>{linkingBitrix24 ? "Сопоставляем…" : `Сопоставить автоматически: ${bitrixCheckResult.autoLinkable}`}</button>}<button type="button" onClick={() => setBitrixCheckResult(null)} disabled={linkingBitrix24}>Закрыть</button></div></div>
      </section></div>}

      {employeeBulkEditOpen && <div className="confirmation-backdrop employee-bulk-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeBulkEditOpen(false); }}><section className="employee-bulk-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-bulk-edit-title">
        <div className="employee-bulk-edit-heading"><div><h2 id="employee-bulk-edit-title">Массовое редактирование сотрудников</h2><p>Выбрано сотрудников: {employeePendingDeletes.length}. Укажите только те поля, которые нужно изменить у всех отмеченных сотрудников. Остальные значения сохранятся.</p></div><button type="button" className="bulk-edit-close" aria-label="Закрыть массовое редактирование" onClick={() => setEmployeeBulkEditOpen(false)}>×</button></div>
        {employeeBulkEditError && <div className="bulk-edit-error" role="alert">{employeeBulkEditError}</div>}
        <div className="employee-bulk-edit-form">
          <div className="employee-bulk-edit-field"><span>Тип</span><CustomSelect value={employeeBulkChanges.employmentType} ariaLabel="Новый тип для выбранных сотрудников" onChange={(employmentType) => { setEmployeeBulkChanges((current) => ({ ...current, employmentType })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.employmentTypes ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Отдел</span><CustomSelect value={employeeBulkChanges.department} ariaLabel="Новый отдел для выбранных сотрудников" onChange={(department) => { setEmployeeBulkChanges((current) => ({ ...current, department })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.departments ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Должность</span><CustomSelect value={employeeBulkChanges.position} ariaLabel="Новая должность для выбранных сотрудников" onChange={(position) => { setEmployeeBulkChanges((current) => ({ ...current, position })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.positions ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Проект</span><CustomSelect value={employeeBulkChanges.projectSiteId} ariaLabel="Новый проект для выбранных сотрудников" onChange={(projectSiteId) => { setEmployeeBulkChanges((current) => ({ ...current, projectSiteId })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, { value: "__unassigned__", label: "Без объекта" }, ...(data?.sites ?? []).map((option) => ({ value: String(option.id), label: option.name }))]} /></div>
        </div>
        <div className="bulk-edit-selection-summary"><strong>Выбрано:</strong><span>{visibleEmployees.filter((employee) => employeePendingDeletes.includes(employee.id)).slice(0, 4).map((employee) => employee.fullName).join(", ")}{employeePendingDeletes.length > 4 ? ` и ещё ${employeePendingDeletes.length - 4}` : ""}</span></div>
        <div className="employee-bulk-edit-actions"><button type="button" className="secondary-button" onClick={() => setEmployeeBulkEditOpen(false)}>Отмена</button><button type="button" className="save-edits-button" onClick={applyEmployeeBulkEdit}>Применить к таблице</button></div>
      </section></div>}

      {mayDeleteEmployees && employeeDeleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-delete-confirmation-title"><h2 id="employee-delete-confirmation-title">Удалить выбранных сотрудников?</h2><p>Вы точно хотите удалить сотрудников ({employeePendingDeletes.length})? Они исчезнут из активного справочника и проектов, но история ранее созданных отчётов сохранится.</p><div><button type="button" className="secondary-button" onClick={() => setEmployeeDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEmployees()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}
      {view === "positions" && may("positions") && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { navigateTo("settings"); setPositionDrafts([]); setPositionFullRowEditIds([]); setPositionPendingDeletes([]); setPositionDeleteConfirmationOpen(false); }}>← К настройкам</button><div className="toolbar-actions"><button type="button" onClick={exportPositions}>Экспорт в Excel</button>{mayCreatePositions && <><button type="button" onClick={() => positionFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={positionFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPositions(file); }} /></>}</div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <PositionAgGrid rows={visiblePositions} drafts={positionDrafts} employmentTypes={data?.employmentTypes ?? []} departments={data?.departments ?? []} pendingDeletes={positionPendingDeletes} fullRowEditIds={positionFullRowEditIds} readOnly={!mayUpdatePositions} selectionDisabled={!mayUpdatePositions && !mayDeletePositions} onEdit={editPositionRow} onSelectionChange={(ids) => { setPositionPendingDeletes(ids); setPositionDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id))); setPositionFullRowEditIds((current) => current.filter((id) => !ids.includes(id))); setNotice(""); }} onPatchDraft={patchPositionDraft} onVisibleIdsChange={(ids) => setPositionVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)} />
        {mayManagePositions && <AdminGridFooter addLabel="Добавить должность" countLabel="Всего должностей" count={visiblePositions.length} deletingCount={positionPendingDeletes.length} deletingLabel="Удалить должности" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(positionDrafts.length)} editingExisting={positionDrafts.some((draft) => Boolean(draft.id))} pendingCount={positionDrafts.length} saving={saving} allowMultiple canCreate={mayCreatePositions} canUpdate={mayUpdatePositions} canDelete={mayDeletePositions} onAdd={() => { setPositionDrafts((current) => current.some((draft) => draft.id) ? current : [...current, { key: newKey(), employmentType: "", department: "", position: "" }]); setNotice(""); }} onDelete={() => setPositionDeleteConfirmationOpen(true)} onEditSelection={editSelectedPositionRows} onClearSelection={() => { setPositionPendingDeletes([]); setNotice(""); }} onCancelEditing={cancelPositionEditing} onSave={() => void savePositions()} />}
      </section>}
      {mayDeletePositions && positionDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные должности?" text={`Вы точно хотите удалить должности (${positionPendingDeletes.length})? Используемые сотрудниками должности удалить нельзя.`} saving={saving} onCancel={() => setPositionDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingPositions()} />}

      {view === "projects" && may("projects") && <section className="users-settings admin-section reference-section project-cards-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { navigateTo("settings"); setSiteDrafts([]); setSiteFullRowEditIds([]); setSitePendingDeletes([]); setSiteDeleteConfirmationOpen(false); }}>← К настройкам</button><div className="toolbar-actions"><button type="button" onClick={exportProjects} disabled={!visibleSites.length}>Экспорт в Excel</button></div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        {useProjectCardLayout
          ? <ProjectCards rows={visibleSites} drafts={siteDrafts} employees={data?.employees ?? []} users={data?.users ?? []} currentSiteId={siteId} selectedIds={sitePendingDeletes} readOnly={!mayManageProjects} canCreate={mayCreateProjects} canUpdate={mayUpdateProjects} canDelete={mayDeleteProjects} onEdit={editSiteRow} onSelectionChange={changeSiteSelection} onPatchDraft={patchSiteDraft} onCancelEditing={cancelSiteEditing} onSave={() => void saveSites()} saving={saving} />
          : <ProjectAgGrid rows={visibleSites} drafts={siteDrafts} pendingDeletes={sitePendingDeletes} fullRowEditIds={siteFullRowEditIds} onEdit={editSiteRow} onSelectionChange={changeSiteSelection} onPatchDraft={patchSiteDraft} />}
        {mayManageProjects && <AdminGridFooter addLabel="Добавить проект" countLabel="Всего проектов" count={visibleSites.length} deletingCount={sitePendingDeletes.length} deletingLabel="Удалить проекты" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(siteDrafts.length)} editingExisting={siteDrafts.some((draft) => Boolean(draft.id))} pendingCount={siteDrafts.length} saving={saving} canCreate={mayCreateProjects} canUpdate={mayUpdateProjects} canDelete={mayDeleteProjects} onAdd={() => { setSiteDrafts((current) => current.length ? current : [...current, { key: newKey(), name: "", code: "", timezone: "Europe/Moscow" }]); setNotice(""); }} onDelete={() => setSiteDeleteConfirmationOpen(true)} onEditSelection={editSelectedSiteRows} onClearSelection={() => { setSitePendingDeletes([]); setNotice(""); }} onCancelEditing={cancelSiteEditing} onSave={() => void saveSites()} />}
      </section>}
      {mayDeleteProjects && siteDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные проекты?" text={`Вы точно хотите удалить проекты (${sitePendingDeletes.length})? Проекты со связанными сотрудниками, пользователями или отчётами удалить нельзя.`} saving={saving} onCancel={() => setSiteDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingSites()} />}

      {view === "users" && may("system_users") && <section className="users-settings admin-section reference-section user-access-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { navigateTo("settings"); setUserDrafts([]); setUserFullRowEditIds([]); setUserPendingDeletes([]); setUserDeleteConfirmationOpen(false); setInvitationResults([]); }}>← К настройкам</button><div className="toolbar-actions"><button type="button" onClick={exportUsers} disabled={!visibleUsers.length}>Экспорт в Excel</button></div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        {invitationResults.map((invitation) => <div className="invitation-result" key={invitation.email}><strong>Приглашение для {invitation.email}</strong><span>Передайте эту ссылку пользователю. После настройки почты она будет отправляться автоматически.</span><a href={invitation.url}>{invitation.url}</a></div>)}
        {useUserAccessCardLayout
          ? <UserAccessCards rows={visibleUsers} drafts={userDrafts} sites={data?.sites ?? []} selectedIds={userPendingDeletes} readOnly={!mayManageSystemUsers} canCreate={mayCreateSystemUsers} canUpdate={mayUpdateSystemUsers} canDelete={mayDeleteSystemUsers} onEdit={editUserRow} onSelectionChange={changeUserSelection} onPatchDraft={patchUserDraft} onCancelEditing={cancelUserEditing} onSave={() => void saveUsers()} saving={saving} />
          : <UserAgGrid rows={visibleUsers} drafts={userDrafts} sites={data?.sites ?? []} pendingDeletes={userPendingDeletes} fullRowEditIds={userFullRowEditIds} onEdit={editUserRow} onSelectionChange={changeUserSelection} onPatchDraft={patchUserDraft} />}
        {mayManageSystemUsers && <AdminGridFooter addLabel="Добавить пользователя" countLabel="Всего пользователей" count={visibleUsers.length} deletingCount={userPendingDeletes.length} deletingLabel="Удалить пользователей" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(userDrafts.length)} editingExisting={userDrafts.some((draft) => Boolean(draft.id))} pendingCount={userDrafts.length} saving={saving} canCreate={mayCreateSystemUsers} canUpdate={mayUpdateSystemUsers} canDelete={mayDeleteSystemUsers} onAdd={() => { setUserDrafts((current) => current.length ? current : [...current, { key: newKey(), fullName: "", email: "", role: "foreman", assignedSiteId: String(siteId) }]); setNotice(""); }} onDelete={() => setUserDeleteConfirmationOpen(true)} onEditSelection={editSelectedUserRows} onClearSelection={() => { setUserPendingDeletes([]); setNotice(""); }} onCancelEditing={cancelUserEditing} onSave={() => void saveUsers()} />}
      </section>}
      {mayDeleteSystemUsers && userDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранных пользователей?" text={`Вы точно хотите удалить пользователей (${userPendingDeletes.length})? Это действие нельзя отменить.`} saving={saving} onCancel={() => setUserDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingUsers()} />}
      {view === "directories" && may("project_directories") && activeDirectoryGroup && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { navigateTo("projectSettings"); setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); }}>← К настройкам проекта</button><div className="toolbar-actions"><button type="button" onClick={exportProjectDirectory}>Экспорт в Excel</button>{mayCreateProjectDirectories && <><button type="button" onClick={downloadProjectDirectoryTemplate}>Скачать шаблон</button><button type="button" onClick={() => projectDirectoryFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={projectDirectoryFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectDirectory(file); }} /></>}</div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <DirectoryAgGrid title={focusedDirectoryTitle} rows={visibleDirectoryItems} drafts={directoryDrafts} employees={data?.placementEmployees ?? []} selectEmployee={activeDirectoryGroup.entity === "master"} pendingDeletes={directoryPendingDeletes} readOnly={!mayUpdateProjectDirectories} selectionDisabled={!mayUpdateProjectDirectories && !mayDeleteProjectDirectories} onEdit={editDirectoryItem} onSelectionChange={changeDirectorySelection} onPatchDraft={patchDirectoryDraft} />
        {mayManageProjectDirectories && <AdminGridFooter addLabel={`Добавить: ${focusedDirectoryTitle.toLocaleLowerCase("ru-RU")}`} countLabel="Всего" count={visibleDirectoryItems.length} deletingCount={directoryPendingDeletes.length} deletingLabel="Удалить" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(directoryDrafts.length)} editingExisting={directoryDrafts.some((draft) => Boolean(draft.id))} pendingCount={directoryDrafts.length} saving={saving} allowMultiple canCreate={mayCreateProjectDirectories} canUpdate={mayUpdateProjectDirectories} canDelete={mayDeleteProjectDirectories} onAdd={addDirectoryItem} onDelete={() => setDirectoryDeleteConfirmationOpen(true)} onEditSelection={editSelectedDirectoryItems} onClearSelection={() => { setDirectoryPendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={cancelDirectoryEditing} onSave={() => void saveDirectoryItems()} />}
      </section>}
      {mayDeleteProjectDirectories && directoryDeleteConfirmationOpen && activeDirectoryGroup && <AdminDeleteConfirmation title="Удалить выбранные значения?" text={`Вы точно хотите удалить значения (${directoryPendingDeletes.length}) из справочника «${focusedDirectoryTitle}» проекта «${activeSite?.name ?? ""}»?`} saving={saving} onCancel={() => setDirectoryDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingDirectoryItems(activeDirectoryGroup.entity)} />}
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
