import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { DirectoryAgGrid, EquipmentRegistryAgGrid, ProjectEmployeeAgGrid, ProjectEquipmentAgGrid, gridTheme, type GridDirectoryDraft, type GridEquipmentRegistryDraft, type GridProjectEmployeeDraft, type GridProjectEquipmentDraft } from "../../app/AgDataGrids";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams } from "../../app/GridFilters";
import { WorkspaceAccessProvider } from "../../app/TableAccessContext";
import { TableOrderProvider, useNativeRowMoves, useWorkspaceTableOrder } from "../../app/TableRowMoves";
import { WorkTypesTable } from "../../app/WorkTypesTable";
import { workTypesWorkspace, type WorkTypeEdits, type WorkTypeRow } from "../../app/workTypesWorkspace";
import "../../app/globals.css";

type Tab = "generic" | "directory" | "equipment" | "projectPeople" | "projectEquipment" | "native" | "workTypes";
type Mode = "full" | "reorder" | "readonly" | "delete" | "noSelect";
const tabs: { id: Tab; label: string; scope: string }[] = [
  { id: "generic", label: "Общая таблица", scope: "fixture-generic" },
  { id: "directory", label: "Зоны", scope: "directory-zone" },
  { id: "equipment", label: "Реестр техники", scope: "equipment" },
  { id: "projectPeople", label: "Сотрудники проекта", scope: "project-personnel" },
  { id: "projectEquipment", label: "Техника проекта", scope: "project-equipment" },
  { id: "native", label: "Нативный табель", scope: "project-personnel" },
  { id: "workTypes", label: "Виды / подвиды", scope: "directory-work-types" },
];
const baseNames = ["Альфа", "Бета", "Гамма", "Дельта", "Эпсилон", "Омега"];
type SampleRow = { kind: "entry" | "edit" | "draft"; item: { id: number }; name: string };
function SavedMoves() {
  const [status, setStatus] = useState({ mutations: [] as unknown[], orders: {} });
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void fetch("/__smoke/status", { signal: controller.signal }).then(response => response.json()).then(value => { if (!controller.signal.aborted) setStatus(value); }).catch(() => {});
    refresh(); const timer = window.setInterval(refresh, 500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  return <output aria-label="Сохранённые переносы" style={{ fontSize: 12 }}>Запросов переноса: {status.mutations.length}. Порядок: {JSON.stringify(status.orders)}</output>;
}

function NativeFixture({ siteId, loading, editing, filtered, sorted, rows }: { siteId: number; loading: boolean; editing: boolean; filtered: boolean; sorted: boolean; rows: SampleRow[] }) {
  const gesture = useRef<string[]>([]);
  const [lastGesture, setLastGesture] = useState<string[]>([]);
  const order = useWorkspaceTableOrder();
  const ordered = order?.order(rows, row => row.item.id) ?? rows;
  const visible = filtered ? ordered.slice(0, 3) : sorted ? [...ordered].sort((a, b) => b.name.localeCompare(a.name)) : ordered;
  const moves = useNativeRowMoves(order, filtered || sorted, loading || editing, { key: `fixture:${siteId}`, ids: visible.map(row => row.item.id) });
  return <><table style={{ borderCollapse: "collapse", width: "100%" }} aria-label="Тестовый нативный табель"
    onDragStartCapture={event => { gesture.current = [`start:${(event.target as Element).closest("tr")?.textContent}`]; }}
    onDragOverCapture={event => { gesture.current.push(`over:${(event.target as Element).closest("tr")?.textContent}`); }}
    onDropCapture={event => { gesture.current.push(`drop:${(event.target as Element).closest("tr")?.textContent}`); }}
    onDragEndCapture={() => { setLastGesture([...gesture.current]); }}
  ><thead><tr><th style={{ width: 80 }}>{moves.headerCheckbox}</th><th>Сотрудник</th><th>Часы</th></tr></thead><tbody>
    {visible.map((row, index) => <tr key={row.item.id} {...moves.rowProps(row.item.id)} style={{ height: 48, borderBottom: "1px solid #ddd" }}>
      <td>{moves.handle(row.item.id, row.name, index + 1)}</td><td>{row.name}</td><td>8</td>
    </tr>)}
  </tbody></table>{moves.ui}<output aria-label="События переноса табеля">{lastGesture.join(" · ")}</output></>;
}

function WorkTypesFixture({ mode, loading, editing, query }: { mode: Mode; loading: boolean; editing: boolean; query: string }) {
  const [drafts, setDrafts] = useState<WorkTypeEdits>({});
  const [selectionVersion, setSelectionVersion] = useState(0);
  const parents = useMemo(() => [{ id: 1, name: "Монтаж" }, { id: 2, name: "Подготовка" }, { id: 3, name: "Завершение" }], []);
  const children = useMemo(() => [{ id: 11, name: "Первая операция", mainWorkTypeId: 1 }, { id: 12, name: "Вторая операция", mainWorkTypeId: 1 }, { id: 13, name: "Третья операция", mainWorkTypeId: 2 }, { id: 14, name: "Четвёртая операция", mainWorkTypeId: 2 }, { id: 15, name: "Без назначения", mainWorkTypeId: null }], []);
  const workspace = useMemo(() => workTypesWorkspace(parents, children, drafts), [parents, children, drafts]);
  const onEdit = (rows: WorkTypeRow[]) => setDrafts(current => ({ ...current, ...Object.fromEntries(rows.map(row => [row.key, row])) }));
  const registerGrid = useCallback(() => () => {}, []);
  return <WorkTypesTable {...workspace} drafts={drafts} errors={{}} query={query} loading={loading} disabled={editing}
    canCreate={mode === "full" || mode === "reorder"} canUpdate={mode === "full" || mode === "reorder"} canDelete={mode === "full" || mode === "delete"}
    selectionVersion={selectionVersion} onEdit={onEdit} onPatch={(row, changes) => setDrafts(current => ({ ...current, [row.key]: { ...row, ...current[row.key], ...changes } }))}
    onAdd={(directoryKind, parentKey) => { const key = `new-${crypto.randomUUID()}`; setDrafts(current => ({ ...current, [key]: { key, directoryKind, parentKey, name: "" } })); }}
    onArchive={() => {}} onSave={() => { setDrafts({}); setSelectionVersion(value => value + 1); }} onCancel={() => setDrafts({})}
    registerGrid={registerGrid} onEditingChange={() => {}} onBatchStart={() => {}} onBatchEnd={() => {}}
    history={{ undo: () => {}, redo: () => {}, canUndo: false, canRedo: false }} />;
}

function TestTable({ tab, mode, siteId, loading, editing, withDraft, filtered, sorted, absentSelection }: { tab: Tab; mode: Mode; siteId: number; loading: boolean; editing: boolean; withDraft: boolean; filtered: boolean; sorted: boolean; absentSelection: boolean }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [callbackCount, setCallbackCount] = useState(0);
  const [directoryDrafts, setDirectoryDrafts] = useState<GridDirectoryDraft[]>([]);
  const [equipmentDrafts, setEquipmentDrafts] = useState<GridEquipmentRegistryDraft[]>([]);
  const [peopleDrafts, setPeopleDrafts] = useState<GridProjectEmployeeDraft[]>([]);
  const [projectDrafts, setProjectDrafts] = useState<GridProjectEquipmentDraft[]>([]);
  const [api, setApi] = useState<GridApi<SampleRow> | null>(null);
  const rows = useMemo(() => baseNames.map((name, index) => ({ kind: "entry" as const, item: { id: (siteId - 1) * 100 + index + 1 }, name: `${name} ${siteId}` })), [siteId]);
  const employees = useMemo(() => rows.map(row => ({ id: row.item.id, fullName: row.name, employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник", source: "manual", siteId, siteName: `Тестовый проект ${siteId}` })), [rows, siteId]);
  const units = useMemo(() => rows.map(row => ({ id: row.item.id, organization: `Организация ${siteId}`, equipmentType: row.name, brand: "Тест", model: `Модель ${row.item.id}`, registrationNumber: `ТЕСТ-${row.item.id}`, note: "Синтетические данные" })), [rows, siteId]);
  const mutationSelection = mode === "full" || mode === "delete";
  const canEdit = mode === "full" || mode === "reorder";
  const noParentSelection = absentSelection || !mutationSelection;
  const onSelectionChange = (ids: number[]) => { setCallbackCount(value => value + 1); setSelected(ids); };
  const columns = useMemo<ColDef<SampleRow>[]>(() => [{ colId: "number", headerName: "№", width: 65, sortable: false, filter: false }, { field: "name", headerName: "Название", flex: 1 }], []);
  useEffect(() => {
    if (!api || api.isDestroyed()) return;
    api.setFilterModel(filtered ? { name: { filterType: "personnel", kind: "text", values: [`Альфа ${siteId}`, `Бета ${siteId}`, `Гамма ${siteId}`], conditions: [], operator: "AND" } } : null);
    api.applyColumnState({ state: [{ colId: "name", sort: sorted ? "desc" : null }] });
  }, [api, filtered, sorted, siteId]);
  const sampleRows = withDraft ? [...rows, { kind: "draft" as const, item: { id: 999 }, name: "Черновик" }] : editing ? rows.map((row, index) => index === 0 ? { ...row, kind: "edit" as const } : row) : rows;
  return <>
    <output aria-label="Родительское выделение">Вызовов родительского onSelectionChange: {callbackCount}; выбранные ID: {selected.join(", ") || "нет"}</output>
    <div style={{ flex: 1, minHeight: 0, height: 440 }}>
      {tab === "generic" ? <div className="ag-grid-shell ag-reference-grid" style={{ height: "100%" }}><LocalizedGrid<SampleRow> theme={gridTheme} rowData={sampleRows} columnDefs={columns} getRowId={params => String(params.data.item.id)} loading={loading} rowOrderBlocked={editing}
        defaultColDef={{ filter: personnelColumnFilter, filterParams: personnelFilterParams, sortable: true, resizable: true }}
        rowSelection={noParentSelection ? undefined : { mode: "multiRow", checkboxes: true, headerCheckbox: true, selectAll: "filtered", enableClickSelection: false }}
        onSelectionChanged={event => { if (!noParentSelection) onSelectionChange(event.api.getSelectedRows().map(row => row.item.id)); }} onGridReady={event => setApi(event.api)} /></div>
      : tab === "directory" ? <DirectoryAgGrid title="Зоны" rows={rows.map(row => ({ id: row.item.id, name: row.name }))} drafts={withDraft ? [...directoryDrafts, { key: "blank", name: "" }] : directoryDrafts} pendingDeletes={selected} selectionDisabled={noParentSelection} readOnly={!canEdit}
        onEdit={item => setDirectoryDrafts(current => current.some(draft => draft.id === item.id) ? current : [...current, { key: `edit-${item.id}`, ...item }])} onSelectionChange={onSelectionChange} onPatchDraft={(key, changes) => setDirectoryDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))} />
      : tab === "equipment" ? <EquipmentRegistryAgGrid rows={units} drafts={withDraft ? [...equipmentDrafts, { key: "blank", organization: "", equipmentType: "", brand: "", model: "", registrationNumber: "", note: "", projectSiteId: "" }] : equipmentDrafts} sites={[]} selectedIds={selected} fullRowEditIds={[]} loading={loading} canCreate={canEdit} canUpdate={canEdit} canSelect={!noParentSelection}
        onEdit={unit => setEquipmentDrafts(current => current.some(draft => draft.id === unit.id) ? current : [...current, { key: `edit-${unit.id}`, ...unit, projectSiteId: "" }])} onSelectionChange={onSelectionChange} onPatchDraft={(key, changes) => setEquipmentDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))} onVisibleIdsChange={() => {}} onValidationError={() => {}} />
      : tab === "projectPeople" ? <ProjectEmployeeAgGrid rows={employees} allEmployees={employees} drafts={withDraft ? [...peopleDrafts, { key: "blank", employeeId: "", employeeQuery: "" }] : peopleDrafts} pendingDeletes={selected} readOnly={!canEdit} selectionDisabled={noParentSelection} onSelectionChange={onSelectionChange} onPatchDraft={(key, changes) => setPeopleDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))} />
      : tab === "projectEquipment" ? <ProjectEquipmentAgGrid rows={units} allUnits={units} drafts={withDraft ? [...projectDrafts, { key: "blank", equipmentId: "" }] : projectDrafts} selectedIds={selected} loading={loading} canCreate={canEdit} canSelect={!noParentSelection} onSelectionChange={onSelectionChange} onPatchDraft={(key, changes) => setProjectDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))} />
      : tab === "native" ? <NativeFixture {...{ siteId, loading, editing, filtered, sorted, rows }} />
      : <WorkTypesFixture mode={mode} loading={loading} editing={editing} query={filtered ? "Монтаж" : ""} />}
    </div>
  </>;
}

function Fixture() {
  const [tab, setTab] = useState<Tab>("generic");
  const [mode, setMode] = useState<Mode>("full");
  const [siteId, setSiteId] = useState(1);
  const [epoch, setEpoch] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [withDraft, setWithDraft] = useState(false);
  const [filtered, setFiltered] = useState(false);
  const [sorted, setSorted] = useState(false);
  const [absentSelection, setAbsentSelection] = useState(false);
  const [slow, setSlow] = useState(false);
  const scope = tabs.find(item => item.id === tab)!.scope;
  const access = { create: mode === "full" || mode === "reorder", update: mode === "full" || mode === "reorder" || mode === "noSelect", delete: mode === "full" || mode === "delete", edit: mode === "full" || mode === "reorder" || mode === "noSelect", select: mode !== "readonly" && mode !== "noSelect", reorder: mode === "full" || mode === "reorder" || mode === "noSelect" };
  return <main style={{ height: "100vh", minHeight: 700, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
    <h1 style={{ fontSize: 22 }}>Перенос строк за галочку</h1>
    <p>Изолированный стенд. Только синтетические данные, сохранение порядка в памяти процесса.</p>
    <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{tabs.map(item => <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => { setTab(item.id); setFiltered(false); setSorted(false); setWithDraft(false); setEditing(false); }}>{item.label}</button>)}</nav>
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
      <label>Права <select aria-label="Права" value={mode} onChange={event => setMode(event.target.value as Mode)}><option value="full">Полные права</option><option value="reorder">Перенос без удаления</option><option value="readonly">Только просмотр</option><option value="delete">Только удаление</option><option value="noSelect">Запрет выбора</option></select></label>
      <label>Проект <select aria-label="Проект" value={siteId} onChange={event => setSiteId(Number(event.target.value))}><option value="1">Тестовый проект 1</option><option value="2">Тестовый проект 2</option></select></label>
      <label><input type="checkbox" checked={absentSelection} onChange={event => setAbsentSelection(event.target.checked)} />Без родительского rowSelection</label>
      <label><input type="checkbox" checked={loading} onChange={event => setLoading(event.target.checked)} />Загрузка</label>
      <label><input type="checkbox" checked={editing} onChange={event => setEditing(event.target.checked)} />Редактирование</label>
      <label><input type="checkbox" checked={withDraft} onChange={event => setWithDraft(event.target.checked)} />Черновик</label>
      <label><input type="checkbox" checked={filtered} onChange={event => setFiltered(event.target.checked)} />Фильтр</label>
      <label><input type="checkbox" checked={sorted} onChange={event => setSorted(event.target.checked)} />Сортировка</label>
      <label><input type="checkbox" checked={slow} onChange={event => { setSlow(event.target.checked); void fetch("/__smoke/policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slow: event.target.checked }) }); }} />Медленное сохранение</label>
      <button type="button" onClick={async () => { await fetch("/__smoke/reset", { method: "POST" }); setEpoch(value => value + 1); }}>Сбросить стенд</button>
    </div>
    <small>Фильтр / сортировка переключателями управляют общей таблицей и нативным табелем; в остальных таблицах используйте меню заголовка. Редактирование в реальных справочниках проверяйте двойным кликом по ячейке.</small>
    <SavedMoves />
    <WorkspaceAccessProvider access={access}><TableOrderProvider key={`${scope}:${siteId}:${mode}:${epoch}`} scope={scope} siteId={siteId}>
      <TestTable key={`${tab}:${mode}:${siteId}:${epoch}`} {...{ tab, mode, siteId, loading, editing, withDraft, filtered, sorted, absentSelection }} />
    </TableOrderProvider></WorkspaceAccessProvider>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider>);
