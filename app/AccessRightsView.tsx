"use client";

import { useEffect, useMemo, useState } from "react";
import { useWorkspaceAccess } from "./TableAccessContext";
import {
  PERMISSION_ACTION_LABELS,
  PERMISSION_ACTIONS,
  PERMISSION_CATALOG,
  PERMISSION_GROUP_LABELS,
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

type AccessUser = {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
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

const COMPACT_ACTION_LABELS: Record<PermissionAction, string> = {
  view: "Видеть",
  create: "Добавить",
  update: "Изменить",
  delete: "Удалить",
};

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

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const roleTemplate = selectedUser ? rolePermissionTemplate(selectedUser.role) : emptyPermissionSet();
  const changed = selectedUser ? !permissionSetsEqual(draft, selectedUser.permissions) || (projectAccess.mode !== displayedUserProjectAccess(selectedUser).mode || [...projectAccess.siteIds].sort((a,b) => a-b).join(",") !== displayedUserProjectAccess(selectedUser).siteIds.join(",")) || pendingReports !== (selectedUser.canViewPendingReports ?? selectedUser.role !== "viewer") : false;
  const visibleUsers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    return users.filter((user) => !query || `${user.fullName} ${user.email} ${ROLE_LABELS[user.role]}`.toLocaleLowerCase("ru-RU").includes(query));
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

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps

  function selectUser(user: AccessUser) {
    if (saving) return;
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
    <div className="settings-toolbar access-rights-toolbar"><button type="button" className="back-button" onClick={onBack}>← К общим настройкам</button><button type="button" className="back-button" onClick={() => void load()} disabled={loading || saving}>Обновить</button></div>
    {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
    {notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
    <div className="access-rights-layout">
      <aside className="access-user-panel">
        <label className="access-user-search"><span>Пользователи</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти пользователя" /></label>
        <div className="access-user-list">
          {loading && <div className="access-user-empty">Загружаем пользователей…</div>}
          {!loading && visibleUsers.map((user) => <button type="button" key={user.id} className={user.id === selectedUserId ? "selected" : ""} onClick={() => selectUser(user)}>
            <span className="access-user-avatar">{initials(user.fullName)}</span>
            <span className="access-user-copy"><strong>{user.fullName}</strong><small>{ROLE_LABELS[user.role]} · {userProjectLabel(user.role, user.assignedSiteId, sites, user.projectAccess, user.projectAccessLimitedToViewer)}</small></span>
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
          <div className="permission-matrix" role="table" aria-label={`Права доступа: ${selectedUser.fullName}`}>
            <div className="permission-matrix-header" role="row"><span role="columnheader">Раздел системы</span>{PERMISSION_ACTIONS.map((action) => <span role="columnheader" data-compact-label={COMPACT_ACTION_LABELS[action]} key={action}>{PERMISSION_ACTION_LABELS[action]}</span>)}</div>
            {(["reports", "timesheets", "general", "project"] as const).map((group) => <section className="permission-group" key={group}><h3>{PERMISSION_GROUP_LABELS[group]}</h3>{PERMISSION_CATALOG.filter((item) => item.group === group).map((definition) => <div className="permission-row" role="row" key={definition.key}>
              <div role="cell"><strong>{definition.title}</strong><span>{definition.description}</span></div>
              {PERMISSION_ACTIONS.map((action) => {
                const supported = definition.actions.includes(action);
                const allowedByRole = selectedUser.projectAccessLimitedToViewer
                  ? selectedUser.role !== "viewer" || action === "view"
                  : roleAllowsPermission(selectedUser.role, definition.key, action, projectAccess);
                const lockOwnAccess = selectedUser.id === currentUserId && definition.key === "access_rights" && (action === "view" || action === "update");
                return <label key={action} className={["permission-cell", supported && allowedByRole ? "" : "unsupported"].filter(Boolean).join(" ")} title={!supported ? "Действие не применяется к этому разделу" : !allowedByRole ? selectedUser.role === "viewer" ? "Роль «Просмотр» не позволяет изменять данные" : "Доступ к выбранным проектам не позволяет менять общие настройки пользователей" : `${PERMISSION_ACTION_LABELS[action]}: ${definition.title}`}>
                  <input type="checkbox" checked={supported && allowedByRole && draft[definition.key][action]} disabled={!canManage || !supported || !allowedByRole || saving || lockOwnAccess} onChange={(event) => patchPermission(definition.key, action, event.target.checked)} />
                  <span aria-hidden="true">✓</span>
                </label>;
              })}
            </div>)}</section>)}
          </div>
          <footer className="access-rights-footer"><span>{selectedUser.id === currentUserId ? "Собственные права управления доступом защищены от отключения." : "Права проверяются сервером для каждого действия."}</span>{canManage && <div><button type="button" className="back-button" onClick={() => void save(true)} disabled={saving || (!selectedUser.customized && permissionSetsEqual(draft, roleTemplate))}>Вернуть права роли</button><button type="button" className="primary-button" onClick={() => void save(false)} disabled={saving || !changed}>{saving ? "Сохраняем…" : "Сохранить доступ"}</button></div>}</footer>
        </> : <div className="access-matrix-empty">Выберите пользователя слева</div>}
      </div>
    </div>
  </section>;
}
