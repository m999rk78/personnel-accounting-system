import { Children, Fragment, cloneElement, isValidElement, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { TimesheetSizedColumn } from "./timesheetColumnSizing";
import "./timesheetColumnPinning.css";

type CellProps = { children?: ReactNode; className?: string; style?: CSSProperties; colSpan?: number; rowSpan?: number };
type Cell = ReactElement<CellProps>;
type ColumnView = { sourceIds: readonly string[]; columns: readonly TimesheetSizedColumn[]; metadataCount: number };

function cells(children: ReactNode): Cell[] {
  return Children.toArray(children).flatMap(child => !isValidElement<CellProps>(child) ? []
    : child.type === Fragment ? cells(child.props.children) : [child]);
}
function side(column: TimesheetSizedColumn) { return column.pinSide ?? (column.sticky ? "left" : null); }
function decorate(cell: Cell, column: TimesheetSizedColumn, index: number, end = column): Cell {
  const pin = side(column);
  const classes = (cell.props.className ?? "").split(/\s+/).filter(name => name && name !== "timesheet-sticky");
  if (pin) classes.push("timesheet-sticky");
  return cloneElement(cell, {
    key: column.id,
    className: classes.join(" "),
    style: { ...cell.props.style,
      "--timesheet-cell-left": `var(--timesheet-left-${column.id}, 0px)`,
      "--timesheet-cell-right": `var(--timesheet-right-${end.id}, 0px)`,
      "--timesheet-header-layer": (pin ? 1000 : 100) - index,
    } as CSSProperties,
    ...{ "data-timesheet-column-id": column.id, "data-timesheet-pin": pin ?? "none" },
  });
}

/** Reorder React cells together with their original date/value/edit callbacks. */
export function arrangeTimesheetCells(children: ReactNode, view: ColumnView) {
  const source = new Map(cells(children).map((cell, index) => [view.sourceIds[index], cell]));
  return view.columns.map((column, index) => {
    const cell = source.get(column.id);
    return cell ? decorate(cell, column, index) : null;
  });
}

/** Split the month heading where pinned dates form a separate frozen group. */
export function arrangeTimesheetHeaders(first: ReactNode, days: ReactNode, view: ColumnView) {
  const source = new Map<string, Cell>();
  for (const cell of [...cells(first), ...cells(days)]) {
    const handle = cells(cell.props.children).find(child => "data-resize-owner" in child.props);
    const id = handle && (handle.props as Record<string, unknown>)["data-resize-owner"];
    if (typeof id === "string") source.set(id, cell);
  }
  const top: ReactNode[] = [], bottom: ReactNode[] = [];
  for (let index = 0; index < view.columns.length;) {
    const column = view.columns[index];
    if (!column.id.startsWith("day-")) {
      const cell = source.get(column.id);
      if (cell) top.push(decorate(cell, column, index));
      index++;
      continue;
    }
    const start = index;
    while (index < view.columns.length && view.columns[index].id.startsWith("day-") && side(view.columns[index]) === side(column)) index++;
    const last = view.columns[index - 1];
    top.push(decorate(<th colSpan={index - start} className="timesheet-month-column-group">Дни месяца</th>, column, start, last));
    for (let day = start; day < index; day++) {
      const cell = source.get(view.columns[day].id);
      if (cell) bottom.push(decorate(cell, view.columns[day], day));
    }
  }
  return <><tr>{top}</tr><tr>{bottom}</tr></>;
}

/** Merge only adjacent metadata with the same pin, retaining exact total tracks. */
export function arrangeTimesheetFooter(children: ReactNode, view: ColumnView) {
  const original = cells(children);
  if (!original.length) return null;
  const metadata = new Set(view.sourceIds.slice(0, view.metadataCount));
  const source = new Map<string, Cell>(view.sourceIds.slice(view.metadataCount).map((id, index) => [id, original[index + 1]]));
  const groups: { start: number; end: number }[] = [];
  for (let index = 0; index < view.columns.length;) {
    if (!metadata.has(view.columns[index].id)) { index++; continue; }
    const start = index, pin = side(view.columns[index]);
    while (index < view.columns.length && metadata.has(view.columns[index].id) && side(view.columns[index]) === pin) index++;
    groups.push({ start, end: index });
  }
  const labelGroup = [...groups].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  const output: ReactNode[] = [];
  for (let index = 0; index < view.columns.length;) {
    const column = view.columns[index];
    const group = groups.find(group => group.start === index);
    if (group) {
      const merged = cloneElement(original[0], { colSpan: group.end - group.start,
        children: group === labelGroup ? original[0].props.children : null });
      output.push(decorate(merged, column, index, view.columns[group.end - 1]));
      index = group.end;
    } else {
      const cell = source.get(column.id);
      if (cell) output.push(decorate(cell, column, index));
      index++;
    }
  }
  return output;
}
