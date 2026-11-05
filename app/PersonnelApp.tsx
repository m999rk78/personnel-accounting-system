"use client";

import { type FormEvent, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TableOrderProvider } from "./TableRowMoves";
import { tableOrderScope } from "./tableRowOrder";
import { AccessRightsView } from "./AccessRightsView";
import { RolesSettingsView } from "./RolesSettingsView";
import { UsersRightsNavigation } from "./UsersRightsNavigation";
import { UserPermissionsDialog } from "./UserPermissionsDialog";
import { AdminGridFooter } from "./AdminGridFooter";
import { DirectoryAgGrid, EmployeeAgGrid, PositionAgGrid, ProjectEmployeeAgGrid } from "./LazyDataGrids";
import { AuditLogView } from "./AuditLogView";
import { WorkTypesDirectory } from "./WorkTypesDirectory";
import { useConfirmationDialog } from "./useConfirmationDialog";
import { CustomSelect } from "./CustomSelect";
import { EquipmentAccountingView } from "./EquipmentAccountingView";
import { ExcelActionsMenu } from "./ExcelActionsMenu";
import { hasPermission, limitPermissionsToRole, type PermissionAction, type PermissionResource } from "./permissionModel";
import { ProjectCards } from "./ProjectCards";
import { TimesheetView } from "./TimesheetView";
import { UserAccessCards } from "./UserAccessCards";
import { parseWorkspaceLocation, workspaceDocumentTitle, workspaceUrl } from "./appRoutes";
import { accessibleProjectIds, canAccessProject, canInspectBitrix24, canViewAllProjects, hasRestrictedProjectAccess } from "./roles";
import { profileProjectChangeAllowed, userDraftProjectAccess, userProjectAccessValid, userProjectLabel, userRoleLabel, userVisibleProjects } from "./userAccessModel";
import { WorkspaceAccessProvider } from "./TableAccessContext";
import { SidebarToggleButton } from "./SidebarToggleButton";
import { GENERAL_SETTINGS_RESOURCES, PROJECT_SETTINGS_RESOURCES, workspaceTableAccess, workspaceViewAllowed } from "./workspaceAccess";
import "./workspaceHeader.css";
import { useSettingsExcelActions } from "./workspace/useSettingsExcelActions";
import { BitrixReviewDialogs } from "./workspace/BitrixReviewDialogs";
import { useBitrixReview } from "./workspace/useBitrixReview";
import { WorkspaceSidebar, AppIcon } from "./workspace/WorkspaceSidebar";
import { useWorkspaceData } from "./workspace/useWorkspaceData";
import { workspaceNavigationDiscards, pendingWorkspaceGridInput, normalize, newKey } from "./workspace/model";
import type { Option, Site, PositionRecord, AppUser, CurrentUser, View, UserDraft, EmployeeDraft, EmployeeBulkChanges, ProjectEmployeeDraft, PositionDraft, DirectoryEntity, DirectoryFocus, DirectoryDraft, SiteDraft } from "./workspace/types";

const PersonnelReportWorkspace = lazy(() => import("./PersonnelReportWorkspace").then(module => ({ default: module.PersonnelReportWorkspace })));
const EquipmentReportPage = lazy(() => import("./EquipmentReportPage").then(module => ({ default: module.EquipmentReportPage })));

function AdminDeleteConfirmation({ title, text: description, saving, onCancel, onConfirm }: { title: string; text: string; saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2><p>{description}</p><div><button type="button" className="secondary-button" onClick={onCancel} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={onConfirm} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>;
}

export default function PersonnelApp({ initialToday, currentUser }: { initialToday: string; currentUser: CurrentUser }) {
  const { confirm, dialog: confirmationDialog } = useConfirmationDialog();
  const role = currentUser.role;
  const effectivePermissions = useMemo(() => limitPermissionsToRole(role, currentUser.permissions, currentUser.projectAccess), [role, currentUser.permissions, currentUser.projectAccess]);
  const projectIds = accessibleProjectIds(currentUser);
  const missingAssignedProject = projectIds !== null && projectIds.length === 0;
  const may = useCallback((resource: PermissionResource, action: PermissionAction = "view") => !missingAssignedProject && hasPermission(effectivePermissions, resource, action), [effectivePermissions, missingAssignedProject]);
  const anyAction = (resource: PermissionResource) => (["create", "update", "delete"] as PermissionAction[]).some((action) => may(resource, action));
  const mayViewWorkersReport = may("workers_report");
  const mayViewEquipmentReport = may("equipment_report");
  const mayViewWorkersTimesheet = may("workers_timesheet");
  const mayViewEquipmentTimesheet = may("equipment_timesheet");
  const mayCreateWorkersReport = may("workers_report", "create");
  const mayUpdateWorkersReport = may("workers_report", "update");
  const mayDeleteWorkersReport = may("workers_report", "delete");
  const mayCreateEmployees = may("employees", "create");
  const mayUseGlobalImports = !hasRestrictedProjectAccess(currentUser);
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
  const mayAccessGeneralSettings = GENERAL_SETTINGS_RESOURCES.some((resource) => may(resource));
  const mayAccessProjectSettings = PROJECT_SETTINGS_RESOURCES.some((resource) => may(resource));
  const mayInspectBitrix24 = canInspectBitrix24(role) && !hasRestrictedProjectAccess(currentUser) && may("employees");
  const mayViewAllProjects = canViewAllProjects(currentUser) || (projectIds?.length ?? 0) > 1;
  const [initialLocation] = useState(() => parseWorkspaceLocation(
    typeof window === "undefined" ? "/reports/workers" : window.location.pathname,
    typeof window === "undefined" ? "" : window.location.search,
    initialToday,
  ));
  const viewAllowed = useCallback((candidate: View) => !missingAssignedProject && workspaceViewAllowed(effectivePermissions, candidate), [effectivePermissions, missingAssignedProject]);
  const fallbackView = useMemo(() => (["placement", "equipment", "timesheet", "equipmentTimesheet", "projectSettings", "settings"] as View[]).find(viewAllowed) ?? "placement", [viewAllowed]);
  const [initialView] = useState(() => viewAllowed(initialLocation.view) ? initialLocation.view : fallbackView);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarToggleRef = useRef<HTMLButtonElement>(null);
  const toggleSidebar = () => {
    const nextOpen = !sidebarOpen;
    setSidebarOpen(nextOpen);
    if (window.matchMedia("(max-width:680px)").matches) {
      requestAnimationFrame(() => (nextOpen ? sidebarToggleRef : mobileSidebarToggleRef).current?.focus({ preventScroll: true }));
    }
  };
  const [view, setView] = useState<View>(initialView);
  const tableAccess = useMemo(() => workspaceTableAccess(effectivePermissions, view), [effectivePermissions, view]);
  const [selectedSiteId, setSiteId] = useState(() => currentUser.assignedSiteId && canAccessProject(currentUser, currentUser.assignedSiteId) ? currentUser.assignedSiteId : projectIds?.[0] ?? (projectIds === null ? 1 : 0));
  const siteId = canAccessProject(currentUser, selectedSiteId) ? selectedSiteId : projectIds?.[0] ?? (projectIds === null ? selectedSiteId : 0);
  const [workDate, setWorkDate] = useState(initialLocation.date);
  const [selectedMonth, setSelectedMonth] = useState(initialLocation.month);
  const { data, loading, error, setError, loadData, invalidateCatalogs } = useWorkspaceData({ siteId, workDate, view, effectivePermissions, viewAllowed });
  const [personnelReportDirty, setPersonnelReportDirty] = useState(false);
  const personnelReportDirtyRef = useRef(false);
  const [equipmentReportDirty, setEquipmentReportDirty] = useState(false);
  const equipmentReportDirtyRef = useRef(false);
  const [workTypesDirty, setWorkTypesDirty] = useState(false);
  const workTypesDirtyRef = useRef(false);
  const equipmentSettingsDirtyRef = useRef(false);
  const accessRightsDirtyRef = useRef(false);
  const nativeTimesheetDirtyRef = useRef(false);
  const childNavigationBusyRef = useRef(false);
  const onEquipmentSettingsDirty = useCallback((dirty: boolean) => { equipmentSettingsDirtyRef.current = dirty; }, []);
  const onAccessRightsDirty = useCallback((dirty: boolean) => { accessRightsDirtyRef.current = dirty; }, []);
  const onNativeTimesheetDirty = useCallback((dirty: boolean) => { nativeTimesheetDirtyRef.current = dirty; }, []);
  const onChildNavigationBusy = useCallback((busy: boolean) => { childNavigationBusyRef.current = busy; }, []);
  const personnelReportLocationRef = useRef("");
  useEffect(() => { personnelReportDirtyRef.current = personnelReportDirty; }, [personnelReportDirty]);
  useEffect(() => { equipmentReportDirtyRef.current = equipmentReportDirty; }, [equipmentReportDirty]);
  useEffect(() => { workTypesDirtyRef.current = workTypesDirty; }, [workTypesDirty]);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
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
  const [userRoleOnlyEditor, setUserRoleOnlyEditor] = useState(false);
  const [userPermissionsId, setUserPermissionsId] = useState<number | null>(null);
  const [employeeDrafts, setEmployeeDrafts] = useState<EmployeeDraft[]>([]);
  const [employeePendingDeletes, setEmployeePendingDeletes] = useState<number[]>([]);
  const [employeeFullRowEditIds, setEmployeeFullRowEditIds] = useState<number[]>([]);
  const [employeeDeleteConfirmationOpen, setEmployeeDeleteConfirmationOpen] = useState(false);
  const [employeeBulkEditOpen, setEmployeeBulkEditOpen] = useState(false);
  const [employeeBulkChanges, setEmployeeBulkChanges] = useState<EmployeeBulkChanges>({ employmentType: "", department: "", position: "", projectSiteId: "" });
  const [employeeBulkEditError, setEmployeeBulkEditError] = useState("");
  const [employeeVisibleIds, setEmployeeVisibleIds] = useState<number[] | null>(null);
  const referenceExportOrder = useRef(new Map<string, number[]>());
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
  const [userDeleteConfirmationOpen, setUserDeleteConfirmationOpen] = useState(false);
  const [sitePendingDeletes, setSitePendingDeletes] = useState<number[]>([]);
  const [siteDeleteConfirmationOpen, setSiteDeleteConfirmationOpen] = useState(false);
  const [directoryFocus, setDirectoryFocus] = useState<DirectoryFocus>(initialView === "directories" ? initialLocation.directoryFocus : "all");
  const activeSite = data?.sites.find((site) => site.id === siteId);
  const visibleEmployees = useMemo(() => data?.employees ?? [], [data?.employees]);
  const selectedEmployeeRows = useMemo(() => {
    const selectedIds = new Set(employeePendingDeletes);
    return visibleEmployees.filter((employee) => selectedIds.has(employee.id));
  }, [employeePendingDeletes, visibleEmployees]);
  const visibleProjectEmployees = data?.projectEmployees ?? data?.placementEmployees ?? [];
  const visiblePositions = data?.positionCatalog ?? [];
  const visibleUsers = data?.users ?? [];
  const visibleSites = useMemo(() => userVisibleProjects(currentUser, data?.sites ?? []), [data?.sites, currentUser]);
  const employeeFileInput = useRef<HTMLInputElement>(null);
  const positionFileInput = useRef<HTMLInputElement>(null);
  const projectEmployeeFileInput = useRef<HTMLInputElement>(null);
  const projectDirectoryFileInput = useRef<HTMLInputElement>(null);
  const directoryGroups: Array<{ entity: DirectoryEntity; title: string; items: Option[] }> = [
    { entity: "zone", title: "Зоны", items: data?.zones ?? [] },
    { entity: "mainWorkType", title: "Виды работ", items: data?.mainWorkTypes ?? [] },
    { entity: "subworkType", title: "Виды подработ", items: data?.subworkTypes ?? [] },
    { entity: "master", title: "Мастера", items: data?.masters ?? [] },
  ];
  const activeDirectoryGroup = directoryFocus === "all" || directoryFocus === "sites" ? undefined : directoryGroups.find((group) => group.entity === directoryFocus);
  const visibleDirectoryItems = activeDirectoryGroup?.items ?? [];
  const focusedDirectoryTitle = directoryFocus === "mainWorkType" || directoryFocus === "subworkType" ? "Виды и подвиды работ" : directoryFocus === "sites" ? "Объекты" : directoryFocus === "all" ? "Все справочники" : directoryGroups.find((group) => group.entity === directoryFocus)?.title ?? "Справочник";
  const { requireSavedExcelRows, exportEmployees, exportPositions, importEmployees, importPositions, exportProjectEmployees, downloadSettingsTemplate, importProjectEmployees, exportProjectDirectory, exportProjects, exportUsers, downloadProjectDirectoryTemplate, importProjectDirectory } = useSettingsExcelActions({
    data, siteId, activeSite, mayUseGlobalImports, loadData, setError, setNotice, setImporting,
    rows: { employees: visibleEmployees, positions: visiblePositions, projectEmployees: visibleProjectEmployees, sites: visibleSites, users: visibleUsers, directoryItems: visibleDirectoryItems },
    pending: { employees: employeeDrafts.length + employeeFullRowEditIds.length, positions: positionDrafts.length + positionFullRowEditIds.length, projectEmployees: projectEmployeeDrafts.length, directory: directoryDrafts.length, sites: siteDrafts.length, users: userDrafts.length },
    order: { employees: employeeVisibleIds, positions: positionVisibleIds, reference: referenceExportOrder },
    directory: { focus: directoryFocus, group: activeDirectoryGroup, title: focusedDirectoryTitle },
    inputs: { employees: employeeFileInput, positions: positionFileInput, projectEmployees: projectEmployeeFileInput, directory: projectDirectoryFileInput },
  });
  const bitrixReview = useBitrixReview({ data, view, visibleEmployees, visibleSites, selectedEmployeeRows, employeeDrafts, employeeFullRowEditIds, mayCreateEmployees, mayDeleteEmployees, mayInspectBitrix24, mayUpdateEmployees, loadData, requireSavedExcelRows, setEmployeePendingDeletes, setError, setNotice, confirm });
  const { syncingBitrix24, linkingBitrix24, setBitrixCheckResult, bitrixBulkRunning, processingBitrixEmployee, selectedBitrixUpdatableEmployees, selectedBitrixWarningEmployees, inspectBitrix24Remaining, inspectBitrix24Title, inspectBitrix24Connection, updateSelectedEmployeesFromBitrix, acknowledgeSelectedBitrixWarnings } = bitrixReview;
  const settingsDraftsDirty = Boolean(userDrafts.length || employeeDrafts.length || employeeFullRowEditIds.length || positionDrafts.length || positionFullRowEditIds.length || siteDrafts.length || directoryDrafts.length || projectEmployeeDrafts.length || employeeBulkEditOpen && Object.values(employeeBulkChanges).some(Boolean));
  const navigationState = useRef({ view, focus: directoryFocus, month: selectedMonth, settings: settingsDraftsDirty, busy: saving || importing });
  useLayoutEffect(() => {
    navigationState.current = { view, focus: directoryFocus, month: selectedMonth, settings: settingsDraftsDirty, busy: saving || importing };
  }, [view, directoryFocus, selectedMonth, settingsDraftsDirty, saving, importing]);
  const getNavigationDiscards = useCallback((nextView: View, nextFocus: DirectoryFocus, changingProject = false) => {
    const pending = pendingWorkspaceGridInput();
    return workspaceNavigationDiscards({ ...navigationState.current,
      settings: navigationState.current.settings || equipmentSettingsDirtyRef.current || accessRightsDirtyRef.current || nativeTimesheetDirtyRef.current || pending.settings,
      report: personnelReportDirtyRef.current || pending.report,
      equipment: equipmentReportDirtyRef.current || pending.equipment,
      workTypes: workTypesDirtyRef.current || pending.workTypes,
    }, nextView, nextFocus, changingProject);
  }, []);
  const discardSettingsEdits = useCallback(() => {
    setUserPermissionsId(null);
    setUserDrafts([]); setUserPendingDeletes([]); setUserDeleteConfirmationOpen(false); setInvitationResults([]);
    setEmployeeDrafts([]); setEmployeeFullRowEditIds([]); setEmployeePendingDeletes([]); setEmployeeDeleteConfirmationOpen(false); setEmployeeBulkEditOpen(false); setBitrixCheckResult(null);
    setPositionDrafts([]); setPositionFullRowEditIds([]); setPositionPendingDeletes([]); setPositionDeleteConfirmationOpen(false);
    setSiteDrafts([]); setSitePendingDeletes([]); setSiteDeleteConfirmationOpen(false);
    setDirectoryDrafts([]); setDirectoryPendingDeletes([]); setDirectoryDeleteConfirmationOpen(false);
    setProjectEmployeeDrafts([]); setProjectEmployeePendingDeletes([]); setProjectEmployeeDeleteConfirmationOpen(false);
    equipmentSettingsDirtyRef.current = false;
    accessRightsDirtyRef.current = false;
    nativeTimesheetDirtyRef.current = false;
    navigationState.current = { ...navigationState.current, settings: false };
  }, [setBitrixCheckResult]);
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      const current = navigationState.current;
      if (!current.busy && !childNavigationBusyRef.current && !Object.values(getNavigationDiscards(current.view, current.focus, true)).some(Boolean)) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [getNavigationDiscards]);
  useEffect(() => { personnelReportLocationRef.current = `${window.location.pathname}${window.location.search}`; }, [view, directoryFocus, workDate, selectedMonth]);
  const initialUrlNormalized = useRef(false);

  useEffect(() => {
    const initialFocus = initialView === "directories" ? initialLocation.directoryFocus : "all";
    const canonicalUrl = viewAllowed(initialView) ? workspaceUrl(initialView, initialFocus, initialLocation.date, initialLocation.month) : "/";
    if (!initialUrlNormalized.current && (!initialLocation.recognized || initialView !== initialLocation.view || `${window.location.pathname}${window.location.search}` !== canonicalUrl)) {
      window.history.replaceState({}, "", canonicalUrl);
    }
    initialUrlNormalized.current = true;

    let listening = true;
    let locationSequence = 0;
    const restoreLocation = async () => {
      const sequence = ++locationSequence;
      if (bitrixBulkRunning.current || navigationState.current.busy || childNavigationBusyRef.current) {
        window.history.pushState({}, "", personnelReportLocationRef.current);
        return;
      }
      const location = parseWorkspaceLocation(window.location.pathname, window.location.search, initialToday);
      const nextView = viewAllowed(location.view) ? location.view : fallbackView;
      const nextFocus = nextView === "directories" ? location.directoryFocus : "all";
      const periodChanged = (navigationState.current.view === "timesheet" || navigationState.current.view === "equipmentTimesheet") && navigationState.current.month !== location.month;
      const discard = getNavigationDiscards(nextView, nextFocus, periodChanged);
      if (Object.values(discard).some(Boolean)) {
        const confirmed = await confirm({ title: "Перейти без сохранения?", description: "На текущей странице есть несохранённые изменения. При переходе в другой раздел они будут отменены.", confirmLabel: "Перейти без сохранения" });
        if (!listening || sequence !== locationSequence) return;
        if (!confirmed) {
          window.history.pushState({}, "", personnelReportLocationRef.current || workspaceUrl("placement", "all", initialToday, initialToday.slice(0, 7)));
          return;
        }
        if (discard.report) { personnelReportDirtyRef.current = false; setPersonnelReportDirty(false); }
        if (discard.equipment) { equipmentReportDirtyRef.current = false; setEquipmentReportDirty(false); }
        if (discard.workTypes) { workTypesDirtyRef.current = false; setWorkTypesDirty(false); }
      }
      if (navigationState.current.view !== nextView || navigationState.current.focus !== nextFocus || periodChanged) discardSettingsEdits();
      setSelectedMonth(location.month);
      setDirectoryFocus(nextFocus);
      setView(nextView);
      setWorkDate(location.date);
      setError("");
      setNotice("");
    };

    window.addEventListener("popstate", restoreLocation);
    return () => { listening = false; window.removeEventListener("popstate", restoreLocation); };
  }, [confirm, discardSettingsEdits, getNavigationDiscards, fallbackView, initialLocation, initialToday, initialView, viewAllowed, bitrixBulkRunning, setError]);

  useEffect(() => {
    if (viewAllowed(view)) {
      if (window.location.pathname === "/") window.history.replaceState({}, "", workspaceUrl(view, directoryFocus, workDate, selectedMonth));
      return;
    }
    const timer = window.setTimeout(() => {
      setView(fallbackView);
      setDirectoryFocus("all");
      window.history.replaceState({}, "", viewAllowed(fallbackView) ? workspaceUrl(fallbackView, "all", workDate, selectedMonth) : "/");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view, viewAllowed, fallbackView, workDate, selectedMonth, directoryFocus]);

  useEffect(() => {
    document.title = viewAllowed(view) ? workspaceDocumentTitle(view, directoryFocus) : "Ресурсный отчёт";
  }, [directoryFocus, view, viewAllowed]);

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
  async function changeSite(nextSiteId: number) {
    if (bitrixBulkRunning.current || navigationState.current.busy || childNavigationBusyRef.current) return;
    if (!mayViewAllProjects || !canAccessProject(currentUser, nextSiteId) || nextSiteId === siteId) return;
    const discard = getNavigationDiscards(view, directoryFocus, true);
    if (Object.values(discard).some(Boolean) && !await confirm({ title: "Сменить проект?", description: "Есть несохранённые изменения. При переходе в другой проект они будут отменены.", confirmLabel: "Сменить без сохранения" })) return;
    discardSettingsEdits();
    personnelReportDirtyRef.current = false;
    setPersonnelReportDirty(false);
    equipmentReportDirtyRef.current = false;
    setEquipmentReportDirty(false);
    workTypesDirtyRef.current = false;
    setWorkTypesDirty(false);
    setSiteId(nextSiteId);
  }

  function changeTimesheetMonth(nextMonth: string) {
    setSelectedMonth(nextMonth);
    if (view === "timesheet" || view === "equipmentTimesheet") window.history.replaceState({}, "", workspaceUrl(view, directoryFocus, workDate, nextMonth));
  }

  async function navigateTo(nextView: View, nextDirectoryFocus: DirectoryFocus = "all") {
    if (bitrixBulkRunning.current || navigationState.current.busy || childNavigationBusyRef.current) return false;
    const allowedView = viewAllowed(nextView) ? nextView : fallbackView;
    const allowedFocus = allowedView === "directories" ? nextDirectoryFocus : "all";
    const discard = getNavigationDiscards(allowedView, allowedFocus);
    if (Object.values(discard).some(Boolean) && !await confirm({ title: "Перейти без сохранения?", description: "На текущей странице есть несохранённые изменения. При переходе в другой раздел они будут отменены.", confirmLabel: "Перейти без сохранения" })) return false;
    if (navigationState.current.view !== allowedView || navigationState.current.focus !== allowedFocus) discardSettingsEdits();
    if (discard.report) { personnelReportDirtyRef.current = false; setPersonnelReportDirty(false); }
    if (discard.equipment) { equipmentReportDirtyRef.current = false; setEquipmentReportDirty(false); }
    if (discard.workTypes) { workTypesDirtyRef.current = false; setWorkTypesDirty(false); }
    const url = workspaceUrl(allowedView, allowedFocus, workDate, selectedMonth);
    setDirectoryFocus(allowedFocus);
    setView(allowedView);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.pushState({}, "", url);
    window.scrollTo({ top: 0, behavior: "auto" });
    return true;
  }
  function patchUserDraft(key: string, changes: Partial<UserDraft>) {
    setUserDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft));
    setError("");
  }
  function editUserRow(user: AppUser, changes: Partial<UserDraft> = {}) {
    if (!mayUpdateSystemUsers) return;
    setUserRoleOnlyEditor(false);
    setUserPendingDeletes([]);
    setUserDrafts((current) => {
      if (current.some((draft) => !draft.id)) return current;
      const existing = current.find((draft) => draft.id === user.id);
      if (existing) return current.map((draft) => draft.id === user.id ? { ...draft, ...changes } : draft);
      return [...current, { key: `user-${user.id}`, id: user.id, fullName: user.fullName, email: user.email, role: user.role, customRoleId: user.customRoleId ?? null, customRoleName: user.customRoleName ?? null, assignedSiteId: user.assignedSiteId ? String(user.assignedSiteId) : "", projectAccess: user.projectAccess, canViewPendingReports: user.canViewPendingReports, ...changes }];
    });
    setNotice("");
  }
  function editUserRole(user: AppUser) {
    if (!mayUpdateSystemUsers) return;
    editUserRow(user);
    setUserRoleOnlyEditor(true);
  }
  function changeUserSelection(ids: number[]) {
    setUserPendingDeletes(ids);
    setUserDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id)));
    setNotice("");
  }
  function editSelectedUserRows() {
    if (!mayUpdateSystemUsers) return;
    if (userDrafts.some((draft) => !draft.id)) return;
    const selected = visibleUsers.filter((user) => userPendingDeletes.includes(user.id));
    selected.forEach((user) => editUserRow(user));
    setUserPendingDeletes([]);
    setNotice(selected.length ? `Открыто редактирование пользователей: ${selected.length}.` : "");
  }
  function cancelUserEditing() {
    setUserDrafts([]);
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
        if (!draft.fullName.trim() || !/^\S+@\S+\.\S+$/.test(email) || !userProjectAccessValid(userDraftProjectAccess(draft), visibleSites, Boolean(draft.id))) throw new Error(`Строка ${index + 1}: заполните ФИО, корректный email, роль и доступ к проектам.`);
        if (usedEmails.has(normalize(email))) throw new Error(`Строка ${index + 1}: пользователь с email «${email}» уже есть в списке.`);
        usedEmails.add(normalize(email));
      });
      const invitations: Array<{ email: string; url: string }> = [];
      for (let index = 0; index < userDrafts.length; index += 1) {
        const draft = userDrafts[index];
        const response = await fetch("/api/data", { method: draft.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: draft.id ? "update-user" : "create-user", userId: draft.id, fullName: draft.fullName, email: draft.email, role: draft.role, customRoleId: draft.customRoleId ?? null, assignedSiteId: userDraftProjectAccess(draft).mode === "selected" ? userDraftProjectAccess(draft).siteIds[0] ?? null : null, projectAccess: userDraftProjectAccess(draft), canViewPendingReports: draft.canViewPendingReports ?? draft.role !== "viewer" }) });
        const result = await response.json() as { error?: string; invitationUrl?: string; emailSent?: boolean };
        if (!response.ok) throw new Error(`Строка ${index + 1}: ${result.error ?? "не удалось сохранить пользователя"}.`);
        if (result.invitationUrl && !result.emailSent) {
          invitations.push({ email: draft.email, url: result.invitationUrl });
          setInvitationResults([...invitations]);
        }
        setUserDrafts((current) => current.filter((item) => item.key !== draft.key));
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
        if (!profileProjectChangeAllowed(accessibleProjectIds(currentUser) ?? undefined, projectSiteId)) throw new Error("Сотрудники должны относиться к разрешённым проектам. Убрать сотрудника из проекта можно в настройках проекта.");
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
      const validSites = new Set(visibleSites.map((site) => site.id));
      const validPositionCombinations = new Set((data?.positionCatalog ?? []).map((item) => normalize(`${item.employmentType}|${item.department}|${item.position}`)));
      employeeDrafts.forEach((draft, index) => {
        if (!draft.fullName.trim() || !draft.employmentType.trim() || !draft.department.trim() || !draft.position.trim()) throw new Error(`Строка ${index + 1}: заполните ФИО, тип, отдел и должность.`);
        if (!validEmploymentTypes.has(normalize(draft.employmentType))) throw new Error(`Строка ${index + 1}: значение «${draft.employmentType}» не относится к столбцу «Тип».`);
        if (!validDepartments.has(normalize(draft.department))) throw new Error(`Строка ${index + 1}: значение «${draft.department}» не относится к столбцу «Отдел».`);
        if (!validPositions.has(normalize(draft.position))) throw new Error(`Строка ${index + 1}: значение «${draft.position}» не относится к столбцу «Должность».`);
        if (draft.projectSiteId && !validSites.has(Number(draft.projectSiteId))) throw new Error(`Строка ${index + 1}: выбранный проект не найден или закрыт.`);
        if (!profileProjectChangeAllowed(accessibleProjectIds(currentUser) ?? undefined, draft.projectSiteId)) throw new Error(`Строка ${index + 1}: сотрудник должен относиться к одному из разрешённых проектов. Для снятия с проекта используйте настройки проекта.`);
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
  async function reorderEmployees(employeeIds: number[]) {
    if (!mayUpdateEmployees || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reorder-employees", employeeIds }) });
      const result = await response.json() as { error?: string; count?: number };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить порядок сотрудников.");
      await loadData();
      setNotice(`Порядок сотрудников сохранён${result.count ? ` · строк: ${result.count}` : ""}.`);
    } catch (reorderError) {
      await loadData();
      setError(reorderError instanceof Error ? reorderError.message : "Не удалось сохранить порядок сотрудников.");
    } finally { setSaving(false); }
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
  const downloadProjectEmployeeTemplate = () => downloadSettingsTemplate("projectEmployees");
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
    setNotice("");
  }
  function editSelectedSiteRows() {
    if (!mayUpdateProjects) return;
    if (siteDrafts.some((draft) => !draft.id)) return;
    const selected = visibleSites.filter((site) => sitePendingDeletes.includes(site.id));
    selected.forEach((site) => editSiteRow(site));
    setSitePendingDeletes([]);
    setNotice(selected.length ? `Открыто редактирование проектов: ${selected.length}.` : "");
  }
  function cancelSiteEditing() {
    setSiteDrafts([]);
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
  const generalSettingsCards: Array<{ icon: string; title: string; description: string; resource: PermissionResource; view?: View; focus?: DirectoryFocus }> = [
    { icon: "С", title: "Сотрудники", description: "Кадровые данные и проекты сотрудников с безопасной проверкой по Битрикс24.", resource: "employees", view: "employees" },
    { icon: "Т", title: "Реестр техники", description: "Единый список техники с назначением на проекты.", resource: "equipment_registry", view: "equipmentRegistry" },
    { icon: "Д", title: "Список должностей", description: "Единая таблица сочетаний «Тип / Отдел / Должность» с импортом и экспортом Excel.", resource: "positions", view: "positions" },
    { icon: "П", title: "Пользователи и права", description: "Пользователи системы, роли и доступ к проектам.", resource: may("system_users") ? "system_users" : "access_rights", view: may("system_users") ? "users" : "accessRights" },
    { icon: "П", title: "Проекты", description: "Строительные проекты и управление их названиями.", resource: "projects", view: "projects" },
    { icon: "Ж", title: "Журнал действий", description: "Кто, когда и какие изменения вносил в отчёты, табели, справочники и настройки.", resource: "audit_log", view: "auditLog" },
  ];
  const projectSettingsCards: Array<{ icon: string; title: string; description: string; resource: PermissionResource; focus?: DirectoryFocus; view?: View }> = [
    { icon: "С", title: "Сотрудники проекта", description: "Состав выбранного проекта без дублирования карточек сотрудников.", resource: "project_employees", view: "projectEmployees" },
    { icon: "Т", title: "Техника проекта", description: "Техника, назначенная выбранному проекту, без дублирования общего реестра.", resource: "project_equipment", view: "projectEquipment" },
    { icon: "З", title: "Зоны", description: "Зоны, доступные только в выбранном проекте.", resource: "project_directories", focus: "zone" },
    { icon: "Р", title: "Виды и подвиды работ", description: "Виды работ с вложенными подвидами для отчётов персонала и техники.", resource: "project_directories", focus: "mainWorkType" },
    { icon: "М", title: "Мастера", description: "Автоматически из сотрудников проекта: тип ИТР, отдел МУ, МУТТ или МУСК. Должность не ограничена.", resource: "project_directories", focus: "master" },
  ];
  const workTypesDirectoryPage = view === "directories" && (directoryFocus === "mainWorkType" || directoryFocus === "subworkType");
  const projectDirectoryPage = view === "projectEmployees" || view === "projectEquipment" || view === "directories";
  const generalDirectoryPage = view === "employees" || view === "equipmentRegistry" || view === "positions" || view === "projects" || view === "users" || view === "accessRights" || view === "auditLog";
  const settingsBackTarget = projectDirectoryPage ? "projectSettings" : generalDirectoryPage ? "settings" : null;
  const settingsBackLabel = projectDirectoryPage ? "К настройкам проекта" : "К общим настройкам";
  const usersRightsPage = view === "users" || view === "accessRights";
  const settingsBackButton = settingsBackTarget && <button type="button" className="page-heading-back" onClick={() => navigateTo(settingsBackTarget)} disabled={workTypesDirectoryPage && (loading || workTypesDirty)} aria-label={settingsBackLabel} title={settingsBackLabel}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
    <span>{projectDirectoryPage ? "Настройки проекта" : "Общие настройки"}</span>
  </button>;
  const tableWorkspacePage = view === "placement"
    || view === "equipment"
    || view === "equipmentRegistry"
    || view === "projectEquipment"
    || view === "employees"
    || view === "positions"
    || view === "projectEmployees"
    || view === "directories";
  const pageContentClassName = view === "placement" || view === "equipment"
    ? "page-content personnel-report-page table-workspace-page"
    : view === "timesheet" || view === "equipmentTimesheet"
      ? "page-content timesheet-workspace-page"
      : view === "users" || view === "accessRights" ? "page-content users-rights-workspace"
        : view === "directories" && (directoryFocus === "mainWorkType" || directoryFocus === "subworkType") ? "page-content table-workspace-page work-types-workspace-page" : tableWorkspacePage ? "page-content table-workspace-page" : "page-content";

  const currentTableOrderScope = viewAllowed(view) ? tableOrderScope(view, directoryFocus) : null;
  return <WorkspaceAccessProvider access={tableAccess}><TableOrderProvider key={`${currentTableOrderScope}:${siteId}:${currentUser.id}`} scope={currentTableOrderScope} siteId={siteId}><main className={sidebarOpen ? "app-shell" : "app-shell sidebar-collapsed"}>
    <SidebarToggleButton expanded={sidebarOpen} onToggle={toggleSidebar} buttonRef={mobileSidebarToggleRef} className="sidebar-mobile-toggle" />
    <WorkspaceSidebar sidebarOpen={sidebarOpen} toggleSidebar={toggleSidebar} sidebarToggleRef={sidebarToggleRef} visibleSites={visibleSites} siteId={siteId} activeSite={activeSite} mayViewAllProjects={mayViewAllProjects} mayViewWorkersReport={mayViewWorkersReport} mayViewWorkersTimesheet={mayViewWorkersTimesheet} mayViewEquipmentReport={mayViewEquipmentReport} mayViewEquipmentTimesheet={mayViewEquipmentTimesheet} mayAccessGeneralSettings={mayAccessGeneralSettings} mayAccessProjectSettings={mayAccessProjectSettings} view={view} navigateTo={navigateTo} fallbackView={fallbackView} changeSite={changeSite} currentUser={currentUser} openProfile={openProfile} />
    <section className="workspace">
      {viewAllowed(view) ? <div className={pageContentClassName}><div className={["page-heading", "workspace-page-heading", view === "placement" || view === "equipment" ? "report-page-heading" : "", view === "placement" || view === "equipment" ? "personnel-report-heading" : "", view === "timesheet" || view === "equipmentTimesheet" ? "timesheet-page-heading" : "", settingsBackTarget ? "settings-page-heading" : "", view === "employees" ? "employees-page-heading" : "", view === "users" || view === "accessRights" ? "users-rights-page-heading" : ""].filter(Boolean).join(" ")}>
        {usersRightsPage && settingsBackButton}
        <div className="page-heading-title">
          {!usersRightsPage && settingsBackButton}
          <h1>{view === "placement" ? "Отчёт персонала" : view === "equipment" ? "Отчёт техники" : view === "timesheet" ? "Табель рабочих" : view === "equipmentTimesheet" ? "Табель техники" : view === "equipmentRegistry" ? "Реестр техники" : view === "projectEquipment" ? "Техника проекта" : view === "employees" ? "Сотрудники" : view === "settings" ? "Общие настройки" : view === "projectSettings" ? "Настройки проекта" : view === "projectEmployees" ? "Сотрудники проекта" : view === "users" || view === "accessRights" ? "Пользователи и права" : view === "positions" ? "Список должностей" : view === "projects" ? "Проекты" : view === "auditLog" ? "Журнал действий" : focusedDirectoryTitle}</h1>
        </div>
        {(view === "users" || view === "accessRights") && <UsersRightsNavigation showBack={false} active={view === "users" ? "users" : "roles"} canViewUsers={may("system_users")} canViewRoles={may("access_rights")} onSelect={tab => { void navigateTo(tab === "users" ? "users" : "accessRights"); }} onBack={() => { void navigateTo("settings"); }} />}
        {view === "employees" && (
          <div className="toolbar-actions settings-heading-actions employees-heading-actions">{mayInspectBitrix24 && <span className="cooldown-button-wrapper" title={inspectBitrix24Title}><button type="button" className="bitrix-check-button" onClick={() => void inspectBitrix24Connection()} disabled={syncingBitrix24 || linkingBitrix24 || importing || inspectBitrix24Remaining > 0} aria-busy={syncingBitrix24}><svg className="employees-bitrix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3a7 7 0 0 0 11.5-1"/></svg><span>{syncingBitrix24 ? "Проверяем…" : "Проверить с Битрикс24"}</span></button></span>}<ExcelActionsMenu actions={[
            { label: "Экспорт в Excel", onSelect: exportEmployees },
            ...(mayUseGlobalImports && (mayCreateEmployees || mayUpdateEmployees) ? [
              { label: importing ? "Импортируем…" : "Импорт из Excel", onSelect: () => employeeFileInput.current?.click(), disabled: importing || syncingBitrix24 || linkingBitrix24 },
              { label: "Скачать шаблон", onSelect: () => downloadSettingsTemplate("employees"), disabled: loading },
            ] : []),
          ]} />{mayUseGlobalImports && (mayCreateEmployees || mayUpdateEmployees) && <><input ref={employeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importEmployees(file); }} /></>}</div>
        )}
        {view === "projectEmployees" && (<div className="toolbar-actions settings-heading-actions"><ExcelActionsMenu actions={[
          { label: "Экспорт в Excel", onSelect: exportProjectEmployees },
          ...(mayCreateProjectEmployees ? [
            { label: importing ? "Импортируем…" : "Импорт из Excel", onSelect: () => projectEmployeeFileInput.current?.click(), disabled: importing },
            { label: "Скачать шаблон", onSelect: downloadProjectEmployeeTemplate },
          ] : []),
        ]} />{mayCreateProjectEmployees && <><input ref={projectEmployeeFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectEmployees(file); }} /></>}</div>)}
        {view === "positions" && (<div className="toolbar-actions settings-heading-actions"><ExcelActionsMenu actions={[
          { label: "Экспорт в Excel", onSelect: exportPositions },
          ...(mayCreatePositions ? [
            { label: importing ? "Импортируем…" : "Импорт из Excel", onSelect: () => positionFileInput.current?.click(), disabled: importing },
            { label: "Скачать шаблон", onSelect: () => downloadSettingsTemplate("positions"), disabled: loading },
          ] : []),
        ]} />{mayCreatePositions && <><input ref={positionFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPositions(file); }} /></>}</div>)}
        {view === "projects" && (<div className="toolbar-actions settings-heading-actions"><ExcelActionsMenu actions={[{ label: "Экспорт в Excel", onSelect: exportProjects, disabled: !visibleSites.length }]} /></div>)}
        {view === "users" && (<div className="toolbar-actions settings-heading-actions"><ExcelActionsMenu actions={[{ label: "Экспорт в Excel", onSelect: exportUsers, disabled: !visibleUsers.length }]} /></div>)}
        {view === "directories" && activeDirectoryGroup && !workTypesDirectoryPage && (<div className="toolbar-actions settings-heading-actions"><ExcelActionsMenu actions={[
          { label: "Экспорт в Excel", onSelect: exportProjectDirectory },
          ...(mayCreateProjectDirectories ? [
            { label: importing ? "Импортируем…" : "Импорт из Excel", onSelect: () => projectDirectoryFileInput.current?.click(), disabled: importing },
            { label: "Скачать шаблон", onSelect: downloadProjectDirectoryTemplate },
          ] : []),
        ]} />{mayCreateProjectDirectories && <><input ref={projectDirectoryFileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectDirectory(file); }} /></>}</div>)}
        {view === "equipmentRegistry" && <div className="settings-heading-actions" id="equipment-registry-actions" />}
        {view === "projectEquipment" && <div className="settings-heading-actions" id="project-equipment-actions" />}
        {workTypesDirectoryPage && <div className="settings-heading-actions settings-heading-tools" id="work-types-heading-actions" />}
        {view === "auditLog" && <div className="settings-heading-actions" id="audit-log-heading-actions" />}
        {view === "placement" && <div id="personnel-report-views" className="personnel-report-views-portal" />}
        {view === "equipment" && <div id="equipment-report-views" className="personnel-report-views-portal" />}

        {view === "placement" && <div id="personnel-report-actions" className="report-heading-portal" />}
        {view === "equipment" && <div id="equipment-report-actions" className="report-heading-portal" />}
        {view === "timesheet" && <div id="personnel-timesheet-actions" className="timesheet-heading-portal" />}
        {view === "equipmentTimesheet" && <div id="equipment-timesheet-actions" className="timesheet-heading-portal" />}
      </div>

      {mayViewWorkersReport && view === "placement" && <>
        {error && <div className="message error" role="alert"><strong>Не удалось загрузить справочники</strong><span>{error}</span></div>}
        <Suspense fallback={<p role="status">Загружаем отчёты персонала…</p>}><PersonnelReportWorkspace key={`personnel-reports-${siteId}-${currentUser.id}`} siteId={siteId} siteName={activeSite?.name ?? "Проект"} today={initialToday} currentUser={currentUser} permissions={{ create: mayCreateWorkersReport, update: mayUpdateWorkersReport, delete: mayDeleteWorkersReport }} employees={data?.reportEmployees ?? []} shifts={data?.shifts ?? []} zones={data?.zones ?? []} mainWorkTypes={data?.mainWorkTypes ?? []} subworkTypes={data?.subworkTypes ?? []} masters={data?.masters ?? []} loading={loading} onDirtyChange={setPersonnelReportDirty} /></Suspense>
      </>}


      {mayViewWorkersTimesheet && view === "timesheet" && <TimesheetView key={`personnel-timesheet-${siteId}-${selectedMonth}`} siteId={siteId} initialMonth={selectedMonth} today={initialToday} onMonthChange={changeTimesheetMonth} onDirtyChange={onNativeTimesheetDirty} onBusyChange={onChildNavigationBusy} />}
      {mayViewEquipmentReport && view === "equipment" && <Suspense fallback={<p role="status">Загружаем отчёты техники…</p>}><EquipmentReportPage key={`equipment-report-${siteId}-${currentUser.id}`} siteId={siteId} siteName={activeSite?.name ?? "Проект"} today={initialToday} currentUser={currentUser} permissions={{ create: may("equipment_report", "create"), update: may("equipment_report", "update"), delete: may("equipment_report", "delete") }} onDirtyChange={setEquipmentReportDirty} /></Suspense>}
      {mayViewEquipmentTimesheet && view === "equipmentTimesheet" && <EquipmentAccountingView key={`equipment-timesheet-${siteId}-${selectedMonth}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} currentUserRole={role} currentUserProjectAccess={currentUser.projectAccess} mode="month" onMonthChange={changeTimesheetMonth} onDirtyChange={onEquipmentSettingsDirty} onBusyChange={onChildNavigationBusy} />}



      {view === "equipmentRegistry" && may("equipment_registry") && <section className="users-settings admin-section equipment-settings-section"><EquipmentAccountingView key={`equipment-registry-${siteId}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} currentUserRole={role} currentUserProjectAccess={currentUser.projectAccess} mode="registry" onDirtyChange={onEquipmentSettingsDirty} onBusyChange={onChildNavigationBusy} /></section>}
      {view === "projectEquipment" && may("project_equipment") && <section className="users-settings admin-section equipment-settings-section"><EquipmentAccountingView key={`project-equipment-${siteId}`} siteId={siteId} initialDate={workDate} initialMonth={selectedMonth} today={initialToday} currentUserRole={role} currentUserProjectAccess={currentUser.projectAccess} mode="project" onDirtyChange={onEquipmentSettingsDirty} onBusyChange={onChildNavigationBusy} /></section>}

      {view === "settings" && mayAccessGeneralSettings && <section className="settings-home general-settings-home"><p className="settings-scope-description">Общие данные используются во всей системе и не зависят от выбранного проекта.</p><div className="settings-list">{generalSettingsCards.filter((card) => may(card.resource)).map((card) => <button type="button" className="settings-list-item" key={card.title} onClick={() => { if (card.focus) void navigateTo("directories", card.focus); else if (card.view) void navigateTo(card.view); }}><span className="settings-card-icon">{card.icon}</span><span className="settings-row-copy"><strong>{card.title}</strong><span>{card.description}</span></span><span className="settings-list-arrow" aria-hidden="true">›</span></button>)}</div></section>}

      {view === "auditLog" && may("audit_log") && <AuditLogView headerActionsTargetId="audit-log-heading-actions" onBack={() => navigateTo("settings")} />}
      {view === "accessRights" && may("access_rights") && <section role="tabpanel" id="users-rights-panel-roles" aria-labelledby="users-rights-tab-roles">{may("system_users") ? <RolesSettingsView onDirtyChange={onAccessRightsDirty} onBusyChange={onChildNavigationBusy} onRolesChanged={invalidateCatalogs} /> : <AccessRightsView onBack={() => { void navigateTo("settings"); }} onDirtyChange={onAccessRightsDirty} onBusyChange={onChildNavigationBusy} />}</section>}
      {view === "projectSettings" && mayAccessProjectSettings && <section className="settings-home">
        <div className="settings-grid">{projectSettingsCards.filter((card) => may(card.resource)).map((card) => <button type="button" key={card.title} onClick={() => { if (card.focus) void navigateTo("directories", card.focus); else if (card.view) void navigateTo(card.view); }}><span className="settings-card-icon">{card.icon}</span><strong>{card.title}</strong><p>{card.description}</p></button>)}</div>
      </section>}
      {view === "projectEmployees" && may("project_employees") && <section className="users-settings admin-section reference-section">
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <ProjectEmployeeAgGrid onVisibleIdsChange={ids => referenceExportOrder.current.set(`projectEmployees:${siteId}`, ids)} rows={visibleProjectEmployees} allEmployees={data?.employees ?? []} drafts={projectEmployeeDrafts} pendingDeletes={projectEmployeePendingDeletes} readOnly={!mayCreateProjectEmployees} selectionDisabled={!mayDeleteProjectEmployees} onPatchDraft={patchProjectEmployeeDraft} onSelectionChange={(ids) => { setProjectEmployeePendingDeletes(ids); setError(""); setNotice(""); }} />
        {mayManageProjectEmployees && <AdminGridFooter addLabel="Добавить сотрудника в проект" countLabel="Всего в проекте" count={visibleProjectEmployees.length} deletingCount={projectEmployeePendingDeletes.length} deletingLabel="Убрать из проекта" uniformActions editorOpen={Boolean(projectEmployeeDrafts.length)} pendingCount={projectEmployeeDrafts.length} saving={saving} allowMultiple canCreate={mayCreateProjectEmployees} canUpdate={mayUpdateProjectEmployees} canDelete={mayDeleteProjectEmployees} onAdd={() => { setProjectEmployeeDrafts((current) => [...current, { key: newKey(), employeeId: "", employeeQuery: "" }]); setNotice(""); }} onDelete={() => setProjectEmployeeDeleteConfirmationOpen(true)} onClearSelection={() => { setProjectEmployeePendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={() => { setProjectEmployeeDrafts([]); setError(""); setNotice(""); }} onSave={() => void assignProjectEmployees()} />}
      </section>}
      {mayDeleteProjectEmployees && projectEmployeeDeleteConfirmationOpen && <AdminDeleteConfirmation title="Убрать выбранных сотрудников из проекта?" text={`Сотрудники (${projectEmployeePendingDeletes.length}) исчезнут только из проекта «${activeSite?.name ?? ""}». Их общие карточки и история отчётов сохранятся.`} saving={saving} onCancel={() => setProjectEmployeeDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingProjectEmployees()} />}
      {view === "employees" && may("employees") && <section className="users-settings admin-section employee-section">
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
        {notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <EmployeeAgGrid
          rows={visibleEmployees}
          drafts={employeeDrafts}
          employmentTypes={data?.employmentTypes ?? []}
          departments={data?.departments ?? []}
          positions={data?.positions ?? []}
          sites={visibleSites}
          requiredSiteId={accessibleProjectIds(currentUser) ?? undefined}
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
          onVisibleIdsChange={(ids) => setEmployeeVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)}
          onValidationError={(message) => { setError(message); setNotice(""); }}
          onReorder={reorderEmployees}
        />
        {mayEditGlobalEmployees && <AdminGridFooter addLabel="Добавить сотрудника" countLabel="Всего сотрудников" count={visibleEmployees.length} deletingCount={employeePendingDeletes.length} deletingLabel="Удалить сотрудников" editSelectionLabel="Редактировать" bulkEditSelectionLabel="Массовое редактирование" uniformActions editorOpen={Boolean(employeeDrafts.length)} editingExisting={employeeDrafts.some((draft) => Boolean(draft.id))} pendingCount={employeeDrafts.length} saving={saving || processingBitrixEmployee} allowMultiple canCreate={mayCreateEmployees} canUpdate={mayUpdateEmployees} canDelete={mayDeleteEmployees} selectionActions={mayInspectBitrix24 && mayUpdateEmployees ? [
          { key: "bitrix-update", label: `Актуализировать с Битрикс24 (${selectedBitrixUpdatableEmployees.length})`, className: "bitrix-selection-update-button", disabled: !mayUpdateEmployees || selectedBitrixUpdatableEmployees.length === 0, title: selectedBitrixUpdatableEmployees.length ? "Каждый выбранный сотрудник будет обновлён по своей связанной карточке Битрикс24." : "Среди выбранных строк нет неподтверждённых расхождений, которые можно актуализировать.", onClick: () => void updateSelectedEmployeesFromBitrix() },
          { key: "bitrix-acknowledge", label: `Подтвердить предупреждение (${selectedBitrixWarningEmployees.length})`, className: "bitrix-selection-acknowledge-button", disabled: !mayUpdateEmployees || selectedBitrixWarningEmployees.length === 0, title: selectedBitrixWarningEmployees.length ? "Отметить выбранные расхождения как допустимые и снять выделение." : "Среди выбранных строк нет активных предупреждений.", onClick: () => void acknowledgeSelectedBitrixWarnings() },
        ] : []} onAdd={() => { setEmployeeDrafts((current) => current.some((draft) => draft.id) ? current : [...current, { key: newKey(), fullName: "", employmentType: "", department: "", position: "", projectSiteId: hasRestrictedProjectAccess(currentUser) ? String(siteId) : "" }]); setNotice(""); }} onDelete={() => setEmployeeDeleteConfirmationOpen(true)} onEditSelection={editSelectedEmployeeRows} onBulkEditSelection={openEmployeeBulkEdit} onClearSelection={() => { setEmployeePendingDeletes([]); setEmployeeBulkEditOpen(false); setEmployeeBulkEditError(""); setNotice(""); }} onCancelEditing={cancelEmployeeEditing} onSave={() => void saveEmployees()} />}
      </section>}

      <BitrixReviewDialogs review={bitrixReview} data={data} visibleSites={visibleSites} mayInspectBitrix24={mayInspectBitrix24} mayCreateEmployees={mayCreateEmployees} mayUpdateEmployees={mayUpdateEmployees} mayDeleteEmployees={mayDeleteEmployees} error={error} />





      {mayUpdateEmployees && employeeBulkEditOpen && <div className="confirmation-backdrop employee-bulk-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeBulkEditOpen(false); }}><section className="employee-bulk-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-bulk-edit-title">
        <div className="employee-bulk-edit-heading"><div><h2 id="employee-bulk-edit-title">Массовое редактирование сотрудников</h2><p>Выбрано сотрудников: {employeePendingDeletes.length}. Укажите только те поля, которые нужно изменить у всех отмеченных сотрудников. Остальные значения сохранятся.</p></div><button type="button" className="bulk-edit-close" aria-label="Закрыть массовое редактирование" onClick={() => setEmployeeBulkEditOpen(false)}>×</button></div>
        {employeeBulkEditError && <div className="bulk-edit-error" role="alert">{employeeBulkEditError}</div>}
        <div className="employee-bulk-edit-form">
          <div className="employee-bulk-edit-field"><span>Тип</span><CustomSelect value={employeeBulkChanges.employmentType} ariaLabel="Новый тип для выбранных сотрудников" onChange={(employmentType) => { setEmployeeBulkChanges((current) => ({ ...current, employmentType })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.employmentTypes ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Отдел</span><CustomSelect value={employeeBulkChanges.department} ariaLabel="Новый отдел для выбранных сотрудников" onChange={(department) => { setEmployeeBulkChanges((current) => ({ ...current, department })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.departments ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Должность</span><CustomSelect value={employeeBulkChanges.position} ariaLabel="Новая должность для выбранных сотрудников" onChange={(position) => { setEmployeeBulkChanges((current) => ({ ...current, position })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(data?.positions ?? []).map((option) => ({ value: option.name, label: option.name }))]} /></div>
          <div className="employee-bulk-edit-field"><span>Проект</span><CustomSelect value={employeeBulkChanges.projectSiteId} ariaLabel="Новый проект для выбранных сотрудников" onChange={(projectSiteId) => { setEmployeeBulkChanges((current) => ({ ...current, projectSiteId })); setEmployeeBulkEditError(""); }} options={[{ value: "", label: "Не изменять" }, ...(!hasRestrictedProjectAccess(currentUser) ? [{ value: "__unassigned__", label: "Без объекта" }] : []), ...visibleSites.map((option) => ({ value: String(option.id), label: option.name }))]} /></div>
        </div>
        <div className="bulk-edit-selection-summary"><strong>Выбрано:</strong><span>{visibleEmployees.filter((employee) => employeePendingDeletes.includes(employee.id)).slice(0, 4).map((employee) => employee.fullName).join(", ")}{employeePendingDeletes.length > 4 ? ` и ещё ${employeePendingDeletes.length - 4}` : ""}</span></div>
        <div className="employee-bulk-edit-actions"><button type="button" className="secondary-button" onClick={() => setEmployeeBulkEditOpen(false)}>Отмена</button><button type="button" className="save-edits-button" onClick={applyEmployeeBulkEdit}>Применить к таблице</button></div>
      </section></div>}

      {mayDeleteEmployees && employeeDeleteConfirmationOpen && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEmployeeDeleteConfirmationOpen(false); }}><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-delete-confirmation-title"><h2 id="employee-delete-confirmation-title">Удалить выбранных сотрудников?</h2><p>Вы точно хотите удалить сотрудников ({employeePendingDeletes.length})? Они исчезнут из активного справочника и проектов, но история ранее созданных отчётов сохранится.</p><div><button type="button" className="secondary-button" onClick={() => setEmployeeDeleteConfirmationOpen(false)} disabled={saving}>Отмена</button><button type="button" className="delete-rows-button" onClick={() => void deletePendingEmployees()} disabled={saving}>{saving ? "Удаляем…" : "Удалить"}</button></div></section></div>}
      {view === "positions" && may("positions") && <section className="users-settings admin-section reference-section">
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <PositionAgGrid rows={visiblePositions} drafts={positionDrafts} employmentTypes={data?.employmentTypes ?? []} departments={data?.departments ?? []} pendingDeletes={positionPendingDeletes} fullRowEditIds={positionFullRowEditIds} readOnly={!mayUpdatePositions} selectionDisabled={!mayUpdatePositions && !mayDeletePositions} onEdit={editPositionRow} onSelectionChange={(ids) => { setPositionPendingDeletes(ids); setPositionDrafts((current) => current.filter((draft) => !draft.id || !ids.includes(draft.id))); setPositionFullRowEditIds((current) => current.filter((id) => !ids.includes(id))); setNotice(""); }} onPatchDraft={patchPositionDraft} onVisibleIdsChange={(ids) => setPositionVisibleIds((current) => current?.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)} />
        {mayManagePositions && <AdminGridFooter addLabel="Добавить должность" countLabel="Всего должностей" count={visiblePositions.length} deletingCount={positionPendingDeletes.length} deletingLabel="Удалить должности" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(positionDrafts.length)} editingExisting={positionDrafts.some((draft) => Boolean(draft.id))} pendingCount={positionDrafts.length} saving={saving} allowMultiple canCreate={mayCreatePositions} canUpdate={mayUpdatePositions} canDelete={mayDeletePositions} onAdd={() => { setPositionDrafts((current) => current.some((draft) => draft.id) ? current : [...current, { key: newKey(), employmentType: "", department: "", position: "" }]); setNotice(""); }} onDelete={() => setPositionDeleteConfirmationOpen(true)} onEditSelection={editSelectedPositionRows} onClearSelection={() => { setPositionPendingDeletes([]); setNotice(""); }} onCancelEditing={cancelPositionEditing} onSave={() => void savePositions()} />}
      </section>}
      {mayDeletePositions && positionDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные должности?" text={`Вы точно хотите удалить должности (${positionPendingDeletes.length})? Используемые сотрудниками должности удалить нельзя.`} saving={saving} onCancel={() => setPositionDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingPositions()} />}

      {view === "projects" && may("projects") && <section className="users-settings admin-section reference-section project-cards-section">
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <ProjectCards rows={visibleSites} drafts={siteDrafts} employees={data?.employees ?? []} users={data?.users ?? []} projectStats={data?.projectStats} currentSiteId={siteId} selectedIds={sitePendingDeletes} readOnly={!mayManageProjects} canCreate={mayCreateProjects} canUpdate={mayUpdateProjects} canDelete={mayDeleteProjects} onEdit={editSiteRow} onSelectionChange={changeSiteSelection} onPatchDraft={patchSiteDraft} onCancelEditing={cancelSiteEditing} onSave={() => void saveSites()} saving={saving} />
        {mayManageProjects && <AdminGridFooter addLabel="Добавить проект" countLabel="Всего проектов" count={visibleSites.length} deletingCount={sitePendingDeletes.length} deletingLabel="Удалить проекты" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(siteDrafts.length)} editingExisting={siteDrafts.some((draft) => Boolean(draft.id))} pendingCount={siteDrafts.length} saving={saving} canCreate={mayCreateProjects} canUpdate={mayUpdateProjects} canDelete={mayDeleteProjects} onAdd={() => { setSiteDrafts((current) => current.length ? current : [...current, { key: newKey(), name: "", code: "", timezone: "Europe/Moscow" }]); setNotice(""); }} onDelete={() => setSiteDeleteConfirmationOpen(true)} onEditSelection={editSelectedSiteRows} onClearSelection={() => { setSitePendingDeletes([]); setNotice(""); }} onCancelEditing={cancelSiteEditing} onSave={() => void saveSites()} />}
      </section>}
      {mayDeleteProjects && siteDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранные проекты?" text={`Вы точно хотите удалить проекты (${sitePendingDeletes.length})? Проекты со связанными сотрудниками, пользователями или отчётами удалить нельзя.`} saving={saving} onCancel={() => setSiteDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingSites()} />}

      {view === "users" && may("system_users") && <section className="users-settings admin-section reference-section user-access-section" role="tabpanel" id="users-rights-panel-users" aria-labelledby="users-rights-tab-users">
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        {invitationResults.map((invitation) => <div className="invitation-result" key={invitation.email}><strong>Приглашение для {invitation.email}</strong><span>Передайте эту ссылку пользователю. После настройки почты она будет отправляться автоматически.</span><a href={invitation.url}>{invitation.url}</a></div>)}
        <UserAccessCards layout="list" rows={visibleUsers} drafts={userDrafts} sites={visibleSites} selectedIds={userPendingDeletes} readOnly={!mayManageSystemUsers} canCreate={mayCreateSystemUsers} canUpdate={mayUpdateSystemUsers} canDelete={mayDeleteSystemUsers} onEdit={editUserRow} onEditRole={editUserRole} onOpenPermissions={may("access_rights") ? setUserPermissionsId : undefined} roleOnly={userRoleOnlyEditor && userDrafts.every(draft => Boolean(draft.id))} error={error} onSelectionChange={changeUserSelection} onPatchDraft={patchUserDraft} onCancelEditing={cancelUserEditing} onSave={() => void saveUsers()} saving={saving} />
        {mayManageSystemUsers && <AdminGridFooter addLabel="Добавить пользователя" countLabel="Всего пользователей" count={visibleUsers.length} deletingCount={userPendingDeletes.length} deletingLabel="Удалить пользователей" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(userDrafts.length)} editingExisting={userDrafts.some((draft) => Boolean(draft.id))} pendingCount={userDrafts.length} saving={saving} canCreate={mayCreateSystemUsers} canUpdate={mayUpdateSystemUsers} canDelete={mayDeleteSystemUsers} onAdd={() => { setUserDrafts((current) => current.length ? current : [...current, { key: newKey(), fullName: "", email: "", role: "foreman", assignedSiteId: String(siteId) }]); setNotice(""); }} onDelete={() => setUserDeleteConfirmationOpen(true)} onEditSelection={editSelectedUserRows} onClearSelection={() => { setUserPendingDeletes([]); setNotice(""); }} onCancelEditing={cancelUserEditing} onSave={() => void saveUsers()} />}
      </section>}
      {view === "users" && userPermissionsId !== null && may("access_rights") && <WorkspaceAccessProvider access={workspaceTableAccess(effectivePermissions, "accessRights")}><UserPermissionsDialog key={userPermissionsId} userId={userPermissionsId} onClose={() => setUserPermissionsId(null)} onDirtyChange={onAccessRightsDirty} onBusyChange={onChildNavigationBusy} /></WorkspaceAccessProvider>}
      {mayDeleteSystemUsers && userDeleteConfirmationOpen && <AdminDeleteConfirmation title="Удалить выбранных пользователей?" text={`Вы точно хотите удалить пользователей (${userPendingDeletes.length})? Это действие нельзя отменить.`} saving={saving} onCancel={() => setUserDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingUsers()} />}
      {view === "directories" && may("project_directories") && (directoryFocus === "mainWorkType" || directoryFocus === "subworkType") && <WorkTypesDirectory headerActionsTargetId="work-types-heading-actions" key={siteId} loading={loading} siteId={siteId} projectName={activeSite?.name ?? "Проект"} mainWorkTypes={data?.mainWorkTypes ?? []} subworkTypes={data?.subworkTypes ?? []} canCreate={mayCreateProjectDirectories} canUpdate={mayUpdateProjectDirectories} canDelete={mayDeleteProjectDirectories} onRefresh={loadData} onDirtyChange={setWorkTypesDirty} onBack={() => navigateTo("projectSettings")} />}
      {view === "directories" && may("project_directories") && activeDirectoryGroup && directoryFocus !== "mainWorkType" && directoryFocus !== "subworkType" && <section className="users-settings admin-section reference-section">
        {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}{notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
        <DirectoryAgGrid onVisibleIdsChange={ids => referenceExportOrder.current.set(`directory:${siteId}:${directoryFocus}`, ids)} title={focusedDirectoryTitle} rows={visibleDirectoryItems} drafts={directoryDrafts} employees={data?.placementEmployees ?? []} selectEmployee={activeDirectoryGroup.entity === "master"} pendingDeletes={directoryPendingDeletes} readOnly={!mayUpdateProjectDirectories} selectionDisabled={!mayUpdateProjectDirectories && !mayDeleteProjectDirectories} onEdit={editDirectoryItem} onSelectionChange={changeDirectorySelection} onPatchDraft={patchDirectoryDraft} />
        {mayManageProjectDirectories && <AdminGridFooter addLabel={`Добавить: ${focusedDirectoryTitle.toLocaleLowerCase("ru-RU")}`} countLabel="Всего" count={visibleDirectoryItems.length} deletingCount={directoryPendingDeletes.length} deletingLabel="Удалить" editSelectionLabel="Редактировать" uniformActions editorOpen={Boolean(directoryDrafts.length)} editingExisting={directoryDrafts.some((draft) => Boolean(draft.id))} pendingCount={directoryDrafts.length} saving={saving} allowMultiple canCreate={mayCreateProjectDirectories} canUpdate={mayUpdateProjectDirectories} canDelete={mayDeleteProjectDirectories} onAdd={addDirectoryItem} onDelete={() => setDirectoryDeleteConfirmationOpen(true)} onEditSelection={editSelectedDirectoryItems} onClearSelection={() => { setDirectoryPendingDeletes([]); setError(""); setNotice(""); }} onCancelEditing={cancelDirectoryEditing} onSave={() => void saveDirectoryItems()} />}
      </section>}
      {mayDeleteProjectDirectories && directoryDeleteConfirmationOpen && activeDirectoryGroup && <AdminDeleteConfirmation title="Удалить выбранные значения?" text={`Вы точно хотите удалить значения (${directoryPendingDeletes.length}) из справочника «${focusedDirectoryTitle}» проекта «${activeSite?.name ?? ""}»?`} saving={saving} onCancel={() => setDirectoryDeleteConfirmationOpen(false)} onConfirm={() => void deletePendingDirectoryItems(activeDirectoryGroup.entity)} />}
      </div> : <div className="page-content"><h1>{missingAssignedProject ? "Нет доступа к проектам" : "Нет доступных разделов"}</h1><p>{missingAssignedProject ? "Обратитесь к супер-администратору, чтобы открыть доступ к нужным проектам." : "Обратитесь к администратору для настройки доступа."}</p></div>}
    </section>
    {profileOpen && <div className="profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !profileSaving) setProfileOpen(false); }}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="profile-dialog-heading"><div className="profile-avatar"><AppIcon name="user" /></div><div><span>Профиль пользователя</span><h2 id="profile-title">{currentUser.fullName}</h2></div><button type="button" className="profile-close" onClick={() => setProfileOpen(false)} disabled={profileSaving} aria-label="Закрыть профиль">×</button></div>
        <dl className="profile-details"><div><dt>Email</dt><dd>{currentUser.email}</dd></div><div><dt>Роль</dt><dd>{userRoleLabel(currentUser)}</dd></div><div><dt>Проекты</dt><dd>{userProjectLabel(role, currentUser.assignedSiteId, visibleSites, currentUser.projectAccess)}</dd></div></dl>
        <form className="profile-password-form" onSubmit={(event) => void changePassword(event)}><h3>Изменить пароль</h3><label><span>Текущий пароль</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label><span>Новый пароль</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label><label><span>Повторите новый пароль</span><input type="password" autoComplete="new-password" minLength={10} maxLength={128} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} required /></label>{profileError && <div className="profile-message error" role="alert">{profileError}</div>}{profileNotice && <div className="profile-message success" role="status">{profileNotice}</div>}<button type="submit" className="profile-save" disabled={profileSaving}>{profileSaving ? "Сохраняем…" : "Изменить пароль"}</button></form>
        <button type="button" className="profile-logout" onClick={() => void logout()} disabled={profileSaving}>Выйти из системы</button>
      </section>
    </div>}
    {confirmationDialog}
  </main></TableOrderProvider></WorkspaceAccessProvider>;
}
