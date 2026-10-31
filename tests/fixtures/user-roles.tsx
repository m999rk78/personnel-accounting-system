import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgGridProvider } from "ag-grid-react";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { UserAccessCards } from "../../app/UserAccessCards";
import { AccessRightsView } from "../../app/AccessRightsView";
import { UserAgGrid, type GridUser, type GridUserDraft } from "../../app/AgDataGrids";
import { effectiveProjectAccess } from "../../app/roles";
import { limitPermissionsToRole, rolePermissionTemplate, type PermissionSet } from "../../app/permissionModel";
import { userDraftProjectAccess, userProjectAccessValid } from "../../app/userAccessModel";
import { CustomRoleError, customRoleNameKey, normalizeCustomRoleInput, type CustomRole } from "../../app/customRoles";
import "../../app/globals.css";

const sites = [{ id: 7, name: "Северный объект" }, { id: 8, name: "Южный объект" }, { id: 9, name: "Резервный объект" }];
type FixtureUser = GridUser & { permissions: PermissionSet; customized?: boolean };
const users: FixtureUser[] = [
  { id: 1, fullName: "Пётр Проектный", email: "foreman@invalid.test", role: "foreman", assignedSiteId: 7, projectAccess: { mode: "selected", siteIds: [7] }, status: "active", permissions: rolePermissionTemplate("foreman") },
  { id: 2, fullName: "Ирина Инженерная", email: "engineer@invalid.test", role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active", permissions: rolePermissionTemplate("engineer") },
  { id: 3, fullName: "Ольга Наблюдающая", email: "viewer@invalid.test", role: "viewer", assignedSiteId: null, projectAccess: { mode: "selected", siteIds: [8] }, canViewPendingReports: false, status: "active", permissions: rolePermissionTemplate("viewer") },
  { id: 4, fullName: "Сергей Системный", email: "superadmin@invalid.test", role: "superadmin", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active", permissions: rolePermissionTemplate("superadmin") },
];
function Fixture() {
  const [rows, setRows] = useState(users);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [drafts, setDrafts] = useState<GridUserDraft[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [grid, setGrid] = useState(false);
  const [rights, setRights] = useState(false);
  const [notice, setNotice] = useState("");
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href).pathname;
      if (path === "/api/roles") {
        if (init?.method !== "POST") return Response.json({ roles, canManage: true });
        try {
          const input = normalizeCustomRoleInput(JSON.parse(String(init.body)));
          if (roles.some(role => customRoleNameKey(role.name) === input.nameKey)) return Response.json({ error: "Роль с таким названием уже существует." }, { status: 409 });
          const role = { id: 100 + roles.length, name: input.name, baseRole: input.baseRole, permissions: input.permissions, revision: 1 };
          setRoles(current => [...current, role]);
          return Response.json({ role }, { status: 201 });
        } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Некорректная роль" }, { status: error instanceof CustomRoleError ? error.status : 400 }); }
      }
      if (path !== "/api/access-rights") return originalFetch(input, init);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const target = rows.find(user => user.id === body.userId);
        if (!target) return Response.json({ error: "Тестовый пользователь не найден" }, { status: 404 });
        const projectAccess = body.projectAccess ?? effectiveProjectAccess(target);
        const permissions = body.reset ? roles.find(role => role.id === target.customRoleId)?.permissions ?? rolePermissionTemplate(target.role) : limitPermissionsToRole(target.role, body.permissions ?? target.permissions, projectAccess);
        const canViewPendingReports = target.role === "viewer" ? Boolean(body.canViewPendingReports ?? target.canViewPendingReports) : true;
        setRows(current => current.map(user => user.id === target.id ? { ...user, projectAccess, permissions, canViewPendingReports, customized: !body.reset } : user));
        return Response.json({ projectAccess, permissions, canViewPendingReports, customized: !body.reset });
      }
      return Response.json({ users: rows.map(user => ({ ...user, roleTemplate: roles.find(role => role.id === user.customRoleId)?.permissions ?? rolePermissionTemplate(user.role) })), sites, canManage: true, currentUserId: 4 });
    };
    return () => { window.fetch = originalFetch; };
  }, [rows, roles]);
  const patch = (key: string, changes: Partial<GridUserDraft>) => setDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft));
  const edit = (user: GridUser, changes: Partial<GridUserDraft> = {}) => setDrafts(current => current.some(draft => draft.id === user.id) ? current : [...current, { key: `user-${user.id}`, id: user.id, fullName: user.fullName, email: user.email, role: user.role, customRoleId: user.customRoleId ?? null, customRoleName: user.customRoleName ?? null, assignedSiteId: user.assignedSiteId ? String(user.assignedSiteId) : "", projectAccess: effectiveProjectAccess(user), canViewPendingReports: user.canViewPendingReports ?? user.role !== "viewer", ...changes }]);
  const save = () => {
    if (drafts.some(draft => !userProjectAccessValid(userDraftProjectAccess(draft), sites))) { setNotice("Нужно выбрать хотя бы один проект или разрешить все проекты."); return; }
    setRows(current => [...current.filter(user => !drafts.some(draft => draft.id === user.id)), ...drafts.map((draft, index) => ({ id: draft.id ?? 10 + index, fullName: draft.fullName, email: draft.email, role: draft.role, customRoleId: draft.customRoleId ?? null, customRoleName: draft.customRoleName ?? null, assignedSiteId: userDraftProjectAccess(draft).siteIds[0] ?? null, projectAccess: userDraftProjectAccess(draft), canViewPendingReports: draft.canViewPendingReports ?? draft.role !== "viewer", status: "active" as const, permissions: roles.find(role => role.id === draft.customRoleId)?.permissions ?? rolePermissionTemplate(draft.role) }))]);
    setDrafts([]); setNotice("Тестовые изменения сохранены в памяти.");
  };
  return <main style={{ padding: 24, height: "100vh", display: "flex", flexDirection: "column", gap: 16 }}>
    <p>Изолированный стенд ролей. Рабочая база и отправка приглашений не подключены.</p>
    <header style={{ display: "flex", alignItems: "center", gap: 16 }}><h1>{rights ? "Права доступа" : "Пользователи системы"}</h1><button type="button" onClick={() => setRights(value => !value)}>{rights ? "К пользователям" : "Права доступа"}</button>{!rights && <><button type="button" onClick={() => { setDrafts([{ key: "new", fullName: "Тестовый пользователь", email: "test@invalid.test", role: "viewer", assignedSiteId: "", projectAccess: { mode: "selected", siteIds: [] }, canViewPendingReports: false }]); setNotice(""); }}>Добавить пользователя</button><label><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)} />Табличный режим</label></>}</header>
    {notice && <p role="status">{notice}</p>}
    {rights ? <AccessRightsView onBack={() => setRights(false)} /> : grid ? <><UserAgGrid rows={rows} drafts={drafts} pendingDeletes={selected} fullRowEditIds={drafts.flatMap(draft => draft.id ? [draft.id] : [])} sites={sites} onEdit={edit} onSelectionChange={setSelected} onPatchDraft={patch} /><button type="button" onClick={save} disabled={!drafts.length}>Сохранить изменения</button></> : <UserAccessCards rows={rows} drafts={drafts} sites={sites} selectedIds={selected} onEdit={edit} onSelectionChange={setSelected} onPatchDraft={patch} onCancelEditing={() => setDrafts([])} onSave={save} saving={false} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider>);
