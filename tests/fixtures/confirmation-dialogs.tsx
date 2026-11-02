import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

// Every API is intercepted by the smoke test. This fixture has no credentials.
const user = { id: 1, fullName: "Проверка интерфейса", email: "ui@example.invalid", role: "superadmin" as const, assignedSiteId: null, permissions: rolePermissionTemplate("superadmin"), permissionsCustomized: false };
createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-02" currentUser={user}/></AgGridProvider></StrictMode>);
