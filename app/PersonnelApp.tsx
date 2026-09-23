"use client";
/* eslint-disable @next/next/no-img-element -- используется оригинальный SVG-логотип из TPS */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DirectoryAgGrid, EmployeeAgGrid, PlacementAgGrid, PositionAgGrid, ProjectAgGrid, ProjectEmployeeAgGrid, UserAgGrid } from "./AgDataGrids";

type Option = { id: number; name: string };
type Site = Option & { code: string; timezone: string };
type Employee = { id: number; fullName: string; employmentType: string; department: string; position: string; source: string; siteId: number | null; siteName: string | null };
type PositionRecord = { id: number; employmentType: string; department: string; position: string };
type AppUser = { id: number; fullName: string; email: string; role: "foreman" | "office"; assignedSiteId: number | null; status?: "active" | "invited" };
type CurrentUser = { id: number; fullName: string; email: string; role: "foreman" | "office"; assignedSiteId: number | null };
type Entry = {
  id: number; siteId: number; workDate: string; employeeId: number; shiftId: number; zoneId: number;
  mainWorkTypeId: number; subworkTypeId: number; note: string; masterId: number; hours: number;
  positionSnapshot: string; employeeName: string; employmentType: string; department: string; shiftName: string;
  zoneName: string; mainWorkTypeName: string; subworkTypeName: string; masterName: string;
};
type DataSet = {
  sites: Site[]; employees: Employee[]; placementEmployees: Employee[]; positionCatalog: PositionRecord[]; employmentTypes: Option[]; departments: Option[]; positions: Option[]; shifts: Option[]; zones: Option[]; mainWorkTypes: Option[];
  subworkTypes: Option[]; masters: Option[]; entries: Entry[]; filledDates: string[]; users: AppUser[];
};
type DraftRow = {
  key: string; employeeId: string; employeeQuery: string; shiftId: string; zoneId: string;
  mainWorkTypeId: string; subworkTypeId: string; note: string; masterId: string; hours: string;
};
type View = "placement" | "employees" | "positions" | "projects" | "directories" | "settings" | "projectSettings" | "projectEmployees" | "users";
type UserDraft = { id?: number; fullName: string; email: string; role: "foreman" | "office"; assignedSiteId: string };
type EmployeeDraft = { id?: number; fullName: string; employmentType: string; department: string; position: string; projectSiteId: string };
type ProjectEmployeeDraft = { employeeId: string; employeeQuery: string };
type PositionDraft = { id?: number; employmentType: string; department: string; position: string };
type DirectoryEntity = "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";
type DirectoryFocus = "all" | "sites" | DirectoryEntity;
type DirectoryDraft = { id?: number; entity: DirectoryEntity; name: string; employeeId?: string };
type SiteDraft = { id?: number; name: string; code: string; timezone: string };

const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const newKey = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
function makeDraft(seed: Partial<DraftRow> = {}): DraftRow {
  return { key: newKey(), employeeId: "", employeeQuery: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", note: "", masterId: "", hours: "10", ...seed };
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

function AdminGridFooter({ addLabel, countLabel, count, deletingCount, deletingLabel, editorOpen, onAdd, onDelete }: { addLabel: string; countLabel: string; count: number; deletingCount: number; deletingLabel: string; editorOpen: boolean; onAdd: () => void; onDelete: () => void }) {
  return <div className="table-edit-footer employee-table-footer"><button type="button" className="secondary-button" onClick={onAdd} disabled={editorOpen}>{addLabel}</button><div>{deletingCount > 0 && <button type="button" className="delete-rows-button" onClick={onDelete}>{`${deletingLabel} (${deletingCount})`}</button>}<span>{countLabel}: <strong>{count}</strong></span></div></div>;
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

function recentDateKeys(endDate: string, count = 10) {
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

function DateStrip({ dates, value, today, filledDates, onChange }: { dates: string[]; value: string; today: string; filledDates: Set<string>; onChange: (value: string) => void }) {
  return <div className="date-strip" role="group" aria-label="Дата отчёта">
    {dates.map((date) => {
      const selected = date === value;
      const filled = filledDates.has(date);
      const isToday = date === today;
      const className = ["date-chip", selected ? "selected" : "", filled ? "filled" : "", isToday ? "today" : ""].filter(Boolean).join(" ");
      const label = `${fullDate(date)}${isToday ? ", сегодня" : ""}${filled ? ", отчёт заполнен" : ", отчёт не заполнен"}`;
      return <button type="button" className={className} key={date} aria-label={label} aria-pressed={selected} title={label} onClick={() => onChange(date)}><span>{shortDate(date)}</span></button>;
    })}
  </div>;
}

export default function PersonnelApp({ initialToday, currentUser }: { initialToday: string; currentUser: CurrentUser }) {
  const role = currentUser.role;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reportsOpen, setReportsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [view, setView] = useState<View>("placement");
  const [siteId, setSiteId] = useState(currentUser.assignedSiteId ?? 1);
  const [workDate, setWorkDate] = useState(initialToday);
  const [data, setData] = useState<DataSet | null>(null);
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [editing, setEditing] = useState<{ id: number; row: DraftRow } | null>(null);
  const [visibleEntryIds, setVisibleEntryIds] = useState<number[] | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<number[]>([]);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [invitationResult, setInvitationResult] = useState<{ email: string; url: string } | null>(null);
  const [userEditor, setUserEditor] = useState<UserDraft | null>(null);
  const [employeeEditor, setEmployeeEditor] = useState<EmployeeDraft | null>(null);
  const [employeePendingDeletes, setEmployeePendingDeletes] = useState<number[]>([]);
  const [employeeDeleteConfirmationOpen, setEmployeeDeleteConfirmationOpen] = useState(false);
  const [employeeVisibleIds, setEmployeeVisibleIds] = useState<number[] | null>(null);
  const [projectEmployeeDraft, setProjectEmployeeDraft] = useState<ProjectEmployeeDraft | null>(null);
  const [projectEmployeePendingDeletes, setProjectEmployeePendingDeletes] = useState<number[]>([]);
  const [projectEmployeeDeleteConfirmationOpen, setProjectEmployeeDeleteConfirmationOpen] = useState(false);
  const [projectEmployeeSearch, setProjectEmployeeSearch] = useState("");
  const [positionEditor, setPositionEditor] = useState<PositionDraft | null>(null);
  const [positionPendingDeletes, setPositionPendingDeletes] = useState<number[]>([]);
  const [positionDeleteConfirmationOpen, setPositionDeleteConfirmationOpen] = useState(false);
  const [positionVisibleIds, setPositionVisibleIds] = useState<number[] | null>(null);
  const [directoryEditor, setDirectoryEditor] = useState<DirectoryDraft | null>(null);
  const [directoryPendingDeletes, setDirectoryPendingDeletes] = useState<number[]>([]);
  const [directoryDeleteConfirmationOpen, setDirectoryDeleteConfirmationOpen] = useState(false);
  const [siteEditor, setSiteEditor] = useState<SiteDraft | null>(null);
  const [userPendingDeletes, setUserPendingDeletes] = useState<number[]>([]);
  const [userDeleteConfirmationOpen, setUserDeleteConfirmationOpen] = useState(false);
  const [sitePendingDeletes, setSitePendingDeletes] = useState<number[]>([]);
  const [siteDeleteConfirmationOpen, setSiteDeleteConfirmationOpen] = useState(false);
  const [directoryFocus, setDirectoryFocus] = useState<DirectoryFocus>("all");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [positionSearch, setPositionSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [directorySearch, setDirectorySearch] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const employeeFileInput = useRef<HTMLInputElement>(null);
  const positionFileInput = useRef<HTMLInputElement>(null);
  const projectEmployeeFileInput = useRef<HTMLInputElement>(null);
  const projectDirectoryFileInput = useRef<HTMLInputElement>(null);
  const loadedSiteId = useRef<number | null>(null);
  const loadedWorkDate = useRef<string | null>(null);
  const adminDataLoaded = useRef(false);
  const recentDates = useMemo(() => recentDateKeys(initialToday), [initialToday]);
  const reportRangeQuery = `rangeStart=${recentDates[0]}&rangeEnd=${initialToday}`;
  const filledDates = useMemo(() => new Set(data?.filledDates ?? []), [data?.filledDates]);
  const activeSite = data?.sites.find((site) => site.id === siteId);
  const visibleEmployees = (data?.employees ?? []).filter((employee) => normalize(`${employee.fullName} ${employee.employmentType} ${employee.department} ${employee.position} ${employee.siteName ?? ""}`).includes(normalize(employeeSearch)));
  const visibleProjectEmployees = (data?.placementEmployees ?? []).filter((employee) => normalize(`${employee.fullName} ${employee.employmentType} ${employee.department} ${employee.position}`).includes(normalize(projectEmployeeSearch)));
  const visiblePositions = (data?.positionCatalog ?? []).filter((position) => normalize(`${position.employmentType} ${position.department} ${position.position}`).includes(normalize(positionSearch)));
  const visibleUsers = (data?.users ?? []).filter((user) => normalize(`${user.fullName} ${user.email} ${user.role === "foreman" ? "прораб" : "офис"} ${data?.sites.find((site) => site.id === user.assignedSiteId)?.name ?? "все проекты"}`).includes(normalize(userSearch)));
  const visibleSites = (data?.sites ?? []).filter((site) => normalize(site.name).includes(normalize(projectSearch)));
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
      const payload = await response.json() as Pick<DataSet, "entries" | "filledDates"> & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить отчёт.");
      setData((current) => current ? { ...current, entries: payload.entries, filledDates: payload.filledDates } : current);
      loadedWorkDate.current = workDate;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить отчёт.");
    } finally { setLoading(false); }
  }, [siteId, workDate, reportRangeQuery]);

  useEffect(() => {
    const loader = loadedSiteId.current !== siteId
      ? view === "placement" ? loadWorkspace : loadData
      : view !== "placement" && !adminDataLoaded.current
        ? loadData
        : view === "placement" && loadedWorkDate.current !== workDate
          ? loadEntries
          : null;
    if (!loader) return;
    const task = window.setTimeout(() => void loader(), 0);
    return () => window.clearTimeout(task);
  }, [siteId, workDate, view, loadData, loadEntries, loadWorkspace]);

  const filteredEntries = data?.entries ?? [];
  const exportEntries = visibleEntryIds === null
    ? filteredEntries
    : filteredEntries.filter((entry) => visibleEntryIds.includes(entry.id));
  const totalOprHours = useMemo(() => (data?.entries ?? []).filter((entry) => normalize(entry.employmentType) === "опр").reduce((sum, entry) => sum + entry.hours, 0), [data]);
  const pendingCount = draftRows.length;
  const canEditDate = role === "office" || workDate === initialToday;

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
    setSiteId(nextSiteId); setDraftRows([]); setEditing(null); setPendingDeletes([]); setDeleteConfirmationOpen(false);
    setProjectEmployeeDraft(null); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false);
    setDirectoryEditor(null); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false);
  }
  function changeWorkDate(nextDate: string) {
    setWorkDate(nextDate); setDraftRows([]); setEditing(null); setPendingDeletes([]); setDeleteConfirmationOpen(false); setVisibleEntryIds(null);
  }

  function patchDraft(key: string, changes: Partial<DraftRow>) {
    setDraftRows((rows) => rows.map((row) => row.key === key ? { ...row, ...changes } : row));
    setError("");
  }
  function patchEditing(changes: Partial<DraftRow>) {
    setEditing((current) => current ? { ...current, row: { ...current.row, ...changes } } : current);
    setError("");
  }
  function startEdit(entry: Entry) {
    if (!canEditDate || pendingDeletes.includes(entry.id)) return;
    setEditing({ id: entry.id, row: makeDraft({ employeeId: String(entry.employeeId), employeeQuery: entry.employeeName, shiftId: String(entry.shiftId), zoneId: String(entry.zoneId), mainWorkTypeId: String(entry.mainWorkTypeId), subworkTypeId: String(entry.subworkTypeId), note: entry.note, masterId: String(entry.masterId), hours: String(entry.hours) }) });
    setNotice("");
  }
  function addRow(seed: Partial<DraftRow> = {}) {
    if (!canEditDate) return;
    setDraftRows((rows) => [...rows, makeDraft(seed)]);
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
  async function saveEditing() {
    if (!editing) return;
    setSaving(true); setError(""); setNotice("");
    try {
      validateRows([editing.row]);
      const response = await fetch("/api/data", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: editing.id, ...payload(editing.row) }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить изменения.");
      setEditing(null); setNotice("Изменения сохранены"); await loadEntries();
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
  async function saveUser() {
    if (!userEditor) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: userEditor.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: userEditor.id ? "update-user" : "create-user", userId: userEditor.id, fullName: userEditor.fullName, email: userEditor.email, role: userEditor.role, assignedSiteId: userEditor.role === "foreman" ? Number(userEditor.assignedSiteId) : null }) });
      const result = await response.json() as { error?: string; invitationUrl?: string; emailSent?: boolean };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить пользователя.");
      if (result.invitationUrl && !result.emailSent) setInvitationResult({ email: userEditor.email, url: result.invitationUrl });
      setUserEditor(null); setNotice(result.emailSent ? "Пользователь сохранён, приглашение отправлено на email" : result.invitationUrl ? "Пользователь сохранён. Почтовый сервис не настроен — используйте ссылку приглашения ниже." : "Пользователь обновлён");
      await loadData();
    } catch (userError) { setError(userError instanceof Error ? userError.message : "Не удалось сохранить пользователя."); }
    finally { setSaving(false); }
  }
  function toggleUserDelete(id: number) {
    setUserPendingDeletes((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    if (userEditor?.id === id) setUserEditor(null);
    setNotice("");
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
  async function saveEmployee() {
    if (!employeeEditor) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: employeeEditor.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: employeeEditor.id ? "update-employee" : "create-employee", employeeId: employeeEditor.id, ...employeeEditor, projectSiteId: Number(employeeEditor.projectSiteId) }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить рабочего.");
      setEmployeeEditor(null); setNotice(employeeEditor.id ? "Данные рабочего обновлены" : "Рабочий добавлен");
      await loadData();
    } catch (employeeError) { setError(employeeError instanceof Error ? employeeError.message : "Не удалось сохранить рабочего."); }
    finally { setSaving(false); }
  }
  function toggleEmployeeDelete(id: number) {
    setEmployeePendingDeletes((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    if (employeeEditor?.id === id) setEmployeeEditor(null);
    setNotice("");
  }
  async function deletePendingEmployees() {
    if (!employeePendingDeletes.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      for (const id of employeePendingDeletes) {
        const response = await fetch(`/api/data?entity=employee&id=${id}`, { method: "DELETE" });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Не удалось удалить сотрудника.");
      }
      const count = employeePendingDeletes.length;
      setEmployeePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setNotice(`Удалено сотрудников: ${count}`);
      await loadData();
    } catch (employeeError) { setError(employeeError instanceof Error ? employeeError.message : "Не удалось удалить выбранных сотрудников."); }
    finally { setSaving(false); }
  }
  async function savePosition() {
    if (!positionEditor) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: positionEditor.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: positionEditor.id ? "update-position" : "create-position", positionId: positionEditor.id, ...positionEditor }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить должность.");
      setPositionEditor(null); setNotice(positionEditor.id ? "Должность обновлена" : "Должность добавлена"); await loadData();
    } catch (positionError) { setError(positionError instanceof Error ? positionError.message : "Не удалось сохранить должность."); }
    finally { setSaving(false); }
  }
  function togglePositionDelete(id: number) {
    setPositionPendingDeletes((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    if (positionEditor?.id === id) setPositionEditor(null);
    setNotice("");
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
    download(createTableXlsx("Сотрудники", "Список сотрудников", ["ФИО", "Тип", "Отдел", "Должность", "Проект"], employees.map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position, employee.siteName ?? ""])), "Сотрудники.xlsx");
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
  async function assignProjectEmployee() {
    if (!projectEmployeeDraft?.employeeId) { setError("Выберите сотрудника из списка."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign-employee-project", employeeId: Number(projectEmployeeDraft.employeeId), siteId }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось добавить сотрудника в проект.");
      setProjectEmployeeDraft(null); setNotice("Сотрудник добавлен в проект"); await loadData();
    } catch (assignmentError) { setError(assignmentError instanceof Error ? assignmentError.message : "Не удалось добавить сотрудника в проект."); }
    finally { setSaving(false); }
  }
  function toggleProjectEmployeeDelete(id: number) {
    setProjectEmployeePendingDeletes((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    setNotice("");
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
  async function saveDirectoryItem() {
    if (!directoryEditor) return;
    const selectedMaster = directoryEditor.entity === "master"
      ? (data?.placementEmployees ?? []).find((employee) => employee.id === Number(directoryEditor.employeeId) && normalize(employee.fullName) === normalize(directoryEditor.name))
      : undefined;
    if (directoryEditor.entity === "master" && !selectedMaster) { setError("Выберите мастера из сотрудников текущего проекта."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: directoryEditor.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: directoryEditor.id ? "update-directory" : "create-directory", directoryId: directoryEditor.id, entity: directoryEditor.entity, name: selectedMaster?.fullName ?? directoryEditor.name, employeeId: selectedMaster?.id, siteId }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить значение справочника.");
      setDirectoryEditor(null); setNotice(directoryEditor.id ? "Значение обновлено" : "Значение добавлено");
      await loadData();
    } catch (directoryError) { setError(directoryError instanceof Error ? directoryError.message : "Не удалось сохранить значение справочника."); }
    finally { setSaving(false); }
  }
  function toggleDirectoryDelete(id: number) {
    setDirectoryPendingDeletes((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    if (directoryEditor?.id === id) setDirectoryEditor(null);
    setNotice("");
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
  async function saveSite() {
    if (!siteEditor) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: siteEditor.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: siteEditor.id ? "update-site" : "create-site", siteId: siteEditor.id, name: siteEditor.name }) });
      const result = await response.json() as { id?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить объект.");
      const nextSiteId = siteEditor.id ?? result.id;
      setSiteEditor(null); setNotice(siteEditor.id ? "Объект обновлён" : "Объект добавлен");
      if (nextSiteId) setSiteId(nextSiteId);
      await loadData();
    } catch (siteError) { setError(siteError instanceof Error ? siteError.message : "Не удалось сохранить объект."); }
    finally { setSaving(false); }
  }
  function toggleSiteDelete(id: number) {
    setSitePendingDeletes((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
    if (siteEditor?.id === id) setSiteEditor(null);
    setNotice("");
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
  function toggleDeleteEntry(id: number) {
    if (!canEditDate) return;
    if (editing?.id === id) setEditing(null);
    setPendingDeletes((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setError("");
    setNotice("");
  }
  async function exportExcel() {
    if (!data || !exportEntries.length) return;
    const { createPlacementXlsx } = await loadPlacementXlsx();
    download(createPlacementXlsx(activeSite?.name ?? "Объект", workDate, exportEntries), `Отчёт_персонала_${activeSite?.code ?? siteId}_${workDate}.xlsx`);
  }
  async function downloadTemplate() {
    if (!data) return;
    const { createPlacementTemplateXlsx } = await loadPlacementXlsx();
    download(createPlacementTemplateXlsx(activeSite?.name ?? "Объект", workDate, { employees: data.placementEmployees, shifts: data.shifts.map((item) => item.name), zones: data.zones.map((item) => item.name), mainWorkTypes: data.mainWorkTypes.map((item) => item.name), subworkTypes: data.subworkTypes.map((item) => item.name), masters: data.masters.map((item) => item.name) }), `Шаблон_отчёта_${activeSite?.code ?? siteId}_${workDate}.xlsx`);
  }
  async function importExcel(file: File) {
    if (!data) return;
    setImporting(true); setError(""); setNotice("");
    try {
      const { parsePlacementXlsx } = await loadPlacementXlsx();
      const rows = await parsePlacementXlsx(file);
      const findEmployee = (name: string) => data.placementEmployees.find((item) => normalize(item.fullName) === normalize(name));
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
  const visibleDirectoryItems = (activeDirectoryGroup?.items ?? []).filter((item) => normalize(item.name).includes(normalize(directorySearch)));
  const focusedDirectoryTitle = directoryFocus === "sites" ? "Объекты" : directoryFocus === "all" ? "Все справочники" : directoryGroups.find((group) => group.entity === directoryFocus)?.title ?? "Справочник";
  const generalSettingsCards: Array<{ icon: string; title: string; description: string; view?: View; focus?: DirectoryFocus }> = [
    { icon: "С", title: "Сотрудники", description: "Таблица сотрудников: ФИО, тип, отдел, должность и проект. Импорт и экспорт Excel.", view: "employees" },
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
      <div className="brand-project-row"><div className="brand"><img src="/tps-logo.svg" alt="Югмонтажстрой" /></div>{role === "office" ? <ProjectSwitcher sites={data?.sites ?? []} value={siteId} onChange={changeSite} /> : <div className="project-fixed-card top-project-select" title={activeSite?.name ?? "Объект"}>{activeSite?.name ?? "Объект"}</div>}</div>
      <nav aria-label="Основная навигация">
        <div className="nav-group">
          <button type="button" className="nav-heading" onClick={() => setReportsOpen((open) => !open)} aria-expanded={reportsOpen} aria-controls="reports-navigation" aria-label={reportsOpen ? "Свернуть раздел «Отчеты»" : "Развернуть раздел «Отчеты»"}><span>Отчеты</span><SidebarChevron open={reportsOpen} /></button>
          {reportsOpen && <div className="nav-sub" id="reports-navigation"><button className={view === "placement" ? "nav-item active" : "nav-item"} onClick={() => setView("placement")}><span>♙</span>Рабочие</button></div>}
        </div>
      </nav>
      <div className="sidebar-bottom"><div className="nav-group settings-group">
        <button type="button" className="nav-heading" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-controls="settings-navigation" aria-label={settingsOpen ? "Свернуть раздел «Настройки»" : "Развернуть раздел «Настройки»"}><span className="nav-heading-icon">⚙</span><span>Настройки</span><SidebarChevron open={settingsOpen} /></button>
        {settingsOpen && <div className="nav-sub" id="settings-navigation">
          <button className={view === "settings" || view === "users" || view === "employees" || view === "positions" || view === "projects" ? "nav-item active" : role === "office" ? "nav-item" : "nav-item muted"} disabled={role !== "office"} onClick={() => { setView("settings"); setDirectoryFocus("all"); setUserEditor(null); }}><span>▤</span>Общие</button>
          <button className={view === "projectSettings" || view === "projectEmployees" || view === "directories" ? "nav-item active" : role === "office" ? "nav-item" : "nav-item muted"} disabled={role !== "office"} onClick={() => { setView("projectSettings"); setDirectoryFocus("all"); setDirectoryEditor(null); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setDirectorySearch(""); setProjectEmployeeDraft(null); }}><span>▦</span>Настройки проекта</button>
        </div>}
      </div>
        <div className="sidebar-user"><div><strong>{currentUser.fullName}</strong><small>{role === "foreman" ? "Прораб" : "Офис"}</small></div><button className="profile-button" onClick={openProfile} title="Профиль" aria-label="Открыть профиль пользователя"><AppIcon name="user" /></button></div>
      </div>
    </aside>
    <section className="workspace">
      <header className="topbar"><button className="sidebar-trigger" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "Свернуть меню" : "Развернуть меню"}><AppIcon name="panel" /></button></header>
      <div className="page-content"><div className="page-heading"><div><h1>{view === "placement" ? "Отчет персонала" : view === "employees" ? "Сотрудники" : view === "settings" ? "Общие настройки" : view === "projectSettings" ? "Настройки проекта" : view === "projectEmployees" ? "Сотрудники проекта" : view === "users" ? "Пользователи системы и права" : view === "positions" ? "Список должностей" : view === "projects" ? "Проекты" : focusedDirectoryTitle}</h1></div></div>

      {view === "placement" && <>
        <section className="control-strip"><DateStrip dates={recentDates} value={workDate} today={initialToday} filledDates={filledDates} onChange={changeWorkDate} /></section>
        {error && <div className="message error"><strong>Нужно проверить данные</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {notice && <div className="message success"><strong>Готово</strong><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
        <section className="table-card personnel-table-card">
          <PlacementAgGrid
            entries={filteredEntries}
            draftRows={draftRows}
            editing={editing}
            employees={data?.placementEmployees ?? []}
            shifts={data?.shifts ?? []}
            zones={data?.zones ?? []}
            mainWorkTypes={data?.mainWorkTypes ?? []}
            subworkTypes={data?.subworkTypes ?? []}
            masters={data?.masters ?? []}
            loading={loading}
            canEdit={canEditDate}
            pendingDeletes={pendingDeletes}
            onEdit={startEdit}
            onToggleDelete={toggleDeleteEntry}
            onPatchDraft={patchDraft}
            onPatchEditing={patchEditing}
            onRemoveDraft={(key) => setDraftRows((rows) => rows.filter((item) => item.key !== key))}
            onCancelEditing={() => setEditing(null)}
            onConfirmEditing={() => void saveEditing()}
            onVisibleEntryIdsChange={(ids) => setVisibleEntryIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
          />
          <div className="table-edit-footer"><button className="secondary-button" onClick={() => addRow()} disabled={!canEditDate} title={!canEditDate ? "Прораб может изменять только сегодняшний отчёт" : undefined}>Добавить запись</button><div>{pendingDeletes.length > 0 && <button className="delete-rows-button" onClick={() => setDeleteConfirmationOpen(true)} disabled={saving}>{`Удалить строки (${pendingDeletes.length})`}</button>}<span>Общее количество часов ОПР: <strong>{totalOprHours}</strong></span>{pendingCount > 0 && <button className="save-button" onClick={() => void savePending()} disabled={saving}>{saving ? "Сохраняем…" : `Сохранить (${pendingCount})`}</button>}</div></div>
        </section>
        <section className="excel-actions"><button onClick={exportExcel} disabled={!exportEntries.length}>Экспорт в Excel</button><button onClick={downloadTemplate}>Скачать Шаблон</button><button onClick={() => fileInput.current?.click()} disabled={importing}>{importing ? "Загружаем…" : "Загрузить данные из Excel"}</button><input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importExcel(file); }} /></section>
      </>}

      {deleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirmation-title"><h2 id="delete-confirmation-title">Удалить выбранные строки?</h2><p>Вы точно хотите удалить строки ({pendingDeletes.length})? Это действие нельзя отменить.</p><div><button type="button" className="secondary-button" onClick={() => setDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEntries()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}

      {view === "settings" && <section className="settings-home"><p className="settings-scope-description">Общие данные используются во всей системе и не зависят от выбранного проекта.</p><div className="settings-grid">{generalSettingsCards.map((card) => <button type="button" key={card.title} onClick={() => { setError(""); setNotice(""); setUserEditor(null); setEmployeeEditor(null); setPositionEditor(null); setDirectoryEditor(null); setSiteEditor(null); setEmployeePendingDeletes([]); setPositionPendingDeletes([]); setUserPendingDeletes([]); setSitePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setPositionDeleteConfirmationOpen(false); setUserDeleteConfirmationOpen(false); setSiteDeleteConfirmationOpen(false); if (card.focus) { setDirectoryFocus(card.focus); setView("directories"); } else if (card.view) setView(card.view); }}><span className="settings-card-icon">{card.icon}</span><strong>{card.title}</strong><p>{card.description}</p></button>)}</div></section>}
      {view === "projectSettings" && <section className="settings-home">
        <div className="settings-grid">{projectSettingsCards.map((card) => <button type="button" key={card.title} onClick={() => { setError(""); setNotice(""); setDirectoryEditor(null); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setDirectorySearch(""); setProjectEmployeeDraft(null); if (card.focus) { setDirectoryFocus(card.focus); setView("directories"); } else if (card.view) setView(card.view); }}><span className="settings-card-icon">{card.icon}</span><strong>{card.title}</strong><p>{card.description}</p></button>)}</div>
      </section>}
      {view === "projectEmployees" && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("projectSettings"); setProjectEmployeeDraft(null); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false); }}>← К настройкам проекта</button><div className="toolbar-actions"><button type="button" onClick={exportProjectEmployees}>Экспорт в Excel</button><button type="button" onClick={downloadProjectEmployeeTemplate}>Скачать шаблон</button><button type="button" onClick={() => projectEmployeeFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={projectEmployeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectEmployees(file); }} /></div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <div className="admin-table-tools"><input value={projectEmployeeSearch} onChange={(event) => setProjectEmployeeSearch(event.target.value)} placeholder="Поиск по ФИО, типу, отделу или должности"/><span>Сотрудников в проекте: {visibleProjectEmployees.length}</span></div>
        <ProjectEmployeeAgGrid rows={visibleProjectEmployees} allEmployees={data?.employees ?? []} draft={projectEmployeeDraft} pendingDeletes={projectEmployeePendingDeletes} onPatchDraft={(changes) => setProjectEmployeeDraft((current) => current ? { ...current, ...changes } : current)} onCancelDraft={() => setProjectEmployeeDraft(null)} onSaveDraft={() => void assignProjectEmployee()} onToggleDelete={toggleProjectEmployeeDelete} />
        <AdminGridFooter addLabel="Добавить сотрудника в проект" countLabel="Всего в проекте" count={visibleProjectEmployees.length} deletingCount={projectEmployeePendingDeletes.length} deletingLabel="Убрать из проекта" editorOpen={Boolean(projectEmployeeDraft)} onAdd={() => { setProjectEmployeeDraft({ employeeId: "", employeeQuery: "" }); setNotice(""); }} onDelete={() => setProjectEmployeeDeleteConfirmationOpen(true)} />
      </section>}
      {projectEmployeeDeleteConfirmationOpen && <AdminDeleteConfirmation title="Убрать выбранных сотрудников из проекта?" text={`Сотрудники (${projectEmployeePendingDeletes.length}) исчезнут только из проекта «${activeSite?.name ?? ""}». Их общие карточки и история отчётов сохранятся.`} saving={saving} onCancel={() => setProjectEmployeeDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingProjectEmployees()} />}
      {view === "employees" && <section className="users-settings admin-section employee-section">
        <div className="settings-toolbar">
          <button type="button" className="back-button" onClick={() => { setView("settings"); setEmployeeEditor(null); setEmployeePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); }}>← К настройкам</button>
          <div className="toolbar-actions"><button type="button" onClick={exportEmployees}>Экспорт в Excel</button><button type="button" onClick={() => employeeFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={employeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importEmployees(file); }} /></div>
        </div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
        {notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <div className="admin-table-tools"><input value={employeeSearch} onChange={(event) => { setEmployeeSearch(event.target.value); setEmployeeVisibleIds(null); }} placeholder="Поиск по ФИО, типу, отделу, должности или проекту"/><span>Сотрудников: {visibleEmployees.length}</span></div>
        <EmployeeAgGrid
          rows={visibleEmployees}
          draft={employeeEditor}
          employmentTypes={data?.employmentTypes ?? []}
          departments={data?.departments ?? []}
          positions={data?.positions ?? []}
          sites={data?.sites ?? []}
          pendingDeletes={employeePendingDeletes}
          onEdit={(employee) => { setEmployeeEditor({ id: employee.id, fullName: employee.fullName, employmentType: employee.employmentType, department: employee.department, position: employee.position, projectSiteId: employee.siteId ? String(employee.siteId) : "" }); setNotice(""); }}
          onToggleDelete={toggleEmployeeDelete}
          onPatchDraft={(changes) => setEmployeeEditor((current) => current ? { ...current, ...changes } : current)}
          onCancelDraft={() => setEmployeeEditor(null)}
          onSaveDraft={() => void saveEmployee()}
          onVisibleIdsChange={(ids) => setEmployeeVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
        />
        <div className="table-edit-footer employee-table-footer"><button type="button" className="secondary-button" onClick={() => { setEmployeeEditor({ fullName: "", employmentType: "", department: "", position: "", projectSiteId: String(siteId) }); setNotice(""); }} disabled={Boolean(employeeEditor)}>Добавить сотрудника</button><div>{employeePendingDeletes.length > 0 && <button type="button" className="delete-rows-button" onClick={() => setEmployeeDeleteConfirmationOpen(true)} disabled={saving}>{`Удалить сотрудников (${employeePendingDeletes.length})`}</button>}<span>Всего сотрудников: <strong>{visibleEmployees.length}</strong></span></div></div>
      </section>}

      {employeeDeleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-delete-confirmation-title"><h2 id="employee-delete-confirmation-title">Удалить выбранных сотрудников?</h2><p>Вы точно хотите удалить сотрудников ({employeePendingDeletes.length})? Они исчезнут из активного справочника. Это действие нельзя отменить.</p><div><button type="button" className="secondary-button" onClick={() => setEmployeeDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEmployees()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}
      {view === "positions" && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("settings"); setPositionEditor(null); setPositionPendingDeletes([]); setPositionDeleteConfirmationOpen(false); }}>← К настройкам</button><div className="toolbar-actions"><button type="button" onClick={exportPositions}>Экспорт в Excel</button><button type="button" onClick={() => positionFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={positionFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPositions(file); }} /></div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <div className="admin-table-tools"><input value={positionSearch} onChange={(event) => { setPositionSearch(event.target.value); setPositionVisibleIds(null); }} placeholder="Поиск по типу, отделу или должности"/><span>Должностей: {visiblePositions.length}</span></div>
        <PositionAgGrid rows={visiblePositions} draft={positionEditor} employmentTypes={data?.employmentTypes ?? []} departments={data?.departments ?? []} pendingDeletes={positionPendingDeletes} onEdit={(position) => { setPositionEditor({ ...position }); setNotice(""); }} onToggleDelete={togglePositionDelete} onPatchDraft={(changes) => setPositionEditor((current) => current ? { ...current, ...changes } : current)} onCancelDraft={() => setPositionEditor(null)} onSaveDraft={() => void savePosition()} onVisibleIdsChange={(ids) => setPositionVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)} />
        <AdminGridFooter addLabel="Добавить должность" countLabel="Всего должностей" count={visiblePositions.length} deletingCount={positionPendingDeletes.length} deletingLabel="Удалить должности" editorOpen={Boolean(positionEditor)} onAdd={() => { setPositionEditor({ employmentType: "", department: "", position: "" }); setNotice(""); }} onDelete={() => setPositionDeleteConfirmationOpen(true)} />
      </section>}
      {positionDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные должности?" text={`Вы точно хотите удалить должности (${positionPendingDeletes.length})? Используемые сотрудниками должности удалить нельзя.`} saving={saving} onCancel={() => setPositionDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingPositions()} />}

      {view === "projects" && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("settings"); setSiteEditor(null); setSitePendingDeletes([]); setSiteDeleteConfirmationOpen(false); }}>← К настройкам</button></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <div className="admin-table-tools"><input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Поиск по проекту"/><span>Проектов: {visibleSites.length}</span></div>
        <ProjectAgGrid rows={visibleSites} draft={siteEditor} pendingDeletes={sitePendingDeletes} onEdit={(site) => { setSiteEditor({ id: site.id, name: site.name, code: site.code, timezone: site.timezone }); setNotice(""); }} onToggleDelete={toggleSiteDelete} onPatchDraft={(changes) => setSiteEditor((current) => current ? { ...current, ...changes } : current)} onCancelDraft={() => setSiteEditor(null)} onSaveDraft={() => void saveSite()} />
        <AdminGridFooter addLabel="Добавить проект" countLabel="Всего проектов" count={visibleSites.length} deletingCount={sitePendingDeletes.length} deletingLabel="Удалить проекты" editorOpen={Boolean(siteEditor)} onAdd={() => { setSiteEditor({ name: "", code: "", timezone: "Europe/Moscow" }); setNotice(""); }} onDelete={() => setSiteDeleteConfirmationOpen(true)} />
      </section>}
      {siteDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные проекты?" text={`Вы точно хотите удалить проекты (${sitePendingDeletes.length})? Проекты со связанными сотрудниками, пользователями или отчётами удалить нельзя.`} saving={saving} onCancel={() => setSiteDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingSites()} />}

      {view === "users" && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("settings"); setUserEditor(null); setUserPendingDeletes([]); setUserDeleteConfirmationOpen(false); }}>← К настройкам</button></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        {invitationResult && <div className="invitation-result"><strong>Приглашение для {invitationResult.email}</strong><span>Передайте эту ссылку пользователю. После настройки почты она будет отправляться автоматически.</span><a href={invitationResult.url}>{invitationResult.url}</a></div>}
        <div className="admin-table-tools"><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="Поиск по ФИО, email, роли или проекту"/><span>Пользователей: {visibleUsers.length}</span></div>
        <UserAgGrid rows={visibleUsers} draft={userEditor} sites={data?.sites ?? []} pendingDeletes={userPendingDeletes} onEdit={(user) => { setUserEditor({ id: user.id, fullName: user.fullName, email: user.email, role: user.role, assignedSiteId: user.assignedSiteId ? String(user.assignedSiteId) : "" }); setNotice(""); }} onToggleDelete={toggleUserDelete} onPatchDraft={(changes) => setUserEditor((current) => current ? { ...current, ...changes } : current)} onCancelDraft={() => setUserEditor(null)} onSaveDraft={() => void saveUser()} />
        <AdminGridFooter addLabel="Добавить пользователя" countLabel="Всего пользователей" count={visibleUsers.length} deletingCount={userPendingDeletes.length} deletingLabel="Удалить пользователей" editorOpen={Boolean(userEditor)} onAdd={() => { setUserEditor({ fullName: "", email: "", role: "foreman", assignedSiteId: String(siteId) }); setNotice(""); }} onDelete={() => setUserDeleteConfirmationOpen(true)} />
      </section>}
      {userDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранных пользователей?" text={`Вы точно хотите удалить пользователей (${userPendingDeletes.length})? Это действие нельзя отменить.`} saving={saving} onCancel={() => setUserDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingUsers()} />}
      {view === "directories" && activeDirectoryGroup && <section className="users-settings admin-section reference-section">
        <div className="settings-toolbar"><button type="button" className="back-button" onClick={() => { setView("projectSettings"); setDirectoryEditor(null); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false); setDirectorySearch(""); }}>← К настройкам проекта</button><div className="toolbar-actions"><button type="button" onClick={exportProjectDirectory}>Экспорт в Excel</button><button type="button" onClick={downloadProjectDirectoryTemplate}>Скачать шаблон</button><button type="button" onClick={() => projectDirectoryFileInput.current?.click()} disabled={importing}>Импорт из Excel</button><input ref={projectDirectoryFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectDirectory(file); }} /></div></div>
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <div className="admin-table-tools"><input value={directorySearch} onChange={(event) => setDirectorySearch(event.target.value)} placeholder={`Поиск: ${focusedDirectoryTitle.toLocaleLowerCase("ru-RU")}`}/><span>{focusedDirectoryTitle}: {visibleDirectoryItems.length}</span></div>
        <DirectoryAgGrid title={focusedDirectoryTitle} rows={visibleDirectoryItems} draft={directoryEditor} employees={data?.placementEmployees ?? []} selectEmployee={activeDirectoryGroup.entity === "master"} pendingDeletes={directoryPendingDeletes} onEdit={(item) => { const employee = activeDirectoryGroup.entity === "master" ? (data?.placementEmployees ?? []).find((candidate) => normalize(candidate.fullName) === normalize(item.name)) : undefined; setDirectoryEditor({ id: item.id, entity: activeDirectoryGroup.entity, name: item.name, employeeId: employee ? String(employee.id) : undefined }); setNotice(""); }} onToggleDelete={toggleDirectoryDelete} onPatchDraft={(changes) => setDirectoryEditor((current) => current ? { ...current, ...changes } : current)} onCancelDraft={() => setDirectoryEditor(null)} onSaveDraft={() => void saveDirectoryItem()} />
        <AdminGridFooter addLabel={`Добавить: ${focusedDirectoryTitle.toLocaleLowerCase("ru-RU")}`} countLabel="Всего" count={visibleDirectoryItems.length} deletingCount={directoryPendingDeletes.length} deletingLabel="Удалить" editorOpen={Boolean(directoryEditor)} onAdd={() => { setDirectoryEditor({ entity: activeDirectoryGroup.entity, name: "" }); setNotice(""); }} onDelete={() => setDirectoryDeleteConfirmationOpen(true)} />
      </section>}
      {directoryDeleteConfirmationOpen && activeDirectoryGroup && <AdminDeleteConfirmation title="Удалить выбранные значения?" text={`Вы точно хотите удалить значения (${directoryPendingDeletes.length}) из справочника «${focusedDirectoryTitle}» проекта «${activeSite?.name ?? ""}»?`} saving={saving} onCancel={() => setDirectoryDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingDirectoryItems(activeDirectoryGroup.entity)} />}
      </div>
    </section>
    {profileOpen && <div className="profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !profileSaving) setProfileOpen(false); }}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="profile-dialog-heading"><div className="profile-avatar"><AppIcon name="user" /></div><div><span>Профиль пользователя</span><h2 id="profile-title">{currentUser.fullName}</h2></div><button type="button" className="profile-close" onClick={() => setProfileOpen(false)} disabled={profileSaving} aria-label="Закрыть профиль">×</button></div>
        <dl className="profile-details"><div><dt>Email</dt><dd>{currentUser.email}</dd></div><div><dt>Роль</dt><dd>{role === "foreman" ? "Прораб" : "Офис"}</dd></div>{role === "foreman" && <div><dt>Проект</dt><dd>{activeSite?.name ?? "Не назначен"}</dd></div>}</dl>
        <form className="profile-password-form" onSubmit={(event) => void changePassword(event)}><h3>Изменить пароль</h3><label><span>Текущий пароль</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label><span>Новый пароль</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><label><span>Повторите новый пароль</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} required /></label>{profileError && <div className="profile-message error" role="alert">{profileError}</div>}{profileNotice && <div className="profile-message success" role="status">{profileNotice}</div>}<button type="submit" className="profile-save" disabled={profileSaving}>{profileSaving ? "Сохраняем…" : "Изменить пароль"}</button></form>
        <button type="button" className="profile-logout" onClick={() => void logout()} disabled={profileSaving}>Выйти из системы</button>
      </section>
    </div>}
  </main>;
}
