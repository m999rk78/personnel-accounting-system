import { StrictMode, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { PersonnelReportGrid, type PersonnelReportGridRow } from "../../app/PersonnelReportGrid";
import { EquipmentReportGrid, type EquipmentReportGridRow } from "../../app/EquipmentReportGrid";
import { DirectoryAgGrid } from "../../app/ReferenceDirectoryGrids";
import type { GridDirectoryDraft } from "../../app/AgDataGrids";
import { draftHistoryReducer, type DraftHistory, type DraftHistoryAction, type PersonnelSpreadsheetDraft } from "../../app/personnelSpreadsheet";
import "../../app/globals.css";
import "../../app/personnelReport.css";

const today = "2026-11-18";
const employees = [{ id: 1, fullName: "Проверяемый сотрудник", employmentType: "ОПР", department: "МУТТ", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" }];
const units = [{ id: 1, equipmentType: "Кран", brand: "Учебная марка", model: "Учебная модель", registrationNumber: "ТЕСТ-001", organization: "Учебная организация", note: "" }];
const options = [{ id: 1, name: "Учебное значение" }];
type ReportDraft = PersonnelSpreadsheetDraft & { equipmentId: string; equipmentQuery: string };
const initial: ReportDraft = { key: "draft-1", employeeId: "1", employeeQuery: employees[0].fullName, equipmentId: "1", equipmentQuery: "Учебная модель // ТЕСТ-001", shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", masterId: "1", hours: "8", note: "Исходное примечание" };

function ReportFixture({ kind }: { kind: "personnel" | "equipment" }) {
  const [state, dispatch] = useReducer((state: DraftHistory<ReportDraft>, action: DraftHistoryAction<ReportDraft>) => draftHistoryReducer(state, action), { present: initial, past: [], future: [] });
  const history = { canUndo: state.past.length > 0, canRedo: state.future.length > 0, undo: () => dispatch({ type: "undo" }), redo: () => dispatch({ type: "redo" }) };
  const common = { today, loading: false, canCreate: true, canReview: true, shifts: options, zones: options, mainWorkTypes: options, subworkTypes: [{ id: 1, name: "Учебный подвид", mainWorkTypeId: 1 }],
    onPatchDraft: (_key: string, changes: Partial<ReportDraft>) => dispatch({ type: "change", update: draft => ({ ...draft, ...changes }) }),
    onApplyRange: () => false, history, onSelectionChange() {}, onCopyRows() {}, onValidationError() {} };
  const row = { rowKey: "draft-1", workDate: today, status: "draft" as const, editable: true, draft: state.present };
  return <section className="personnel-report-workspace" style={{ height: 450, display: "flex", flexDirection: "column" }}>
    {kind === "personnel" ? <PersonnelReportGrid {...common} rows={[row] as PersonnelReportGridRow[]} employees={employees} masters={options} />
      : <EquipmentReportGrid {...common} rows={[row] as EquipmentReportGridRow[]} units={units} />}
    <output aria-label="Черновик отчёта">{JSON.stringify(state.present)}</output>
  </section>;
}

function CatalogFixture({ name }: { name: string }) {
  const [drafts, setDrafts] = useState<GridDirectoryDraft[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  return <section data-catalog={name} style={{ height: 330, minWidth: 0, display: "flex", flexDirection: "column" }}>
    <h2>{name}</h2>
    <div style={{ minHeight: 0, flex: 1 }}><DirectoryAgGrid title={name} scopeKey={name} rows={[{ id: 1, name: `Исходное ${name}` }]} drafts={drafts} pendingDeletes={selected} onSelectionChange={setSelected}
      onEdit={row => setDrafts(current => [...current.filter(draft => draft.id !== row.id), { ...row, key: `directory-${row.id}` }])}
      onPatchDraft={(key, changes) => setDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))} onReplaceDrafts={setDrafts} /></div>
    <output aria-label={`Черновик ${name}`}>{JSON.stringify(drafts)}</output>
  </section>;
}

function Fixture() {
  const [view, setView] = useState("personnel");
  return <main style={{ padding: 16, display: "grid", gap: 12 }}>
    <h1 style={{ margin: 0 }}>Отмена изменений — только синтетические данные</h1>
    <nav><button onClick={() => setView("personnel")}>Персонал</button> <button onClick={() => setView("equipment")}>Техника</button> <button onClick={() => setView("catalog")}>Справочники</button></nav>
    <label>Заметка вне таблицы <input aria-label="Заметка вне таблицы" /></label>
    <button type="button" data-outside style={{ justifySelf: "start" }}>Фокус вне таблицы</button>
    {view === "catalog" ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}><CatalogFixture name="Альфа" /><CatalogFixture name="Бета" /></div>
      : <ReportFixture key={view} kind={view as "personnel" | "equipment"} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider></StrictMode>);
