import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgGridProvider } from "ag-grid-react";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { CustomSelect } from "../../app/CustomSelect";
import { EquipmentDailyAgGrid, type GridEquipmentDraft } from "../../app/AgDataGrids";
import { TimesheetColumnFilter, TimesheetFiltersProvider } from "../../app/TimesheetColumnFilter";
import { useTimesheetFilters, type TimesheetFilterColumn } from "../../app/useTimesheetFilters";
import { VirtualChoiceList } from "../../app/VirtualChoiceList";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams } from "../../app/GridFilters";
import "../../app/globals.css";

const labels = [
  "Монтаж в проектное положение металлоконструкций и технологических трубопроводов",
  "Монтаж запорной арматуры",
  "Нанесение антикоррозионного покрытия на наружную поверхность трубопровода",
  "Перевозка между зонами работ, погрузка и разгрузка строительных материалов",
  "Перемещение материалов",
  "Погрузо-разгрузка, сортировка и складирование материалов на строительной площадке",
  "Подготовительные работы",
  "Подготовка к гидравлическим испытаниям технологического оборудования",
  `ДлинноеНазваниеБезПробелов_${"1234567890".repeat(12)}`,
];
const options = labels.map((label, index) => ({ value: String(index + 1), label }));
type TimesheetChoice = { id: string; name: string };
const timesheetChoices: TimesheetChoice[] = options.map(option => ({ id: option.value, name: option.label }));
const timesheetColumns: readonly TimesheetFilterColumn<TimesheetChoice>[] = [{ colId: "name", headerName: "Вид подработ", getValue: row => row.name }];
const timesheetChoiceId = (row: TimesheetChoice) => row.id;
const manyValues = Array.from({ length: 2000 }, (_, i) => `${String(i + 1).padStart(4, "0")} · ${labels[i % labels.length]}`);
const units = [{ id: 1, organization: "Тестовая организация с длинным полным юридическим наименованием", equipmentType: "Экскаватор", brand: "Тестовая марка", model: "Очень длинное название модели техники для испытания списка", registrationNumber: "ТЕСТ-001", note: labels[0] }];

function TimesheetChoiceFilter() {
  const filters = useTimesheetFilters({ rows: timesheetChoices, columns: timesheetColumns, getRowId: timesheetChoiceId, resetKey: "choice-menu-timesheet" });
  return <TimesheetFiltersProvider value={filters.context}>
    {filters.controller}
    <div><TimesheetColumnFilter columnId="name" label="Вид подработ" /></div>
    <output aria-label="Строк после фильтра табеля">{filters.rows.length}</output>
  </TimesheetFiltersProvider>;
}

function ChoiceMenus() {
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<GridEquipmentDraft[]>([{ key: "new", equipmentId: "", shiftId: "", zoneId: "", mainWorkTypeId: "1", subworkTypeId: "", hours: "", note: "" }]);
  return <main style={{ padding: 16, display: "grid", gap: 24 }}>
    <h1 style={{ fontSize: 20 }}>Проверка списков выбора</h1>
    <section aria-label="Фильтры AG Grid Enterprise"><h2>Длинные названия в фильтре</h2><div style={{height:300}}><LocalizedGrid enterpriseFilters rowData={labels.map((name, id) => ({kind:"entry" as const,id,name}))} columnDefs={[{field:"name",headerName:"Название работы",flex:1}]} defaultColDef={{filter:personnelColumnFilter,filterParams:personnelFilterParams,sortable:true}} /></div></section>
    <p>Синтетические данные, без подключения к рабочей базе.</p>
    <div style={{ width: 190 }}><CustomSelect value={value} onChange={setValue} options={options} ariaLabel="Вид подработ" searchable /></div>
    <output aria-label="Выбранное значение">{value}</output>
    <div style={{ width: 300, maxWidth: "100%" }} aria-label="Большой список"><VirtualChoiceList items={manyValues} emptyText="Пусто" renderItem={(label) => <label className="grid-value-option"><input type="checkbox" checked={checked.includes(label)} onChange={(event) => setChecked(current => event.target.checked ? [...current, label] : current.filter(v => v !== label))} /><span>{label}</span></label>} /></div>
    <TimesheetChoiceFilter />
    <section><h2>Техника</h2><div style={{ height: 300, maxWidth: "100%" }}><EquipmentDailyAgGrid entries={[]} drafts={drafts} units={units} dailyTimesheetMarks={[]} shifts={[]} zones={[]} mainWorkTypes={[{ id: 1, name: "Вспомогательные работы" }]} subworkTypes={labels.map((name, index) => ({ id: index + 1, name, mainWorkTypeId: 1 }))} loading={false} canCreate canUpdate canDelete selectedIds={[]} selectedDraftKeys={[]} onEdit={() => {}} onPatchDraft={(key, changes) => setDrafts(current => current.map(draft => draft.key === key ? { ...draft, ...changes } : draft))} onSelectionChange={() => {}} onDraftSelectionChange={() => {}} onValidationError={() => {}} /></div></section>
    <div style={{ display: "flex", justifyContent: "flex-end" }}><div style={{ width: 180 }}><CustomSelect value={value} onChange={setValue} options={options} ariaLabel="Список у правого края" searchable /></div></div>
    <div style={{ position: "fixed", right: 16, bottom: 16, width: 180 }}><CustomSelect value={value} onChange={setValue} options={options} ariaLabel="Список у нижнего края" searchable /></div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><ChoiceMenus /></AgGridProvider>);
