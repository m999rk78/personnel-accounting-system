import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { gridTheme, pinnableHeader } from "../../app/AgDataGrids";
import { LocalizedGrid, personnelColumnFilter, personnelFilterParams } from "../../app/GridFilters";
import "../../app/globals.css";

// Isolated browser QA: generated rows never touch application APIs or a database.
window.fetch = async () => Response.json({ error: "API отключён в изолированном стенде." }, { status: 404 });
type Row = { id: number; kind: "entry"; date: string | null; department: string; hours: number };
type DateFormat = "iso" | "display";
const formatDate = (value: string | null, format: DateFormat) => format === "display" && value && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}` : value;
function makeRows(count = 34, format: DateFormat = "iso"): Row[] {
  const dates = ["2025-11-01", "2025-12-31", "2026-10-31", ...Array.from({ length: 28 }, (_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`), "2026-12-01", "2026", null];
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, kind: "entry", date: formatDate(dates[index % dates.length], format), department: index % 2 ? "МУСК" : "МУТТ", hours: 8 }));
}
function Fixture() {
  const compact = new URLSearchParams(location.search).has("compact");
  const checklist = new URLSearchParams(location.search).has("checklist");
  const apiRef = useRef<GridApi<Row> | null>(null);
  const [enterprise, setEnterprise] = useState(true);
  const [dateFormat, setDateFormat] = useState<DateFormat>("iso");
  const [rows, setRows] = useState(() => makeRows());
  const [snapshot, setSnapshot] = useState("{}");
  const updateSnapshot = (api = apiRef.current) => {
    if (!api || api.isDestroyed()) return;
    const dates: (string | null)[] = [];
    api.forEachNodeAfterFilter(node => { if (node.data) dates.push(node.data.date); });
    setSnapshot(JSON.stringify({ rows: dates.length, dates: dates.length < 80 ? dates : dates.slice(0, 3), model: api.getFilterModel() }));
  };
  const columns = useMemo<ColDef<Row>[]>(() => [
    { field: "date", colId: "date", headerName: "Дата", width: 240, cellDataType: false, filterParams: { ...personnelFilterParams, kind: "date" } },
    { field: "department", headerName: "Отдел", width: 200 },
    { field: "hours", headerName: "Часы", width: 180, filterParams: { ...personnelFilterParams, kind: "number" } },
  ], []);
  const defaults = useMemo<ColDef<Row>>(() => ({ filter: personnelColumnFilter, filterParams: { ...personnelFilterParams, ...(checklist ? { presentation: "checklist" } : compact ? { presentation: "compact" } : {}) }, headerComponentParams: pinnableHeader, sortable: true, resizable: true, editable: true, suppressHeaderMenuButton: true }), [compact, checklist]);
  const setDepartment = async (department: string | null) => {
    const api = apiRef.current;
    if (!api) return;
    const model = department == null ? null : enterprise
      ? { filterType: "multi", filterModels: [null, { filterType: "set", values: [department] }, null] }
      : { filterType: "personnel", kind: "text", values: [department], conditions: [], operator: "AND" };
    await api.setColumnFilterModel("department", model);
    api.onFilterChanged();
  };
  const changeDateFormat = (format: DateFormat) => {
    apiRef.current?.hideColumnFilter();
    apiRef.current?.setFilterModel(null);
    setDateFormat(format);
    setRows(makeRows(34, format));
  };
  return <main className="date-tree-fixture"><style>{`
    .date-tree-fixture{height:100dvh;min-height:560px;display:flex;flex-direction:column;gap:10px;padding:14px 18px;overflow:hidden}
    .date-tree-fixture h1{margin:0;font-size:22px}.date-tree-fixture nav{display:flex;flex-wrap:wrap;gap:8px}
    .date-tree-fixture nav button{min-height:34px;padding:5px 10px;border:1px solid #d4d4d8;border-radius:6px;background:#fff;font-size:12px}
    .date-tree-fixture nav button[aria-pressed=true]{background:#18181b;color:#fff}.date-tree-fixture p{margin:0;font-size:12px}
    .date-tree-fixture .ag-grid-shell{flex:1;min-height:0}.date-tree-fixture output{display:block;max-height:100px;overflow:auto;padding:8px;background:#fafafa;border:1px solid #ddd;font-size:11px;overflow-wrap:anywhere}
  `}</style><h1>Дерево дат: год → месяц → день</h1>
    <nav aria-label="Управление тестовыми данными">
      <button type="button" aria-pressed={enterprise} onClick={() => setEnterprise(true)}>AG Enterprise</button>
      <button type="button" aria-pressed={!enterprise} onClick={() => setEnterprise(false)}>Резервный фильтр</button>
      <button type="button" aria-pressed={dateFormat === "iso"} onClick={() => changeDateFormat("iso")}>Даты ISO</button>
      <button type="button" aria-pressed={dateFormat === "display"} onClick={() => changeDateFormat("display")}>Даты ДД.ММ.ГГГГ</button>
      <button type="button" onClick={() => apiRef.current?.showColumnFilter("date")}>Открыть фильтр даты</button>
      <button type="button" onClick={() => { void setDepartment("МУТТ"); }}>Только МУТТ</button>
      <button type="button" onClick={() => { void setDepartment(null); }}>Все отделы</button>
      <button type="button" onClick={() => setRows(current => [...current, { id: current.reduce((max, row) => Math.max(max, row.id), 0) + 1, kind: "entry", date: formatDate("2026-11-06", dateFormat), department: "МУТТ", hours: 8 }])}>+1 строка 06.11.2026</button>
      <button type="button" onClick={() => setRows(makeRows(100_000, dateFormat))}>100 000 строк</button>
      <button type="button" onClick={() => { apiRef.current?.setFilterModel(null); setDateFormat("iso"); setRows(makeRows()); }}>Сбросить стенд</button>
    </nav>
    <p>34 строки: 2025–2026 гг., 28 ноябрьских дней, два отдела, пустая и некорректная дата «2026». {checklist ? "Выбор применяется сразу." : "Выбор должен применяться только кнопкой «Применить»."}</p>
    <div className="ag-grid-shell ag-admin-grid"><LocalizedGrid<Row> key={`${enterprise ? "enterprise" : "fallback"}:${dateFormat}`} theme={gridTheme} enterpriseFilters={enterprise} rowData={rows} columnDefs={columns} defaultColDef={defaults} getRowId={({ data }) => String(data.id)} rowHeight={42} headerHeight={48}
      onGridReady={event => { apiRef.current = event.api; updateSnapshot(event.api); }} onFilterChanged={event => updateSnapshot(event.api)} onRowDataUpdated={event => updateSnapshot(event.api)} onModelUpdated={event => updateSnapshot(event.api)} />
    </div>
    <output aria-label="Наблюдение за фильтрами">{snapshot}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture/></AgGridProvider>);
