import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { LocalizedGrid } from "../../app/GridFilters";
import { gridTheme } from "../../app/AgDataGrids";
import { TableOrderProvider, useNativeRowMoves, useWorkspaceTableOrder } from "../../app/TableRowMoves";
import { WorkspaceAccessProvider } from "../../app/TableAccessContext";
import { useTableViewport } from "../../app/useTableViewport";
import "../../app/globals.css";

type Mode = "personnel-timesheet" | "equipment-timesheet" | "personnel-report" | "equipment-report";
type Row = { kind: "entry"; item: { id: number }; name: string; position: string; hours: number };
const modes: { id: Mode; label: string }[] = [
  { id: "personnel-timesheet", label: "Табель персонала" },
  { id: "equipment-timesheet", label: "Табель техники" },
  { id: "personnel-report", label: "Отчёт персонала" },
  { id: "equipment-report", label: "Отчёт техники" },
];
const rows: Row[] = Array.from({ length: 120 }, (_, index) => ({
  kind: "entry", item: { id: index + 1 }, name: `Тестовая строка ${String(index + 1).padStart(3, "0")}`,
  position: "Синтетические данные", hours: 8,
}));
const positions = ["top", "middle", "bottom"] as const;
const positionLabel = { top: "В начало", middle: "В середину", bottom: "В конец" };
const access = { create: true, update: true, delete: true, edit: true, select: true, reorder: true };

function SavedMoves() {
  const [state, setState] = useState({ mutations: [] as unknown[] });
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void fetch("/__smoke/status", { signal: controller.signal }).then(response => response.json()).then(value => {
      if (!controller.signal.aborted) setState(value);
    }).catch(() => {});
    refresh(); const timer = window.setInterval(refresh, 300);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  return <output aria-label="Сохранённые переносы" style={{ fontSize: 12 }}>Переносов: {state.mutations.length}; последний: {JSON.stringify(state.mutations.at(-1) ?? null)}</output>;
}

function NativeDragTrace({ shellRef }: { shellRef: RefObject<HTMLDivElement | null> }) {
  const output = useRef<HTMLOutputElement>(null);
  const trace = useRef<unknown[]>([]);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const document = shell.ownerDocument;
    const view = document.defaultView;
    const names = ["dragstart", "dragenter", "dragover", "drop", "dragend", "mouseup"];
    const describe = (element: Element | null) => element ? {
      tag: element.tagName.toLowerCase(),
      row: element.closest("[data-virtual-row]")?.getAttribute("data-virtual-row") ?? null,
      section: element.closest("thead") ? "thead" : element.closest("tfoot") ? "tfoot" : element.closest("tbody") ? "tbody" : null,
      class: typeof element.className === "string" ? element.className : null,
    } : null;
    const record = (event: Event, phase: string) => {
      const target = event.target instanceof Element ? event.target : null;
      const pointer = event instanceof MouseEvent ? event : null;
      const drag = event instanceof DragEvent ? event : null;
      const hit = pointer ? document.elementFromPoint(pointer.clientX, pointer.clientY) : null;
      trace.current = [...trace.current.slice(-19), {
        type: event.type, phase, x: pointer?.clientX ?? null, y: pointer?.clientY ?? null,
        defaultPrevented: event.defaultPrevented, effectAllowed: drag?.dataTransfer?.effectAllowed ?? null,
        dropEffect: drag?.dataTransfer?.dropEffect ?? null, rootContains: Boolean(target && shell.contains(target)),
        target: describe(target), hit: describe(hit), rootContainsHit: Boolean(hit && shell.contains(hit)),
      }];
      if (output.current) output.current.value = JSON.stringify(trace.current);
    };
    const docCapture = (event: Event) => record(event, "document-capture");
    const docBubble = (event: Event) => record(event, "document-bubble");
    const rootCapture = (event: Event) => record(event, "shell-capture");
    const rootBubble = (event: Event) => record(event, "shell-bubble");
    const blur = (event: Event) => record(event, "window");
    for (const name of names) {
      document.addEventListener(name, docCapture, true);
      document.addEventListener(name, docBubble);
      shell.addEventListener(name, rootCapture, true);
      shell.addEventListener(name, rootBubble);
    }
    view?.addEventListener("blur", blur);
    return () => {
      for (const name of names) {
        document.removeEventListener(name, docCapture, true);
        document.removeEventListener(name, docBubble);
        shell.removeEventListener(name, rootCapture, true);
        shell.removeEventListener(name, rootBubble);
      }
      view?.removeEventListener("blur", blur);
    };
  }, [shellRef]);
  return <details style={{ flex: "none", fontSize: 11 }}><summary>Диагностика переноса: последние 20 событий</summary>
    <button type="button" onClick={() => { trace.current = []; if (output.current) output.current.value = "[]"; }}>Очистить диагностику</button>
    <output ref={output} aria-label="Диагностика native drag" style={{ display: "block", maxHeight: 100, overflow: "auto", overflowWrap: "anywhere" }}>[]</output>
  </details>;
}

function NativeTable({ mode }: { mode: Mode }) {
  const order = useWorkspaceTableOrder();
  const ordered = order?.order(rows, row => row.item.id) ?? rows;
  const moves = useNativeRowMoves(order, false, false, { key: mode, ids: ordered.map(row => row.item.id) });
  const { shellRef, top, bottom, start, end } = useTableViewport(ordered.length, mode, Boolean(order?.ready));
  const scrollOutput = useRef<HTMLOutputElement>(null);
  const gestureOutput = useRef<HTMLOutputElement>(null);
  const gestureEvents = useRef<string[]>([]);
  const equipment = mode === "equipment-timesheet";
  const scrollTo = (position: typeof positions[number]) => {
    const shell = shellRef.current;
    if (shell) shell.scrollTo({ top: position === "top" ? 0 : position === "bottom" ? shell.scrollHeight : (shell.scrollHeight - shell.clientHeight) / 2 });
  };
  return <>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {positions.map(position => <button key={position} type="button" onClick={() => scrollTo(position)}>{positionLabel[position]}</button>)}
      <output ref={scrollOutput} aria-label="Прокрутка табеля">scrollTop: 0</output>
      <output ref={gestureOutput} aria-label="События переноса табеля">Перенос не начат</output>
    </div>
    <NativeDragTrace shellRef={shellRef} />
    {moves.ui}
    <div ref={shellRef} className={`timesheet-grid-shell ${equipment ? "equipment-timesheet-shell" : "timesheet-grid-shell-reconciled"}`}
      style={{ flex: 1, minHeight: 0, height: "auto", maxHeight: "none" }}
      onScroll={event => { if (scrollOutput.current) scrollOutput.current.value = `scrollTop: ${Math.round(event.currentTarget.scrollTop)}`; }}
      onDragStartCapture={event => { gestureEvents.current = [`start:${(event.target as Element).closest("tr")?.getAttribute("data-virtual-row")}`]; if (gestureOutput.current) gestureOutput.current.value = gestureEvents.current.join(" · "); }}
      onMouseUpCapture={() => { gestureEvents.current.push("mouseup"); }}
      onDropCapture={event => { gestureEvents.current.push(`drop:${(event.target as Element).closest("tr")?.getAttribute("data-virtual-row")}:${event.dataTransfer.getData("text/plain")}`); }}
      onDragEndCapture={() => { gestureEvents.current.push("end"); if (gestureOutput.current) gestureOutput.current.value = gestureEvents.current.join(" · "); }}
      aria-label={equipment ? "Изолированный табель техники" : "Изолированный табель персонала"}>
      <table className={`timesheet-table ${equipment ? "equipment-month-table" : "personnel-timesheet-table"}`} aria-rowcount={ordered.length + 3}>
        <thead><tr><th className="timesheet-sticky timesheet-number-column" rowSpan={2}>{moves.headerCheckbox}</th><th className="timesheet-sticky timesheet-employee-column" style={{ left: 50 }} rowSpan={2}>{equipment ? "Техника" : "Сотрудник"}</th><th rowSpan={2}>Назначение</th><th colSpan={3}>Дни месяца</th></tr>
          <tr><th>1</th><th>2</th><th>3</th></tr></thead>
        <tbody>
          {top > 0 && <tr className="timesheet-virtual-spacer" aria-hidden="true"><td colSpan={6} style={{ height: top }} /></tr>}
          {ordered.slice(start, end).map((row, offset) => {
            const index = start + offset;
            return <tr key={row.item.id} {...moves.rowProps(row.item.id)} data-virtual-row={index} aria-rowindex={index + 3}>
              <td className="timesheet-sticky timesheet-number-column">{moves.handle(row.item.id, row.name, index + 1)}</td>
              <th className="timesheet-sticky timesheet-employee-column" style={{ left: 50 }} scope="row">{row.name}</th><td>{row.position}</td><td>{row.hours}</td><td>{row.hours}</td><td>{row.hours}</td>
            </tr>;
          })}
          {bottom > 0 && <tr className="timesheet-virtual-spacer" aria-hidden="true"><td colSpan={6} style={{ height: bottom }} /></tr>}
        </tbody>
        <tfoot><tr><th colSpan={3}>Итого</th><td>960</td><td>960</td><td>960</td></tr></tfoot>
      </table>
    </div>
  </>;
}

function ReportGrid() {
  const [api, setApi] = useState<GridApi<Row> | null>(null);
  const scrollOutput = useRef<HTMLOutputElement>(null);
  const columns = useMemo<ColDef<Row>[]>(() => [
    { headerName: "№", width: 70, valueGetter: params => (params.node?.rowIndex ?? 0) + 1, sortable: false, filter: false },
    { field: "name", headerName: "Строка", flex: 1, minWidth: 260 },
    { field: "position", headerName: "Назначение", flex: 1, minWidth: 260 },
    { field: "hours", headerName: "Часы", width: 120 },
  ], []);
  return <>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {positions.map(position => <button key={position} type="button" onClick={() => api?.ensureIndexVisible(position === "top" ? 0 : position === "bottom" ? rows.length - 1 : 60, position === "top" ? "top" : position === "bottom" ? "bottom" : "middle")}>{positionLabel[position]}</button>)}
      <output ref={scrollOutput} aria-label="Прокрутка отчёта">scrollTop: 0</output>
    </div>
    <div className="ag-grid-shell" style={{ flex: 1, minHeight: 0 }}>
      <LocalizedGrid<Row> theme={gridTheme} rowData={rows} columnDefs={columns} getRowId={params => String(params.data.item.id)}
        defaultColDef={{ resizable: true, sortable: false, filter: false }}
        rowSelection={{ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false }}
        onGridReady={event => setApi(event.api)}
        onBodyScroll={event => { if (scrollOutput.current) scrollOutput.current.value = `scrollTop: ${Math.round(event.top)}`; }} />
    </div>
  </>;
}

function Fixture() {
  const [mode, setMode] = useState<Mode>("personnel-timesheet");
  const [epoch, setEpoch] = useState(0);
  return <main style={{ height: "100dvh", padding: 16, display: "flex", flexDirection: "column", gap: 10, overflow: "hidden" }}>
    <h1 style={{ margin: 0, fontSize: 20 }}>Прокрутка при переносе строк</h1>
    <p style={{ margin: 0, fontSize: 12 }}>Изолированный стенд: 120 синтетических строк, сохранение только в памяти процесса.</p>
    <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}
      <button type="button" onClick={async () => { await fetch("/__smoke/reset", { method: "POST" }); setEpoch(value => value + 1); }}>Сбросить стенд</button></nav>
    <SavedMoves />
    <WorkspaceAccessProvider access={access}><TableOrderProvider key={`${mode}:${epoch}`} scope={`fixture-${mode}`} siteId={1}>
      {mode.endsWith("timesheet") ? <NativeTable key={`${mode}:${epoch}`} mode={mode} /> : <ReportGrid key={`${mode}:${epoch}`} />}
    </TableOrderProvider></WorkspaceAccessProvider>
  </main>;
}

createRoot(document.getElementById("root")!).render(<AgGridProvider modules={[AllEnterpriseModule]}><Fixture /></AgGridProvider>);
