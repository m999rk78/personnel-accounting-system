import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

const query = new URLSearchParams(location.search);
const role = query.get("role") === "foreman" ? "foreman" : "viewer";
const permissions = rolePermissionTemplate(query.get("grants") === "default" ? role : "superadmin");
const path = new URL(query.get("page") ?? "/settings/general/positions", location.origin);
for (const [key, value] of query) if (key !== "page") path.searchParams.set(key, value);
window.history.replaceState({}, "", `${path.pathname}${path.search}`);
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><PersonnelApp initialToday="2026-11-09" currentUser={{ id: 71, role, fullName: "Проверка выданных прав", email: "fixture@invalid.test", assignedSiteId: 1, projectAccess: { mode: "all", siteIds: [] }, permissions, permissionsCustomized: true, canViewPendingReports: false }} /></AgGridProvider>);
