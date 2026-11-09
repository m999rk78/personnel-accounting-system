"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceAccess } from "./TableAccessContext";
import {
  PERMISSION_CATALOG,
  emptyPermissionSet,
  limitPermissionsToRole,
  normalizePermissionSet,
  patchPermissionSet,
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
import { RoleCatalog } from "./RoleCatalog";
import type { CustomRole } from "./customRoles";
import { useConfirmationDialog } from "./useConfirmationDialog";
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
  permissionsManageable?: boolean;
};

type AccessPayload = { sites?: { id: number; name: string }[]; users?: AccessUser[]; canManage?: boolean; currentUserId?: number; error?: string };

function clonePermissions(value: PermissionSet) {
  return normalizePermissionSet(value);
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase("ru-RU")).join("") || "?";
}

export function AccessRightsView({ onBack, onDirtyChange, onBusyChange, initialUserId, embedded = false }: { onBack: () => void; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; initialUserId?: number; embedded?: boolean }) {
  const { confirm, dialog: confirmationDialog } = useConfirmationDialog();
  const [sites, setSites] = useState<{ id: number; name: string }[]>([]);
  const [projectAccess, setProjectAccess] = useState<ProjectAccess>({ mode: "selected", siteIds: [] });
  const [pendingReports, setPendingReports] = useState(false);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(initialUserId ?? null);
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
  const selectedCanManage = canManage && selectedUser?.permissionsManageable !== false;
  const roleTemplate = selectedUser ? limitPermissionsToRole(selectedUser.role, selectedUser.roleTemplate ?? rolePermissionTemplate(selectedUser.role), projectAccess) : emptyPermissionSet();
  const changed = selectedUser ? !permissionSetsEqual(draft, selectedUser.permissions) || (projectAccess.mode !== displayedUserProjectAccess(selectedUser).mode || [...projectAccess.siteIds].sort((a,b) => a-b).join(",") !== displayedUserProjectAccess(selectedUser).siteIds.join(",")) || pendingReports !== (selectedUser.canViewPendingReports ?? selectedUser.role !== "viewer") : false;
  useLayoutEffect(() => { onDirtyChange?.(changed); return () => onDirtyChange?.(false); }, [changed, onDirtyChange]);
  useLayoutEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);
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
      const nextUsers = (payload.users ?? []).map(user => ({ ...user, permissions: clonePermissions(user.permissions) }));
      const nextSelectedId = selectedUserId && nextUsers.some((user) => user.id === selectedUserId) ? selectedUserId : embedded ? null : nextUsers[0]?.id ?? null;
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
  useEffect(() => { const requests = rolesRequestSequence.current; if (!embedded) void loadRoles(); return () => { requests.version++; }; }, [embedded]); // eslint-disable-line react-hooks/set-state-in-effect

  async function selectUser(user: AccessUser) {
    if (saving || user.id === selectedUserId) return;
    if (changed && !await confirm({ title: "Переключить пользователя?", description: "Изменения прав доступа ещё не сохранены. При выборе другого пользователя они будут отменены.", confirmLabel: "Переключить без сохранения" })) return;
    setSelectedUserId(user.id);
    setProjectAccess(displayedUserProjectAccess(user));
    setPendingReports(user.canViewPendingReports ?? user.role !== "viewer");
    setDraft(clonePermissions(user.permissions));
    setError("");
    setNotice("");
  }

  async function refresh() {
    if (loading || saving) return;
    if (changed && !await confirm({ title: "Обновить данные?", description: "Изменения прав доступа ещё не сохранены. При обновлении загрузятся сохранённые настройки, а ваши правки будут отменены.", confirmLabel: "Обновить без сохранения" })) return;
    await Promise.all([load(), ...(!embedded ? [loadRoles()] : [])]);
  }

  async function openRole(role: CustomRole) {
    if (saving) return;
    if (role.id > 0 && rolesCanManage && changed && !await confirm({ title: "Открыть редактирование роли?", description: "Несохранённые индивидуальные права пользователя будут отменены.", confirmLabel: "Продолжить", cancelLabel: "Остаться" })) return;
    if (role.id > 0 && rolesCanManage && changed && selectedUser) {
      setDraft(clonePermissions(selectedUser.permissions)); setProjectAccess(displayedUserProjectAccess(selectedUser)); setPendingReports(selectedUser.canViewPendingReports ?? selectedUser.role !== "viewer");
    }
    setRoleEditor(role);
  }

  async function removeRole(role: CustomRole) {
    if (!canManage || !rolesCanManage || saving || role.id < 1) return;
    if (!await confirm({ title: `Удалить роль «${role.name}»?`, description: "Удалить можно только роль, которая не назначена пользователям.", confirmLabel: "Удалить роль", cancelLabel: "Отмена" })) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/roles", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roleId: role.id, revision: role.revision }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось удалить роль.");
      rolesRequestSequence.current.version++;
      setRoles(current => current.filter(item => item.id !== role.id));
      setNotice(`Роль «${role.name}» удалена.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось удалить роль."); }
    finally { setSaving(false); }
  }

  async function back() {
    if (saving) return;
    if (changed && !await confirm({ title: "Выйти из настроек доступа?", description: "Изменения прав доступа ещё не сохранены. При переходе к общим настройкам они будут отменены.", confirmLabel: "Перейти без сохранения" })) return;
    onDirtyChange?.(false);
    onBack();
  }

  function patchPermission(resource: PermissionResource, action: PermissionAction, enabled: boolean) {
    if (!selectedUser || !selectedCanManage) return;
    setDraft(current => patchPermissionSet(current, resource, action, enabled));
    setNotice("");
  }

  async function save(reset = false) {
    if (!selectedUser || !selectedCanManage) return;
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

  return <section className={`access-rights-page${embedded ? " embedded-user-access" : ""}`}>
    <div className="settings-toolbar access-rights-toolbar"><button type="button" className="back-button" onClick={() => void back()} disabled={saving}>{embedded ? "Закрыть" : "← К общим настройкам"}</button><div className="access-rights-toolbar-actions"><button type="button" className="back-button" onClick={() => void refresh()} disabled={loading || saving}>Обновить</button>{!embedded && canManage && rolesCanManage && <button type="button" className="primary-button" disabled={saving || loading} onClick={() => setRoleEditor("create")}><span aria-hidden="true">＋</span>Добавить роль</button>}</div></div>
    {error && <div className="message error inline-message" role="alert"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
    {notice && <div className="message success inline-message" role="status"><strong>Готово</strong><span>{notice}</span></div>}
    {!embedded && <details className="access-role-catalog" open={showRoleCatalog} onToggle={event => setShowRoleCatalog(event.currentTarget.open)}><summary>Справочник ролей<span>{roles.length + 1}</span></summary><RoleCatalog roles={roles} canManage={canManage && rolesCanManage} busy={saving || loading} onOpen={role => void openRole(role)} onDelete={role => void removeRole(role)}/></details>}
    <div className="access-rights-layout">
      {!embedded && <aside className="access-user-panel">
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
      </aside>}
      <div className="access-matrix-panel">
        {selectedUser ? <>
          <section className="access-project-panel" aria-label="Доступ выбранного пользователя к проектам">
            <header><h3>Доступ к проектам</h3>{selectedUser.projectAccessLimitedToViewer && <span>{selectedCanManage ? "В пределах вашего доступа" : "Доступ пользователя выходит за пределы ваших проектов"}</span>}</header>
            <ProjectAccessPicker key={selectedUser.id} value={projectAccess} sites={sites} disabled={!selectedCanManage || saving || selectedUser.role === "superadmin"} onChange={next => { setProjectAccess(next); setDraft(current => limitPermissionsToRole(selectedUser.role, current, next)); setNotice(""); }} />

          </section>
          <div className="access-preset-bar"><div><strong>{changed ? "Не сохранено" : "Сохранено"}</strong></div>{selectedCanManage && <div><button type="button" onClick={() => setDraft(clonePermissions(roleTemplate))} disabled={saving}>Шаблон роли</button><button type="button" onClick={applyViewOnly} disabled={saving}>Только просмотр</button><button type="button" onClick={applyFullAccess} disabled={saving}>Полный доступ</button></div>}</div>
          <PermissionMatrix compact label={`Права доступа: ${selectedUser.fullName}`} value={draft} disabled={!selectedCanManage || saving} onChange={patchPermission} cellPolicy={(resource, action) => {
            const allowed = roleAllowsPermission(selectedUser.role, resource, action, projectAccess);
            const locked = selectedUser.id === currentUserId && resource === "access_rights" && (action === "view" || action === "update");
            return { allowed, locked };
          }} />
          <footer className="access-rights-footer">{selectedUser.id === currentUserId && <span>Собственное управление доступом защищено.</span>}{selectedCanManage && <div><button type="button" className="back-button" onClick={() => void save(true)} disabled={saving || (!selectedUser.customized && permissionSetsEqual(draft, roleTemplate))}>Вернуть права роли</button><button type="button" className="primary-button" onClick={() => void save(false)} disabled={saving || !changed}>{saving ? "Сохраняем…" : "Сохранить доступ"}</button></div>}</footer>
        </> : <div className="access-matrix-empty">{embedded ? loading ? "Загружаем права…" : "Пользователь недоступен" : "Выберите пользователя слева"}</div>}
      </div>
    </div>
    {roleEditor && <RoleEditorDialog previewRole={roleEditor === "create" ? undefined : roleEditor} editable={canManage && rolesCanManage && roleEditor !== "create" && roleEditor.id > 0} onClose={() => setRoleEditor(null)} onCreated={role => {
      // A catalog read started before this POST must not remove the new role.
      rolesRequestSequence.current.version++;
      setRoles(current => [...current.filter(item => item.id !== role.id), role].sort((left, right) => left.name.localeCompare(right.name, "ru")));
      const updated = roleEditor !== "create";
      setRoleEditor(null);
      setShowRoleCatalog(true);
      setNotice(`Роль «${role.name}» ${updated ? "обновлена" : "создана"}.`);
      if (updated) void load();
    }} />}
    {confirmationDialog}
  </section>;
}
