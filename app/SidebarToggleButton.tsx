"use client";

import type { Ref } from "react";

export function SidebarToggleButton({ expanded, onToggle, buttonRef, className = "" }: {
  expanded: boolean;
  onToggle: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  const label = expanded ? "Свернуть меню" : "Развернуть меню";
  return <button ref={buttonRef} type="button" className={`sidebar-panel-toggle ${className}`} onClick={onToggle} aria-controls="primary-sidebar" aria-expanded={expanded} aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4.5h3v15H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5Z" fill="currentColor" fillOpacity=".14" stroke="none" />
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9 4.5v15" />
    </svg>
  </button>;
}
