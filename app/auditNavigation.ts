import type { WorkspaceDirectoryFocus, WorkspaceView } from "./appRoutes";
import { isEmployeeNavigationTarget, isEquipmentNavigationTarget, validMonth } from "./appRoutes.ts";

/** A destination inside the ordinary workspace, never a URL taken from audit data. */
export type AuditNavigationTarget = {
  view: WorkspaceView;
  directoryFocus?: WorkspaceDirectoryFocus;
  siteId?: number | null;
  employeeId?: number;
  equipmentId?: number;
  month?: string;
};

const supportedViews = new Set<WorkspaceView>([
  "placement", "equipment", "timesheet", "equipmentTimesheet", "personnelStatistics", "equipmentStatistics",
  "employees", "equipmentRegistry", "positions", "projects", "users", "accessRights", "settings",
  "projectSettings", "projectEmployees", "projectEquipment", "directories",
]);
const projectViews = new Set<WorkspaceView>([
  "placement", "equipment", "timesheet", "equipmentTimesheet", "personnelStatistics", "equipmentStatistics",
  "projectSettings", "projectEmployees", "projectEquipment", "directories",
]);
const directoryFocuses = new Set<WorkspaceDirectoryFocus>(["zone", "mainWorkType", "subworkType", "master"]);

export function auditNavigationAllowed(target: AuditNavigationTarget, access: {
  viewAllowed: (view: WorkspaceView) => boolean;
  projectAllowed: (siteId: number) => boolean;
}) {
  if (!target || !supportedViews.has(target.view) || !access.viewAllowed(target.view)) return false;
  if (target.month !== undefined && !validMonth(target.month)) return false;
  if (target.employeeId !== undefined && !isEmployeeNavigationTarget(target.view, target.employeeId)) return false;
  if (target.equipmentId !== undefined && !isEquipmentNavigationTarget(target.view, target.equipmentId)) return false;
  if (target.employeeId !== undefined && target.equipmentId !== undefined) return false;
  if (target.view === "directories") {
    if (!target.directoryFocus || !directoryFocuses.has(target.directoryFocus)) return false;
  } else if (target.directoryFocus !== undefined && target.directoryFocus !== "all") return false;
  // Falling back to the currently selected project would show unrelated data.
  if (projectViews.has(target.view) && target.siteId == null) return false;
  if (target.siteId != null && (!Number.isSafeInteger(target.siteId) || target.siteId < 1 || !access.projectAllowed(target.siteId))) return false;
  return true;
}
