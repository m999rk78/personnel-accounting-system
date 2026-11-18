"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeTableContextMenu } from "./tableContextMenuPlacement";
import "./tableContextMenu.css";

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
  section?: string;
  icon?: ReactNode;
  children?: TableContextMenuAction[];
  onSelect: () => void | Promise<void>;
};

function ActionIcon({ action }: { action: TableContextMenuAction }) {
  if (action.icon) return action.icon;
  const label = action.label.toLocaleLowerCase("ru-RU");
  let shape: ReactNode;
  if (action.danger || /удалить|очистить/.test(label)) shape = <><path d="M3 5h10M6 5V3h4v2M5 5l.5 8h5l.5-8M7 7v4M9 7v4" /></>;
  else if (/перейти|открыть|табель|справочник/.test(label)) shape = <><path d="M9 2h5v5M14 2 7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" /></>;
  else if (/перемещ|перенос|выше|ниже|начало|конец/.test(label)) shape = <><path d="M5 13V3m-3 3 3-3 3 3M11 3v10m-3-3 3 3 3-3" /></>;
  else if (/редактир/.test(label)) shape = <><path d="m10.5 2.5 3 3L6 13l-4 1 1-4zM9 4l3 3" /></>;
  else if (/вставить/.test(label) && !action.children) shape = <><path d="M6 3H3v11h10V3h-3M6 2h4v3H6zM5 8h6M5 11h4" /></>;
  else if (/копир|вырезать/.test(label)) shape = <><rect x="5" y="5" width="8" height="9" rx="1" /><path d="M10 3V2H2v9h1" /></>;
  else if (/выбрать|выдел|снять/.test(label)) shape = <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="m5 8 2 2 4-4" /></>;
  else shape = <><path d="M3 4h10M3 8h7M3 12h10" /></>;
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shape}</svg>;
}

function menuButtons(panel: HTMLElement | null | undefined) {
  return panel ? [...panel.querySelectorAll<HTMLButtonElement>(":scope > button[role='menuitem']:not(:disabled)")] : [];
}

function MenuPanel({ depth, x, y, anchor, panelRef, children, label, onKeyDown }: {
  depth: number;
  x: number;
  y: number;
  anchor?: HTMLButtonElement;
  panelRef: (panel: HTMLDivElement | null) => void;
  children: ReactNode;
  label: string;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const place = () => {
      const size = panel.getBoundingClientRect();
      const source = anchor?.getBoundingClientRect();
      // Use the full content height so a previously constrained flyout does not
      // alternate above/below its trigger when ResizeObserver runs again.
      const height = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const placement = placeTableContextMenu({ x, y, width: size.width, height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, anchor: source });
      panel.style.maxHeight = `${placement.maxHeight}px`;
      panel.style.left = `${placement.left}px`;
      panel.style.top = `${placement.top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    const parentPanel = anchor?.closest(".table-context-menu");
    if (parentPanel) observer.observe(parentPanel);
    return () => observer.disconnect();
  }, [anchor, x, y]);
  return <div ref={node => { ref.current = node; panelRef(node); }} className={`table-context-menu${depth ? " table-context-submenu" : ""}`} role="menu" aria-label={label} tabIndex={-1}
    style={{ left: x, top: y }} onKeyDown={onKeyDown} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
    {children}
  </div>;
}

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
  const panels = useRef(new Map<number, HTMLDivElement>());
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const onCloseRef = useRef(onClose);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [openPath, setOpenPath] = useState<number[]>([]);
  const focusRequest = useRef<number | null>(null);
  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const close = useCallback((restore = false) => {
    onCloseRef.current();
    if (restore && restoreFocus.current?.isConnected) restoreFocus.current.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isInside = (target: EventTarget | null) => target instanceof Node && [...panels.current.values()].some(panel => panel.contains(target));
    const closeOther = (event: Event) => { if ((event as CustomEvent).detail !== panels.current.get(0)) close(); };
    const closeOutside = (event: PointerEvent) => { if (!isInside(event.target)) close(); };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(true); }
    };
    const closeOnScroll = (event: Event) => {
      if (!isInside(event.target)) { close(); return; }
      // A scrolled parent must not leave a flyout next to a different action.
      const scrolled = [...panels.current].find(([, panel]) => panel === event.target);
      if (scrolled) setOpenPath(current => current.length > scrolled[0] ? current.slice(0, scrolled[0]) : current);
    };
    const closeOnResize = () => close();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener(OPEN_EVENT, closeOther);
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: panels.current.get(0) }));
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("scroll", closeOnScroll, true);
    const frame = requestAnimationFrame(() => (menuButtons(panels.current.get(0))[0] ?? panels.current.get(0))?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      if (focusRequest.current !== null) cancelAnimationFrame(focusRequest.current);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener(OPEN_EVENT, closeOther);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [close]);

  const open = (depth: number, index: number, focus = false) => {
    setOpenPath(current => [...current.slice(0, depth), index]);
    if (focus) {
      if (focusRequest.current !== null) cancelAnimationFrame(focusRequest.current);
      focusRequest.current = requestAnimationFrame(() => menuButtons(panels.current.get(depth + 1))[0]?.focus({ preventScroll: true }));
    }
  };
  const closeLevel = (depth: number) => {
    const parentKey = openPath.slice(0, depth).join("/");
    setOpenPath(current => current.slice(0, depth - 1));
    anchors.current.get(parentKey)?.focus({ preventScroll: true });
  };
  const keyDown = (depth: number, items: TableContextMenuAction[], event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panels.current.get(depth);
    const buttons = menuButtons(panel);
    const focused = document.activeElement as HTMLButtonElement | null;
    const position = buttons.findIndex(button => button === focused);
    const index = focused?.dataset.menuIndex ? Number(focused.dataset.menuIndex) : -1;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (position + 1) % buttons.length : position < 0 ? buttons.length - 1 : (position - 1 + buttons.length) % buttons.length;
      setOpenPath(current => current.slice(0, depth));
      buttons[next]?.focus({ preventScroll: true });
      buttons[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowRight" && index >= 0 && items[index]?.children?.length) {
      event.preventDefault(); event.stopPropagation(); open(depth, index, true);
    } else if (event.key === "ArrowLeft" && depth > 0) {
      event.preventDefault(); event.stopPropagation(); closeLevel(depth);
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (depth > 0) closeLevel(depth); else close(true);
    } else if (event.key === "Tab") { event.stopPropagation(); close(); }
  };

  const renderPanel = (items: TableContextMenuAction[], depth: number, path: number[], label: string): ReactNode => {
    const parentKey = path.join("/");
    const activeIndex = openPath[depth];
    const active = items[activeIndex];
    return <Fragment key={parentKey || "root"}>
      <MenuPanel depth={depth} x={x} y={y} anchor={depth ? anchors.current.get(parentKey) : undefined} label={label}
        panelRef={panel => { if (panel) panels.current.set(depth, panel); else panels.current.delete(depth); }} onKeyDown={event => keyDown(depth, items, event)}>
        {depth === 0 && <div className="table-context-menu-caption"><strong title={value}>{value || "Пустая ячейка"}</strong><span>{caption}</span></div>}
        {items.map((action, index) => {
          const key = [...path, index].join("/");
          const hasChildren = Boolean(action.children?.length);
          const expanded = hasChildren && activeIndex === index;
          const sectionStart = Boolean(action.section && action.section !== items[index - 1]?.section);
          return <Fragment key={`${action.label}-${index}`}>
            {(action.separatorBefore || sectionStart && index > 0) && <div className="table-context-menu-separator" role="separator" />}
            {sectionStart && <div className="table-context-menu-section">{action.section}</div>}
            <button ref={button => { if (button) anchors.current.set(key, button); else anchors.current.delete(key); }} type="button" role="menuitem" data-menu-index={index}
              className={[action.danger ? "danger" : "", expanded ? "is-expanded" : ""].filter(Boolean).join(" ") || undefined}
              disabled={action.disabled} title={action.title} aria-haspopup={hasChildren ? "menu" : undefined} aria-expanded={hasChildren ? expanded : undefined}
              onPointerEnter={() => { if (hasChildren && !action.disabled) open(depth, index); else setOpenPath(current => current.slice(0, depth)); }}
              onClick={event => { if (action.disabled) return; if (hasChildren) open(depth, index, event.detail === 0); else void action.onSelect(); }}>
              <span className="table-context-menu-icon"><ActionIcon action={action} /></span><span className="table-context-menu-label">{action.label}</span>
              {action.shortcut && <kbd>{action.shortcut}</kbd>}{hasChildren && <svg className="table-context-menu-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>}
            </button>
          </Fragment>;
        })}
        {depth === 0 && error && <p role="status">{error}</p>}
      </MenuPanel>
      {active && !active.disabled && active.children?.length ? renderPanel(active.children, depth + 1, [...path, activeIndex], active.label) : null}
    </Fragment>;
  };
  if (typeof document === "undefined") return null;
  // Refs provide measured parent anchors; they are populated before a submenu opens.
  // eslint-disable-next-line react-hooks/refs
  return createPortal(renderPanel(actions, 0, [], ariaLabel), document.body);
}
