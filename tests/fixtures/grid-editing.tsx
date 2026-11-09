import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AllCommunityModule } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { DirectoryAgGrid, EquipmentRegistryAgGrid, EmployeeAgGrid, PositionAgGrid, type GridDirectoryDraft, type GridEquipmentRegistryDraft, type GridEmployeeDraft, type GridPositionDraft } from "../../app/AgDataGrids";
import "../../app/globals.css";

function EditingSmoke() {
  const [section, setSection] = useState("zones");
  const [drafts, setDrafts] = useState<GridDirectoryDraft[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [rows, setRows] = useState([{ id: 1, name: "Исходная зона" }, { id: 2, name: "Вторая зона" }]);
  const [equipmentDrafts, setEquipmentDrafts] = useState<GridEquipmentRegistryDraft[]>([]);
  const [units, setUnits] = useState([{ id: 1, organization: "Организация", equipmentType: "Экскаватор", brand: "Марка", model: "Модель", registrationNumber: "А001", note: "" }]);
  return <main style={{ padding: 16 }}>
    <h1>Таблицы — проверка непрерывного ввода</h1>
    <p>Только тестовые данные. Нет подключения к рабочей базе.</p>
    <label>Раздел <select value={section} onChange={(event) => { setSection(event.target.value); setSelected([]); }}><option value="zones">Зоны</option><option value="equipment">Техника</option><option value="employees">Сотрудники</option><option value="positions">Должности</option></select></label>
    {section === "equipment" ? <>
      <button onClick={() => { setUnits(current => current.map(unit => ({ ...unit, ...equipmentDrafts.find(d => d.id === unit.id) }))); setEquipmentDrafts([]); }}>Сохранить технику</button>
      <button onClick={() => setEquipmentDrafts([])}>Отменить технику</button>
      <output aria-label="Состояние черновика">{JSON.stringify(equipmentDrafts)}</output>
      <div style={{ height: 450 }}><EquipmentRegistryAgGrid rows={units} drafts={equipmentDrafts} sites={[]} selectedIds={selected} fullRowEditIds={[]} loading={false} canCreate canUpdate canSelect
        onEdit={unit => setEquipmentDrafts([{ ...unit, key: `edit-${unit.id}`, projectSiteId: "" }])}
        onSelectionChange={setSelected} onPatchDraft={(key, changes) => setEquipmentDrafts(current => current.map(d => d.key === key ? { ...d, ...changes } : d))}
        onVisibleIdsChange={() => {}} onValidationError={() => {}}
      /></div>
    </> : section !== "zones" ? <ReferenceFixture key={section} section={section} /> : <>
    <button onClick={() => setDrafts([{ key: "new", name: "" }])}>Добавить зону</button>{" "}
    <button onClick={() => { setRows((current) => [...current.map((row) => ({ ...row, name: drafts.find((d) => d.id === row.id)?.name ?? row.name })), ...drafts.filter((d) => !d.id).map((d, i) => ({ id: 100 + i, name: d.name }))]); setDrafts([]); }}>Сохранить</button>{" "}
    <button onClick={() => setDrafts([])}>Отменить</button>
    <output aria-label="Состояние черновика">{JSON.stringify(drafts)}</output>
    <div style={{ height: 450 }}><DirectoryAgGrid rows={rows} drafts={drafts} title="Зоны" pendingDeletes={selected}
      onEdit={(item) => setDrafts([{ key: `edit-${item.id}`, id: item.id, name: item.name }])}
      onSelectionChange={setSelected}
      onPatchDraft={(key, changes) => setDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...changes } : draft))}
    /></div>
    </>}
  </main>;
}

type ReferenceDraft = GridEmployeeDraft & GridPositionDraft;
const reference = { id: 1, fullName: "Тестовый сотрудник", employmentType: "ОПР", department: "Отдел", position: "Должность", source: "manual", siteId: null, siteName: null };
function ReferenceFixture({ section }: { section: string }) {
  const [rows, setRows] = useState([reference]);
  const [drafts, setDrafts] = useState<ReferenceDraft[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const common = {
    rows, drafts, fullRowEditIds: [], selectedIds: selected, pendingDeletes: selected,
    onSelectionChange: setSelected,
    onEdit: (row: { id: number }, changes: Partial<ReferenceDraft> = {}) => setDrafts([{ ...reference, ...row, projectSiteId: "", ...changes, key: `edit-${row.id}` }]),
    onPatchDraft: (key: string, changes: Partial<ReferenceDraft>) => setDrafts(current => current.map(d => d.key === key ? { ...d, ...changes } : d)),
    employmentTypes: [{ id: 1, name: "ОПР" }], departments: [{ id: 1, name: "Отдел" }], positions: [{ id: 1, name: "Должность" }], sites: [],
    onVisibleIdsChange: () => {}, onValidationError: () => {}, onReorder: async () => {},
  };
  return <>
    <button onClick={() => { setRows(current => current.map(row => { const draft = drafts.find(d => d.id === row.id); return draft ? { ...row, fullName: draft.fullName, employmentType: draft.employmentType, department: draft.department, position: draft.position } : row; })); setDrafts([]); }}>Сохранить справочник</button>
    <button onClick={() => setDrafts([])}>Отменить справочник</button>
    <output aria-label="Состояние черновика">{JSON.stringify(drafts)}</output>
    <div style={{ height: 450 }}>
      {section === "employees" ? <EmployeeAgGrid {...common} /> : <PositionAgGrid {...common} />}
    </div>
  </>;
}

const enterprise = new URLSearchParams(location.search).has("enterprise");
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[enterprise ? AllEnterpriseModule : AllCommunityModule]}><EditingSmoke /></AgGridProvider>);
