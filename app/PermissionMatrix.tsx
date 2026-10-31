"use client";

import {
  PERMISSION_ACTION_LABELS, PERMISSION_ACTIONS, PERMISSION_CATALOG, PERMISSION_GROUP_LABELS,
  type PermissionAction, type PermissionResource, type PermissionSet,
} from "./permissionModel";

const COMPACT_ACTION_LABELS: Record<PermissionAction, string> = {
  view: "Видеть", create: "Добавить", update: "Изменить", delete: "Удалить",
};

type CellPolicy = { allowed?: boolean; locked?: boolean; title?: string };

export function PermissionMatrix({ label, value, disabled = false, onChange, cellPolicy }: {
  label: string;
  value: PermissionSet;
  disabled?: boolean;
  onChange?: (resource: PermissionResource, action: PermissionAction, enabled: boolean) => void;
  cellPolicy?: (resource: PermissionResource, action: PermissionAction) => CellPolicy;
}) {
  return <div className="permission-matrix" role="table" aria-label={label}>
    <div className="permission-matrix-header" role="row"><span role="columnheader">Раздел системы</span>{PERMISSION_ACTIONS.map(action => <span role="columnheader" data-compact-label={COMPACT_ACTION_LABELS[action]} key={action}>{PERMISSION_ACTION_LABELS[action]}</span>)}</div>
    {(["reports", "timesheets", "general", "project"] as const).map(group => <section className="permission-group" key={group}>
      <h3>{PERMISSION_GROUP_LABELS[group]}</h3>
      {PERMISSION_CATALOG.filter(item => item.group === group).map(definition => <div className="permission-row" role="row" key={definition.key}>
        <div role="cell"><strong>{definition.title}</strong><span>{definition.description}</span></div>
        {PERMISSION_ACTIONS.map(action => {
          const supported = definition.actions.includes(action);
          const policy = cellPolicy?.(definition.key, action);
          const allowed = supported && policy?.allowed !== false;
          const title = !supported ? "Действие не применяется к этому разделу" : policy?.title ?? `${PERMISSION_ACTION_LABELS[action]}: ${definition.title}`;
          return <label key={action} className={`permission-cell${allowed ? "" : " unsupported"}`} title={title}>
            <input type="checkbox" aria-label={`${PERMISSION_ACTION_LABELS[action]}: ${definition.title}`} checked={allowed && value[definition.key][action]} disabled={disabled || !allowed || policy?.locked || !onChange} onChange={event => onChange?.(definition.key, action, event.target.checked)} />
            <span aria-hidden="true">✓</span>
          </label>;
        })}
      </div>)}
    </section>)}
  </div>;
}
