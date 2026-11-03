"use client";

import "./usersRights.css";

export function UsersRightsNavigation({ active, canViewUsers, canViewRoles, onSelect, onBack, showBack = true }: {
  active: "users" | "roles";
  canViewUsers: boolean;
  canViewRoles: boolean;
  onSelect: (tab: "users" | "roles") => void;
  onBack: () => void;
  showBack?: boolean;
}) {
  const tabs = [
    ...(canViewUsers ? [{ key: "users" as const, title: "Пользователи" }] : []),
    ...(canViewRoles ? [{ key: "roles" as const, title: "Роли и права" }] : []),
  ];
  return <div className="users-rights-navigation">
    {showBack && <button type="button" className="users-rights-back" onClick={onBack}>← К общим настройкам</button>}
    <div className="users-rights-tabs" role="tablist" aria-label="Пользователи и права">
      {tabs.map((tab, index) => <button key={tab.key} type="button" role="tab" id={`users-rights-tab-${tab.key}`} aria-selected={active === tab.key} aria-controls={`users-rights-panel-${tab.key}`} tabIndex={active === tab.key ? 0 : -1} onClick={() => onSelect(tab.key)} onKeyDown={event => {
        const target = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (target < 0) return;
        event.preventDefault();
        document.getElementById(`users-rights-tab-${tabs[target].key}`)?.focus();
        onSelect(tabs[target].key);
      }}>{tab.title}</button>)}
    </div>
  </div>;
}
