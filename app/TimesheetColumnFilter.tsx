"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./gridFilters.css";

export type TimesheetFilterOption = { value: string; label: string };
export type TimesheetSortOption = { value: string; label: string };

export const TIMESHEET_ALL_OPTION: TimesheetFilterOption = { value: "all", label: "Все значения" };

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

export function TimesheetColumnFilter({ label, value, options, onChange, compact = false, sortValue = "", sortOptions = [], defaultSortValue = "", onSortChange }: {
  label: string;
  value: string[];
  options: readonly TimesheetFilterOption[];
  onChange: (value: string[]) => void;
  compact?: boolean;
  sortValue?: string;
  sortOptions?: readonly TimesheetSortOption[];
  defaultSortValue?: string;
  onSortChange?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(value);
  const [draftSort, setDraftSort] = useState(sortValue);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const available = useMemo(() => options.filter((option) => option.value !== "all"), [options]);
  const matching = useMemo(() => available.filter((option) => normalize(option.label).includes(normalize(search))), [available, search]);
  const selected = new Set(draft);
  const matchingSelected = matching.filter((option) => selected.has(option.value)).length;

  useEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(348, window.innerWidth - 24);
      const height = Math.min(470, window.innerHeight - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const top = rect.bottom + 7 + height <= window.innerHeight ? rect.bottom + 7 : Math.max(12, rect.top - height - 7);
      setPosition({ top, left });
    }
    const focusTask = window.setTimeout(() => searchInput.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTask);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle() {
    if (!open) {
      setDraft(value);
      setDraftSort(sortValue);
      setSearch("");
    }
    setOpen((current) => !current);
  }

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    toggle();
  }

  function toggleOption(optionValue: string, checked: boolean) {
    setDraft((current) => checked ? [...new Set([...current, optionValue])] : current.filter((item) => item !== optionValue));
  }

  const popup = open && typeof document !== "undefined" ? createPortal(
    <div className="timesheet-filter-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
    <div className="timesheet-filter-popover personnel-filter" ref={popover} role="dialog" aria-modal="false" aria-label={`Настройка фильтра и сортировки: ${label}`} style={{ top: position.top, left: position.left }}>
      <div className="grid-filter-heading"><strong>{label}</strong><span>{sortOptions.length > 0 ? "Фильтр и порядок строк" : "Фильтр по значениям"}</span></div>
      {sortOptions.length > 0 && <div className="timesheet-filter-sort-section">
        <span>Сортировка</span>
        <div>{sortOptions.map((option) => <button type="button" key={option.value} className={draftSort === option.value ? "selected" : ""} onClick={() => setDraftSort(option.value)}>{option.label}</button>)}</div>
      </div>}
      <label className="grid-filter-search"><span className="sr-only">Поиск значений</span><input ref={searchInput} placeholder="Найти значение…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="grid-filter-selection">
        <label className="grid-value-option"><input type="checkbox" checked={matching.length > 0 && matchingSelected === matching.length} onChange={(event) => {
          const next = new Set(draft);
          matching.forEach((option) => { if (event.target.checked) next.add(option.value); else next.delete(option.value); });
          setDraft([...next]);
        }} /><span>{search ? "Выбрать найденные" : "Выбрать все"}</span></label>
        <button type="button" onClick={() => setDraft([])}>Все значения</button>
      </div>
      <div className="grid-filter-values timesheet-filter-values">
        {matching.length > 0 ? matching.map((option) => <label className="grid-value-option" key={option.value}><input type="checkbox" checked={selected.has(option.value)} onChange={(event) => toggleOption(option.value, event.target.checked)} /><span title={option.label}>{option.label}</span></label>) : <p>Значения не найдены</p>}
      </div>
      <p className="grid-filter-preview" role="status">{draft.length > 0 ? `Выбрано значений: ${draft.length}` : "Показаны все значения"}</p>
      <div className="timesheet-filter-popover-actions">
        <button type="button" onClick={() => { onChange([]); onSortChange?.(defaultSortValue); setOpen(false); }}>Сбросить</button>
        <button type="button" onClick={() => setOpen(false)}>Отмена</button>
        <button type="button" className="apply" onClick={() => { onChange(draft); onSortChange?.(draftSort); setOpen(false); }}>Применить</button>
      </div>
    </div>
    </div>,
    document.body,
  ) : null;

  return <>
    <button ref={trigger} type="button" className={["timesheet-header-filter", value.length > 0 || Boolean(sortValue && sortValue !== defaultSortValue) ? "active" : "", compact ? "compact" : ""].filter(Boolean).join(" ")} title={`${sortOptions.length > 0 ? "Фильтр и сортировка" : "Фильтр"}: ${label}`} aria-label={`${sortOptions.length > 0 ? "Фильтр и сортировка" : "Фильтр"}: ${label}`} aria-expanded={open} onClick={handleClick}>
      <span className="timesheet-header-filter-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" /></svg></span>
    </button>
    {popup}
  </>;
}

export function TimesheetFilterableHeading({ children, label, value, options, onChange, compact = false, sortValue, sortOptions, defaultSortValue, onSortChange }: {
  children: ReactNode;
  label: string;
  value: string[];
  options: readonly TimesheetFilterOption[];
  onChange: (value: string[]) => void;
  compact?: boolean;
  sortValue?: string;
  sortOptions?: readonly TimesheetSortOption[];
  defaultSortValue?: string;
  onSortChange?: (value: string) => void;
}) {
  return <span className={["timesheet-filterable-heading", compact ? "compact" : ""].filter(Boolean).join(" ")}>
    <span className="timesheet-filterable-heading-label">{children}</span>
    <TimesheetColumnFilter label={label} value={value} options={options} onChange={onChange} compact={compact} sortValue={sortValue} sortOptions={sortOptions} defaultSortValue={defaultSortValue} onSortChange={onSortChange} />
  </span>;
}
