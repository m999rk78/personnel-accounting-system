import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { normalizePermissionSet, rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

// Synthetic actor; all requests are intercepted by employee-header-smoke.mjs.
const mode = new URLSearchParams(window.location.search).get("mode");
const limited = mode === "readonly" || mode === "restricted";
const user = { id: 1, fullName: "Проверка шапки", email: "header@example.invalid", role: limited ? "engineer" as const : "superadmin" as const, assignedSiteId: null,
  projectAccess: mode === "restricted" ? { mode: "selected" as const, siteIds: [1] } : { mode: "all" as const, siteIds: [] },
  permissions: limited ? normalizePermissionSet({ employees: { view: true } }) : rolePermissionTemplate("superadmin"), permissionsCustomized: limited };
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-03" currentUser={user}/></AgGridProvider></StrictMode>);
