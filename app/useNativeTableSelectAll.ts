"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { serializeSpreadsheetText } from "./spreadsheetClipboard";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "./tableSelectAllShortcut";
import "./nativeTableSelectAll.css";

type ClipboardRows = readonly (readonly (string | number | null | undefined)[])[];

/** Select the column headings and displayed data, independently of row-action checkboxes. */
export function useNativeTableSelectAll<T extends HTMLElement = HTMLDivElement>({ rows, headers, resetKey = "", enabled = true, rootRef }: {
  rows: ClipboardRows;
  headers?: ClipboardRows[number];
  resetKey?: string;
  enabled?: boolean;
  rootRef?: RefObject<T | null>;
}) {
  const localRef = useRef<T>(null);
  const ref = rootRef ?? localRef;
  const text = useMemo(() => serializeSpreadsheetText([...(headers?.length ? [headers] : []), ...rows].map(row => row.map(value => value == null ? "" : String(value)))), [headers, rows]);
  const scope = `${enabled ? "enabled" : "disabled"}\u0000${resetKey}\u0000${text}`;
  const [state, setState] = useState({ scope, selected: false });
  if (state.scope !== scope) setState({ scope, selected: false });
  const selection = useRef<string | null>(null);
  const hasCells = rows.length > 0 || Boolean(headers?.length);
  const selected = enabled && hasCells && state.scope === scope && state.selected;

  const clear = useCallback(() => { selection.current = null; setState(current => ({ ...current, selected: false })); }, []);
  useLayoutEffect(() => { if (selection.current !== scope) selection.current = null; }, [scope]);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      if (selection.current && event.target instanceof Node && !ref.current?.contains(event.target)) clear();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [clear, ref]);

  const onKeyDownCapture = (event: KeyboardEvent<T>) => {
    if (!enabled || isTableTextEntryTarget(event.target)) return;
    if (event.key === "Escape" && selection.current === scope) {
      event.preventDefault(); event.stopPropagation(); clear(); return;
    }
    if (!isTableSelectAllShortcut(event.nativeEvent)) return;
    event.preventDefault(); event.stopPropagation();
    if (!hasCells) { clear(); return; }
    selection.current = scope; setState({ scope, selected: true });
  };
  const onCopyCapture = (event: ClipboardEvent<T>) => {
    if (!enabled || selection.current !== scope || !hasCells || isTableTextEntryTarget(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    event.clipboardData.setData("text/plain", text);
  };
  const onPointerDownCapture = (event: PointerEvent<T>) => {
    if (selection.current) clear();
    if (!enabled || !(event.target instanceof Element) || event.target.closest("input,textarea,select,button,a,[contenteditable]:not([contenteditable='false']),[role='combobox']")) return;
    ref.current?.focus({ preventScroll: true });
  };
  const onBlurCapture = (event: FocusEvent<T>) => {
    if (event.relatedTarget instanceof Node && !ref.current?.contains(event.relatedTarget)) clear();
  };

  return {
    ref, selected,
    className: selected ? "native-table-select-all" : "",
    handlers: { onKeyDownCapture, onCopyCapture, onPointerDownCapture, onBlurCapture },
  };
}
