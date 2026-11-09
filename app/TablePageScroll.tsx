"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { GridApi } from "ag-grid-community";

export type TablePageScrollSource = {
  getViewport: () => HTMLElement | null;
  /** Natural content height, including the table header and any in-table totals. */
  getContentHeight: () => number;
  /** Full column width, independent of which virtual columns are mounted. */
  getHorizontalContentWidth?: () => number;
  subscribe?: (refresh: () => void) => () => void;
};

type TablePageScrollProps = {
  gridRoot: RefObject<HTMLDivElement | null>;
  source: TablePageScrollSource;
  children: ReactNode;
  footer?: ReactNode;
  enabled?: boolean;
  geometryKey?: string | number;
  label?: string;
  className?: string;
  frameClassName?: string;
};

/** The document owns scrolling; the existing table retains its virtualized viewport. */
export function TablePageScroll({ gridRoot, source, children, footer, enabled = true, geometryKey, label = "Горизонтальная прокрутка таблицы", className = "", frameClassName = "" }: TablePageScrollProps) {
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const refresh = useRef<(() => void) | null>(null);
  const scrollTo = useRef<((position: number) => void) | null>(null);
  const [horizontal, setHorizontal] = useState(false);
  const controlId = useId();

  useLayoutEffect(() => {
    const root = gridRoot.current, stageElement = stage.current, frameElement = frame.current;
    const external = track.current, content = spacer.current, viewport = source.getViewport();
    if (!enabled || !root || !stageElement || !frameElement || !external || !content || !viewport) return;
    const oldId = root.id;
    if (!oldId) root.setAttribute("id", controlId);
    external.setAttribute("aria-controls", root.id);
    const oldViewportMarker = viewport.getAttribute("data-table-page-viewport");
    viewport.setAttribute("data-table-page-viewport", "");
    const nativeRail = root.querySelector<HTMLElement>(".ag-body-vertical-scroll");
    const oldRailMarker = nativeRail?.getAttribute("data-table-page-native-rail");
    nativeRail?.setAttribute("data-table-page-native-rail", "");
    let animationFrame: number | null = null, disposed = false, geometryPending = true;
    let synchronizedTop = viewport.scrollTop, synchronizedWindowTop = window.scrollY, synchronizedLeft = viewport.scrollLeft;
    let measuredHeight = viewport.scrollHeight, measuredViewportHeight = viewport.clientHeight;
    const bottomGap = 12;

    const setHeight = (element: HTMLElement, value: number) => {
      const next = `${Math.ceil(value)}px`;
      if (element.style.height === next) return false;
      element.style.height = next;
      return true;
    };
    const writeLeft = (next: number) => {
      if (Math.abs(viewport.scrollLeft - next) > .5) viewport.scrollLeft = next;
      if (Math.abs(external.scrollLeft - viewport.scrollLeft) > .5) external.scrollLeft = viewport.scrollLeft;
      synchronizedLeft = viewport.scrollLeft;
      external.setAttribute("aria-valuenow", String(Math.round(synchronizedLeft)));
    };
    scrollTo.current = writeLeft;
    const fromViewportX = () => {
      // A queued grid scroll event must not undo newer input on the page control.
      if (Math.abs(viewport.scrollLeft - synchronizedLeft) <= .5 && Math.abs(external.scrollLeft - synchronizedLeft) > .5) {
        writeLeft(external.scrollLeft);
        return;
      }
      if (Math.abs(external.scrollLeft - viewport.scrollLeft) > .5) external.scrollLeft = viewport.scrollLeft;
      synchronizedLeft = viewport.scrollLeft;
      external.setAttribute("aria-valuenow", String(Math.round(synchronizedLeft)));
    };
    const updateHorizontal = () => {
      const bounds = root.getBoundingClientRect();
      const left = `${bounds.left}px`, width = `${bounds.width}px`;
      if (external.style.left !== left) external.style.left = left;
      if (external.style.width !== width) external.style.width = width;
      const maximum = Math.max(0, (source.getHorizontalContentWidth?.() ?? viewport.scrollWidth) - viewport.clientWidth);
      const contentWidth = `${external.clientWidth + maximum}px`;
      if (content.style.width !== contentWidth) content.style.width = contentWidth;
      external.setAttribute("aria-valuemax", String(maximum));
      const frameBounds = frameElement.getBoundingClientRect();
      setHorizontal(maximum > 1 && frameBounds.top < window.innerHeight && frameBounds.bottom > 0);
      // A real width change can shrink the range before AG commits its DOM.
      // Otherwise preserve any newer input queued on the page control.
      if (viewport.scrollLeft > maximum) writeLeft(maximum);
      else fromViewportX();
    };
    const schedule = (geometry = true) => {
      geometryPending ||= geometry;
      if (!disposed && animationFrame === null) animationFrame = requestAnimationFrame(update);
    };
    const update = () => {
      animationFrame = null;
      if (disposed) return;
      const recheckLayout = geometryPending;
      observeLayout();
      const stageTop = stageElement.getBoundingClientRect().top;
      const absoluteTop = stageTop + window.scrollY;
      const available = Math.max(120, window.innerHeight - Math.max(0, stageTop) - bottomGap);
      const footerHeight = panel.current?.getBoundingClientRect().height ?? 0;
      const chrome = Math.max(0, root.getBoundingClientRect().height - viewport.clientHeight);
      const naturalHeight = Math.max(0, source.getContentHeight()) + chrome + footerHeight;
      const stageHeight = Math.max(naturalHeight, Math.max(120, window.innerHeight - absoluteTop - bottomGap));
      const stageChanged = setHeight(stageElement, stageHeight);
      const frameChanged = setHeight(frameElement, Math.min(available, stageHeight));
      if (stageChanged || frameChanged) { schedule(); return; }
      measuredHeight = viewport.scrollHeight;
      measuredViewportHeight = viewport.clientHeight;
      const top = Math.max(0, Math.min(measuredHeight - measuredViewportHeight, -stageElement.getBoundingClientRect().top));
      if (Math.abs(viewport.scrollTop - top) > .5) viewport.scrollTop = top;
      synchronizedTop = viewport.scrollTop;
      synchronizedWindowTop = window.scrollY;
      geometryPending = false;
      updateHorizontal();
      // AG applies flex widths after its resize event; reconcile that final DOM layout.
      if (recheckLayout) schedule(false);
    };
    const fromWindow = () => schedule(false);
    const fromViewport = () => {
      fromViewportX();
      const next = viewport.scrollTop;
      if (Math.abs(next - synchronizedTop) <= .5) return;
      if (geometryPending || Math.abs(window.scrollY - synchronizedWindowTop) > .5
        || viewport.scrollHeight !== measuredHeight || viewport.clientHeight !== measuredViewportHeight) { schedule(); return; }
      // Keyboard navigation and row dragging already ask the table to reveal rows.
      const target = Math.max(0, stageElement.getBoundingClientRect().top + window.scrollY + next);
      synchronizedTop = next;
      if (Math.abs(window.scrollY - target) > .5) window.scrollTo({ top: target, behavior: "instant" });
      synchronizedWindowTop = window.scrollY;
      schedule(false);
    };
    const fromExternal = () => {
      if (Math.abs(external.scrollLeft - synchronizedLeft) <= .5 && Math.abs(viewport.scrollLeft - synchronizedLeft) > .5) fromViewportX();
      else writeLeft(external.scrollLeft);
    };
    const geometryChanged = () => schedule();
    const headerWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)
        && event.target instanceof Element && event.target.closest(".ag-header")?.closest(".ag-root")?.querySelector(".ag-grid-viewport") === viewport) event.stopPropagation();
    };
    const observer = new ResizeObserver(geometryChanged);
    const observed = new Set<Element>();
    const observeLayout = () => {
      // A native table may mount only after its initial loading state.
      const elements = new Set<Element>([root, viewport, panel.current, root.closest(".page-content"), root.querySelector(".ag-grid-scrollable-area"), root.querySelector(".ag-grid-scrolling-container"), root.querySelector(".ag-header-row"), root.querySelector("table")].filter((element): element is HTMLElement => Boolean(element)));
      for (const element of observed) if (!elements.has(element)) { observer.unobserve(element); observed.delete(element); }
      for (const element of elements) if (!observed.has(element)) { observer.observe(element); observed.add(element); }
    };
    // Virtual cells, headers and selection decorations change during scrolling.
    // They do not change the column model or the page's dimensions. Observing
    // their mutations would force layout and feed offsets back into the scroll.
    const unsubscribe = source.subscribe?.(geometryChanged);
    window.addEventListener("scroll", fromWindow, { passive: true });
    window.addEventListener("resize", geometryChanged);
    viewport.addEventListener("scroll", fromViewport, { passive: true });
    external.addEventListener("scroll", fromExternal, { passive: true });
    root.addEventListener("wheel", headerWheel, { capture: true, passive: true });
    refresh.current = geometryChanged;
    schedule();
    return () => {
      disposed = true;
      refresh.current = null;
      scrollTo.current = null;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      observer.disconnect();
      unsubscribe?.();
      window.removeEventListener("scroll", fromWindow);
      window.removeEventListener("resize", geometryChanged);
      viewport.removeEventListener("scroll", fromViewport);
      external.removeEventListener("scroll", fromExternal);
      root.removeEventListener("wheel", headerWheel, true);
      if (!oldId) root.removeAttribute("id");
      if (oldViewportMarker === null) viewport.removeAttribute("data-table-page-viewport"); else viewport.setAttribute("data-table-page-viewport", oldViewportMarker);
      if (nativeRail) { if (oldRailMarker == null) nativeRail.removeAttribute("data-table-page-native-rail"); else nativeRail.setAttribute("data-table-page-native-rail", oldRailMarker); }
    };
  }, [enabled, source, gridRoot, controlId]);

  useLayoutEffect(() => { refresh.current?.(); }, [geometryKey, footer]);

  if (!enabled) return <>{children}{footer}</>;
  return <div ref={stage} className={`table-page-scroll-stage ${className}`.trim()}>
    <div ref={frame} className={`table-page-scroll-frame ${frameClassName}`.trim()}>
      {children}
      {footer && <div ref={panel} className="table-page-scroll-footer">{footer}</div>}
    </div>
    <div ref={track} className="table-page-horizontal" data-table-page-horizontal hidden={!horizontal}
      role="scrollbar" aria-label={label} aria-orientation="horizontal" aria-controls={controlId} aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={0}
      onKeyDown={event => {
        const maximum = event.currentTarget.scrollWidth - event.currentTarget.clientWidth;
        const step = Math.max(40, event.currentTarget.clientWidth * .9);
        const offsets: Record<string, number> = { ArrowLeft: -40, ArrowRight: 40, PageUp: -step, PageDown: step };
        if (event.key !== "Home" && event.key !== "End" && !Object.hasOwn(offsets, event.key)) return;
        event.preventDefault();
        scrollTo.current?.(event.key === "Home" ? 0 : event.key === "End" ? maximum : Math.max(0, Math.min(maximum, event.currentTarget.scrollLeft + offsets[event.key])));
      }}><div ref={spacer} aria-hidden="true" /></div>
  </div>;
}

export function AgTablePageScroll({ api, ...props }: Omit<TablePageScrollProps, "source"> & { api: GridApi | null }) {
  const root = props.gridRoot;
  const source = useMemo<TablePageScrollSource>(() => ({
    getViewport: () => root.current?.querySelector<HTMLElement>(".ag-grid-viewport") ?? null,
    getContentHeight: () => {
      if (!api || api.isDestroyed()) return 0;
      const count = api.getDisplayedRowCount();
      const last = count ? api.getDisplayedRowAtIndex(count - 1) : null;
      const rows = last ? (last.rowTop ?? 0) + (last.rowHeight ?? api.getSizesForCurrentTheme().rowHeight) : 0;
      return rows + (root.current?.querySelector(".ag-header")?.getBoundingClientRect().height ?? 0);
    },
    getHorizontalContentWidth: () => {
      if (!api || api.isDestroyed()) return 0;
      // Include pinned and off-screen columns, never transient virtual DOM.
      const columnsWidth = api.getAllDisplayedColumns().reduce((width, column) => width + column.getActualWidth(), 0);
      const rail = root.current?.querySelector<HTMLElement>(".ag-body-vertical-scroll");
      const railSize = rail?.getBoundingClientRect().width ?? 0;
      // Overlay scrollbars have a pointer hitbox but reserve no column space.
      const railWidth = railSize > 0 ? api.getGridOption("scrollbarWidth") ?? (rail?.classList.contains("ag-scrollbar-invisible") ? 0 : railSize) : 0;
      const pinnedWidth = [...api.getDisplayedLeftColumns(), ...api.getDisplayedRightColumns()].reduce((width, column) => width + column.getActualWidth(), 0);
      const viewport = root.current?.querySelector<HTMLElement>(".ag-grid-viewport");
      if (pinnedWidth > 0 && viewport && pinnedWidth >= viewport.clientWidth - railWidth) return 0;
      return columnsWidth + railWidth;
    },
    subscribe: refresh => {
      if (!api || api.isDestroyed()) return () => {};
      const events = ["columnResized", "displayedColumnsChanged", "gridSizeChanged", "modelUpdated", "rowDataUpdated", "firstDataRendered"] as const;
      for (const event of events) api.addEventListener(event, refresh);
      return () => { if (!api.isDestroyed()) for (const event of events) api.removeEventListener(event, refresh); };
    },
  }), [api, root]);
  return <TablePageScroll {...props} source={source} />;
}
