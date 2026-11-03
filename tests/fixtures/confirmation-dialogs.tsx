import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { emptyPermissionSet, rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

// Every API is intercepted by the smoke test. This fixture has no credentials.
const user = { id: 1, fullName: "Проверка интерфейса", email: "ui@example.invalid", role: "superadmin" as const, assignedSiteId: null, permissions: rolePermissionTemplate("superadmin"), permissionsCustomized: false };
const accessMode = new URLSearchParams(window.location.search).get("access");
const limitedPermissions = emptyPermissionSet();
limitedPermissions.system_users.view = accessMode !== "roles-only";
limitedPermissions.access_rights.view = accessMode !== "users-only";
const actor = accessMode ? { ...user, role: "engineer" as const, permissions: limitedPermissions } : user;
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-02" currentUser={actor}/></AgGridProvider></StrictMode>);
