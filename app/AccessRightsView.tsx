"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PERMISSION_ACTION_LABELS,
  PERMISSION_ACTIONS,
  PERMISSION_CATALOG,
  PERMISSION_GROUP_LABELS,
  emptyPermissionSet,
  normalizePermissionSet,
  permissionSetsEqual,
  rolePermissionTemplate,
  type PermissionAction,
  type PermissionResource,
  type PermissionSet,
} from "./permissionModel";
import { ROLE_LABELS, type UserRole } from "./roles";

type AccessUser = {
  id: number;
  fullName: string;
  email: string;
  role: UserRole;
  assignedSiteId: number | null;
  assignedSiteName: string | null;
  permissions: PermissionSet;
  customized: boolean;
};

type AccessPayload = { users?: AccessUser[]; canManage?: boolean; currentUserId?: number; error?: string };

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
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [draft, setDraft] = useState<PermissionSet>(() => emptyPermissionSet());
  const [canManage, setCanManage] = useState(false);
  const [currentUserId, setCurrentUserId] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const roleTemplate = selectedUser ? rolePermissionTemplate(selectedUser.role) : emptyPermissionSet();
  const changed = selectedUser ? !permissionSetsEqual(draft, selectedUser.permissions) : false;
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
    setDraft(clonePermissions(user.permissions));
    setError("");
    setNotice("");
  }

  function patchPermission(resource: PermissionResource, action: PermissionAction, enabled: boolean) {
    if (!selectedUser || !canManage) return;
    setDraft((current) => {
      const next = clonePermissions(current);
      next[resource][action] = enabled;
      if (action !== "view" && enabled) next[resource].view = true;
      if (action === "view" && !enabled) {
        next[resource].create = false;
        next[resource].update = false;
        next[resource].delete = false;
      }
      return normalizePermissionSet(next);
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
        body: JSON.stringify(reset ? { userId: selectedUser.id, reset: true } : { userId: selectedUser.id, permissions: draft }),
      });
      const payload = await response.json() as { permissions?: PermissionSet; customized?: boolean; error?: string };
      if (!response.ok || !payload.permissions) throw new Error(payload.error ?? "Не удалось сохранить права доступа.");
      const nextPermissions = clonePermissions(payload.permissions);
      setUsers((current) => current.map((user) => user.id === selectedUser.id ? { ...user, permissions: nextPermissions, customized: Boolean(payload.customized) } : user));
      setDraft(nextPermissions);
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
    setDraft(normalizePermissionSet(next));
    setNotice("");
  }

  return <section className="access-rights-page">
    <div className="settings-toolbar access-rights-toolbar"><button type="button" className="back-button" onClick={onBack}>← К общим настройкам</button><button type="button" className="back-button" onClick={() => void load()} disabled={loading || saving}>Обновить</button></div>
    <div className="access-rights-intro"><div><strong>Гибкие права поверх ролей</strong><span>Роль задаёт безопасный шаблон. Индивидуальные настройки позволяют открыть только нужные разделы и действия.</span></div><span>Сервер применяет изменения сразу</span></div>
    {error && <div className="message error inline-message"><strong>Не удалось выполнить действие</strong><span>{error}</span></div>}
    {notice && <div className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
    <div className="access-rights-layout">
      <aside className="access-user-panel">
        <label className="access-user-search"><span>Пользователи</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти пользователя" /></label>
        <div className="access-user-list">
          {loading && <div className="access-user-empty">Загружаем пользователей…</div>}
          {!loading && visibleUsers.map((user) => <button type="button" key={user.id} className={user.id === selectedUserId ? "selected" : ""} onClick={() => selectUser(user)}>
            <span className="access-user-avatar">{initials(user.fullName)}</span>
            <span className="access-user-copy"><strong>{user.fullName}</strong><small>{ROLE_LABELS[user.role]}{user.assignedSiteName ? ` · ${user.assignedSiteName}` : ""}</small></span>
            <span className={user.customized ? "access-user-state custom" : "access-user-state"}>{user.customized ? "Настроено" : "По роли"}</span>
          </button>)}
          {!loading && !visibleUsers.length && <div className="access-user-empty">Пользователи не найдены</div>}
        </div>
      </aside>
      <div className="access-matrix-panel">
        {selectedUser ? <>
          <header className="access-matrix-heading"><div><span>Права пользователя</span><h2>{selectedUser.fullName}</h2><p>{selectedUser.email} · {ROLE_LABELS[selectedUser.role]}{selectedUser.assignedSiteName ? ` · Проект: ${selectedUser.assignedSiteName}` : ""}</p></div><span className={selectedUser.customized ? "access-mode-badge custom" : "access-mode-badge"}>{selectedUser.customized ? "Индивидуальные права" : "Шаблон роли"}</span></header>
          <div className="access-preset-bar"><div><span>Быстрые настройки</span><strong>{changed ? "Есть несохранённые изменения" : "Все изменения сохранены"}</strong></div>{canManage && <div><button type="button" onClick={() => setDraft(clonePermissions(roleTemplate))} disabled={saving}>Шаблон роли</button><button type="button" onClick={applyViewOnly} disabled={saving}>Только просмотр</button><button type="button" onClick={applyFullAccess} disabled={saving}>Полный доступ</button></div>}</div>
          <div className="permission-matrix" role="table" aria-label={`Права доступа: ${selectedUser.fullName}`}>
            <div className="permission-matrix-header" role="row"><span role="columnheader">Раздел системы</span>{PERMISSION_ACTIONS.map((action) => <span role="columnheader" data-compact-label={COMPACT_ACTION_LABELS[action]} key={action}>{PERMISSION_ACTION_LABELS[action]}</span>)}</div>
            {(["reports", "timesheets", "general", "project"] as const).map((group) => <section className="permission-group" key={group}><h3>{PERMISSION_GROUP_LABELS[group]}</h3>{PERMISSION_CATALOG.filter((item) => item.group === group).map((definition) => <div className="permission-row" role="row" key={definition.key}>
              <div role="cell"><strong>{definition.title}</strong><span>{definition.description}</span></div>
              {PERMISSION_ACTIONS.map((action) => {
                const supported = definition.actions.includes(action);
                const lockOwnAccess = selectedUser.id === currentUserId && definition.key === "access_rights" && (action === "view" || action === "update");
                return <label key={action} className={["permission-cell", supported ? "" : "unsupported"].filter(Boolean).join(" ")} title={supported ? `${PERMISSION_ACTION_LABELS[action]}: ${definition.title}` : "Действие не применяется к этому разделу"}>
                  <input type="checkbox" checked={supported && draft[definition.key][action]} disabled={!canManage || !supported || saving || lockOwnAccess} onChange={(event) => patchPermission(definition.key, action, event.target.checked)} />
                  <span aria-hidden="true">✓</span>
                </label>;
              })}
            </div>)}</section>)}
          </div>
          <footer className="access-rights-footer"><span>{selectedUser.id === currentUserId ? "Собственные права управления доступом защищены от отключения." : "Права проверяются сервером для каждого действия."}</span>{canManage && <div><button type="button" className="back-button" onClick={() => void save(true)} disabled={saving || (!selectedUser.customized && permissionSetsEqual(draft, roleTemplate))}>Вернуть права роли</button><button type="button" className="primary-button" onClick={() => void save(false)} disabled={saving || !changed}>{saving ? "Сохраняем…" : "Сохранить права"}</button></div>}</footer>
        </> : <div className="access-matrix-empty">Выберите пользователя слева</div>}
      </div>
    </div>
  </section>;
}
