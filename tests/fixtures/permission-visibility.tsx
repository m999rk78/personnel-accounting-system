import { createRoot } from "react-dom/client";
import { AgGridProvider } from "ag-grid-react";
import { AllCommunityModule } from "ag-grid-community";
import AuthGate, { type CurrentUser } from "../../app/AuthGate";
import { emptyPermissionSet, normalizePermissionSet, rolePermissionTemplate } from "../../app/permissionModel";
import "../../app/globals.css";

const scenario = new URLSearchParams(window.location.search).get("scenario");
const permissions = scenario === "none" ? emptyPermissionSet()
  : scenario === "report-only" ? normalizePermissionSet({ workers_report: { view: true } })
    : scenario === "partial" ? normalizePermissionSet({ employees: { view: true, update: true } })
      : rolePermissionTemplate("foreman");
const user: CurrentUser = { id: 10, fullName: "Прораб для проверки", email: "fixture@example.invalid", role: "foreman", assignedSiteId: 1, permissions, permissionsCustomized: true };
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllCommunityModule]}><AuthGate initialToday="2026-10-28" initialUser={user} /></AgGridProvider>);
