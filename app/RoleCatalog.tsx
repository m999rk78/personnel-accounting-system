"use client";

import { useState } from "react";
import type { CustomRole } from "./customRoles";
import { rolePermissionTemplate } from "./permissionModel";

const builtins: CustomRole[] = [{ id: -1, name: "Супер-админ", baseRole: "engineer", permissions: rolePermissionTemplate("superadmin"), revision: 1 }];

export function RoleCatalog({ roles, canManage, busy, onOpen, onDelete }: {
  roles: CustomRole[]; canManage: boolean; busy: boolean; onOpen: (role: CustomRole) => void; onDelete: (role: CustomRole) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase("ru-RU");
  const visible = [...builtins, ...roles].filter(role => !needle || role.name.toLocaleLowerCase("ru-RU").includes(needle));
  return <section className="role-catalog" aria-label="Справочник ролей">
    <label className="role-catalog-search"><span>Найти роль</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название роли"/></label>
    <div className="role-catalog-list">{visible.map(role => <article className="role-catalog-row" key={role.id}>
      <div><button type="button" className="role-catalog-name" disabled={busy} onClick={() => onOpen(role)}>{role.name}</button><span>{role.id < 0 ? "Системная" : "Созданная роль"}</span></div>
      <div className="role-catalog-actions"><button type="button" disabled={busy} onClick={() => onOpen(role)}>{canManage && role.id > 0 ? "Редактировать" : "Просмотреть"}</button>{canManage && role.id > 0 && <button type="button" className="role-catalog-delete" disabled={busy} onClick={() => onDelete(role)} aria-label={`Удалить роль ${role.name}`}>Удалить</button>}</div>
    </article>)}</div>
    {!visible.length && <p className="role-catalog-empty">Роли не найдены</p>}
  </section>;
}
