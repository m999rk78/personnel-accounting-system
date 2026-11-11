"use client";

import { useMemo } from "react";
import { useNativeTableSelectAll } from "./useNativeTableSelectAll";
import {
  PERMISSION_ACTION_LABELS, PERMISSION_ACTIONS, PERMISSION_CATALOG, PERMISSION_GROUP_LABELS,
  normalizePermissionSet,
  type PermissionAction, type PermissionResource, type PermissionSet,
} from "./permissionModel";

const COMPACT_ACTION_LABELS: Record<PermissionAction, string> = {
  view: "Видеть", create: "Добавить", update: "Изменить", delete: "Удалить",
};
export const PERMISSION_TABLE_CLIPBOARD_HEADERS = ["Раздел системы", ...PERMISSION_ACTIONS.map(action => PERMISSION_ACTION_LABELS[action])];

type CellPolicy = { allowed?: boolean; locked?: boolean; title?: string };

export function permissionTableClipboardRows(definitions: readonly { key: PermissionResource; title: string; description: string; actions: readonly PermissionAction[] }[], value: PermissionSet, compact: boolean, cellPolicy?: (resource: PermissionResource, action: PermissionAction) => CellPolicy) {
  return definitions.map(definition => [compact ? definition.title : `${definition.title}\n${definition.description}`, ...PERMISSION_ACTIONS.map(action => {
    const allowed = definition.actions.includes(action) && cellPolicy?.(definition.key, action)?.allowed !== false;
    return allowed ? value[definition.key][action] ? "Да" : "Нет" : "—";
  })]);
}

export function PermissionMatrix({ label, value, disabled = false, onChange, cellPolicy, compact = false, search = "" }: {
  label: string;
  value: PermissionSet;
  disabled?: boolean;
  onChange?: (resource: PermissionResource, action: PermissionAction, enabled: boolean) => void;
  cellPolicy?: (resource: PermissionResource, action: PermissionAction) => CellPolicy;
  compact?: boolean;
  search?: string;
}) {
  const query = search.trim().toLocaleLowerCase("ru-RU");
  const normalized = useMemo(() => normalizePermissionSet(value), [value]);
  const definitions = useMemo(() => {
    const matches = (item: typeof PERMISSION_CATALOG[number]) => !query || `${item.title} ${item.description} ${PERMISSION_GROUP_LABELS[item.group]}`.toLocaleLowerCase("ru-RU").includes(query);
    return PERMISSION_CATALOG.filter(item => matches(item) || item.parent && PERMISSION_CATALOG.some(parent => parent.key === item.parent && matches(parent)) || PERMISSION_CATALOG.some(child => child.parent === item.key && matches(child)));
  }, [query]);
  const clipboardRows = useMemo(() => permissionTableClipboardRows(definitions, normalized, compact, cellPolicy), [definitions, normalized, compact, cellPolicy]);
  const { ref: selectionRef, className: selectionClass, handlers: selectionHandlers } = useNativeTableSelectAll({ rows: clipboardRows, headers: PERMISSION_TABLE_CLIPBOARD_HEADERS, resetKey: `${label}:${query}` });
  return <div ref={selectionRef} className={`permission-matrix${compact ? " compact" : ""} ${selectionClass}`} role="grid" aria-label={label} tabIndex={0} {...selectionHandlers}>
    <div className="permission-matrix-header" role="row"><span role="columnheader">Раздел системы</span>{PERMISSION_ACTIONS.map(action => <span role="columnheader" data-compact-label={COMPACT_ACTION_LABELS[action]} key={action}>{PERMISSION_ACTION_LABELS[action]}</span>)}</div>
    {Object.entries(PERMISSION_GROUP_LABELS).filter(([group]) => definitions.some(item => item.group === group)).map(([group, title]) => <section className="permission-group" key={group}>
      <h3>{title}</h3>
      {group === "reports" && <p className="permission-report-help">Общие права ограничивают весь отчёт. Для каждой вкладки можно отдельно разрешить просмотр, добавление, изменение и удаление.</p>}
      {definitions.filter(item => item.group === group).map(definition => <div className={`permission-row${definition.parent ? " permission-status-row" : definition.group === "reports" ? " permission-report-row" : ""}`} role="row" key={definition.key} data-permission-resource={definition.key}>
        <div role="cell" title={definition.description}><strong>{definition.shortTitle ?? definition.title}</strong>{(!compact || definition.parent) && <span>{definition.description}</span>}</div>
        {PERMISSION_ACTIONS.map(action => {
          const supported = definition.actions.includes(action);
          const policy = cellPolicy?.(definition.key, action);
          const allowed = supported && policy?.allowed !== false;
          const title = !supported ? "Действие не применяется к этому разделу" : policy?.title ?? `${PERMISSION_ACTION_LABELS[action]}: ${definition.title}`;
          return <label key={action} className={`permission-cell${allowed ? "" : " unsupported"}`} title={title}>
            <input type="checkbox" aria-label={`${PERMISSION_ACTION_LABELS[action]}: ${definition.title}`} checked={allowed && normalized[definition.key][action]} disabled={disabled || !allowed || policy?.locked || !onChange} onChange={event => onChange?.(definition.key, action, event.target.checked)} />
            <span aria-hidden="true">✓</span>
          </label>;
        })}
      </div>)}
    </section>)}
    {!definitions.length && <p className="roles-no-results">Разделы не найдены</p>}
  </div>;
}
