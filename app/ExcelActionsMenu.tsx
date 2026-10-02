"use client";

import { useEffect, useRef, useState } from "react";

export type ExcelMenuAction = {
  label: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
};

export function ExcelActionsMenu({ actions, label = "Excel" }: { actions: ExcelMenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="excel-menu" ref={root}>
    <button type="button" className="excel-menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span>{label}</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
    </button>
    {open && <div className="excel-menu-popover" role="menu" aria-label="Действия с Excel">
      {actions.map((action) => <button type="button" role="menuitem" key={action.label} disabled={action.disabled} onClick={() => { setOpen(false); void action.onSelect(); }}>{action.label}</button>)}
    </div>}
  </div>;
}
