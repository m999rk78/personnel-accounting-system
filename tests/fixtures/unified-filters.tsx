import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { TimesheetView } from "../../app/TimesheetView";
import { EquipmentAccountingView } from "../../app/EquipmentAccountingView";
import { gridTheme, pinnableHeader, type GridEquipmentUnit } from "../../app/AgDataGrids";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams } from "../../app/GridFilters";
import { TableOrderProvider } from "../../app/TableRowMoves";
import { moveRowBlock, reconcileRowOrder } from "../../app/tableRowOrder";
import "../../app/globals.css";

type Screen = "workers" | "equipment" | "grid" | "legacy";
type WorkerMark = { employeeId: number; workDate: string; hours: number | null; code: string | null; note: string; updatedBy: string };
type EquipmentMark = { equipmentId: number; workDate: string; productiveHours: number; downtimeHours: number; note: string; updatedBy: string };
const employees = [
  { id: 1, fullName: "Александров Александр Александрович — проверка длинного имени сотрудника в списке значений фильтра", employmentType: "ОПР", department: "Монтаж технологических трубопроводов и оборудования производственного комплекса", position: "Монтажник технологических трубопроводов и связанных с ними металлических конструкций" },
  { id: 2, fullName: "Белов Борис Борисович", employmentType: "ОПР", department: "Монтаж технологических трубопроводов и оборудования производственного комплекса", position: "Сварщик" },
  { id: 3, fullName: "Васильева Вера Васильевна", employmentType: "ИТР", department: "Производственно-технический отдел", position: "Инженер производственно-технического отдела" },
  { id: 4, fullName: "Громов Григорий Григорьевич", employmentType: "ИТР", department: "Контроль качества", position: "Мастер" },
];
const units: GridEquipmentUnit[] = [
  { id: 101, organization: "Организация с очень длинным наименованием для проверки переноса текста и доступности всех кнопок фильтра", equipmentType: "Автомобильный кран повышенной грузоподъёмности", brand: "Тестовая марка", model: "Длинная модель для проверки фильтров", registrationNumber: "ТЕСТ-101", note: "" },
  { id: 102, organization: "Стройтехника", equipmentType: "Экскаватор", brand: "Тест", model: "ЭК-2", registrationNumber: "ТЕСТ-102", note: "" },
  { id: 103, organization: "Стройтехника", equipmentType: "Самосвал", brand: "Тест", model: "СМ-3", registrationNumber: "ТЕСТ-103", note: "" },
  { id: 104, organization: "Контроль", equipmentType: "Погрузчик", brand: "Тест", model: "ПГ-4", registrationNumber: "ТЕСТ-104", note: "" },
];
const stores = new Map<string, ReturnType<typeof makeStore>>();
const orders = new Map<string, number[]>();
function makeStore(month: string) {
  return {
    workerEntries: [
      { employeeId: 1, workDate: `${month}-01`, hours: 8, masters: "Мастер А", zones: "Зона А" },
      { employeeId: 1, workDate: `${month}-02`, hours: 2, masters: "Мастер А", zones: "Зона А" },
      { employeeId: 2, workDate: `${month}-01`, hours: 4, masters: "Мастер Б", zones: "Зона Б" },
      { employeeId: 2, workDate: `${month}-02`, hours: 8, masters: "Мастер Б", zones: "Зона Б" },
    ],
    workerMarks: [
      { employeeId: 1, workDate: `${month}-01`, hours: 6, code: null, note: "Расхождение ОПР", updatedBy: "Тест" },
      { employeeId: 2, workDate: `${month}-01`, hours: null, code: "В", note: "Табельный код", updatedBy: "Тест" },
      { employeeId: 2, workDate: `${month}-02`, hours: 10, code: null, note: "Ручная правка", updatedBy: "Тест" },
      { employeeId: 3, workDate: `${month}-01`, hours: 8, code: null, note: "Ожидаемые ручные часы ИТР", updatedBy: "Тест" },
    ] as WorkerMark[],
    equipmentEntries: [
      { ...units[0], id: 201, equipmentId: 101, workDate: `${month}-01`, hours: 8, subworkTypeName: "Работа" },
      { ...units[1], id: 202, equipmentId: 102, workDate: `${month}-01`, hours: 4, subworkTypeName: "Простой" },
      { ...units[2], id: 203, equipmentId: 103, workDate: `${month}-02`, hours: 3, subworkTypeName: "Работа" },
    ].map(row => ({ ...row, shiftId: 1, zoneId: 1, mainWorkTypeId: 1, subworkTypeId: 1, shiftName: "Дневная", zoneName: "Зона А", mainWorkTypeName: "Монтаж", responsibleUserId: 1, responsibleUserName: "Тест", revision: 1 })),
    equipmentMarks: [
      { equipmentId: 101, workDate: `${month}-01`, productiveHours: 6, downtimeHours: 2, note: "Работа и простой; расхождение", updatedBy: "Тест" },
      { equipmentId: 103, workDate: `${month}-01`, productiveHours: 0, downtimeHours: 0, note: "Явная нулевая ручная отметка", updatedBy: "Тест" },
      { equipmentId: 103, workDate: `${month}-02`, productiveHours: 5, downtimeHours: 0, note: "Расхождение", updatedBy: "Тест" },
    ] as EquipmentMark[],
  };
}
function store(siteId: number, month: string) {
  const key = `${siteId}:${month}`;
  if (!stores.has(key)) stores.set(key, makeStore(month));
  return stores.get(key)!;
}

// Every application request stays in this browser memory; never fall through to a real API.
window.fetch = async (input, init) => {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const siteId = Number(body.siteId ?? url.searchParams.get("siteId") ?? 1);
    const month = String(url.searchParams.get("month") ?? body.workDate?.slice(0, 7) ?? "2026-10");
    const data = store(siteId, month);
    if (url.pathname === "/api/table-order") {
      const scope = String(body.scope ?? url.searchParams.get("scope") ?? "project-personnel");
      const key = `${scope}:${siteId}`;
      const available = scope === "project-equipment" ? units.map(row => row.id) : employees.map(row => row.id);
      const saved = reconcileRowOrder(available, orders.get(key) ?? []);
      if (method === "POST") {
        if (!Array.isArray(body.movingIds) || body.movingIds.some((id: number) => !available.includes(id))) throw new Error("Выберите строки тестового каталога.");
        orders.set(key, moveRowBlock(saved, body));
      }
      return Response.json({ ids: orders.get(key) ?? saved, canWrite: true, hasSavedOrder: orders.has(key) });
    }
    if (url.pathname === "/api/timesheet") {
      if (method === "POST") {
        data.workerMarks = data.workerMarks.filter(row => row.employeeId !== body.employeeId || row.workDate !== body.workDate);
        if (!body.value) return Response.json({ deleted: true });
        const numeric = /^\d+$/.test(body.value);
        const mark: WorkerMark = { employeeId: Number(body.employeeId), workDate: String(body.workDate), hours: numeric ? Number(body.value) : null, code: numeric ? null : String(body.value), note: body.note ?? "", updatedBy: "Тест" };
        data.workerMarks.push(mark);
        return Response.json({ mark });
      }
      return Response.json({ siteId, siteName: `Учебный проект ${siteId}`, month, employees, entries: data.workerEntries, marks: data.workerMarks, canEdit: true, canCreate: true, canUpdate: true, canDelete: true });
    }
    if (url.pathname === "/api/equipment") {
      if (method === "POST") {
        if (body.action !== "save-timesheet-mark") throw new Error("На стенде доступно только изменение отметок табеля.");
        data.equipmentMarks = data.equipmentMarks.filter(row => row.equipmentId !== body.equipmentId || row.workDate !== body.workDate);
        if (body.clear) return Response.json({ deleted: true });
        const mark: EquipmentMark = { equipmentId: Number(body.equipmentId), workDate: String(body.workDate), productiveHours: Number(body.productiveHours ?? 0), downtimeHours: Number(body.downtimeHours ?? 0), note: body.note ?? "", updatedBy: "Тест" };
        data.equipmentMarks.push(mark);
        return Response.json({ mark });
      }
      return Response.json({ siteId, siteName: `Учебный проект ${siteId}`, workDate: `${month}-29`, month, units, availableUnits: [], sites: [{ id: siteId, name: `Учебный проект ${siteId}` }], entries: data.equipmentEntries, marks: data.equipmentMarks, dailyTimesheetMarks: [], shifts: [{ id: 1, name: "Дневная" }], zones: [{ id: 1, name: "Зона А" }], mainWorkTypes: [{ id: 1, name: "Монтаж" }], subworkTypes: [{ id: 1, name: "Работа", mainWorkTypeId: 1 }], filledDates: [`${month}-01`, `${month}-02`], foremanProgress: [], currentUserRole: "superadmin", currentUserName: "Тест", reportSubmitted: false, canEditTimesheet: true, canCreateTimesheet: true, canUpdateTimesheet: true, canDeleteTimesheet: true, canEditDaily: false, canCreateDaily: false, canUpdateDaily: false, canDeleteDaily: false, canManageRegistry: false, canCreateRegistry: false, canUpdateRegistry: false, canDeleteRegistry: false, canManageAssignments: false, canCreateAssignments: false, canUpdateAssignments: false, canDeleteAssignments: false });
    }
    return Response.json({ error: `Запрос ${method} ${url.pathname} заблокирован изолированным стендом.` }, { status: 404 });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Некорректный тестовый запрос." }, { status: 400 });
  }
};

type ExampleRow = { id: number; kind: "entry"; name: string; organization: string; hours: number; date: string };
function ExampleGrid({ month, enterprise = true }: { month: string; enterprise?: boolean }) {
  const [rows, setRows] = useState<ExampleRow[]>(() => employees.map((employee, index) => ({ id: employee.id, kind: "entry", name: employee.fullName, organization: units[index].organization, hours: [0, 4, 8, 12][index], date: `${month}-0${index + 1}` })));
  const columns = useMemo<ColDef<ExampleRow>[]>(() => [
    { field: "name", headerName: "Сотрудник", minWidth: 260, flex: 2 },
    { field: "organization", headerName: "Организация", minWidth: 220, flex: 1.5 },
    { field: "hours", headerName: "Часы", width: 130, filterParams: { ...personnelFilterParams, kind: "number" } },
    { field: "date", headerName: "Дата", width: 150, filterParams: { ...personnelFilterParams, kind: "date" } },
  ], []);
  const defaults = useMemo<ColDef<ExampleRow>>(() => ({ filter: personnelColumnFilter, filterParams: personnelFilterParams, headerComponentParams: pinnableHeader, sortable: true, resizable: true, editable: true, suppressHeaderMenuButton: true }), []);
  return <div className="ag-grid-shell ag-admin-grid unified-example-grid"><LocalizedGrid<ExampleRow> theme={gridTheme} enterpriseFilters={enterprise} rowData={rows} columnDefs={columns} defaultColDef={defaults} getRowId={({ data }) => String(data.id)} getRowOrderId={row => row.id} rowHeight={54} headerHeight={48} onCellValueChanged={event => { if (event.data) setRows(current => current.map(row => row.id === event.data!.id ? { ...event.data! } : row)); }} /></div>;
}
const styles = `
  .unified-fixture { height:100vh; min-height:0; display:flex; flex-direction:column; gap:10px; padding:14px 18px; overflow:hidden; }
  .unified-fixture-controls { flex:0 0 auto; display:flex; align-items:center; flex-wrap:wrap; gap:8px; font-size:12px; }
  .unified-fixture-controls > strong { margin-right:auto; }
  .unified-fixture-controls button,.unified-fixture-controls select { min-height:32px; padding:4px 9px; border:1px solid #d4d4d8; border-radius:5px; background:#fff; }
  .unified-fixture-controls button[aria-pressed=true] { background:#18181b; color:#fff; }
  .unified-fixture .unified-fixture-content { min-height:0; flex:1; display:flex; flex-direction:column; }
  .unified-fixture-actions { min-height:38px; flex:0 0 auto; display:flex; justify-content:flex-end; margin-bottom:6px; }
  .unified-fixture .unified-example-grid { flex:1; height:auto; min-height:240px; }
  .unified-fixture-note { margin:0; color:#71717a; font-size:11px; }
  @media(max-width:680px) { .unified-fixture { padding:10px; }.unified-fixture-controls > strong { width:100%; } }
`;
function Fixture() {
  const [screen, setScreen] = useState<Screen>("workers");
  const [siteId, setSiteId] = useState(1);
  const [month, setMonth] = useState("2026-10");
  const [version, setVersion] = useState(0);
  const key = `${screen}:${siteId}:${month}:${version}`;
  const gridScreen = screen === "grid" || screen === "legacy";
  return <AgGridProvider modules={[AllEnterpriseModule]}><style>{styles}</style><main className="unified-fixture">
    <nav className="unified-fixture-controls" aria-label="Тестовые таблицы"><strong>Единые фильтры — изолированный стенд</strong>
      {([['workers', 'Табель рабочих'], ['equipment', 'Табель техники'], ['grid', 'AG Grid'], ['legacy', 'Без Enterprise']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={screen === value} onClick={() => setScreen(value)}>{label}</button>)}
      <select aria-label="Тестовый проект" value={siteId} onChange={event => setSiteId(Number(event.target.value))}><option value={1}>Проект 1</option><option value={2}>Проект 2</option></select>
      <select aria-label="Тестовый месяц" value={month} onChange={event => setMonth(event.target.value)}><option value="2026-10">Октябрь 2026</option><option value="2026-09">Сентябрь 2026</option></select>
      <button type="button" onClick={() => { stores.clear(); orders.clear(); setVersion(value => value + 1); }}>Сбросить тестовые данные</button>
    </nav>
    <p className="unified-fixture-note">По 4 строки. Данные 1–2 числа: часы, код В, ручные правки, расхождения, простой и пустые дни. Все изменения остаются в памяти браузера.</p>
    <div className="unified-fixture-content timesheet-workspace-page">
      {!gridScreen && <div id={screen === "workers" ? "personnel-timesheet-actions" : "equipment-timesheet-actions"} className="unified-fixture-actions"/>}
      <TableOrderProvider key={key} scope={screen === "equipment" ? "project-equipment" : "project-personnel"} siteId={siteId}>
        {screen === "workers" ? <TimesheetView siteId={siteId} initialMonth={month} today="2026-10-29" onMonthChange={setMonth}/> : screen === "equipment" ? <EquipmentAccountingView siteId={siteId} initialDate={`${month}-29`} initialMonth={month} today="2026-10-29" mode="month" onMonthChange={setMonth}/> : <ExampleGrid month={month} enterprise={screen !== "legacy"}/>}
      </TableOrderProvider>
    </div>
  </main></AgGridProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
