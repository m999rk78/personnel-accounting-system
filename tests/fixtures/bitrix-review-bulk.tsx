import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

const readOnly = new URLSearchParams(location.search).has("readonly");
const permissions = rolePermissionTemplate("engineer");
if (readOnly) permissions.employees = { view: true, create: false, update: false, delete: false };
const user = { id: 1, fullName: "Тестовая проверка", email: "bulk@example.invalid", role: "engineer" as const, assignedSiteId: null, projectAccess: { mode: "all" as const, siteIds: [] }, permissions, permissionsCustomized: readOnly };
history.replaceState({}, "", "/settings/general/employees");
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-02" currentUser={user}/></AgGridProvider></StrictMode>);
