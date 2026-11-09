import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { rolePermissionTemplate } from "../../app/permissionModel";
import type { CurrentUser } from "../../app/workspace/types";
import "../../app/globals.css";

// Synthetic actors only. The smoke runner intercepts every application request.
const params = new URLSearchParams(location.search);
const role = params.get("role") === "viewer" ? "viewer" : params.get("role") === "foreman" ? "foreman" : "superadmin";
const route = params.get("route") ?? "/settings/general/employees";
history.replaceState(null, "", route);
const user: CurrentUser = {
  id: role === "viewer" ? 3 : role === "foreman" ? 2 : 1,
  fullName: "Проверка контекстных меню", email: "menus@example.invalid", role,
  assignedSiteId: role === "foreman" ? 1 : null,
  projectAccess: { mode: "all" as const, siteIds: [] },
  permissions: rolePermissionTemplate(role), permissionsCustomized: false,
};
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-04" currentUser={user}/></AgGridProvider></StrictMode>);
