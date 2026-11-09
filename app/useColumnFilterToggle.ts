"use client";

import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { CustomInnerHeaderProps } from "ag-grid-react";
import { columnFilterToggleHandlers, columnFilterVisibility } from "./columnFilterToggle";

const closed = () => null;
export function useColumnFilterToggle({ api, column, showFilter }: Pick<CustomInnerHeaderProps, "api" | "column" | "showFilter">) {
  const visibility = useMemo(() => columnFilterVisibility(api), [api]);
  const openColumn = useSyncExternalStore(visibility.subscribe, visibility.getSnapshot, closed);
  const columnId = column.getColId();
  // AG refreshes inner-header callbacks when a popup opens. The mouse press and
  // its later click must share one gesture even across that intervening render.
  const pressHandled = useRef(false);
  const showFilterRef = useRef(showFilter);
  useLayoutEffect(() => { showFilterRef.current = showFilter; }, [showFilter]);
  useLayoutEffect(() => { pressHandled.current = false; }, [api, columnId]);
  // The factory only captures these refs; it reads them later in DOM event
  // handlers, never while rendering or constructing the returned callbacks.
  // eslint-disable-next-line react-hooks/refs
  const buttonProps = useMemo(() => columnFilterToggleHandlers(api, columnId, button => showFilterRef.current(button), visibility, pressHandled), [api, columnId, visibility]);
  return { open: openColumn === columnId, buttonProps };
}
