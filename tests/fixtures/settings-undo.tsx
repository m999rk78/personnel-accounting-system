import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgGridProvider } from "ag-grid-react";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { RolesSettingsView } from "../../app/RolesSettingsView";
import { RoleEditorDialog } from "../../app/RoleEditorDialog";
import { AccessRightsView } from "../../app/AccessRightsView";
import { UserAccessCards } from "../../app/UserAccessCards";
import { ProjectCards } from "../../app/ProjectCards";
import type { ProjectAccess, UserRole } from "../../app/roles";
import "../../app/globals.css";

const mode = new URLSearchParams(location.search).get("mode") ?? "roles";
const sites = [{ id: 1, name: "Учебный проект" }, { id: 2, name: "Второй проект" }];
type FixtureUser = { id: number; key: string; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: string; projectAccess?: ProjectAccess; canViewPendingReports?: boolean };
const initialUsers: FixtureUser[] = [
  { id: 1, key: "user-1", fullName: "Тестовый сотрудник", email: "first@example.invalid", role: "engineer" as const, customRoleId: 1, customRoleName: "Первая роль", assignedSiteId: "1", projectAccess: { mode: "selected" as const, siteIds: [1] }, canViewPendingReports: true },
  { id: 2, key: "user-2", fullName: "Другой сотрудник", email: "second@example.invalid", role: "engineer" as const, customRoleId: 2, customRoleName: "Вторая роль", assignedSiteId: "2", projectAccess: { mode: "selected" as const, siteIds: [2] }, canViewPendingReports: true },
];
const initialProjects = [{ key: "project-1", id: 1, name: "Учебный проект", code: "ONE", timezone: "Europe/Moscow" }, { key: "project-2", id: 2, name: "Второй проект", code: "TWO", timezone: "Europe/Moscow" }];

function Fixture() {
  const [userDrafts, setUserDrafts] = useState(initialUsers);
  const [projectDrafts, setProjectDrafts] = useState(initialProjects);
  const [users, setUsers] = useState(initialUsers);
  const [projects, setProjects] = useState(initialProjects);
  const [saving, setSaving] = useState(false);
  const [roleOpen, setRoleOpen] = useState(true);
  function finishSave() {
    if (mode === "users") { setUsers(userDrafts); setUserDrafts([]); }
    if (mode === "projects") { setProjects(projectDrafts); setProjectDrafts([]); }
    setSaving(false);
  }
  return <main style={{ padding: 16, minHeight: "100vh" }}>
    <h1>Изолированная проверка отмены настроек</h1>
    {(mode === "users" || mode === "projects") && <button type="button" style={{ position: "fixed", top: 4, right: 4, zIndex: 3000 }} disabled={!saving} onClick={finishSave}>Завершить тестовое сохранение</button>}
    {mode === "roles" && <RolesSettingsView />}
    {mode === "role-dialog" && roleOpen && <RoleEditorDialog onClose={() => setRoleOpen(false)} onCreated={() => setRoleOpen(false)} />}
    {mode === "access" && <AccessRightsView onBack={() => {}} />}
    {mode === "users" && <UserAccessCards rows={users.map(({ assignedSiteId, ...user }) => ({ ...user, assignedSiteId: Number(assignedSiteId), status: "active" }))} drafts={userDrafts} sites={sites} selectedIds={[]}
      onEdit={user => setUserDrafts([users.find(item => item.id === user.id)!])} onSelectionChange={() => {}}
      onPatchDraft={(key, changes) => setUserDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))}
      onCancelEditing={() => setUserDrafts([])} onSave={() => setSaving(true)} saving={saving} />}
    {mode === "projects" && <ProjectCards rows={projects} drafts={projectDrafts} employees={[]} users={[]} currentSiteId={1} selectedIds={[]}
      onEdit={project => setProjectDrafts([projects.find(item => item.id === project.id)!])} onSelectionChange={() => {}}
      onPatchDraft={(key, changes) => setProjectDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))}
      onCancelEditing={() => setProjectDrafts([])} onSave={() => setSaving(true)} saving={saving} />}
    <output aria-label="Черновики проверки">{JSON.stringify({ users: userDrafts, projects: projectDrafts, saving })}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider></StrictMode>);
