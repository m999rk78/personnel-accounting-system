"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import { ColumnFilterIcon } from "./ColumnFilterIcon";
import "./gridFilters.css";

export type TimesheetFiltersContextValue = {
  open: (columnId: string, trigger: HTMLElement, wasOpen?: boolean) => void;
  openColumnId: string | null;
  presentation?: "full" | "compact" | "checklist";
  activeColumns: ReadonlySet<string>;
  sorts: ReadonlyMap<string, { direction: "asc" | "desc"; priority: number }>;
};
const TimesheetFiltersContext = createContext<TimesheetFiltersContextValue | null>(null);
export const TimesheetFiltersProvider = TimesheetFiltersContext.Provider;

export function TimesheetColumnFilter({ columnId, label, compact = false }: { columnId: string; label: string; compact?: boolean }) {
  const filters = useContext(TimesheetFiltersContext);
  const openOnPointerDown = useRef<boolean | null>(null);
  const sort = filters?.sorts.get(columnId);
  const active = filters?.activeColumns.has(columnId) || Boolean(sort);
  const title = `${filters?.presentation === "compact" || filters?.presentation === "checklist" ? "Фильтр" : "Фильтр и сортировка"}: ${label}`;
  return <button type="button" className={["timesheet-header-filter", active ? "active" : "", compact ? "compact" : ""].filter(Boolean).join(" ")}
    title={title} aria-label={title} aria-haspopup="dialog" aria-expanded={filters?.openColumnId === columnId}
    onPointerDownCapture={() => { openOnPointerDown.current = filters?.openColumnId === columnId; }}
    onKeyDownCapture={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
    onClick={event => {
      event.stopPropagation();
      const wasOpen = event.detail > 0 ? openOnPointerDown.current ?? filters?.openColumnId === columnId : filters?.openColumnId === columnId;
      openOnPointerDown.current = null;
      filters?.open(columnId, event.currentTarget, wasOpen);
    }}>
    <span className="timesheet-header-filter-icon" aria-hidden="true"><ColumnFilterIcon /></span>
    {sort && <span className="timesheet-sort-indicator" aria-hidden="true">{sort.direction === "asc" ? "↑" : "↓"}{sort.priority > 1 ? sort.priority : ""}</span>}
  </button>;
}

export function TimesheetFilterableHeading({ children, ...props }: { children: ReactNode; columnId: string; label: string; compact?: boolean }) {
  return <span className={["timesheet-filterable-heading", props.compact ? "compact" : ""].filter(Boolean).join(" ")}>
    <span className="timesheet-filterable-heading-label">{children}</span><TimesheetColumnFilter {...props}/>
  </span>;
}
