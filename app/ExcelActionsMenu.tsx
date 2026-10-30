"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { choiceMenuPosition, choiceMenuWidth, type ChoiceMenuPosition } from "./choiceMenuLayout";

export type ExcelMenuAction = {
  label: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
};

export function ExcelActionsMenu({ actions, label = "Excel" }: { actions: ExcelMenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ChoiceMenuPosition | null>(null);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const focusedForOpen = useRef(false);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    focusedForOpen.current = false;
    if (restoreFocus) trigger.current?.focus();
  }, []);
  const updatePosition = useCallback(() => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = choiceMenuWidth(trigger.current, actions.map(action => action.label), 190);
    const next = choiceMenuPosition({ top: rect.top, bottom: rect.bottom, width: rect.width, left: rect.right - width }, { width: window.innerWidth, height: window.innerHeight }, width, actions.length * 40 + 12);
    // Align the popup to physical pixels even when its trigger has fractional coordinates.
    const pixelRatio = window.devicePixelRatio || 1;
    const snap = (value: number) => Math.round(value * pixelRatio) / pixelRatio;
    setPosition({
      ...next,
      left: snap(next.left),
      top: next.top === undefined ? undefined : snap(next.top),
      bottom: next.bottom === undefined ? undefined : snap(next.bottom),
    });
  }, [actions]);
  const openMenu = (last = false) => {
    focusLast.current = last;
    focusedForOpen.current = false;
    setPortalHost(root.current?.closest("dialog[open]") ?? document.body);
    if (open) updatePosition();
    else setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const viewportChanged = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      updatePosition();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", viewportChanged);
    window.addEventListener("scroll", viewportChanged, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", viewportChanged);
      window.removeEventListener("scroll", viewportChanged, true);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    if (!open || !portalHost || !position || focusedForOpen.current) return;
    const frame = requestAnimationFrame(() => {
      if (!menu.current) return;
      focusedForOpen.current = true;
      const buttons = menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (buttons?.length) buttons[focusLast.current ? buttons.length - 1 : 0].focus();
      else menu.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, portalHost, position]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    // Let the browser continue tabbing from the trigger, rather than the body portal.
    if (event.key === "Tab") { close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  return <div className="excel-menu" ref={root}>
    <button ref={trigger} type="button" className="excel-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => open ? close() : openMenu()} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(event.key === "ArrowUp"); }
    }}>
      <span>{label}</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
    </button>
    {open && position && portalHost && createPortal(<div ref={menu} id={menuId} className="excel-menu-popover" role="menu" aria-label="Действия с Excel" tabIndex={-1} onKeyDown={navigate} style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.maxHeight }}>
      {actions.map((action) => <button type="button" role="menuitem" key={action.label} disabled={action.disabled} onClick={() => { close(true); void action.onSelect(); }}>{action.label}</button>)}
    </div>, portalHost)}
  </div>;
}
