"use client";

import { useEffect, useRef, useState } from "react";
import { createCellTextEditSession } from "./cellTextEditing";

/** Keep keystrokes local: updating grid rows while typing can remount the input. */
export function GridTextEditor({ value, onChange, onBlur, onEnter, focusOnMount = true, placeholder = "ФИО сотрудника" }: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onEnter?: () => void;
  focusOnMount?: boolean;
  placeholder?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [session] = useState(() => createCellTextEditSession(value));
  useEffect(() => {
    if (focusOnMount) { input.current?.focus(); input.current?.select(); }
  }, [focusOnMount]);
  const commit = () => {
    const next = session.commit(input.current?.value ?? value);
    if (next !== undefined) onChange(next);
  };
  return <input ref={input} className="ag-inline-control" defaultValue={value} placeholder={placeholder} aria-label={placeholder}
    onBlur={() => { commit(); onBlur?.(); }}
    onKeyDown={(event) => {
      // Text selection, cursor movement and native undo belong to the input.
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      const grid = input.current?.closest<HTMLElement>(".localized-grid-body");
      if (event.key === "Escape") { session.cancel(); onBlur?.(); }
      else { commit(); (onEnter ?? onBlur)?.(); }
      grid?.focus({ preventScroll: true });
    }} />;
}
