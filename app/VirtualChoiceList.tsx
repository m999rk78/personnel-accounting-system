"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Virtualize measured rows: wrapped labels must never use a fixed row height. */
export function VirtualChoiceList({ items, renderItem, emptyText }: {
  items: readonly string[];
  renderItem: (value: string) => ReactNode;
  emptyText: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(false);
  const [measurements, setMeasurements] = useState(new Map<string, number>());
  const [viewport, setViewport] = useState({ top: 0, height: 204 });
  const offsets = useMemo(() => {
    const result = [0];
    for (const item of items) result.push(result[result.length - 1] + (measurements.get(item) ?? 34));
    return result;
  }, [items, measurements]);
  const firstAt = (position: number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle + 1] <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const start = Math.max(0, firstAt(viewport.top) - 3);
  const end = Math.min(items.length, firstAt(viewport.top + viewport.height) + 4);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let previousWidth = element.clientWidth;
    const observeViewport = () => {
      if (element.clientWidth !== previousWidth) {
        previousWidth = element.clientWidth;
        setMeasurements(new Map());
      }
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    };
    const observer = new ResizeObserver(observeViewport);
    observer.observe(element);
    observeViewport();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const elements = Array.from(rows.current?.children ?? []) as HTMLElement[];
    const measure = () => {
      const element = root.current;
      // Filters can mount before AG attaches the popup. A detached 0×0 list is
      // not a user who scrolled to the end: keep newly opened trees at the top.
      const atBottom = element?.isConnected && element.clientHeight > 0 && element.scrollTop > 0
        && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
      const sizes = elements.map((element) => [element.dataset.value!, element.getBoundingClientRect().height] as const);
      setMeasurements((current) => {
        if (!sizes.some(([key, height]) => height > 0 && current.get(key) !== height)) return current;
        const next = new Map(current);
        for (const [key, height] of sizes) if (height > 0) next.set(key, height);
        return next;
      });
      // Keep the last item reachable when measured rows expand the scroll range.
      if (atBottom || stickToEnd.current) requestAnimationFrame(() => {
        if (element?.isConnected) element.scrollTop = element.scrollHeight;
      });
    };
    const observer = new ResizeObserver(measure);
    elements.forEach((element) => observer.observe(element));
    measure();
    return () => observer.disconnect();
  });

  // A scrollable region needs a tab stop and Home/End handling to reach every value.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions
  return <div className="grid-filter-values" ref={root} role="region" aria-label="Значения фильтра" tabIndex={0} onPointerDown={() => { stickToEnd.current = false; }} onWheel={() => { stickToEnd.current = false; }} onKeyDown={(event) => {
    stickToEnd.current = event.target === event.currentTarget && event.key === "End";
    if (event.target !== event.currentTarget || !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.currentTarget.scrollTop = event.key === "Home" ? 0 : event.currentTarget.scrollHeight;
  }} onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    {items.length ? <div style={{ height: offsets[items.length], position: "relative" }}>
      <div ref={rows} style={{ position: "absolute", top: offsets[start], left: 0, right: 0 }}>
        {items.slice(start, end).map((value) => <div key={value} data-value={value}>{renderItem(value)}</div>)}
      </div>
    </div> : <p>{emptyText}</p>}
  </div>;
}
