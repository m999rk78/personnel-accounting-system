"use client";
/* eslint-disable @next/next/no-img-element -- original TPS SVG logo */

import { useEffect, useRef, useState, type RefObject } from "react";
import { userRoleLabel } from "../userAccessModel";
import { SidebarToggleButton } from "../SidebarToggleButton";
import type { Site, CurrentUser, View, DirectoryFocus } from "./types";

type AppIconName = "user" | "workersReport" | "equipmentReport" | "workersTimesheet" | "equipmentTimesheet" | "settings" | "generalSettings" | "projectSettings";

export function AppIcon({ name }: { name: AppIconName; }) {
  return <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">







    {name === "user" && <><circle cx="12" cy="8" r="4" /><path d="M4 22a8 8 0 0 1 16 0" /></>}

    {name === "workersReport" && <><path d="M6.5 10a5.5 5.5 0 0 1 11 0M5 10h14M9 10v1.5a3 3 0 0 0 6 0V10M12 4.5V7" /><path d="M4 21a8 8 0 0 1 16 0" /></>}
    {name === "equipmentReport" && <><path d="M5 21h9M8 21V7h3v14M8 9l3 3-3 3 3 3-3 3" /><path d="M3 7h18M8 7l4-4h3l3 4M3 5v4" /><path d="M19 7v7M19 14v2.5a2 2 0 0 1-4 0" /></>}
    {name === "workersTimesheet" && <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 9h18" /><circle cx="9" cy="13" r="2" /><path d="M6 19c.4-2 1.4-3 3-3s2.6 1 3 3M15 15l1.5 1.5L20 13" /></>}
    {name === "equipmentTimesheet" && <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 9h18" /><circle cx="10" cy="15" r="3" /><path d="M10 11v1M10 18v1M6 15h1M13 15h1M7.2 12.2l.7.7M12.1 17.1l.7.7M12.8 12.2l-.7.7M7.9 17.1l-.7.7M16 16l1.5 1.5L21 14" /></>}
    {name === "settings" && <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4.05v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z" /></>}
    {name === "generalSettings" && <><path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h4M12 12h8" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /><circle cx="10" cy="12" r="2" /></>}
    {name === "projectSettings" && <><path d="M4 21h16M6 21V7l6-3 6 3v14M9 10h2M13 10h2M9 14h2M13 14h2M10 21v-3h4v3" /></>}
  </svg>;
}

function SidebarChevron({ open }: { open: boolean; }) {
  return <svg className={open ? "sidebar-chevron open" : "sidebar-chevron"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m7 9 5 5 5-5" />
  </svg>;
}

function ProjectSwitcher({ sites, value, onChange }: { sites: Site[]; value: number; onChange: (siteId: number) => void; }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = sites.find((site) => site.id === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <div className="project-switcher top-project-select" ref={root}>
    <button type="button" className="project-switcher-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label="Выбрать проект"><span>{selected?.name ?? "Выберите проект"}</span><SidebarChevron open={open} /></button>
    {open && <div className="project-switcher-menu" role="listbox" aria-label="Проекты"><div className="project-switcher-caption">Выберите проект</div>{sites.map((site) => <button type="button" role="option" aria-selected={site.id === value} className={site.id === value ? "selected" : ""} key={site.id} onClick={() => { onChange(site.id); setOpen(false); }}><span className="project-switcher-mark">{site.id === value ? "✓" : ""}</span><strong>{site.name}</strong></button>)}</div>}
  </div>;
}

type WorkspaceSidebarProps = {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  visibleSites: Site[];
  siteId: number;
  activeSite: Site | undefined;
  mayViewAllProjects: boolean;
  mayViewWorkersReport: boolean;
  mayViewWorkersTimesheet: boolean;
  mayViewEquipmentReport: boolean;
  mayViewEquipmentTimesheet: boolean;
  mayAccessGeneralSettings: boolean;
  mayAccessProjectSettings: boolean;
  view: View;
  navigateTo: (view: View, focus?: DirectoryFocus) => Promise<boolean>;
  fallbackView: View;
  changeSite: (siteId: number) => Promise<void>;
  currentUser: CurrentUser;
  openProfile: () => void;
};

export function WorkspaceSidebar({ sidebarOpen, toggleSidebar, sidebarToggleRef, visibleSites, siteId, activeSite, mayViewAllProjects, mayViewWorkersReport, mayViewWorkersTimesheet, mayViewEquipmentReport, mayViewEquipmentTimesheet, mayAccessGeneralSettings, mayAccessProjectSettings, view, navigateTo, fallbackView, changeSite, currentUser, openProfile }: WorkspaceSidebarProps) {
  const [equipmentOpen, setEquipmentOpen] = useState(true);
  const [personnelOpen, setPersonnelOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  return <aside className="sidebar" id="primary-sidebar">
    <div className="brand-project-row"><button type="button" className="brand" onClick={() => { setEquipmentOpen(true); setPersonnelOpen(true); navigateTo(fallbackView); }} aria-label="Открыть доступный раздел" title="Открыть доступный раздел"><img src="/tps-logo.svg" alt="" /></button>{mayViewAllProjects ? <ProjectSwitcher sites={visibleSites} value={siteId} onChange={changeSite} /> : <div className="project-fixed-card top-project-select" title={activeSite?.name ?? "Нет доступа к проектам"}>{activeSite?.name ?? "Нет доступа к проектам"}</div>}</div>
    <div className="sidebar-product-title"><span>Ресурсный отчёт</span><SidebarToggleButton expanded={sidebarOpen} onToggle={toggleSidebar} buttonRef={sidebarToggleRef} /></div>
    <nav aria-label="Основная навигация">
      {(mayViewWorkersReport || mayViewWorkersTimesheet) && <div className="nav-group">
        <button type="button" className="nav-heading" onClick={() => setPersonnelOpen((open) => !open)} aria-expanded={personnelOpen} aria-controls="personnel-navigation" aria-label={personnelOpen ? "Свернуть раздел «Персонал»" : "Развернуть раздел «Персонал»"}><span className="nav-heading-icon"><AppIcon name="workersReport" /></span><span>Персонал</span><SidebarChevron open={personnelOpen} /></button>
        {(personnelOpen || !sidebarOpen) && <div className="nav-sub" id="personnel-navigation">{mayViewWorkersReport && <button className={view === "placement" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("placement")} aria-label="Отчёт персонала" title="Отчёт персонала"><span className="nav-item-icon"><AppIcon name="workersReport" /></span>Отчёт персонала</button>}{mayViewWorkersTimesheet && <button className={view === "timesheet" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("timesheet")} aria-label="Табель персонала" title="Табель персонала"><span className="nav-item-icon"><AppIcon name="workersTimesheet" /></span>Табель персонала</button>}</div>}
      </div>}
      {(mayViewEquipmentReport || mayViewEquipmentTimesheet) && <div className="nav-group">
        <button type="button" className="nav-heading" onClick={() => setEquipmentOpen((open) => !open)} aria-expanded={equipmentOpen} aria-controls="equipment-navigation" aria-label={equipmentOpen ? "Свернуть раздел «Техника»" : "Развернуть раздел «Техника»"}><span className="nav-heading-icon"><AppIcon name="equipmentReport" /></span><span>Техника</span><SidebarChevron open={equipmentOpen} /></button>
        {(equipmentOpen || !sidebarOpen) && <div className="nav-sub" id="equipment-navigation">{mayViewEquipmentReport && <button className={view === "equipment" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("equipment")} aria-label="Отчёт техники" title="Отчёт техники"><span className="nav-item-icon"><AppIcon name="equipmentReport" /></span>Отчёт техники</button>}{mayViewEquipmentTimesheet && <button className={view === "equipmentTimesheet" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("equipmentTimesheet")} aria-label="Табель техники" title="Табель техники"><span className="nav-item-icon"><AppIcon name="equipmentTimesheet" /></span>Табель техники</button>}</div>}
      </div>}
    </nav>
    <div className="sidebar-bottom">{(mayAccessGeneralSettings || mayAccessProjectSettings) && <div className="nav-group settings-group">
      <button type="button" className="nav-heading" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen} aria-controls="settings-navigation" aria-label={settingsOpen ? "Свернуть раздел «Настройки»" : "Развернуть раздел «Настройки»"}><span className="nav-heading-icon"><AppIcon name="settings" /></span><span>Настройки</span><SidebarChevron open={settingsOpen} /></button>
      {(settingsOpen || !sidebarOpen) && <div className="nav-sub" id="settings-navigation">
        {mayAccessGeneralSettings && <button className={view === "settings" || view === "users" || view === "employees" || view === "positions" || view === "projects" || view === "equipmentRegistry" || view === "auditLog" || view === "accessRights" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("settings")} aria-label="Общие настройки" title="Общие настройки"><span className="nav-item-icon"><AppIcon name="generalSettings" /></span>Общие</button>}
        {mayAccessProjectSettings && <button className={view === "projectSettings" || view === "projectEmployees" || view === "projectEquipment" || view === "directories" ? "nav-item active" : "nav-item"} onClick={() => navigateTo("projectSettings")} aria-label="Настройки проекта" title="Настройки проекта"><span className="nav-item-icon"><AppIcon name="projectSettings" /></span>Настройки проекта</button>}
      </div>}
    </div>}
      <div className="sidebar-user"><div><strong>{currentUser.fullName}</strong><small>{userRoleLabel(currentUser)}</small></div><button className="profile-button" onClick={openProfile} title="Профиль" aria-label="Открыть профиль пользователя"><AppIcon name="user" /></button></div>
    </div>
  </aside>;
}
