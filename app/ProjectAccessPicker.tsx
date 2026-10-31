"use client";

import { useMemo, useState } from "react";
import type { ProjectAccess } from "./roles";

export type ProjectAccessOption = { id: number; name: string };

export function ProjectAccessPicker({ value, sites, onChange, disabled = false }: {
  value: ProjectAccess; sites: readonly ProjectAccessOption[]; onChange: (value: ProjectAccess) => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(value.siteIds), [value.siteIds]);
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
    return sites.filter(site => site.name.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").includes(search));
  }, [query, sites]);
  return <section className="project-access-picker" aria-label="Доступ к проектам">
    <div className="project-access-mode" role="group" aria-label="Область доступа к проектам">
      <button type="button" aria-pressed={value.mode === "all"} disabled={disabled} onClick={() => onChange({ mode: "all", siteIds: [] })}>Все проекты</button>
      <button type="button" aria-pressed={value.mode === "selected"} disabled={disabled} onClick={() => onChange({ mode: "selected", siteIds: value.siteIds })}>Выбранные проекты</button>
    </div>
    {value.mode === "all" ? <p className="project-access-summary">Доступ ко всем текущим и новым проектам.</p> : <>
      <div className="project-access-list-toolbar"><label><span className="sr-only">Найти проект</span><input type="search" aria-label="Найти проект" placeholder="Найти проект…" value={query} onChange={event => setQuery(event.target.value)} /></label><span>Выбрано: {value.siteIds.length}</span><button type="button" disabled={disabled || !value.siteIds.length} onClick={() => onChange({ mode: "selected", siteIds: [] })}>Снять все</button></div>
      <div className="project-access-list" role="group" aria-label="Выбранные проекты">
        {visible.map(site => <label key={site.id}><input type="checkbox" checked={selected.has(site.id)} disabled={disabled} onChange={event => onChange({ mode: "selected", siteIds: event.target.checked ? [...new Set([...value.siteIds, site.id])] : value.siteIds.filter(id => id !== site.id) })} /><span>{site.name}</span></label>)}
        {!visible.length && <p>{sites.length ? "Проекты не найдены" : "Нет доступных проектов"}</p>}
      </div>
      {!value.siteIds.length && <p className="project-access-summary">Доступ к проектам закрыт. Отметьте проекты, которые пользователь должен видеть.</p>}
    </>}
  </section>;
}
