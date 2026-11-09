import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import PersonnelApp from "../../app/PersonnelApp";
import { normalizePermissionSet, rolePermissionTemplate } from "../../app/permissionModel";
import type { CurrentUser } from "../../app/workspace/types";
import "../../app/globals.css";

// Real application and grid; the companion preview server supplies synthetic data only.
const requestedMode = new URLSearchParams(window.location.search).get("mode");
const mode = requestedMode === "readonly" || requestedMode === "createonly" || requestedMode === "restricted"
  ? requestedMode : "full";
const restricted = mode === "restricted";
const user: CurrentUser = {
  id: { full: 901, readonly: 902, createonly: 903, restricted: 904 }[mode],
  fullName: `Проверка таблицы (${mode})`,
  email: `${mode}@employee-smoke.example.invalid`,
  role: mode === "full" ? "superadmin" : "engineer",
  assignedSiteId: null,
  projectAccess: restricted ? { mode: "selected", siteIds: [1] } : { mode: "all", siteIds: [] },
  permissions: mode === "full" ? rolePermissionTemplate("superadmin") : normalizePermissionSet({
    employees: {
      view: true,
      create: mode !== "readonly",
      update: restricted,
      delete: restricted,
    },
  }),
  permissionsCustomized: mode !== "full",
};

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
  const url = new URL(request.url);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return nativeFetch(request);
  const headers = new Headers(request.headers);
  headers.set("X-Employee-Smoke-Mode", mode);
  return nativeFetch(new Request(request, { headers }));
};

if (!window.location.pathname.startsWith("/settings/")) {
  window.history.replaceState({}, "", `/settings/general/employees${window.location.search}`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgGridProvider modules={[AllEnterpriseModule]}>
      <PersonnelApp initialToday="2026-11-06" currentUser={user} />
    </AgGridProvider>
  </StrictMode>,
);
