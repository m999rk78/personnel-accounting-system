"use client";

import { Fragment, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const OPEN_EVENT = "resource-report:table-context-menu";
export function closeTableContextMenus() {
  document.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export type TableContextMenuAction = {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  separatorBefore?: boolean;
  onSelect: () => void | Promise<void>;
};

export function TableContextMenu({ x, y, caption, value, error, actions, onClose, ariaLabel = "Действия с ячейкой таблицы" }: {
  x: number;
  y: number;
  caption: string;
  value: string;
  error?: string;
  actions: TableContextMenuAction[];
  onClose: () => void;
  ariaLabel?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOther = (event: Event) => {
      if ((event as CustomEvent).detail !== menuRef.current) onClose();
    };
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener(OPEN_EVENT, closeOther);
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: menuRef.current }));
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener(OPEN_EVENT, closeOther);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(<div
    ref={menuRef}
    className="table-context-menu"
    role="menu"
    aria-label={ariaLabel}
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
