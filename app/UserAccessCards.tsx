"use client";

import { useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";
import { ProjectAccessPicker } from "./ProjectAccessPicker";
import { type ProjectAccess, type UserRole } from "./roles";
import { customUserRoleChanges, userDraftProjectAccess, userProjectAccessValid, userProjectLabel, userRoleChanges, userRoleLabel } from "./userAccessModel";
import type { CustomRole } from "./customRoles";
import "./customRoles.css";

type AccessOption = { id: number; name: string };
type AccessUser = { id: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: number | null; projectAccess?: ProjectAccess; projectAccessLimitedToViewer?: boolean; canViewPendingReports?: boolean; status?: "active" | "invited" };
type AccessUserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: string; projectAccess?: ProjectAccess; canViewPendingReports?: boolean };

type UserAccessCardsProps = {
  rows: AccessUser[];
  drafts: AccessUserDraft[];
  sites: AccessOption[];
  selectedIds: number[];
  onEdit: (user: AccessUser) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<AccessUserDraft>) => void;
  onCancelEditing: () => void;
  onSave: () => void;
  saving: boolean;
  readOnly?: boolean;
  canCreate?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
};

function normalize(value: string) {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "НП").toLocaleUpperCase("ru-RU");
}

function UserEditorDialog({ drafts, sites, saving, onPatch, onCancel, onSave, roles, rolesLoading, rolesError, onRetryRoles }: { drafts: AccessUserDraft[]; sites: AccessOption[]; saving: boolean; onPatch: (key: string, changes: Partial<AccessUserDraft>) => void; onCancel: () => void; onSave: () => void; roles: CustomRole[]; rolesLoading: boolean; rolesError: string; onRetryRoles: () => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const safeActiveIndex = Math.min(activeIndex, drafts.length - 1);
  const draft = drafts[safeActiveIndex] ?? drafts[0];
  const editing = Boolean(draft.id);
  const invalidProjectIndex = drafts.findIndex(item => !userProjectAccessValid(userDraftProjectAccess(item), sites, Boolean(item.id)));
  const activeProjectInvalid = !userProjectAccessValid(userDraftProjectAccess(draft), sites, Boolean(draft.id));
  const invalidProjectUser = invalidProjectIndex >= 0 ? drafts[invalidProjectIndex] : undefined;
  const roleOptions = [{ value: "", label: "Выберите роль", disabled: true }, ...roles.map(role => ({ value: String(role.id), label: role.name, disabled: false }))];
  if (draft.customRoleId && !roles.some(role => role.id === draft.customRoleId)) roleOptions.push({ value: String(draft.customRoleId), label: draft.customRoleName || "Текущая роль пользователя", disabled: true });
  const selectBuiltinRole = (role: UserRole) => onPatch(draft.key, { ...userRoleChanges(role, draft.assignedSiteId, draft.projectAccess), customRoleId: null, customRoleName: null });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !saving) onCancel(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, saving]);

  return <div className="user-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <form className="user-create-dialog" role="dialog" aria-modal="true" aria-labelledby="user-editor-title" onSubmit={(event) => { event.preventDefault(); if (invalidProjectIndex >= 0) { setActiveIndex(invalidProjectIndex); return; } onSave(); }}>
      <header className="user-create-heading">
        <span className="user-create-icon" aria-hidden="true">{editing ? <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M3 20c0-3.4 2.7-6 6-6 1.7 0 3.2.6 4.3 1.7M15.5 17.5 20 13l1 1-4.5 4.5-2 .5.5-2Z"/></svg> : <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M3 20c0-3.4 2.7-6 6-6 1.7 0 3.2.6 4.3 1.7M18 8v6M15 11h6"/></svg>}</span>
        <div><h2 id="user-editor-title">{editing ? "Редактирование пользователя" : "Новый пользователь"}</h2><p>{editing ? "Обновите личные данные, роль или доступ к проектам." : "Добавьте сотрудника и настройте его доступ к системе."}</p></div>
        <button type="button" className="user-create-close" aria-label={editing ? "Закрыть редактирование пользователя" : "Закрыть окно добавления пользователя"} onClick={onCancel} disabled={saving}>×</button>
      </header>

      <div className="user-create-content">
        {drafts.length > 1 && <div className="user-editor-pagination"><div><span>Пользователь {safeActiveIndex + 1} из {drafts.length}</span><strong>{draft.fullName || "Без имени"}</strong></div><nav aria-label="Переключение редактируемых пользователей"><button type="button" aria-label="Предыдущий пользователь" disabled={safeActiveIndex === 0} onClick={() => setActiveIndex(Math.max(0, safeActiveIndex - 1))}>‹</button><button type="button" aria-label="Следующий пользователь" disabled={safeActiveIndex === drafts.length - 1} onClick={() => setActiveIndex(Math.min(drafts.length - 1, safeActiveIndex + 1))}>›</button></nav></div>}
        <section className="user-create-section">
          <div className="user-create-section-heading"><span>1</span><div><h3>Личные данные</h3><p>{editing ? "Имя отображается в системе, email используется для входа." : "Имя будет отображаться в системе, а на email придёт приглашение."}</p></div></div>
          <div className="user-create-personal-fields">
            <label className="user-create-field"><span>ФИО</span><input required value={draft.fullName} placeholder="Например, Иванов Иван Иванович" onChange={(event) => onPatch(draft.key, { fullName: event.target.value })} /></label>
            <label className="user-create-field"><span>Рабочий email</span><input required type="email" value={draft.email} placeholder="ivanov@company.ru" onChange={(event) => onPatch(draft.key, { email: event.target.value })} /></label>
          </div>
        </section>

        <section className="user-create-section">
          <div className="user-create-section-heading"><span>2</span><div><h3>Роль и доступ</h3><p>Выберите, какие разделы и проекты будут доступны пользователю.</p></div></div>
          <div className="user-create-role-options" role="radiogroup" aria-label="Роль пользователя">
            <button type="button" role="radio" disabled={saving} aria-checked={!draft.customRoleId && draft.role === "foreman"} className={!draft.customRoleId && draft.role === "foreman" ? "selected" : ""} onClick={() => selectBuiltinRole("foreman")}><span className="user-create-role-icon" aria-hidden="true">П</span><span><strong>Прораб</strong><small>Свои отчёты в доступных проектах</small></span><i aria-hidden="true">✓</i></button>
            <button type="button" role="radio" disabled={saving} aria-checked={!draft.customRoleId && draft.role === "engineer"} className={!draft.customRoleId && draft.role === "engineer" ? "selected" : ""} onClick={() => selectBuiltinRole("engineer")}><span className="user-create-role-icon engineer" aria-hidden="true">И</span><span><strong>Инженер</strong><small>Отчёты, табели и настройки доступных проектов</small></span><i aria-hidden="true">✓</i></button>
            <button type="button" role="radio" disabled={saving} aria-checked={!draft.customRoleId && draft.role === "viewer"} className={!draft.customRoleId && draft.role === "viewer" ? "selected" : ""} onClick={() => { if (draft.role !== "viewer" || draft.customRoleId) selectBuiltinRole("viewer"); }}><span className="user-create-role-icon viewer" aria-hidden="true">П</span><span><strong>Просмотр</strong><small>Чтение данных и экспорт Excel</small></span><i aria-hidden="true">✓</i></button>
            <button type="button" role="radio" disabled={saving} aria-checked={!draft.customRoleId && draft.role === "superadmin"} className={!draft.customRoleId && draft.role === "superadmin" ? "selected" : ""} onClick={() => selectBuiltinRole("superadmin")}><span className="user-create-role-icon superadmin" aria-hidden="true">С</span><span><strong>Супер-админ</strong><small>Полный доступ ко всей системе</small></span><i aria-hidden="true">✓</i></button>
          </div>
          <div className="user-custom-role-field"><span>Дополнительная роль</span><CustomSelect searchable value={draft.customRoleId ? String(draft.customRoleId) : ""} options={roleOptions} ariaLabel="Дополнительная роль пользователя" disabled={saving || rolesLoading || roles.length === 0} onChange={value => { const role = roles.find(item => String(item.id) === value); if (role && role.id !== draft.customRoleId) onPatch(draft.key, customUserRoleChanges(role, draft.projectAccess)); }} />
            {rolesLoading ? <p role="status">Загружаем роли…</p> : rolesError ? <p className="user-custom-role-error" role="alert">{rolesError}<button type="button" disabled={saving} onClick={onRetryRoles}>Повторить</button></p> : <p>Новые роли добавляются в разделе «Права доступа».</p>}
          </div>
          <div className={`user-create-access-field${activeProjectInvalid ? " invalid" : ""}`}>
            <span>Доступ к проектам</span>
            <ProjectAccessPicker value={userDraftProjectAccess(draft)} sites={sites} disabled={saving || draft.role === "superadmin"} onChange={projectAccess => onPatch(draft.key, { projectAccess, assignedSiteId: projectAccess.mode === "selected" ? String(projectAccess.siteIds[0] ?? "") : "" })} />
            {activeProjectInvalid && <p className="user-create-project-error" role="alert">Выберите хотя бы один доступный проект или разрешите все проекты.</p>}
            {draft.role === "viewer" && <label className="access-pending-toggle" aria-label="Показывать черновики и отчёты на проверке"><input type="checkbox" checked={Boolean(draft.canViewPendingReports)} disabled={saving} onChange={event => onPatch(draft.key, { canViewPendingReports: event.target.checked })} /><span><strong>Показывать черновики и отчёты на проверке</strong><small>По умолчанию доступны подтверждённые отчёты и табели. Изменение данных всегда запрещено.</small></span></label>}
          </div>
        </section>
      </div>

      <footer className="user-create-actions">
        <p className={invalidProjectUser ? "user-create-save-error" : undefined} role={invalidProjectUser ? "alert" : undefined}><span aria-hidden="true">{invalidProjectUser ? "!" : "i"}</span>{invalidProjectUser ? drafts.length > 1 ? `Выберите проект: пользователь ${invalidProjectIndex + 1} из ${drafts.length} — ${invalidProjectUser.fullName || "Без имени"}.` : "Для сохранения нужно выбрать проект." : editing ? drafts.length > 1 ? `Изменения будут сохранены для ${drafts.length} пользователей.` : "Изменения доступа вступят в силу после сохранения." : "После сохранения будет создано приглашение для входа."}{invalidProjectUser && invalidProjectIndex !== safeActiveIndex && <button type="button" className="user-create-invalid-jump" disabled={saving} onClick={() => setActiveIndex(invalidProjectIndex)}>Показать</button>}</p>
        <div><button type="button" className="user-create-cancel" onClick={onCancel} disabled={saving}>Отмена</button><button type="submit" className="user-create-submit" disabled={saving || invalidProjectIndex >= 0}>{saving ? "Сохраняем…" : editing ? drafts.length > 1 ? `Сохранить всех (${drafts.length})` : "Сохранить изменения" : "Создать пользователя"}</button></div>
      </footer>
    </form>
  </div>;
}

export function UserAccessCards({ rows, drafts, sites, selectedIds, onEdit, onSelectionChange, onPatchDraft, onCancelEditing, onSave, saving, readOnly = false, canCreate, canUpdate, canDelete }: UserAccessCardsProps) {
  const [query, setQuery] = useState("");
  const editorOpen = drafts.length > 0;
  const mayCreate = canCreate ?? !readOnly;
  const mayUpdate = canUpdate ?? !readOnly;
  const mayDelete = canDelete ?? !readOnly;
  const locked = !mayUpdate && !mayDelete;
  const mayShowEditor = drafts.some((draft) => Boolean(draft.id)) ? mayUpdate : mayCreate;
  const search = normalize(query);
  const visibleRows = useMemo(() => rows.filter((user) => !search || normalize(`${user.fullName} ${user.email} ${userRoleLabel(user)} ${sites.find((site) => site.id === user.assignedSiteId)?.name ?? ""}`).includes(search)), [rows, search, sites]);
  const activeCount = rows.filter((user) => user.status === "active").length;
  const invitedCount = rows.length - activeCount;
  const adminCount = rows.filter((user) => user.role === "superadmin").length;
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesError, setRolesError] = useState("");
  const [rolesReload, setRolesReload] = useState(0);
  const mayLoadRoles = mayCreate || mayUpdate;

  useEffect(() => {
    if (!mayLoadRoles) return;
    let active = true;
    const controller = new AbortController();
    // A fresh request starts whenever the editor opens; keep the last loaded choices meanwhile.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRolesLoading(true);
    setRolesError("");
    void fetch("/api/roles", { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json() as { roles?: CustomRole[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить роли.");
      if (active) setRoles(payload.roles ?? []);
    }).catch(loadError => { if (active) setRolesError(loadError instanceof Error ? loadError.message : "Не удалось загрузить роли."); }).finally(() => { if (active) setRolesLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [mayLoadRoles, editorOpen, rolesReload]);

  function toggleUser(id: number) {
    if (!mayDelete || editorOpen) return;
    onSelectionChange(selectedIds.includes(id) ? selectedIds.filter((selectedId) => selectedId !== id) : [...selectedIds, id]);
  }

  return <section className="user-access-shell" aria-label="Пользователи системы">
    <div className="user-access-overview">
      <div className="user-access-stats" aria-label="Сводка по пользователям">
        <div><strong>{rows.length}</strong><span>пользователей</span></div>
        <div><strong>{activeCount}</strong><span>активны</span></div>
        <div><strong>{invitedCount}</strong><span>ожидают входа</span></div>
        <div><strong>{adminCount}</strong><span>супер-админы</span></div>
      </div>
      <label className="user-access-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти пользователя…" aria-label="Найти пользователя" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить поиск">×</button>}</label>
    </div>

    <div className="user-access-list">
      {visibleRows.map((user) => {
        const selected = selectedIds.includes(user.id);
        const scopeTitle = user.projectAccessLimitedToViewer ? "Проекты в пределах вашего доступа" : user.role === "superadmin" ? "Полный доступ" : user.role === "viewer" ? "Только просмотр" : "Рабочий доступ";
        const scopeText = user.role === "superadmin" && !user.projectAccessLimitedToViewer ? "Все проекты и глобальные настройки" : userProjectLabel(user.role, user.assignedSiteId, sites, user.projectAccess, user.projectAccessLimitedToViewer);
        return <article className={`${selected ? "user-access-card selected" : "user-access-card"}${locked ? " read-only" : ""}`} key={user.id} onDoubleClick={(event) => { if (mayUpdate && !editorOpen && !(event.target as Element).closest("button,input")) onEdit(user); }}>
          <div className="user-access-identity">
            <span className="user-access-avatar" aria-hidden="true">{initials(user.fullName)}</span>
            <div><div className="user-access-name-line"><h2>{user.fullName}</h2><span className={user.status === "active" ? "user-status active" : "user-status invited"}>{user.status === "active" ? "Активен" : "Приглашён"}</span></div><a href={`mailto:${user.email}`}>{user.email}</a></div>
          </div>
          <div className="user-access-scope">
            <span className={`user-role ${user.role}${user.customRoleId ? " custom" : ""}`}>{userRoleLabel(user)}</span>
            <div><strong>{scopeTitle}</strong><span>{scopeText}</span></div>
          </div>
          {(mayUpdate || mayDelete) && <div className="user-access-card-actions">
            {mayUpdate && <button type="button" className="user-access-configure" onClick={() => onEdit(user)} disabled={editorOpen}>Редактировать</button>}
            {mayDelete && <label className="user-access-select"><input type="checkbox" checked={selected} disabled={editorOpen} onChange={() => toggleUser(user.id)} aria-label={`Выбрать пользователя ${user.fullName}`} /><span aria-hidden="true">✓</span></label>}
          </div>}
        </article>;
      })}
      {!drafts.length && !visibleRows.length && <div className="user-access-empty"><strong>Пользователи не найдены</strong><span>Попробуйте изменить поисковый запрос.</span></div>}
    </div>
    {mayShowEditor && drafts.length > 0 && <UserEditorDialog drafts={drafts} sites={sites} saving={saving} onPatch={onPatchDraft} onCancel={onCancelEditing} onSave={onSave} roles={roles} rolesLoading={rolesLoading} rolesError={rolesError} onRetryRoles={() => setRolesReload(current => current + 1)} />}
  </section>;
}
