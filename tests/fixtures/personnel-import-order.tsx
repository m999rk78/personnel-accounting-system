import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { ProjectEmployeeAgGrid, type GridEmployee } from "../../app/AgDataGrids";
import { PersonnelReportGrid, type PersonnelReportGridRow } from "../../app/PersonnelReportGrid";
import { TimesheetView } from "../../app/TimesheetView";
import { notifyTableImportOrder, TableOrderProvider } from "../../app/TableRowMoves";
import "../../app/globals.css";

const today = "2026-11-02";
const employees: GridEmployee[] = [
  { id: 1, fullName: "Абаев", employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" },
  { id: 2, fullName: "Петров", employmentType: "ОПР", department: "Тестовый отдел", position: "Сварщик", source: "manual", siteId: 1, siteName: "Учебный проект" },
  { id: 3, fullName: "Зотов", employmentType: "ОПР", department: "Тестовый отдел", position: "Монтажник", source: "manual", siteId: 1, siteName: "Учебный проект" },
];
const option = [{ id: 1, name: "Тестовое значение" }];
const tabs = [
  { key: "catalog", label: "Общий справочник", scope: "employees" },
  { key: "project", label: "Сотрудники проекта", scope: "project-personnel" },
  { key: "report", label: "Отчёт персонала", scope: "personnel-report-rows" },
  { key: "timesheet", label: "Табель", scope: "project-personnel" },
] as const;
type Tab = typeof tabs[number]["key"];
const names = (ids: number[]) => ids.map(id => employees.find(employee => employee.id === id)?.fullName ?? String(id)).join(" → ");
function reportRows(ids: number[]): PersonnelReportGridRow[] {
  return ids.map((id, index) => ({
    rowKey: `report-11-${100 + id}`, workDate: today, status: "draft", editable: true, rowOrder: index,
    createdAt: `${today}T08:0${id}:00.000Z`, updatedAt: `${today}T08:0${id}:00.000Z`, responsibleUserId: 10, responsibleUserName: "Тестовый прораб",
    draft: { key: `report-11-${100 + id}`, employeeId: String(id), employeeQuery: employees.find(employee => employee.id === id)!.fullName, shiftId: "1", zoneId: "1", mainWorkTypeId: "1", subworkTypeId: "1", masterId: "1", hours: "8", note: `Строка файла ${index + 1}` },
  }));
}

function Fixture() {
  const [tab, setTab] = useState<Tab>("project");
  const [fileOrder, setFileOrder] = useState([3, 1, 2]);
  const [report, setReport] = useState(() => reportRows([3, 1, 2]));
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState("");
  const scope = tabs.find(item => item.key === tab)!.scope;
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/__smoke/status", { signal: controller.signal }).then(response => response.json()).then((state: { importIds: number[]; importCount: number }) => {
      if (controller.signal.aborted) return;
      setFileOrder(state.importIds); setReport(reportRows(state.importIds)); setCount(state.importCount); setReady(true);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Ошибка стенда"); });
    return () => controller.abort();
  }, []);
  const changeImport = async (reset = false) => {
    const response = await fetch(reset ? "/__smoke/reset" : "/__smoke/import", { method: "POST" });
    const result = await response.json() as { importIds: number[]; importCount: number; error?: string };
    if (!response.ok) { setError(result.error ?? "Ошибка тестового импорта"); return; }
    setFileOrder(result.importIds); setReport(reportRows(result.importIds)); setCount(result.importCount);
    if (reset) setEpoch(value => value + 1);
    else notifyTableImportOrder(scope, 1);
  };
  return <main style={{ height: "100vh", minHeight: 650, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
    <h1 style={{ fontSize: 22 }}>Порядок импорта сотрудников</h1>
    <p>Изолированный стенд. Только синтетические данные, API меняет память процесса.</p>
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{tabs.map(item => <button type="button" key={item.key} aria-pressed={tab === item.key} onClick={() => { setTab(item.key); setSelected([]); }}>{item.label}</button>)}</nav>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: 10, background: "#eff6ff", borderRadius: 8 }}>
      <strong aria-label="Ожидаемый порядок файла">Excel: {names(fileOrder)} ({fileOrder.join(", ")})</strong>
      <span aria-label="Исходный ручной порядок">Ручной: {names([2, 3, 1])} (2, 3, 1)</span>
      <span>Повторных импортов: {count}</span>
      <button type="button" disabled={!ready} onClick={() => void changeImport()}>Повторить импорт</button>
      <button type="button" disabled={!ready} onClick={() => void changeImport(true)}>Сбросить стенд</button>
    </div>
    <small>В меню фильтра выберите «Порядок импорта», затем вернитесь к ручному порядку. Повторный импорт должен активировать новую последовательность без перезагрузки страницы.</small>
    {error && <p role="alert">{error}</p>}
    <div className={tab === "timesheet" ? "timesheet-workspace-page" : ""} style={{ flex: 1, minHeight: 0 }}>
      {ready && <TableOrderProvider key={`${scope}:${tab}:${epoch}`} scope={scope} siteId={1}>
        {tab === "timesheet" ? <TimesheetView siteId={1} initialMonth={today.slice(0, 7)} today={today} />
        : tab === "report" ? <PersonnelReportGrid rows={report} today={today} loading={false} canCreate canReview employees={employees} shifts={option} zones={option} mainWorkTypes={option} subworkTypes={option.map(item => ({ ...item, mainWorkTypeId: 1 }))} masters={option}
          onPatchDraft={(key, changes) => setReport(current => current.map(row => row.rowKey === key ? { ...row, draft: { ...row.draft!, ...changes } } : row))}
          onSelectionChange={() => {}} onCopyRows={() => {}} onValidationError={setError} onApplyRange={() => false}
          history={{ undo: () => {}, redo: () => {}, canUndo: false, canRedo: false }} />
        : <ProjectEmployeeAgGrid rows={employees} allEmployees={employees} drafts={[]} pendingDeletes={selected} readOnly selectionDisabled={false} onPatchDraft={() => {}} onSelectionChange={setSelected} />}
      </TableOrderProvider>}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider>);
