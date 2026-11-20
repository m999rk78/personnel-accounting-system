"use client";

import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

export function ReportChangesSaveButton({ disabled, busy, onSave }: { disabled: boolean; busy: boolean; onSave: () => unknown }) {
  const save = useRef(onSave);
  useLayoutEffect(() => { save.current = onSave; }, [onSave]);
  return <button className="secondary-button" type="button" disabled={disabled}
    // Keep the editor focused until click: committing on pointerdown can move
    // this conditional button and consume the click before it reaches Save.
    onPointerDown={event => { if (event.button === 0) event.preventDefault(); }}
    onClick={event => {
      const button = event.currentTarget;
      const input = document.activeElement;
      const workspace = button.closest(".personnel-report-workspace");
      if (input instanceof HTMLElement && input.matches("input.ag-inline-control") && workspace?.contains(input)) {
        // Blur commits local keystrokes. Read the refreshed callback afterwards,
        // so saving uses the new draft and owner keys, not the previous render.
        flushSync(() => input.blur());
      }
      if (button.isConnected && !button.disabled) void save.current();
    }}>
    {busy ? "Сохраняем…" : "Сохранить изменения"}{!disabled && <span className="personnel-report-unsaved-dot" aria-label="Есть несохранённые изменения" />}
  </button>;
}
