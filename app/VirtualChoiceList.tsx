"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

const estimatedRowHeight = 34;

/** Virtualize measured rows: wrapped labels must never use a fixed row height. */
export function VirtualChoiceList({ items, renderItem, emptyText }: {
  items: readonly string[];
  renderItem: (value: string) => ReactNode;
  emptyText: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(false);
  const pendingEnd = useRef<number | null>(null);
  const [measurements, setMeasurements] = useState(new Map<string, number>());
  const [viewport, setViewport] = useState({ top: 0, height: 204 });
  const offsets = useMemo(() => {
    const result = [0];
    for (const item of items) result.push(result[result.length - 1] + (measurements.get(item) ?? estimatedRowHeight));
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
    const element = root.current;
    const top = pendingEnd.current;
    pendingEnd.current = null;
    // Only follow a measurement once its new height is in the DOM, and only
    // if the user hasn't already scrolled upward.
    if (element && top !== null && element.scrollTop >= top - 1) element.scrollTop = element.scrollHeight;
  }, [measurements]);

  useLayoutEffect(() => {
    const elements = Array.from(rows.current?.children ?? []) as HTMLElement[];
    const measure = () => {
      const element = root.current;
      if (!element?.isConnected || element.clientHeight === 0) return;
      const sizes = elements.map(row => [row.dataset.value!, row.getBoundingClientRect().height] as const)
        .filter(([key, height]) => height > 0 && (measurements.get(key) ?? estimatedRowHeight) !== height);
      if (!sizes.length) return;
      const { scrollTop, clientHeight, scrollHeight } = element;
      const atBottom = scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 1;
      if (stickToEnd.current || atBottom) pendingEnd.current = scrollTop;
      setMeasurements((current) => {
        const next = new Map(current);
        for (const [key, height] of sizes) next.set(key, height);
        return next;
      });
    };
    const observer = new ResizeObserver(measure);
    elements.forEach((element) => observer.observe(element));
    measure();
    return () => observer.disconnect();
  }, [items, start, end, measurements]);

  const stopFollowingEnd = () => {
    stickToEnd.current = false;
    pendingEnd.current = null;
  };
  // A scrollable region needs a tab stop and Home/End handling to reach every value.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions
  return <div className="grid-filter-values" ref={root} role="region" aria-label="Значения фильтра" tabIndex={0} onPointerDown={stopFollowingEnd} onWheel={stopFollowingEnd} onKeyDown={(event) => {
    stopFollowingEnd();
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
