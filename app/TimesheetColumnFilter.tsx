"use client";

import { createContext, useContext, type ReactNode } from "react";
import "./gridFilters.css";

export type TimesheetFiltersContextValue = {
  open: (columnId: string, trigger: HTMLButtonElement) => void;
  openColumnId: string | null;
  activeColumns: ReadonlySet<string>;
  sorts: ReadonlyMap<string, { direction: "asc" | "desc"; priority: number }>;
};
const TimesheetFiltersContext = createContext<TimesheetFiltersContextValue | null>(null);
export const TimesheetFiltersProvider = TimesheetFiltersContext.Provider;

export function TimesheetColumnFilter({ columnId, label, compact = false }: { columnId: string; label: string; compact?: boolean }) {
  const filters = useContext(TimesheetFiltersContext);
  const sort = filters?.sorts.get(columnId);
  const active = filters?.activeColumns.has(columnId) || Boolean(sort);
  return <button type="button" className={["timesheet-header-filter", active ? "active" : "", compact ? "compact" : ""].filter(Boolean).join(" ")}
    title={`Фильтр и сортировка: ${label}`} aria-label={`Фильтр и сортировка: ${label}`} aria-haspopup="dialog" aria-expanded={filters?.openColumnId === columnId}
    onClick={event => { event.stopPropagation(); filters?.open(columnId, event.currentTarget); }}>
    <span className="timesheet-header-filter-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" /></svg></span>
    {sort && <span className="timesheet-sort-indicator" aria-hidden="true">{sort.direction === "asc" ? "↑" : "↓"}{sort.priority > 1 ? sort.priority : ""}</span>}
  </button>;
}

export function TimesheetFilterableHeading({ children, ...props }: { children: ReactNode; columnId: string; label: string; compact?: boolean }) {
  return <span className={["timesheet-filterable-heading", props.compact ? "compact" : ""].filter(Boolean).join(" ")}>
    <span className="timesheet-filterable-heading-label">{children}</span><TimesheetColumnFilter {...props}/>
  </span>;
}
