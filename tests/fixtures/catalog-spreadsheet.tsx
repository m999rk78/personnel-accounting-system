import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { ExcelExportPreviewPage } from "../../app/ExcelExportPreview";
import { normalizePermissionSet, rolePermissionTemplate } from "../../app/permissionModel";
import type { CurrentUser } from "../../app/workspace/types";
import "../../app/globals.css";

// Real PersonnelApp wiring; every /api request stays inside the synthetic preview server.
const requestedMode = new URLSearchParams(window.location.search).get("mode");
const storedMode = window.sessionStorage.getItem("catalog-smoke-mode");
const actorMode = requestedMode ?? storedMode;
const mode = actorMode === "readonly" || actorMode === "createonly" || actorMode === "restricted" ? actorMode : "full";
window.sessionStorage.setItem("catalog-smoke-mode", mode);
const resourcePermissions = { view: true, create: mode !== "readonly", update: mode === "restricted", delete: mode === "restricted" };
const user: CurrentUser = {
  id: { full: 911, readonly: 912, createonly: 913, restricted: 914 }[mode],
  fullName: `Проверка справочников (${mode})`,
  email: `${mode}@catalog-smoke.example.invalid`,
  role: mode === "full" ? "superadmin" : "engineer",
  assignedSiteId: null,
  projectAccess: mode === "restricted" ? { mode: "selected", siteIds: [1] } : { mode: "all", siteIds: [] },
  permissions: mode === "full" ? rolePermissionTemplate("superadmin") : normalizePermissionSet({
    employees: resourcePermissions,
    positions: resourcePermissions,
    equipment_registry: resourcePermissions,
    project_employees: resourcePermissions,
    project_equipment: resourcePermissions,
    project_directories: resourcePermissions,
  }),
  permissionsCustomized: mode !== "full",
};

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
  const url = new URL(request.url);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return nativeFetch(request);
  const headers = new Headers(request.headers);
  headers.set("X-Catalog-Smoke-Mode", mode);
  return nativeFetch(new Request(request, { headers }));
};
if (!/^\/(?:settings|reports|timesheets)\//.test(window.location.pathname) && window.location.pathname !== "/excel-preview") {
  window.history.replaceState({}, "", `/settings/general/positions${window.location.search}`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><AgGridProvider modules={[AllEnterpriseModule]}>
    {window.location.pathname === "/excel-preview" ? <ExcelExportPreviewPage /> : <PersonnelApp initialToday="2026-11-09" currentUser={user} />}
  </AgGridProvider></StrictMode>,
);
