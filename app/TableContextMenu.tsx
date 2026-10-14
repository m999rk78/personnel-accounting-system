"use client";

import { Fragment, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type TableContextMenuAction = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  separatorBefore?: boolean;
  onSelect: () => void | Promise<void>;
};

export function TableContextMenu({ x, y, caption, value, error, actions, onClose }: {
  x: number;
  y: number;
  caption: string;
  value: string;
  error?: string;
  actions: TableContextMenuAction[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(<div
    ref={menuRef}
    className="table-context-menu"
    role="menu"
    aria-label="Действия с ячейкой таблицы"
    tabIndex={-1}
    style={{ left: x, top: y }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    <div className="table-context-menu-caption"><span>{caption}</span><strong title={value}>{value || "Пустая ячейка"}</strong></div>
    {actions.map((action, index) => <Fragment key={`${action.label}-${index}`}>
      {action.separatorBefore && <div className="table-context-menu-separator" role="separator" />}
      <button
        type="button"
        role="menuitem"
        className={action.danger ? "danger" : undefined}
        disabled={action.disabled}
        title={action.title}
        onClick={() => { if (!action.disabled) void action.onSelect(); }}
      ><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>
    </Fragment>)}
    {error && <p role="status">{error}</p>}
  </div>, document.body);
}
