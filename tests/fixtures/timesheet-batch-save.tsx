import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

// Actual application with synthetic actor/data; smoke script intercepts every API.
const route = new URLSearchParams(location.search).get("route") ?? "/timesheets/workers?month=2026-11";
history.replaceState(null, "", route);
const user = { id: 1, fullName: "Проверка сохранения", email: "timesheets@example.invalid", role: "superadmin" as const, assignedSiteId: null,
  projectAccess: { mode: "all" as const, siteIds: [] }, permissions: rolePermissionTemplate("superadmin"), permissionsCustomized: false };
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-05" currentUser={user}/></AgGridProvider></StrictMode>);
