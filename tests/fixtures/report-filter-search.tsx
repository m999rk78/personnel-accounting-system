import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { PersonnelReportGrid, type PersonnelReportGridRow } from "../../app/PersonnelReportGrid";
import { EquipmentReportGrid, type EquipmentReportGridRow } from "../../app/EquipmentReportGrid";
import { personnelCellErrors, type PersonnelSpreadsheetDraft } from "../../app/personnelSpreadsheet";
import { equipmentCellErrors, equipmentSpreadsheetName, type EquipmentSpreadsheetDraft } from "../../app/equipmentSpreadsheet";
import type { GridEmployee, GridEquipmentUnit } from "../../app/AgDataGrids";
import "../../app/globals.css";

// Standalone component QA: every record and edit lives only in React state.
window.fetch = async () => Response.json({ error: "В этом стенде API отключён." }, { status: 404 });
const today = "2026-11-03";
const yesterday = "2026-11-02";
const employees: GridEmployee[] = [
  { id: 1, fullName: "Иванов Иван", employmentType: "ОПР", department: "Монтаж", position: "Монтажник", source: "manual", siteId: 1, siteName: "Тестовый проект" },
  { id: 2, fullName: "Иванов Пётр", employmentType: "ОПР", department: "Монтаж", position: "Сварщик", source: "manual", siteId: 1, siteName: "Тестовый проект" },
  { id: 3, fullName: "Петров Павел", employmentType: "ИТР", department: "Контроль", position: "Мастер", source: "manual", siteId: 1, siteName: "Тестовый проект" },
];
const units: GridEquipmentUnit[] = [
  { id: 1, equipmentType: "Кран", brand: "Альфа", model: "", registrationNumber: "", organization: "Монтаж", note: "" },
  { id: 2, equipmentType: "Кран", brand: "Бета", model: "", registrationNumber: "", organization: "Монтаж", note: "" },
  { id: 3, equipmentType: "Экскаватор", brand: "", model: "", registrationNumber: "", organization: "Подготовка", note: "" },
];
const shifts = [{ id: 1, name: "Дневная" }, { id: 2, name: "Ночная" }];
const zones = [{ id: 1, name: "Зона А" }, { id: 2, name: "Зона Б" }];
const mainWorkTypes = [{ id: 1, name: "Монтаж" }, { id: 2, name: "Подготовка" }];
const subworkTypes = [{ id: 1, name: "Работа", mainWorkTypeId: 1 }, { id: 2, name: "Простой", mainWorkTypeId: 2 }];
const masters = [{ id: 1, name: "Тестовый мастер" }];
const catalogs = { employees, units, shifts, zones, mainWorkTypes, subworkTypes, masters };
const seeds = [
  { id: 1, date: today, entity: 1, status: "draft", zone: 1, hours: 8 },
  { id: 2, date: today, entity: 2, status: "submitted", zone: 2, hours: 4 },
  { id: 3, date: today, entity: 3, status: "approved", zone: 1, hours: 6 },
  { id: 4, date: today, entity: 1, status: "rejected", zone: 2, hours: 2 },
  { id: 5, date: yesterday, entity: 1, status: "draft", zone: 1, hours: 3 },
  { id: 6, date: yesterday, entity: 2, status: "approved", zone: 1, hours: 5 },
  { id: 7, date: yesterday, entity: 3, status: "submitted", zone: 2, hours: 7 },
  { id: 8, date: yesterday, entity: 2, status: "rejected", zone: 2, hours: 1 },
] as const;
function common(seed: typeof seeds[number], prefix: string) {
  const key = `${prefix}-${seed.id}`;
  return { rowKey: key, workDate: seed.date, createdAt: `${seed.date}T08:00:00Z`, updatedAt: `${seed.date}T08:00:00Z`,
    status: seed.status, editable: seed.status === "draft" || seed.status === "rejected", responsibleUserId: 1, responsibleUserName: "Тестовый прораб",
    draft: { key, shiftId: seed.zone === 1 ? "1" : "2", zoneId: String(seed.zone), mainWorkTypeId: "1", subworkTypeId: "1", hours: String(seed.hours), note: `Строка ${seed.id} · ${seed.date}` } };
}
const initialPersonnel: PersonnelReportGridRow[] = seeds.map(seed => {
  const row = common(seed, "personnel");
  return { ...row, draft: { ...row.draft, employeeId: String(seed.entity), employeeQuery: employees.find(employee => employee.id === seed.entity)!.fullName, masterId: "1" } };
});
const initialEquipment: EquipmentReportGridRow[] = seeds.map(seed => {
  const row = common(seed, "equipment");
  return { ...row, draft: { ...row.draft, equipmentId: String(seed.entity), equipmentQuery: equipmentSpreadsheetName(units.find(unit => unit.id === seed.entity)) } };
});
const initialErrors = [
  ...initialPersonnel.flatMap(row => Object.values(personnelCellErrors(row.draft!, catalogs, true))),
  ...initialEquipment.flatMap(row => Object.values(equipmentCellErrors(row.draft!, catalogs, true, row.workDate))),
];
const history = { canUndo: false, canRedo: false, undo() {}, redo() {} };
const styles = `
  .report-filter-fixture { height:100dvh; min-height:560px; display:flex; flex-direction:column; gap:10px; padding:14px 18px; }
  .report-filter-fixture h1 { margin:0; font-size:22px; }
  .report-filter-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .report-filter-controls button { min-height:34px; padding:5px 10px; border:1px solid #d4d4d8; border-radius:6px; background:#fff; font-size:12px; }
  .report-filter-controls button[aria-pressed=true] { background:#18181b; color:#fff; }
  .report-filter-fixture > .personnel-history-table { min-height:0; flex:1; }
  .report-filter-fixture p,.report-filter-fixture output { margin:0; font-size:12px; line-height:18px; }
  .report-filter-observation { flex:none; padding:9px 12px; border:1px solid #d4d4d8; border-radius:6px; background:#fafafa; overflow-wrap:anywhere; }
  @media(max-width:680px) { .report-filter-fixture { padding:10px; } }
`;

function Fixture() {
  const [kind, setKind] = useState<"personnel" | "equipment">("personnel");
  const [personnel, setPersonnel] = useState(() => structuredClone(initialPersonnel));
  const [equipment, setEquipment] = useState(() => structuredClone(initialEquipment));
  const [visiblePersonnel, setVisiblePersonnel] = useState(initialPersonnel.map(row => row.rowKey));
  const [visibleEquipment, setVisibleEquipment] = useState(initialEquipment.map(row => row.rowKey));
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState("");
  const patchPersonnel = (key: string, changes: Partial<PersonnelSpreadsheetDraft>) => setPersonnel(current => current.map(row => row.draft?.key === key ? { ...row, draft: { ...row.draft, ...changes } } : row));
  const patchEquipment = (key: string, changes: Partial<EquipmentSpreadsheetDraft>) => setEquipment(current => current.map(row => row.draft?.key === key ? { ...row, draft: { ...row.draft, ...changes } } : row));
  const rows = kind === "personnel" ? personnel : equipment;
  const keys = kind === "personnel" ? visiblePersonnel : visibleEquipment;
  const visibleHours = rows.filter(row => keys.includes(row.rowKey)).reduce((sum, row) => sum + Number(row.draft?.hours || 0), 0);
  return <main className="report-filter-fixture"><style>{styles}</style>
    <h1>Фильтры отчётов: поиск и несколько значений</h1>
    <nav className="report-filter-controls" aria-label="Проверка отчётов">
      <button type="button" aria-pressed={kind === "personnel"} onClick={() => { setKind("personnel"); setSelected([]); }}>Отчёт персонала</button>
      <button type="button" aria-pressed={kind === "equipment"} onClick={() => { setKind("equipment"); setSelected([]); }}>Отчёт техники</button>
      <button type="button" onClick={() => { setPersonnel(current => structuredClone(current)); setEquipment(current => structuredClone(current)); setRevision(value => value + 1); }}>Обновить props без API</button>
      <button type="button" onClick={() => kind === "personnel" ? patchPersonnel("personnel-1", { hours: String(Number(personnel[0].draft?.hours || 0) + 1) }) : patchEquipment("equipment-1", { hours: String(Number(equipment[0].draft?.hours || 0) + 1) })}>+1 час в первой строке</button>
      <button type="button" onClick={() => { setPersonnel(structuredClone(initialPersonnel)); setEquipment(structuredClone(initialEquipment)); setVisiblePersonnel(initialPersonnel.map(row => row.rowKey)); setVisibleEquipment(initialEquipment.map(row => row.rowKey)); setSelected([]); setError(""); setRevision(0); setEpoch(value => value + 1); }}>Сбросить стенд</button>
    </nav>
    <p>По 8 строк, 2 даты, все статусы. Поиск «Иванов» / «Кран» → 1, 2, 4, 5, 6, 8 (23 ч). Вместе с «Зона А» → 1, 5, 6 (16 ч). Изменения остаются в памяти.</p>
    <output aria-label="Проверка исходных данных">Исходные drafts: {initialErrors.length ? initialErrors.join("; ") : "валидны"}. Обновлений props: {revision}.</output>
    {error && <p role="alert">{error}</p>}
    {kind === "personnel" ? <PersonnelReportGrid key={`personnel:${epoch}`} rows={personnel} today={today} loading={false} canCreate canReview {...catalogs}
      onPatchDraft={patchPersonnel} onVisibleRowsChange={setVisiblePersonnel} onSelectionChange={setSelected} onApplyRange={() => false} onCopyRows={() => {}} onValidationError={setError} history={history}/>
      : <EquipmentReportGrid key={`equipment:${epoch}`} rows={equipment} today={today} loading={false} canCreate canReview {...catalogs}
        onPatchDraft={patchEquipment} onVisibleRowsChange={setVisibleEquipment} onSelectionChange={setSelected} onApplyRange={() => false} onCopyRows={() => {}} onValidationError={setError} history={history}/>}
    <output className="report-filter-observation" aria-label="Видимые строки и часы">{JSON.stringify({ table: kind, keys, rows: keys.length, hours: visibleHours, selected })}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture/></AgGridProvider>);
