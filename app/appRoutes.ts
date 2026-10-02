export type WorkspaceView = "placement" | "equipment" | "timesheet" | "equipmentTimesheet" | "equipmentRegistry" | "projectEquipment" | "employees" | "positions" | "projects" | "auditLog" | "accessRights" | "directories" | "settings" | "projectSettings" | "projectEmployees" | "users";

export type WorkspaceDirectoryFocus = "all" | "sites" | "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";

export type WorkspaceLocation = {
  view: WorkspaceView;
  directoryFocus: WorkspaceDirectoryFocus;
  date: string;
  month: string;
  recognized: boolean;
};

const ROUTES: Array<{ path: string; view: WorkspaceView; directoryFocus?: WorkspaceDirectoryFocus }> = [
  { path: "/reports/workers", view: "placement" },
  { path: "/reports/equipment", view: "equipment" },
  { path: "/timesheets/workers", view: "timesheet" },
  { path: "/timesheets/equipment", view: "equipmentTimesheet" },
  { path: "/settings/general", view: "settings" },
  { path: "/settings/general/employees", view: "employees" },
  { path: "/settings/general/equipment", view: "equipmentRegistry" },
  { path: "/settings/general/positions", view: "positions" },
  { path: "/settings/general/users", view: "users" },
  { path: "/settings/general/projects", view: "projects" },
  { path: "/settings/general/activity", view: "auditLog" },
  { path: "/settings/general/access", view: "accessRights" },
  { path: "/settings/project", view: "projectSettings" },
  { path: "/settings/project/employees", view: "projectEmployees" },
  { path: "/settings/project/equipment", view: "projectEquipment" },
  { path: "/settings/project/zones", view: "directories", directoryFocus: "zone" },
  { path: "/settings/project/work-types", view: "directories", directoryFocus: "mainWorkType" },
  { path: "/settings/project/subwork-types", view: "directories", directoryFocus: "subworkType" },
  { path: "/settings/project/masters", view: "directories", directoryFocus: "master" },
];

const ROUTE_BY_PATH = new Map(ROUTES.map((route) => [route.path, route]));

function normalizedPath(pathname: string) {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export function validDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validMonth(value: string | null | undefined): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value));
}

export function parseWorkspaceLocation(pathname: string, search: string, fallbackDate: string): WorkspaceLocation {
  const route = ROUTE_BY_PATH.get(normalizedPath(pathname));
  const params = new URLSearchParams(search);
  const date = validDate(params.get("date")) ? params.get("date")! : fallbackDate;
  const month = validMonth(params.get("month")) ? params.get("month")! : date.slice(0, 7);
  return {
    view: route?.view ?? "placement",
    directoryFocus: route?.directoryFocus ?? "all",
    date,
    month,
    recognized: Boolean(route),
  };
}

export function workspacePath(view: WorkspaceView, directoryFocus: WorkspaceDirectoryFocus = "all") {
  if (view === "directories") {
    const directoryRoute = ROUTES.find((route) => route.view === view && route.directoryFocus === directoryFocus);
    return directoryRoute?.path ?? "/settings/project";
  }
  return ROUTES.find((route) => route.view === view)?.path ?? "/reports/workers";
}

export function workspaceUrl(view: WorkspaceView, directoryFocus: WorkspaceDirectoryFocus, date: string, month: string) {
  const path = workspacePath(view, directoryFocus);
  if (view === "placement" || view === "equipment") return `${path}?date=${encodeURIComponent(date)}`;
  if (view === "timesheet" || view === "equipmentTimesheet") return `${path}?month=${encodeURIComponent(month)}`;
  return path;
}

export function isGeneralSettingsView(view: WorkspaceView) {
  return view === "settings" || view === "employees" || view === "equipmentRegistry" || view === "positions" || view === "users" || view === "projects" || view === "auditLog" || view === "accessRights";
}

export function isTimesheetView(view: WorkspaceView) {
  return view === "timesheet" || view === "equipmentTimesheet";
}
