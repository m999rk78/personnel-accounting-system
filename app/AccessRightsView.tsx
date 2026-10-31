"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceAccess } from "./TableAccessContext";
import {
  PERMISSION_CATALOG,
  emptyPermissionSet,
  limitPermissionsToRole,
  normalizePermissionSet,
  permissionSetsEqual,
  rolePermissionTemplate,
  roleAllowsPermission,
  type PermissionAction,
  type PermissionResource,
  type PermissionSet,
} from "./permissionModel";
import { ROLE_LABELS, type ProjectAccess, type UserRole } from "./roles";
import { ProjectAccessPicker } from "./ProjectAccessPicker";
import { displayedUserProjectAccess, userProjectLabel } from "./userAccessModel";
import { PermissionMatrix } from "./PermissionMatrix";
import { RoleEditorDialog } from "./RoleEditorDialog";
import type { CustomRole } from "./customRoles";
import "./customRoles.css";

type AccessUser = {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
  customRoleId?: number | null;
  customRoleName?: string | null;
  roleTemplate?: PermissionSet;
  assignedSiteId: number | null;
  assignedSiteName: string | null;
  projectAccess?: ProjectAccess;
  projectAccessLimitedToViewer?: boolean;
  canViewPendingReports?: boolean;
  permissions: PermissionSet;
  customized: boolean;
  permissionsCustomized?: boolean;
};

type AccessPayload = { sites?: { id: number; name: string }[]; users?: AccessUser[]; canManage?: boolean; currentUserId?: number; error?: string };

function clonePermissions(value: PermissionSet) {
  return normalizePermissionSet(value);
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase("ru-RU")).join("") || "?";
}

export function AccessRightsView({ onBack }: { onBack: () => void }) {
  const [sites, setSites] = useState<{ id: number; name: string }[]>([]);
  const [projectAccess, setProjectAccess] = useState<ProjectAccess>({ mode: "selected", siteIds: [] });
  const [pendingReports, setPendingReports] = useState(false);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [draft, setDraft] = useState<PermissionSet>(() => emptyPermissionSet());
  const access = useWorkspaceAccess();
  const [serverCanManage, setCanManage] = useState(false);
  const canManage = serverCanManage && (access?.update ?? true);
  const [currentUserId, setCurrentUserId] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [rolesCanManage, setRolesCanManage] = useState(false);
  const [roleEditor, setRoleEditor] = useState<"create" | CustomRole | null>(null);
  const [showRoleCatalog, setShowRoleCatalog] = useState(false);
  const rolesRequestSequence = useRef({ version: 0 });

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const roleTemplate = selectedUser ? limitPermissionsToRole(selectedUser.role, selectedUser.roleTemplate ?? rolePermissionTemplate(selectedUser.role), projectAccess) : emptyPermissionSet();
  const changed = selectedUser ? !permissionSetsEqual(draft, selectedUser.permissions) || (projectAccess.mode !== displayedUserProjectAccess(selectedUser).mode || [...projectAccess.siteIds].sort((a,b) => a-b).join(",") !== displayedUserProjectAccess(selectedUser).siteIds.join(",")) || pendingReports !== (selectedUser.canViewPendingReports ?? selectedUser.role !== "viewer") : false;
  const visibleUsers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    return users.filter((user) => !query || `${user.fullName} ${user.email} ${user.customRoleName ?? ROLE_LABELS[user.role]}`.toLocaleLowerCase("ru-RU").includes(query));
  }, [search, users]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/access-rights", { cache: "no-store" });
      const payload = await response.json() as AccessPayload;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить права доступа.");
      const nextUsers = payload.users ?? [];
      const nextSelectedId = selectedUserId && nextUsers.some((user) => user.id === selectedUserId) ? selectedUserId : nextUsers[0]?.id ?? null;
      const nextSelected = nextUsers.find((user) => user.id === nextSelectedId);
      setUsers(nextUsers);
      setSites(payload.sites ?? []);
      setProjectAccess(nextSelected ? displayedUserProjectAccess(nextSelected) : { mode: "selected", siteIds: [] });
      setPendingReports(nextSelected?.canViewPendingReports ?? nextSelected?.role !== "viewer");
      setSelectedUserId(nextSelectedId);
      setDraft(nextSelected ? clonePermissions(nextSelected.permissions) : emptyPermissionSet());
      setCanManage(Boolean(payload.canManage));
      setCurrentUserId(payload.currentUserId ?? 0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить права доступа.");
    } finally {
      setLoading(false);
    }
  }

  async function loadRoles() {
    const requestSequence = ++rolesRequestSequence.current.version;
    try {
      const response = await fetch("/api/roles", { cache: "no-store" });
      const payload = await response.json() as { roles?: CustomRole[]; canManage?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить роли.");
      if (requestSequence !== rolesRequestSequence.current.version) return;
      setRoles(payload.roles ?? []);
      setRolesCanManage(Boolean(payload.canManage));
    } catch (loadError) {
      if (requestSequence !== rolesRequestSequence.current.version) return;
      setRolesCanManage(false);
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить роли.");
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { const requests = rolesRequestSequence.current; void loadRoles(); return () => { requests.version++; }; }, []); // eslint-disable-line react-hooks/set-state-in-effect

  function selectUser(user: AccessUser) {
    if (saving) return;
    if (changed && !window.confirm("Есть несохранённые изменения доступа. Переключить пользователя и отменить их?")) return;
    setSelectedUserId(user.id);
    setProjectAccess(displayedUserProjectAccess(user));
    setPendingReports(user.canViewPendingReports ?? user.role !== "viewer");
    setDraft(clonePermissions(user.permissions));
    setError("");
    setNotice("");
  }

  function patchPermission(resource: PermissionResource, action: PermissionAction, enabled: boolean) {
    if (!selectedUser || !canManage || !roleAllowsPermission(selectedUser.role, resource, action, projectAccess)) return;
    setDraft((current) => {
      const next = clonePermissions(current);
      next[resource][action] = enabled;
      if (action !== "view" && enabled) next[resource].view = true;
      if (action === "view" && !enabled) {
        next[resource].create = false;
        next[resource].update = false;
        next[resource].delete = false;
      }
      return limitPermissionsToRole(selectedUser.role, next, projectAccess);
    });
    setNotice("");
  }

  async function save(reset = false) {
    if (!selectedUser || !canManage) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/access-rights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reset ? { userId: selectedUser.id, reset: true } : { userId: selectedUser.id, permissions: draft, projectAccess, canViewPendingReports: pendingReports }),
      });
      const payload = await response.json() as { permissions?: PermissionSet; customized?: boolean; projectAccess?: ProjectAccess; canViewPendingReports?: boolean; error?: string };
      if (!response.ok || !payload.permissions) throw new Error(payload.error ?? "Не удалось сохранить права доступа.");
      const nextPermissions = clonePermissions(payload.permissions);
      const nextAccess = payload.projectAccess ?? projectAccess;
      const nextPending = payload.canViewPendingReports ?? pendingReports;
      setUsers((current) => current.map((user) => user.id === selectedUser.id ? { ...user, permissions: nextPermissions, customized: Boolean(payload.customized), projectAccess: nextAccess, canViewPendingReports: nextPending } : user));
      setDraft(nextPermissions);
      setProjectAccess(nextAccess);
      setPendingReports(nextPending);
      setNotice(reset ? "Восстановлены стандартные права выбранной роли." : "Индивидуальные права сохранены.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить права доступа.");
    } finally {
      setSaving(false);
    }
  }

  function applyViewOnly() {
    const next = emptyPermissionSet();
    for (const definition of PERMISSION_CATALOG) if (draft[definition.key].view) next[definition.key].view = true;
    setDraft(next);
    setNotice("");
  }

  function applyFullAccess() {
    const next = emptyPermissionSet();
    for (const definition of PERMISSION_CATALOG) for (const action of definition.actions) next[definition.key][action] = true;
    setDraft(selectedUser ? limitPermissionsToRole(selectedUser.role, next, projectAccess) : normalizePermissionSet(next));
    setNotice("");
  }

  return <section className="access-rights-page">
    <div className="settings-toolbar access-rights-toolbar"><button type="button" className="back-button" onClick={onBack}>← К общим настройкам</button><div className="access-rights-toolbar-actions"><button type="button" className="back-button" onClick={() => { if (!changed || window.confirm("Есть несохранённые изменения доступа. Обновить страницу и отменить их?")) void Promise.all([load(), loadRoles()]); }} disabled={loading || saving}>Обновить</button>{canManage && rolesCanManage && <button type="button" className="primary-button" disabled={saving || loading} onClick={() => setRoleEditor("create")}><span aria-hidden="true">＋</span>Добавить роль</button>}</div></div>
    {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
    {notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
    {roles.length > 0 && <details className="access-role-catalog" open={showRoleCatalog} onToggle={event => setShowRoleCatalog(event.currentTarget.open)}><summary>Созданные роли<span>{roles.length}</span></summary><div className="access-role-list">{roles.map(role => <button type="button" key={role.id} onClick={() => setRoleEditor(role)}>{role.name}</button>)}</div></details>}
    <div className="access-rights-layout">
      <aside className="access-user-panel">
        <label className="access-user-search"><span>Пользователи</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти пользователя" /></label>
        <div className="access-user-list">
          {loading && <div className="access-user-empty">Загружаем пользователей…</div>}
          {!loading && visibleUsers.map((user) => <button type="button" key={user.id} className={user.id === selectedUserId ? "selected" : ""} onClick={() => selectUser(user)}>
            <span className="access-user-avatar">{initials(user.fullName)}</span>
            <span className="access-user-copy"><strong>{user.fullName}</strong><small>{user.customRoleName ?? ROLE_LABELS[user.role]} · {userProjectLabel(user.role, user.assignedSiteId, sites, user.projectAccess, user.projectAccessLimitedToViewer)}</small></span>
            <span className={user.customized || user.permissionsCustomized ? "access-user-state custom" : "access-user-state"}>{user.customized || user.permissionsCustomized ? "Настроено" : "По роли"}</span>
          </button>)}
          {!loading && !visibleUsers.length && <div className="access-user-empty">Пользователи не найдены</div>}
        </div>
      </aside>
      <div className="access-matrix-panel">
        {selectedUser ? <>
          <section className="access-project-panel" aria-label="Доступ выбранного пользователя к проектам">
            <header><h3>Доступ к проектам</h3><span>{selectedUser.projectAccessLimitedToViewer ? "Показаны только проекты в пределах вашего доступа" : selectedUser.role === "superadmin" ? "Супер-админ видит все проекты" : "Настраивается отдельно от роли"}</span></header>
            <ProjectAccessPicker key={selectedUser.id} value={projectAccess} sites={sites} disabled={!canManage || saving || selectedUser.role === "superadmin"} onChange={next => { setProjectAccess(next); setDraft(current => limitPermissionsToRole(selectedUser.role, current, next)); setNotice(""); }} />
            {selectedUser.role === "viewer" && <label className="access-pending-toggle" aria-label="Показывать черновики и отчёты на проверке"><input type="checkbox" checked={pendingReports} disabled={!canManage || saving} onChange={event => { setPendingReports(event.target.checked); setNotice(""); }} /><span><strong>Показывать черновики и отчёты на проверке</strong><small>По умолчанию пользователь видит подтверждённые отчёты и табели. Роль «Просмотр» не позволяет менять данные.</small></span></label>}
          </section>
          <div className="access-preset-bar"><div><span>Быстрые настройки</span><strong>{changed ? "Есть несохранённые изменения" : "Все изменения сохранены"}</strong></div>{canManage && <div><button type="button" onClick={() => setDraft(clonePermissions(roleTemplate))} disabled={saving}>Шаблон роли</button><button type="button" onClick={applyViewOnly} disabled={saving}>Только просмотр</button><button type="button" onClick={applyFullAccess} disabled={saving}>{selectedUser.role === "viewer" ? "Все разделы" : "Полный доступ"}</button></div>}</div>
          <PermissionMatrix label={`Права доступа: ${selectedUser.fullName}`} value={draft} disabled={!canManage || saving} onChange={patchPermission} cellPolicy={(resource, action) => {
            const allowed = selectedUser.projectAccessLimitedToViewer
              ? selectedUser.role !== "viewer" || action === "view"
              : roleAllowsPermission(selectedUser.role, resource, action, projectAccess);
            const locked = selectedUser.id === currentUserId && resource === "access_rights" && (action === "view" || action === "update");
            return { allowed, locked, ...(!allowed ? { title: selectedUser.role === "viewer" ? "Роль «Просмотр» не позволяет изменять данные" : "Доступ к выбранным проектам не позволяет менять общие настройки пользователей" } : {}) };
          }} />
          <footer className="access-rights-footer"><span>{selectedUser.id === currentUserId ? "Собственные права управления доступом защищены от отключения." : "Права проверяются сервером для каждого действия."}</span>{canManage && <div><button type="button" className="back-button" onClick={() => void save(true)} disabled={saving || (!selectedUser.customized && permissionSetsEqual(draft, roleTemplate))}>Вернуть права роли</button><button type="button" className="primary-button" onClick={() => void save(false)} disabled={saving || !changed}>{saving ? "Сохраняем…" : "Сохранить доступ"}</button></div>}</footer>
        </> : <div className="access-matrix-empty">Выберите пользователя слева</div>}
      </div>
    </div>
    {roleEditor && <RoleEditorDialog previewRole={roleEditor === "create" ? undefined : roleEditor} onClose={() => setRoleEditor(null)} onCreated={role => {
      // A catalog read started before this POST must not remove the new role.
      rolesRequestSequence.current.version++;
      setRoles(current => [...current.filter(item => item.id !== role.id), role].sort((left, right) => left.name.localeCompare(right.name, "ru")));
      setRoleEditor(null);
      setShowRoleCatalog(true);
      setNotice(`Роль «${role.name}» создана. Её можно выбрать при добавлении или редактировании пользователя.`);
    }} />}
  </section>;
}
