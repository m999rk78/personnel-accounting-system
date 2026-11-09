"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GridApi } from "ag-grid-community";
import { useWorkspaceTableOrder } from "./TableRowMoves";
import { WorkTypesTable } from "./WorkTypesTable";
import { ExcelActionsMenu } from "./ExcelActionsMenu";
import { downloadExcelFile, excelFileName } from "./excelFiles";
import { WORK_TYPES_EXCEL_HEADERS, WORK_TYPES_EXCEL_SHEET, WORK_TYPES_EXCEL_WIDTHS, workTypesExcelValues, workTypesTemplateRows } from "./workTypesExcel";
import type { WorkTypeOption } from "./workTypeHierarchy";
import { draftHistoryReducer, type DraftHistory, type DraftHistoryAction } from "./personnelSpreadsheet";
import { removeNewWorkTypeDrafts, workTypeDraft, workTypesArchiveSelection, workTypesDraftErrors, workTypesSavePayload, workTypesWorkspace, type WorkTypeDraft, type WorkTypeEdits, type WorkTypeRow } from "./workTypesWorkspace";
import "./workTypesDirectory.css";

type Props = {
  siteId: number; currentUserId?: number; projectName: string; mainWorkTypes: WorkTypeOption[]; subworkTypes: WorkTypeOption[];
  canCreate: boolean; canUpdate: boolean; canDelete: boolean; loading?: boolean; onRefresh: () => Promise<void>; onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  headerActionsTargetId?: string;
};
type Archive = ReturnType<typeof workTypesArchiveSelection>;
const count = (value: number) => new Intl.NumberFormat("ru-RU").format(value);

function ArchiveConfirmation({ archive, busy, error, onClose, onConfirm }: { archive: Archive; busy: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const buttons = [...root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];
        if (buttons.length && event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        else if (buttons.length && !event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [busy, onClose]);
  return createPortal(<div className="confirmation-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={root} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>Архивировать выбранные записи?</h2>
      <p>Видов работ: {count(archive.parentCount)}. Подвидов: {count(archive.childCount)}{archive.parentCount > 0 ? ", включая все подвиды выбранных видов работ" : ""}. Записи исчезнут из справочника, история отчётов сохранится.</p>
      {error && <p role="alert" className="work-types-error">{error}</p>}
      <div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Отмена</button><button type="button" className="delete-rows-button" disabled={busy} onClick={onConfirm}>{busy ? "Архивируем…" : "Архивировать"}</button></div>
    </section>
  </div>, document.body);
}

export function WorkTypesDirectory(props: Props) {
  const rowOrder = useWorkspaceTableOrder();
  const [history, dispatch] = useReducer((state: DraftHistory<WorkTypeEdits>, action: DraftHistoryAction<WorkTypeEdits>) => draftHistoryReducer(state, action), { present: {}, past: [], future: [] });
  const edits = history.present;
  const editsRef = useRef(edits);
  useLayoutEffect(() => { editsRef.current = edits; }, [edits]);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLElement | null>(null);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [validate, setValidate] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const grids = useRef(new Set<GridApi<WorkTypeRow>>());
  const gridScopes = useRef(new Map<GridApi<WorkTypeRow>, string | undefined>());
  const activeEditors = useRef(new Set<GridApi<WorkTypeRow>>());
  const [editing, setEditing] = useState(false);
  const batch = useRef<WorkTypeEdits | null>(null);
  const batchError = useRef("");
  const dirty = Object.keys(edits).length > 0;
  const locked = Boolean(busy || props.loading);
  const headerActionsTargetId = props.headerActionsTargetId;
  useEffect(() => {
    const frame = requestAnimationFrame(() => setHeaderActionsTarget(headerActionsTargetId ? document.getElementById(headerActionsTargetId) : null));
    return () => cancelAnimationFrame(frame);
  }, [headerActionsTargetId]);
  const workspace = useMemo(() => workTypesWorkspace(props.mainWorkTypes, props.subworkTypes, edits), [props.mainWorkTypes, props.subworkTypes, edits]);
  const errors = useMemo(() => validate ? workTypesDraftErrors(props.mainWorkTypes, props.subworkTypes, edits) : {}, [validate, props.mainWorkTypes, props.subworkTypes, edits]);
  useEffect(() => {
    if (!dirty && !editing) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, editing]);
  const onDirtyChange = props.onDirtyChange;
  useEffect(() => { onDirtyChange?.(dirty || editing || busy); }, [onDirtyChange, dirty, editing, busy]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const registerGrid = useCallback((grid: GridApi<WorkTypeRow>, parentKey?: string) => { grids.current.add(grid); gridScopes.current.set(grid, parentKey); return () => { grids.current.delete(grid); gridScopes.current.delete(grid); if (activeEditors.current.delete(grid)) setEditing(activeEditors.current.size > 0); }; }, []);
  const stopEditors = (cancel = false) => { for (const grid of grids.current) if (!grid.isDestroyed()) grid.stopEditing(cancel); };
  const change = useCallback((update: (value: WorkTypeEdits) => WorkTypeEdits) => {
    if (batch.current) { batch.current = update(batch.current); return; }
    const next = update(editsRef.current);
    editsRef.current = next;
    dispatch({ type: "change", update: next });
    setError(""); setNotice("");
  }, []);
  const reset = () => { editsRef.current = {}; dispatch({ type: "reset", value: {} }); setValidate(false); setSelectionVersion(value => value + 1); };
  const editRows = (rows: WorkTypeRow[]) => {
    if (locked || !props.canUpdate || !rows.length) return;
    if (new Set([...Object.keys(editsRef.current), ...rows.map(row => row.key)]).size > 500) { setError("За один раз можно редактировать до 500 записей."); return; }
    change(current => ({ ...current, ...Object.fromEntries(rows.filter(row => !row.unassigned && !current[row.key]).map(row => [row.key, workTypeDraft(row)])) }));
    setSelectionVersion(value => value + 1);
  };
  const patch = (row: WorkTypeRow, changes: Partial<WorkTypeDraft>) => {
    if (locked || row.unassigned || (row.id ? !props.canUpdate : !props.canCreate)) return;
    if (!(batch.current ?? editsRef.current)[row.key] && Object.keys(batch.current ?? editsRef.current).length >= 500) {
      const message = "За один раз можно редактировать до 500 записей. Выберите меньший диапазон.";
      if (batch.current) batchError.current = message;
      setError(message); return;
    }
    change(current => ({ ...current, [row.key]: { ...current[row.key] ?? workTypeDraft(row), ...changes } }));
  };
  const add = (directoryKind: WorkTypeDraft["directoryKind"], parentKey?: string) => {
    if (locked || !props.canCreate) return;
    if (Object.keys(editsRef.current).length >= 500) { setError("Сохраните текущие изменения, прежде чем добавлять новые строки."); return; }
    for (const grid of grids.current) if (!grid.isDestroyed()) grid.setFilterModel(null);
    const key = `new-${directoryKind}-${crypto.randomUUID()}`;
    change(current => ({ ...current, [key]: { key, directoryKind, name: "", ...(directoryKind === "child" ? { parentKey } : {}) } }));
    setQuery("");
  };
  const removeNewRows = (rows: WorkTypeRow[]) => {
    if (locked || !props.canCreate) return;
    const keys = rows.filter(row => !row.unassigned && row.id === undefined).map(row => row.key);
    if (!keys.length) return;
    stopEditors();
    try {
      const result = removeNewWorkTypeDrafts(editsRef.current, keys);
      if (!result.removedKeys.length) return;
      change(() => result.edits);
      setNotice(`Убрано новых строк: ${count(result.removedKeys.length)}. Отменить — Ctrl+Z.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось убрать новые строки."); }
  };
  async function request(payload: unknown) {
    const response = await fetch("/api/work-types", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json() as { error?: string; count?: number };
    if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить изменения.");
    return result;
  }
  async function save() {
    if (busyRef.current || props.loading) return;
    busyRef.current = true;
    stopEditors();
    // Native AG Grid delivers the final edit request before the next frame.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const current = editsRef.current;
    if (!Object.keys(current).length) { busyRef.current = false; return; }
    setValidate(true);
    if (Object.keys(workTypesDraftErrors(props.mainWorkTypes, props.subworkTypes, current)).length) { busyRef.current = false; setError("Проверьте выделенные ячейки: заполните названия, выберите вид работы и устраните повторения."); return; }
    setBusy(true); setError("");
    try {
      await request({ action: "save", siteId: props.siteId, ...workTypesSavePayload(current) });
      reset();
      await props.onRefresh();
      setNotice("Изменения сохранены.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить изменения."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const askArchive = (rows: WorkTypeRow[]) => {
    if (locked || dirty || !props.canDelete) return;
    const selection = workTypesArchiveSelection(rows, props.mainWorkTypes, props.subworkTypes);
    if (!selection.parents.length && !selection.children.length) return;
    if (selection.parents.length + selection.children.length > 5000) { setError("За один раз можно архивировать до 5000 записей. Раскройте группу и выберите часть подвидов."); return; }
    setError(""); setArchive(selection);
  };
  async function archiveRows() {
    if (!archive || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await request({ action: "archive", siteId: props.siteId, parents: archive.parents, children: archive.children });
      setArchive(null); setSelectionVersion(value => value + 1); await props.onRefresh();
      setNotice(`Архивировано записей: ${count(result.count ?? archive.parentCount + archive.childCount)}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось архивировать записи."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function exportExcel(template = false) {
    if (locked || !template && (dirty || editing)) return;
    setError("");
    try {
      const { createTableXlsx } = await import("./placementXlsx");
      const visible = new Map<string | undefined, WorkTypeRow[]>();
      for (const [grid, scope] of gridScopes.current) if (!grid.isDestroyed()) {
        const rows: WorkTypeRow[] = [];
        grid.forEachNodeAfterFilterAndSort(node => { if (node.data && !node.detail) rows.push(node.data); });
        visible.set(scope, rows);
      }
      const orderedParents = visible.get(undefined) ?? (rowOrder ? rowOrder.order(workspace.masters, row => row.unassigned ? undefined : row.key) : workspace.masters);
      const values = template ? workTypesTemplateRows() : workTypesExcelValues(orderedParents, parent => {
        if (visible.has(parent.key)) return visible.get(parent.key)!;
        const children = workspace.details.get(parent.key) ?? [];
        const ordered = rowOrder ? rowOrder.order(children, row => row.key) : children;
        const search = query.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
        return !search ? ordered : ordered.filter(child => (child.searchText ?? child.name).toLocaleLowerCase("ru-RU").replaceAll("ё", "е").includes(search));
      });
      if (!template && !values.length) throw new Error("Нет строк для экспорта с текущими фильтрами.");
      downloadExcelFile(createTableXlsx(WORK_TYPES_EXCEL_SHEET, `${template ? "Шаблон: " : ""}Виды и подвиды работ — ${props.projectName}`, WORK_TYPES_EXCEL_HEADERS, values, WORK_TYPES_EXCEL_WIDTHS), excelFileName(template ? "Шаблон видов и подвидов работ" : "Виды и подвиды работ", [props.projectName]));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось скачать файл Excel."); }
  }
  async function importExcel(file: File) {
    if (busyRef.current || dirty) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const { parseTableXlsx } = await import("./placementXlsx");
      const rows = await parseTableXlsx(file, WORK_TYPES_EXCEL_HEADERS);
      const entries = rows.map(row => ({ name: row["Вид работы"], subworkName: row["Подвид работы"] })).filter(row => row.name.trim() || row.subworkName.trim());
      if (!entries.length) throw new Error("В файле нет заполненных видов или подвидов работ.");
      const result = await request({ siteId: props.siteId, entries });
      await props.onRefresh(); setNotice(`Обработано строк: ${result.count ?? entries.length}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось импортировать файл."); }
    finally { busyRef.current = false; setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  const searchControl = <input className="work-types-search" type="search" aria-label="Поиск видов и подвидов работ" placeholder="Найти вид или подвид работы…" value={query} disabled={locked} onChange={event => setQuery(event.target.value)}/>;
  const excelControls = <div className="work-types-toolbar-actions">
    <span className="work-types-totals">Видов: <strong>{count(props.mainWorkTypes.length)}</strong> · Подвидов: <strong>{count(props.subworkTypes.length)}</strong></span>
    <ExcelActionsMenu actions={[
      { label: "Экспорт в Excel", disabled: locked || dirty || editing, onSelect: () => exportExcel() },
      ...(props.canCreate && props.canUpdate ? [
        { label: "Импорт из Excel", disabled: locked || dirty || editing, onSelect: () => fileInput.current?.click() },
        { label: "Скачать шаблон", disabled: locked, onSelect: () => exportExcel(true) },
      ] : []),
    ]}/>
  </div>;
  return <section className="users-settings admin-section reference-section work-types-directory" aria-label="Виды и подвиды работ" aria-busy={locked}>
    {headerActionsTargetId ? headerActionsTarget && createPortal(<div className="work-types-heading-actions">{searchControl}{excelControls}</div>, headerActionsTarget) : <div className="settings-toolbar">
      <button type="button" className="back-button" disabled={locked || dirty || editing} onClick={props.onBack}>← К настройкам проекта</button>
      {searchControl}{excelControls}
    </div>}
    <input ref={fileInput} hidden type="file" accept=".xlsx" onChange={event => { const file = event.target.files?.[0]; if (file) void importExcel(file); }}/>
    {error && !archive && <div role="alert" className="message error inline-message"><strong>Проверьте данные</strong><span>{error}</span></div>}
    {notice && <div role="status" className="message success inline-message"><strong>Готово</strong><span>{notice}</span></div>}
    <WorkTypesTable masters={workspace.masters} details={workspace.details} drafts={edits} errors={errors} query={query} loading={props.loading} disabled={locked} canCreate={props.canCreate} canUpdate={props.canUpdate} canDelete={props.canDelete} preferenceScope={{ userId: props.currentUserId ?? 0, siteId: props.siteId }} selectionVersion={selectionVersion} onEdit={editRows} onPatch={patch} onAdd={add} onRemoveNew={removeNewRows} onArchive={askArchive} onSave={() => void save()} onCancel={() => { stopEditors(true); reset(); setError(""); }} registerGrid={registerGrid}
      onEditingChange={(grid, active) => { if (active) activeEditors.current.add(grid); else activeEditors.current.delete(grid); setEditing(activeEditors.current.size > 0); }}
      onBatchStart={() => { batchError.current = ""; batch.current = editsRef.current; }} onBatchEnd={() => { const next = batch.current; batch.current = null; if (batchError.current) { setError(batchError.current); batchError.current = ""; return; } if (next && next !== editsRef.current) change(() => next); }}
      history={{ canUndo: !locked && history.past.length > 0, canRedo: !locked && history.future.length > 0, undo: () => { if (!locked) { stopEditors(true); dispatch({ type: "undo" }); } }, redo: () => { if (!locked) { stopEditors(true); dispatch({ type: "redo" }); } } }}/>
    {archive && <ArchiveConfirmation archive={archive} busy={busy} error={error} onClose={() => { setArchive(null); setError(""); }} onConfirm={() => void archiveRows()}/>}
  </section>;
}
