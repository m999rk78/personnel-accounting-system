"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CustomRole } from "./customRoles";
import { emptyPermissionSet, normalizePermissionSet, permissionSetsEqual, rolePermissionTemplate, type PermissionAction, type PermissionResource, type PermissionSet } from "./permissionModel";
import { PermissionMatrix } from "./PermissionMatrix";
import { useWorkspaceAccess } from "./TableAccessContext";
import { useConfirmationDialog } from "./useConfirmationDialog";
import "./customRoles.css";
import "./usersRights.css";

const superadmin: CustomRole = { id: -1, name: "Супер-админ", baseRole: "engineer", permissions: rolePermissionTemplate("superadmin"), revision: 1 };

export function RolesSettingsView({ onDirtyChange, onBusyChange, onRolesChanged }: {
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onRolesChanged?: () => void;
}) {
  const access = useWorkspaceAccess();
  const { confirm, dialog } = useConfirmationDialog();
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [selected, setSelected] = useState<CustomRole | null>(superadmin);
  const [name, setName] = useState(superadmin.name);
  const [permissions, setPermissions] = useState<PermissionSet>(superadmin.permissions);
  const [serverCanManage, setServerCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [roleQuery, setRoleQuery] = useState("");
  const [resourceQuery, setResourceQuery] = useState("");
  const sequence = useRef(0);
  const busy = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const canManage = serverCanManage && (access?.update ?? true);
  const protectedRole = selected?.id === -1;
  const editable = canManage && !protectedRole && !loading && !saving;
  const changed = canManage && !protectedRole && (name !== (selected?.name ?? "") || !permissionSetsEqual(permissions, selected?.permissions ?? emptyPermissionSet()));
  const visibleRoles = [superadmin, ...roles].filter(role => role.name.toLocaleLowerCase("ru-RU").includes(roleQuery.trim().toLocaleLowerCase("ru-RU")));

  useLayoutEffect(() => { onDirtyChange?.(changed); return () => onDirtyChange?.(false); }, [changed, onDirtyChange]);
  useLayoutEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);
  useEffect(() => {
    if (!changed && !saving) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [changed, saving]);

  function showRole(role: CustomRole | null) {
    setSelected(role);
    setName(role?.name ?? "");
    setPermissions(normalizePermissionSet(role?.permissions ?? emptyPermissionSet()));
    setResourceQuery("");
    setError("");
    setNotice("");
  }

  async function load(initial = false) {
    const version = ++sequence.current;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/roles", { cache: "no-store" });
      const payload = await response.json() as { roles?: CustomRole[]; canManage?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить роли.");
      if (version !== sequence.current) return;
      const nextRoles = (payload.roles ?? []).map(role => ({ ...role, permissions: normalizePermissionSet(role.permissions) }));
      setRoles(nextRoles);
      setServerCanManage(Boolean(payload.canManage));
      if (!initial) showRole(nextRoles.find(role => role.id === selected?.id) ?? superadmin);
    } catch (failure) {
      if (version !== sequence.current) return;
      setServerCanManage(false);
      setError(failure instanceof Error ? failure.message : "Не удалось загрузить роли.");
    } finally { if (version === sequence.current) setLoading(false); }
  }
  useEffect(() => { void load(true); return () => { sequence.current++; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect

  async function mayDiscard() {
    return !changed || await confirm({ title: "Продолжить без сохранения?", description: "Изменения роли ещё не сохранены. При переключении они будут отменены.", confirmLabel: "Продолжить без сохранения", cancelLabel: "Остаться" });
  }
  async function selectRole(role: CustomRole | null) {
    if (busy.current || loading || role?.id === selected?.id || !role && !canManage) return;
    if (!await mayDiscard()) return;
    showRole(role);
    if (!role) requestAnimationFrame(() => nameInput.current?.focus({ preventScroll: true }));
  }
  async function refresh() {
    if (busy.current || loading || !await mayDiscard()) return;
    await load();
  }
  function patchPermission(resource: PermissionResource, action: PermissionAction, enabled: boolean) {
    if (!editable) return;
    setPermissions(current => {
      const next = normalizePermissionSet(current);
      next[resource][action] = enabled;
      if (action !== "view" && enabled) next[resource].view = true;
      if (action === "view" && !enabled) next[resource] = { view: false, create: false, update: false, delete: false };
      return normalizePermissionSet(next);
    });
    setNotice("");
  }
  async function save() {
    if (!editable || busy.current || !name.trim() || !changed) return;
    busy.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/roles", { method: selected ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(selected ? { roleId: selected.id, revision: selected.revision } : {}), name: name.trim(), permissions }) });
      const payload = await response.json() as { role?: CustomRole; error?: string };
      if (!response.ok || !payload.role) throw new Error(payload.error ?? "Не удалось сохранить роль.");
      sequence.current++;
      const role = payload.role;
      setRoles(current => [...current.filter(item => item.id !== role.id), role].sort((a, b) => a.name.localeCompare(b.name, "ru")));
      showRole(role); setRoleQuery(""); setNotice("Роль сохранена.");
      onRolesChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось сохранить роль."); }
    finally { busy.current = false; setSaving(false); }
  }
  async function remove() {
    if (!editable || !selected || busy.current) return;
    const role = selected;
    if (!await confirm({ title: `Удалить роль «${role.name}»?`, description: "Удалить можно только роль, которая не назначена пользователям.", confirmLabel: "Удалить роль" })) return;
    busy.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/roles", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roleId: role.id, revision: role.revision }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось удалить роль.");
      sequence.current++;
      setRoles(current => current.filter(item => item.id !== role.id));
      showRole(superadmin); setNotice(`Роль «${role.name}» удалена.`);
      onRolesChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось удалить роль."); }
    finally { busy.current = false; setSaving(false); }
  }

  return <section className="roles-workspace" aria-label="Роли и права">
    <aside className="roles-sidebar">
      <header><div><h2>Роли</h2><span>{roles.length + 1}</span></div><button type="button" className="roles-refresh" onClick={() => void refresh()} disabled={loading || saving} aria-label="Обновить роли" title="Обновить роли">↻</button></header>
      <label className="roles-search"><span className="sr-only">Найти роль</span><input type="search" placeholder="Найти роль…" value={roleQuery} onChange={event => setRoleQuery(event.target.value)} /></label>
      <div className="roles-sidebar-list" aria-label="Список ролей">
        {visibleRoles.map(role => <button type="button" key={role.id} className={`roles-sidebar-item${role.id === selected?.id ? " selected" : ""}`} aria-pressed={role.id === selected?.id} onClick={() => void selectRole(role)} disabled={loading || saving}><span className="roles-item-icon" aria-hidden="true">{role.id === -1 ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6Z"/><path d="m8 12 3 3 5-6"/></svg> : role.name.slice(0, 1).toLocaleUpperCase("ru-RU")}</span><span><strong>{role.name}</strong><small>{role.id === -1 ? "Системная роль" : `Доступно разделов: ${Object.values(role.permissions).filter(row => row.view).length}`}</small></span></button>)}
        {!loading && !visibleRoles.length && <p className="roles-no-results">Роли не найдены</p>}
        {loading && <p className="roles-no-results" role="status">Загружаем роли…</p>}
      </div>
      {canManage && <footer><button type="button" className="primary-button" disabled={loading || saving || !selected} onClick={() => void selectRole(null)}>＋ Создать роль</button></footer>}
    </aside>
    <form className="roles-permissions-panel" onSubmit={event => { event.preventDefault(); void save(); }}>
      <header className="roles-panel-heading"><div><span>Права доступа</span><h2>{selected?.name ?? "Новая роль"}</h2></div>{protectedRole ? <span className="roles-system-badge">Системная</span> : !canManage && <span className="roles-system-badge">Только просмотр</span>}</header>
      {error && <div className="roles-message error" role="alert">{error}</div>}
      {notice && <div className="roles-message success" role="status">{notice}</div>}
      {protectedRole ? <p className="roles-protected-note"><span aria-hidden="true">◆</span>Полный доступ ко всем разделам. Эту роль нельзя изменить или удалить.</p> : <div className="roles-name-row"><label><span>Название роли</span><input ref={nameInput} value={name} onChange={event => { setName(event.target.value); setNotice(""); }} maxLength={80} required disabled={!editable} placeholder="Например, Руководитель проекта" /></label>{selected && canManage && <button type="button" className="roles-delete" onClick={() => void remove()} disabled={!editable}>Удалить роль</button>}</div>}
      <div className="roles-matrix-toolbar"><label><span className="sr-only">Найти раздел прав</span><input type="search" value={resourceQuery} onChange={event => setResourceQuery(event.target.value)} placeholder="Найти раздел системы…" /></label>{!protectedRole && canManage && <button type="button" disabled={!editable} onClick={() => { setPermissions(current => Object.fromEntries(Object.entries(current).map(([key, row]) => [key, { ...row, create: false, update: false, delete: false }])) as PermissionSet); setNotice(""); }}>Только просмотр</button>}</div>
      <div className="roles-matrix-scroll"><PermissionMatrix compact label={selected ? `Права роли: ${selected.name}` : "Права новой роли"} value={permissions} disabled={!editable} onChange={editable ? patchPermission : undefined} search={resourceQuery} /></div>
      <footer className="roles-panel-footer"><span>{protectedRole ? "Защищённая роль" : changed ? "Есть несохранённые изменения" : selected ? "Изменения сохранены" : "Укажите название и выберите права"}</span>{!protectedRole && canManage && <div><button type="button" className="back-button" disabled={saving || !changed && Boolean(selected)} onClick={() => { if (selected) { setName(selected.name); setPermissions(normalizePermissionSet(selected.permissions)); setError(""); } else void selectRole(superadmin); }}>{selected ? "Сбросить изменения" : "Отмена"}</button><button type="submit" className="primary-button" disabled={!editable || !name.trim() || !changed}>{saving ? "Сохраняем…" : selected ? "Сохранить изменения" : "Создать роль"}</button></div>}</footer>
    </form>
    {dialog}
  </section>;
}
