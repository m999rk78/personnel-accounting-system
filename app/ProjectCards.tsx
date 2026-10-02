"use client";

import { useEffect, useMemo, useState } from "react";
import type { UserRole } from "./roles";

type Project = { id: number; name: string; code: string; timezone: string };
type ProjectDraft = { key: string; id?: number; name: string; code: string; timezone: string };
type ProjectEmployee = { siteId: number | null };
type ProjectUser = { role: UserRole; assignedSiteId: number | null };

type ProjectCardsProps = {
  rows: Project[];
  drafts: ProjectDraft[];
  employees: ProjectEmployee[];
  users: ProjectUser[];
  currentSiteId: number;
  selectedIds: number[];
  onEdit: (project: Project) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<ProjectDraft>) => void;
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

function projectMark(value: string) {
  const parts = value.replace(/[—–-]/g, " ").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "ПР").toLocaleUpperCase("ru-RU");
}

function ProjectEditorDialog({ drafts, saving, onPatch, onCancel, onSave }: { drafts: ProjectDraft[]; saving: boolean; onPatch: (key: string, changes: Partial<ProjectDraft>) => void; onCancel: () => void; onSave: () => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const safeActiveIndex = Math.min(activeIndex, drafts.length - 1);
  const draft = drafts[safeActiveIndex] ?? drafts[0];
  const editing = Boolean(draft.id);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onCancel(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, saving]);

  return <div className="project-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel(); }}>
    <form className="project-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="project-editor-title" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <header className="project-editor-dialog-heading">
        <span className="project-editor-dialog-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h2v2H9zM13 9h2v2h-2zM9 14h2v2H9zM13 14h2v2h-2zM10 21v-3h4v3"/></svg></span>
        <div><h2 id="project-editor-title">{editing ? "Редактирование проекта" : "Новый проект"}</h2><p>{editing ? "Измените название объекта — оно обновится во всех разделах системы." : "Создайте объект, чтобы назначать сотрудников и формировать отчёты."}</p></div>
        <button type="button" className="project-editor-close" aria-label={editing ? "Закрыть редактирование проекта" : "Закрыть добавление проекта"} onClick={onCancel} disabled={saving}>×</button>
      </header>

      <div className="project-editor-dialog-content">
        {drafts.length > 1 && <div className="project-editor-pagination"><div><span>Проект {safeActiveIndex + 1} из {drafts.length}</span><strong>{draft.name || "Без названия"}</strong></div><nav aria-label="Переключение редактируемых проектов"><button type="button" aria-label="Предыдущий проект" disabled={safeActiveIndex === 0} onClick={() => setActiveIndex(Math.max(0, safeActiveIndex - 1))}>‹</button><button type="button" aria-label="Следующий проект" disabled={safeActiveIndex === drafts.length - 1} onClick={() => setActiveIndex(Math.min(drafts.length - 1, safeActiveIndex + 1))}>›</button></nav></div>}

        <section className="project-editor-section">
          <label className="project-editor-name-field"><span>Название проекта</span><input value={draft.name} placeholder="Например, ГПЗ — Установка 3" onChange={(event) => onPatch(draft.key, { name: event.target.value })} /></label>
        </section>

      </div>

      <footer className="project-editor-dialog-actions">
        <p><span aria-hidden="true">i</span>{editing ? drafts.length > 1 ? `Изменения будут сохранены для ${drafts.length} проектов.` : "Связанные сотрудники и отчёты сохранятся без изменений." : "После создания проект появится в общем списке объектов."}</p>
        <div><button type="button" className="project-editor-cancel" onClick={onCancel} disabled={saving}>Отмена</button><button type="submit" className="project-editor-submit" disabled={saving}>{saving ? "Сохраняем…" : editing ? drafts.length > 1 ? `Сохранить все (${drafts.length})` : "Сохранить изменения" : "Создать проект"}</button></div>
      </footer>
    </form>
  </div>;
}

export function ProjectCards({ rows, drafts, employees, users, currentSiteId, selectedIds, onEdit, onSelectionChange, onPatchDraft, onCancelEditing, onSave, saving, readOnly = false, canCreate, canUpdate, canDelete }: ProjectCardsProps) {
  const [query, setQuery] = useState("");
  const editorOpen = drafts.length > 0;
  const mayCreate = canCreate ?? !readOnly;
  const mayUpdate = canUpdate ?? !readOnly;
  const mayDelete = canDelete ?? !readOnly;
  const locked = !mayUpdate && !mayDelete;
  const mayShowEditor = drafts.some((draft) => Boolean(draft.id)) ? mayUpdate : mayCreate;
  const search = normalize(query);
  const employeeCounts = useMemo(() => {
    const counts = new Map<number, number>();
    employees.forEach((employee) => { if (employee.siteId) counts.set(employee.siteId, (counts.get(employee.siteId) ?? 0) + 1); });
    return counts;
  }, [employees]);
  const foremanCounts = useMemo(() => {
    const counts = new Map<number, number>();
    users.forEach((user) => { if (user.role === "foreman" && user.assignedSiteId) counts.set(user.assignedSiteId, (counts.get(user.assignedSiteId) ?? 0) + 1); });
    return counts;
  }, [users]);
  const visibleRows = useMemo(() => rows.filter((project) => !search || normalize(project.name).includes(search)), [rows, search]);
  const assignedEmployees = employees.filter((employee) => employee.siteId && rows.some((project) => project.id === employee.siteId)).length;
  const assignedForemen = users.filter((user) => user.role === "foreman" && user.assignedSiteId && rows.some((project) => project.id === user.assignedSiteId)).length;

  function toggleProject(id: number) {
    if (!mayDelete || editorOpen) return;
    onSelectionChange(selectedIds.includes(id) ? selectedIds.filter((selectedId) => selectedId !== id) : [...selectedIds, id]);
  }

  return <section className="project-cards-shell" aria-label="Портфель проектов">
    <div className="project-cards-overview">
      <div className="project-cards-caption"><strong>Объекты компании</strong><span><b>{rows.length}</b> проекта · <b>{assignedEmployees}</b> сотрудников · <b>{assignedForemen}</b> прораба</span></div>
      <label className="project-cards-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти проект…" aria-label="Найти проект" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить поиск">×</button>}</label>
    </div>

    <div className="project-cards-list">
      {visibleRows.map((project) => {
        const selected = selectedIds.includes(project.id);
        const current = project.id === currentSiteId;
        return <article className={`${selected ? "project-card selected" : "project-card"}${locked ? " read-only" : ""}`} key={project.id} onDoubleClick={(event) => { if (mayUpdate && !editorOpen && !(event.target as Element).closest("button,input")) onEdit(project); }}>
          <div className="project-card-heading">
            <span className="project-card-mark" aria-hidden="true">{projectMark(project.name)}</span>
            <div className="project-card-title"><h2>{project.name}</h2>{current && <span>Текущий проект</span>}</div>
          </div>
          <div className="project-card-team">
            <span><strong>{employeeCounts.get(project.id) ?? 0}</strong> сотрудников</span>
            <span><strong>{foremanCounts.get(project.id) ?? 0}</strong> прорабов</span>
          </div>
          {(mayUpdate || mayDelete) && <div className="project-card-actions">
            {mayUpdate && <button type="button" className="project-card-edit" onClick={() => onEdit(project)} disabled={editorOpen}>Изменить проект</button>}
            {mayDelete && <label className="project-card-select"><input type="checkbox" checked={selected} disabled={editorOpen} onChange={() => toggleProject(project.id)} aria-label={`Выбрать проект ${project.name}`} /><span aria-hidden="true">✓</span></label>}
          </div>}
        </article>;
      })}
      {!visibleRows.length && <div className="project-cards-empty"><strong>Проекты не найдены</strong><span>Попробуйте изменить поисковый запрос.</span></div>}
    </div>
    {mayShowEditor && drafts.length > 0 && <ProjectEditorDialog drafts={drafts} saving={saving} onPatch={onPatchDraft} onCancel={onCancelEditing} onSave={onSave} />}
  </section>;
}
