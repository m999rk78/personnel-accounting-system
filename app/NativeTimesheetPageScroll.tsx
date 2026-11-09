"use client";

import { useMemo, type ReactNode, type RefObject } from "react";
import { TablePageScroll, type TablePageScrollSource } from "./TablePageScroll";

/** Native timesheets retain their existing row window and frozen table cells. */
export function NativeTimesheetPageScroll({ viewportRef, rowCount, rowHeight = 46, geometryKey, label, children }: {
  viewportRef: RefObject<HTMLDivElement | null>;
  rowCount: number;
  rowHeight?: number;
  geometryKey: string;
  label: string;
  children: ReactNode;
}) {
  const source = useMemo<TablePageScrollSource>(() => ({
    getViewport: () => viewportRef.current,
    getContentHeight: () => {
      const viewport = viewportRef.current;
      if (!viewport) return 0;
      const table = viewport.querySelector<HTMLTableElement>("table.timesheet-table");
      if (!table) return viewport.querySelector<HTMLElement>(".timesheet-loading")?.getBoundingClientRect().height ?? 0;
      const headerHeight = table.tHead?.getBoundingClientRect().height ?? 0;
      const footerHeight = table.tFoot?.getBoundingClientRect().height ?? 0;
      const measuredRow = table.querySelector<HTMLElement>("tr[data-virtual-row]")?.getBoundingClientRect().height || rowHeight;
      // The filler row stretches to the viewport, so measuring the whole table
      // would retain a long page after filtering down to a short or empty list.
      const emptyBody = rowCount ? 0 : table.querySelector<HTMLElement>(".equipment-table-empty")?.getBoundingClientRect().height ?? 0;
      return headerHeight + rowCount * measuredRow + emptyBody + footerHeight;
    },
  }), [viewportRef, rowCount, rowHeight]);

  return <TablePageScroll gridRoot={viewportRef} source={source} geometryKey={geometryKey} label={label}>
    {children}
  </TablePageScroll>;
}
