"use client";

import { useEffect, useMemo, useState } from "react";
import { CustomSelect } from "./CustomSelect";
import { ROLE_LABELS, type UserRole } from "./roles";

type AccessOption = { id: number; name: string };
type AccessUser = { id: number; fullName: string; email: string; role: UserRole; assignedSiteId: number | null; status?: "active" | "invited" };
type AccessUserDraft = { key: string; id?: number; fullName: string; email: string; role: UserRole; assignedSiteId: string };

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
};

function normalize(value: string) {
  return value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "НП").toLocaleUpperCase("ru-RU");
}

function UserEditorDialog({ drafts, sites, saving, onPatch, onCancel, onSave }: { drafts: AccessUserDraft[]; sites: AccessOption[]; saving: boolean; onPatch: (key: string, changes: Partial<AccessUserDraft>) => void; onCancel: () => void; onSave: () => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const safeActiveIndex = Math.min(activeIndex, drafts.length - 1);
  const draft = drafts[safeActiveIndex] ?? drafts[0];
  const editing = Boolean(draft.id);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onCancel(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, saving]);

  return <div className="user-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <form className="user-create-dialog" role="dialog" aria-modal="true" aria-labelledby="user-editor-title" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
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
            <label className="user-create-field"><span>ФИО</span><input value={draft.fullName} placeholder="Например, Иванов Иван Иванович" onChange={(event) => onPatch(draft.key, { fullName: event.target.value })} /></label>
            <label className="user-create-field"><span>Рабочий email</span><input type="email" value={draft.email} placeholder="ivanov@company.ru" onChange={(event) => onPatch(draft.key, { email: event.target.value })} /></label>
          </div>
        </section>

        <section className="user-create-section">
          <div className="user-create-section-heading"><span>2</span><div><h3>Роль и доступ</h3><p>Выберите, какие разделы и проекты будут доступны пользователю.</p></div></div>
          <div className="user-create-role-options" role="radiogroup" aria-label="Роль пользователя">
            <button type="button" role="radio" aria-checked={draft.role === "foreman"} className={draft.role === "foreman" ? "selected" : ""} onClick={() => onPatch(draft.key, { role: "foreman" })}><span className="user-create-role-icon" aria-hidden="true">П</span><span><strong>Прораб</strong><small>Доступ только к выбранному проекту</small></span><i aria-hidden="true">✓</i></button>
            <button type="button" role="radio" aria-checked={draft.role === "engineer"} className={draft.role === "engineer" ? "selected" : ""} onClick={() => onPatch(draft.key, { role: "engineer", assignedSiteId: "" })}><span className="user-create-role-icon engineer" aria-hidden="true">И</span><span><strong>Инженер</strong><small>Отчёты, сотрудники и настройки проектов</small></span><i aria-hidden="true">✓</i></button>
            <button type="button" role="radio" aria-checked={draft.role === "superadmin"} className={draft.role === "superadmin" ? "selected" : ""} onClick={() => onPatch(draft.key, { role: "superadmin", assignedSiteId: "" })}><span className="user-create-role-icon superadmin" aria-hidden="true">С</span><span><strong>Супер-админ</strong><small>Полный доступ ко всей системе</small></span><i aria-hidden="true">✓</i></button>
          </div>
          <div className="user-create-access-field">
            <span>{draft.role === "foreman" ? "Доступный проект" : "Уровень доступа"}</span>
            {draft.role !== "foreman"
              ? <div className="user-create-all-projects"><span aria-hidden="true">✓</span><div><strong>{draft.role === "superadmin" ? "Полный доступ" : "Рабочий доступ"}</strong><small>{draft.role === "superadmin" ? "Все проекты и глобальные настройки" : "Все проекты, сотрудники и настройки проектов"}</small></div></div>
              : <CustomSelect value={draft.assignedSiteId} ariaLabel={editing ? "Проект пользователя" : "Проект нового пользователя"} onChange={(assignedSiteId) => onPatch(draft.key, { assignedSiteId })} options={[{ value: "", label: "Выберите проект" }, ...sites.map((site) => ({ value: String(site.id), label: site.name }))]} />}
          </div>
        </section>
      </div>

      <footer className="user-create-actions">
        <p><span aria-hidden="true">i</span>{editing ? drafts.length > 1 ? `Изменения будут сохранены для ${drafts.length} пользователей.` : "Изменения доступа вступят в силу после сохранения." : "После сохранения будет создано приглашение для входа."}</p>
        <div><button type="button" className="user-create-cancel" onClick={onCancel} disabled={saving}>Отмена</button><button type="submit" className="user-create-submit" disabled={saving}>{saving ? "Сохраняем…" : editing ? drafts.length > 1 ? `Сохранить всех (${drafts.length})` : "Сохранить изменения" : "Создать пользователя"}</button></div>
      </footer>
    </form>
  </div>;
}

export function UserAccessCards({ rows, drafts, sites, selectedIds, onEdit, onSelectionChange, onPatchDraft, onCancelEditing, onSave, saving, readOnly = false }: UserAccessCardsProps) {
  const [query, setQuery] = useState("");
  const editorOpen = drafts.length > 0;
  const search = normalize(query);
  const visibleRows = useMemo(() => rows.filter((user) => !search || normalize(`${user.fullName} ${user.email} ${ROLE_LABELS[user.role]} ${sites.find((site) => site.id === user.assignedSiteId)?.name ?? ""}`).includes(search)), [rows, search, sites]);
  const activeCount = rows.filter((user) => user.status === "active").length;
  const invitedCount = rows.length - activeCount;
  const adminCount = rows.filter((user) => user.role === "superadmin").length;

  function toggleUser(id: number) {
    if (readOnly || editorOpen) return;
    onSelectionChange(selectedIds.includes(id) ? selectedIds.filter((selectedId) => selectedId !== id) : [...selectedIds, id]);
  }

  return <section className="user-access-shell" aria-label="Управление пользователями и правами">
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
        const siteName = sites.find((site) => site.id === user.assignedSiteId)?.name ?? "Проект не назначен";
        const scopeTitle = user.role === "foreman" ? "Проектный доступ" : user.role === "engineer" ? "Рабочий доступ" : "Полный доступ";
        const scopeText = user.role === "foreman" ? siteName : user.role === "engineer" ? "Все проекты, сотрудники и настройки проектов" : "Все проекты и глобальные настройки";
        return <article className={`${selected ? "user-access-card selected" : "user-access-card"}${readOnly ? " read-only" : ""}`} key={user.id} onDoubleClick={(event) => { if (!readOnly && !editorOpen && !(event.target as Element).closest("button,input")) onEdit(user); }}>
          <div className="user-access-identity">
            <span className="user-access-avatar" aria-hidden="true">{initials(user.fullName)}</span>
            <div><div className="user-access-name-line"><h2>{user.fullName}</h2><span className={user.status === "active" ? "user-status active" : "user-status invited"}>{user.status === "active" ? "Активен" : "Приглашён"}</span></div><a href={`mailto:${user.email}`}>{user.email}</a></div>
          </div>
          <div className="user-access-scope">
            <span className={`user-role ${user.role}`}>{ROLE_LABELS[user.role]}</span>
            <div><strong>{scopeTitle}</strong><span>{scopeText}</span></div>
          </div>
          {!readOnly && <div className="user-access-card-actions">
            <button type="button" className="user-access-configure" onClick={() => onEdit(user)} disabled={editorOpen}>Настроить доступ</button>
            <label className="user-access-select"><input type="checkbox" checked={selected} disabled={editorOpen} onChange={() => toggleUser(user.id)} aria-label={`Выбрать пользователя ${user.fullName}`} /><span aria-hidden="true">✓</span></label>
          </div>}
        </article>;
      })}
      {!drafts.length && !visibleRows.length && <div className="user-access-empty"><strong>Пользователи не найдены</strong><span>Попробуйте изменить поисковый запрос.</span></div>}
    </div>
    {!readOnly && drafts.length > 0 && <UserEditorDialog drafts={drafts} sites={sites} saving={saving} onPatch={onPatchDraft} onCancel={onCancelEditing} onSave={onSave} />}
  </section>;
}
