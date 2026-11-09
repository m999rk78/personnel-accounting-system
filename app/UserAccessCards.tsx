"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTableEscapeSelection } from "./useTableEscapeSelection";
import { useNativeTableSelectAll } from "./useNativeTableSelectAll";
import { CustomSelect } from "./CustomSelect";
import { ProjectAccessPicker } from "./ProjectAccessPicker";
import { useTimesheetFilters, type TimesheetFilterColumn } from "./useTimesheetFilters";
import { TimesheetFilterableHeading, TimesheetFiltersProvider } from "./TimesheetColumnFilter";
import { type ProjectAccess, type UserRole } from "./roles";
import { customUserRoleChanges, userDraftProjectAccess, userProjectAccessValid, userProjectLabel, userRoleChanges, userRoleLabel } from "./userAccessModel";
import type { CustomRole } from "./customRoles";
import "./customRoles.css";
import "./usersRights.css";

type AccessOption = { id: number; name: string };
type AccessUser = { id: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: number | null; projectAccess?: ProjectAccess; projectAccessLimitedToViewer?: boolean; canViewPendingReports?: boolean; status?: "active" | "invited" };
type AccessUserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; customRoleId?: number | null; customRoleName?: string | null; assignedSiteId: string; projectAccess?: ProjectAccess; canViewPendingReports?: boolean };
const userFilterColumns: readonly TimesheetFilterColumn<AccessUser>[] = [
  { colId: "fullName", headerName: "ФИО", getValue: user => user.fullName },
  { colId: "roleStatus", headerName: "Роль и статус", getValue: user => `${userRoleLabel(user)} · ${user.status === "active" ? "Активен" : "Приглашён"}` },
];
const userFilterRowId = (user: AccessUser) => String(user.id);
export const USER_TABLE_CLIPBOARD_HEADERS = ["ФИО", "Email", "Роль", "Статус"] as const;

export function userTableClipboardRows(rows: readonly AccessUser[]) {
  return rows.map(user => [user.fullName, user.email, userRoleLabel(user), user.status === "active" ? "Активен" : "Приглашён"]);
}

type UserAccessCardsProps = {
  rows: AccessUser[];
  drafts: AccessUserDraft[];
  sites: AccessOption[];
  selectedIds: number[];
  onEdit: (user: AccessUser) => void;
  onEditRole?: (user: AccessUser) => void;
  roleOnly?: boolean;
  error?: string;
  layout?: "cards" | "list";
  onOpenPermissions?: (userId: number) => void;
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

function UserDetailsDialog({ user, sites, onClose, onEdit, onEditRole, onOpenPermissions }: {
  user: AccessUser; sites: AccessOption[]; onClose: () => void; onEdit?: () => void; onEditRole?: () => void; onOpenPermissions?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = ref.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className="user-detail-dialog" aria-labelledby="user-detail-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="user-detail-heading"><span className="user-access-avatar" aria-hidden="true">{initials(user.fullName)}</span><div><h2 id="user-detail-title">{user.fullName}</h2><p>Пользователь системы</p></div><button type="button" className="user-detail-close" aria-label="Закрыть карточку пользователя" onClick={onClose}>×</button></header>
    <dl className="user-detail-fields">
      <div><dt>Почта</dt><dd><a href={`mailto:${user.email}`}>{user.email}</a></dd></div>
      <div><dt>Роль</dt><dd>{userRoleLabel(user)}</dd></div>
      <div><dt>Проекты</dt><dd>{userProjectLabel(user.role, user.assignedSiteId, sites, user.projectAccess, user.projectAccessLimitedToViewer)}</dd></div>
      <div><dt>Статус</dt><dd>{user.status === "active" ? "Активен" : "Приглашён"}</dd></div>

    </dl>
    <footer className="user-detail-actions">{onOpenPermissions && <button type="button" className="back-button" onClick={onOpenPermissions}>Индивидуальные права</button>}{onEditRole && <button type="button" className="back-button" onClick={onEditRole}>Изменить роль</button>}{onEdit && <button type="button" className="primary-button" onClick={onEdit}>Редактировать</button>}</footer>
  </dialog>;
}

function UserEditorDialog({ drafts, sites, saving, onPatch, onCancel, onSave, roles, rolesLoading, rolesError, onRetryRoles, roleOnly = false, error }: { drafts: AccessUserDraft[]; sites: AccessOption[]; saving: boolean; onPatch: (key: string, changes: Partial<AccessUserDraft>) => void; onCancel: () => void; onSave: () => void; roles: CustomRole[]; rolesLoading: boolean; rolesError: string; onRetryRoles: () => void; roleOnly?: boolean; error?: string }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const safeActiveIndex = Math.min(activeIndex, drafts.length - 1);
  const draft = drafts[safeActiveIndex] ?? drafts[0];
  const editing = Boolean(draft.id);
  const invalidProjectIndex = drafts.findIndex(item => !userProjectAccessValid(userDraftProjectAccess(item), sites, Boolean(item.id)));
  const activeProjectInvalid = !userProjectAccessValid(userDraftProjectAccess(draft), sites, Boolean(draft.id));
  const invalidProjectUser = invalidProjectIndex >= 0 ? drafts[invalidProjectIndex] : undefined;
  const roleOptions = [{ value: "", label: "Выберите роль", disabled: true }, { value: "__superadmin__", label: "Супер-админ", disabled: false }, ...roles.map(role => ({ value: String(role.id), label: role.name, disabled: false }))];
  if (draft.customRoleId && !roles.some(role => role.id === draft.customRoleId)) roleOptions.push({ value: String(draft.customRoleId), label: draft.customRoleName || "Текущая роль пользователя", disabled: true });
  const defaultRole = roles.find(role => role.legacyRoleKey === draft.role);
  const roleValue = draft.customRoleId ? String(draft.customRoleId) : draft.role === "superadmin" ? "__superadmin__" : defaultRole ? String(defaultRole.id) : draft.id ? `__legacy:${draft.role}` : "";
  const roleInvalid = !draft.id && !roleValue;
  if (roleValue.startsWith("__legacy:")) roleOptions.push({ value: roleValue, label: userRoleLabel(draft), disabled: true });
  const selectBuiltinRole = (role: UserRole) => onPatch(draft.key, { ...userRoleChanges(role, draft.assignedSiteId, draft.projectAccess), customRoleId: null, customRoleName: null });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !saving) onCancel(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, saving]);

  return <div className="user-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <form className="user-create-dialog" role="dialog" aria-modal="true" aria-labelledby="user-editor-title" onSubmit={(event) => { event.preventDefault(); if (invalidProjectIndex >= 0) { setActiveIndex(invalidProjectIndex); return; } if (roleInvalid || rolesLoading) return; onSave(); }}>
      <header className="user-create-heading">
        <span className="user-create-icon" aria-hidden="true">{editing ? <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M3 20c0-3.4 2.7-6 6-6 1.7 0 3.2.6 4.3 1.7M15.5 17.5 20 13l1 1-4.5 4.5-2 .5.5-2Z"/></svg> : <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M3 20c0-3.4 2.7-6 6-6 1.7 0 3.2.6 4.3 1.7M18 8v6M15 11h6"/></svg>}</span>
        <div><h2 id="user-editor-title">{editing ? roleOnly ? "Изменить роль пользователя" : "Редактирование пользователя" : "Новый пользователь"}</h2><p>{roleOnly ? draft.fullName : editing ? "Обновите личные данные, роль или доступ к проектам." : "Добавьте сотрудника и настройте его доступ к системе."}</p></div>
        <button type="button" className="user-create-close" aria-label={editing ? "Закрыть редактирование пользователя" : "Закрыть окно добавления пользователя"} onClick={onCancel} disabled={saving}>×</button>
      </header>

      <div className="user-create-content">
        {error && <p className="user-create-project-error" role="alert">{error}</p>}
        {drafts.length > 1 && <div className="user-editor-pagination"><div><span>Пользователь {safeActiveIndex + 1} из {drafts.length}</span><strong>{draft.fullName || "Без имени"}</strong></div><nav aria-label="Переключение редактируемых пользователей"><button type="button" aria-label="Предыдущий пользователь" disabled={safeActiveIndex === 0} onClick={() => setActiveIndex(Math.max(0, safeActiveIndex - 1))}>‹</button><button type="button" aria-label="Следующий пользователь" disabled={safeActiveIndex === drafts.length - 1} onClick={() => setActiveIndex(Math.min(drafts.length - 1, safeActiveIndex + 1))}>›</button></nav></div>}
        {!roleOnly && <section className="user-create-section">
          <div className="user-create-section-heading"><span>1</span><div><h3>Личные данные</h3><p>{editing ? "Имя отображается в системе, email используется для входа." : "Имя будет отображаться в системе, а на email придёт приглашение."}</p></div></div>
          <div className="user-create-personal-fields">
            <label className="user-create-field"><span>ФИО</span><input required value={draft.fullName} placeholder="Например, Иванов Иван Иванович" onChange={(event) => onPatch(draft.key, { fullName: event.target.value })} /></label>
            <label className="user-create-field"><span>Рабочий email</span><input required type="email" value={draft.email} placeholder="ivanov@company.ru" onChange={(event) => onPatch(draft.key, { email: event.target.value })} /></label>
          </div>
        </section>}

        <section className="user-create-section">
          <div className="user-create-section-heading"><span>{roleOnly ? 1 : 2}</span><div><h3>Роль и доступ</h3><p>Выберите, какие разделы и проекты будут доступны пользователю.</p></div></div>
          <div className="user-custom-role-field"><span>Роль</span><CustomSelect searchable value={roleValue} options={roleOptions} ariaLabel="Роль пользователя" disabled={saving || rolesLoading} onChange={value => { if (value === "__superadmin__") { selectBuiltinRole("superadmin"); return; } const role = roles.find(item => String(item.id) === value); if (role && role.id !== draft.customRoleId) onPatch(draft.key, customUserRoleChanges(role, draft.projectAccess)); }} />
            {rolesLoading ? <p role="status">Загружаем роли…</p> : rolesError ? <p className="user-custom-role-error" role="alert">{rolesError}<button type="button" disabled={saving} onClick={onRetryRoles}>Повторить</button></p> : <p>Роли настраиваются на вкладке «Роли и права».</p>}
          </div>
          <div className={`user-create-access-field${activeProjectInvalid ? " invalid" : ""}`}>
            <span>Доступ к проектам</span>
            <ProjectAccessPicker value={userDraftProjectAccess(draft)} sites={sites} disabled={saving || draft.role === "superadmin"} onChange={projectAccess => onPatch(draft.key, { projectAccess, assignedSiteId: projectAccess.mode === "selected" ? String(projectAccess.siteIds[0] ?? "") : "" })} />
            {activeProjectInvalid && <p className="user-create-project-error" role="alert">Выберите хотя бы один доступный проект или разрешите все проекты.</p>}

          </div>
        </section>
      </div>

      <footer className="user-create-actions">
        <p className={invalidProjectUser ? "user-create-save-error" : undefined} role={invalidProjectUser ? "alert" : undefined}><span aria-hidden="true">{invalidProjectUser ? "!" : "i"}</span>{invalidProjectUser ? drafts.length > 1 ? `Выберите проект: пользователь ${invalidProjectIndex + 1} из ${drafts.length} — ${invalidProjectUser.fullName || "Без имени"}.` : "Для сохранения нужно выбрать проект." : editing ? drafts.length > 1 ? `Изменения будут сохранены для ${drafts.length} пользователей.` : "Изменения доступа вступят в силу после сохранения." : "После сохранения будет создано приглашение для входа."}{invalidProjectUser && invalidProjectIndex !== safeActiveIndex && <button type="button" className="user-create-invalid-jump" disabled={saving} onClick={() => setActiveIndex(invalidProjectIndex)}>Показать</button>}</p>
        <div><button type="button" className="user-create-cancel" onClick={onCancel} disabled={saving}>Отмена</button><button type="submit" className="user-create-submit" disabled={saving || rolesLoading || roleInvalid || invalidProjectIndex >= 0}>{saving ? "Сохраняем…" : editing ? drafts.length > 1 ? `Сохранить всех (${drafts.length})` : roleOnly ? "Сохранить роль пользователя" : "Сохранить изменения" : "Создать пользователя"}</button></div>
      </footer>
    </form>
  </div>;
}

export function UserAccessCards({ rows, drafts, sites, selectedIds, onEdit, onEditRole, roleOnly = false, error, layout = "cards", onOpenPermissions, onSelectionChange, onPatchDraft, onCancelEditing, onSave, saving, readOnly = false, canCreate, canUpdate, canDelete }: UserAccessCardsProps) {
  const [query, setQuery] = useState("");
  const [detailUser, setDetailUser] = useState<AccessUser | null>(null);
  const editorOpen = drafts.length > 0;
  useTableEscapeSelection({ hasSelection: () => selectedIds.length > 0, clearSelection: () => onSelectionChange([]), isEditing: () => editorOpen || Boolean(detailUser) || saving });
  const mayCreate = canCreate ?? !readOnly;
  const mayUpdate = canUpdate ?? !readOnly;
  const mayDelete = canDelete ?? !readOnly;
  const locked = !mayUpdate && !mayDelete;
  const mayShowEditor = drafts.some((draft) => Boolean(draft.id)) ? mayUpdate : mayCreate;
  const search = normalize(query);
  const searchedRows = useMemo(() => rows.filter((user) => !search || normalize(`${user.fullName} ${user.email} ${userRoleLabel(user)} ${sites.find((site) => site.id === user.assignedSiteId)?.name ?? ""}`).includes(search)), [rows, search, sites]);
  const filters = useTimesheetFilters({ rows: searchedRows, columns: userFilterColumns, getRowId: userFilterRowId, resetKey: "users-list", presentation: "checklist" });
  const visibleRows = layout === "list" ? filters.rows : searchedRows;
  const clipboardRows = useMemo(() => userTableClipboardRows(visibleRows), [visibleRows]);
  const { ref: selectionRef, className: selectionClass, handlers: selectionHandlers } = useNativeTableSelectAll({ rows: clipboardRows, headers: USER_TABLE_CLIPBOARD_HEADERS, resetKey: layout, enabled: layout === "list" && !editorOpen && !detailUser });
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

  const allSelected = visibleRows.length > 0 && visibleRows.every(user => selectedIds.includes(user.id));
  return <TimesheetFiltersProvider value={filters.context}><section className={`user-access-shell${layout === "list" ? " users-list-shell users-page-scroll-list" : ""}`} aria-label="Пользователи системы">
    {layout === "list" && filters.controller}
    <div className="user-access-overview">
      {layout === "list" ? <div className="users-list-summary"><strong>Пользователи <span className="users-list-count">{rows.length}</span></strong><span>{activeCount} активных · {invitedCount} приглашённых{(search || filters.isActive) && ` · Найдено ${visibleRows.length} из ${rows.length}`}</span></div> : <div className="user-access-stats" aria-label="Сводка по пользователям">
        <div><strong>{rows.length}</strong><span>пользователей</span></div>
        <div><strong>{activeCount}</strong><span>активны</span></div>
        <div><strong>{invitedCount}</strong><span>ожидают входа</span></div>
        <div><strong>{adminCount}</strong><span>супер-админы</span></div>
      </div>}
      {layout === "list" && filters.isActive && <button type="button" className="users-list-filter-reset" onClick={filters.reset}>Сбросить фильтры{filters.activeCount > 0 && <span>{filters.activeCount}</span>}</button>}
      <label className="user-access-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти пользователя…" aria-label="Найти пользователя" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить поиск">×</button>}</label>
    </div>

    {layout === "list" ? <div ref={selectionRef} className={`users-table-wrap ${selectionClass}`} role="grid" aria-label="Данные пользователей" tabIndex={0} {...selectionHandlers}><table className="users-table" aria-label="Список пользователей"><thead><tr>{mayDelete && <th className="users-table-selection"><input type="checkbox" aria-label="Выбрать всех пользователей" checked={allSelected} disabled={editorOpen || !visibleRows.length} ref={element => { if (element) element.indeterminate = !allSelected && visibleRows.some(user => selectedIds.includes(user.id)); }} onChange={() => { const ids = new Set(visibleRows.map(user => user.id)); onSelectionChange(allSelected ? selectedIds.filter(id => !ids.has(id)) : [...new Set([...selectedIds, ...ids])]); }} /></th>}<th scope="col"><TimesheetFilterableHeading columnId="fullName" label="ФИО">ФИО</TimesheetFilterableHeading></th><th scope="col"><TimesheetFilterableHeading columnId="roleStatus" label="Роль и статус">Роль и статус</TimesheetFilterableHeading></th></tr></thead><tbody>{visibleRows.map(user => <tr key={user.id} className={selectedIds.includes(user.id) ? "selected" : ""}>{mayDelete && <td className="users-table-selection"><input type="checkbox" checked={selectedIds.includes(user.id)} disabled={editorOpen} onChange={() => toggleUser(user.id)} aria-label={`Выбрать пользователя ${user.fullName}`} /></td>}<td><button type="button" className="users-table-open" aria-label={`Открыть пользователя ${user.fullName}`} disabled={editorOpen} onClick={() => setDetailUser(user)}><span className="user-access-avatar" aria-hidden="true">{initials(user.fullName)}</span><span className="users-table-identity"><strong>{user.fullName}</strong><small>{user.email}</small></span></button></td><td><span className={`user-role${user.customRoleId ? " custom" : ""}`}>{userRoleLabel(user)}</span><small className="users-table-status"><span className={user.status === "active" ? "is-active" : "is-invited"} aria-hidden="true" />{user.status === "active" ? "Активен" : "Приглашён"}</small></td></tr>)}</tbody></table>{!visibleRows.length && <div className="user-access-empty"><strong>Пользователи не найдены</strong><span>Попробуйте изменить поисковый запрос.</span></div>}</div> : <div className="user-access-list">
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
            {mayUpdate && onEditRole && <button type="button" className="user-access-configure" onClick={() => onEditRole(user)} disabled={editorOpen}>Изменить роль</button>}
            {mayDelete && <label className="user-access-select"><input type="checkbox" checked={selected} disabled={editorOpen} onChange={() => toggleUser(user.id)} aria-label={`Выбрать пользователя ${user.fullName}`} /><span aria-hidden="true">✓</span></label>}
          </div>}
        </article>;
      })}
      {!drafts.length && !visibleRows.length && <div className="user-access-empty"><strong>Пользователи не найдены</strong><span>Попробуйте изменить поисковый запрос.</span></div>}
    </div>}
    {detailUser && !editorOpen && <UserDetailsDialog user={detailUser} sites={sites} onClose={() => setDetailUser(null)} onEdit={mayUpdate ? () => { setDetailUser(null); onEdit(detailUser); } : undefined} onEditRole={mayUpdate && onEditRole ? () => { setDetailUser(null); onEditRole(detailUser); } : undefined} onOpenPermissions={onOpenPermissions ? () => { setDetailUser(null); onOpenPermissions(detailUser.id); } : undefined} />}
    {mayShowEditor && drafts.length > 0 && <UserEditorDialog drafts={drafts} sites={sites} saving={saving} roleOnly={roleOnly} error={error} onPatch={onPatchDraft} onCancel={onCancelEditing} onSave={onSave} roles={roles} rolesLoading={rolesLoading} rolesError={rolesError} onRetryRoles={() => setRolesReload(current => current + 1)} />}
  </section></TimesheetFiltersProvider>;
}
