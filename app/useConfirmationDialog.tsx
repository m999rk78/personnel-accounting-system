"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./confirmationDialog.css";

export type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

function ConfirmationDialog({ options, onAnswer }: { options: ConfirmationOptions; onAnswer: (confirmed: boolean) => void }) {
  const root = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const dialog = root.current;
    dialog?.showModal();
    cancel.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  // A styled HTML dialog keeps focus inside and puts nested confirmations above
  // other modals. Unlike window.confirm, its content and buttons belong to us.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return createPortal(<dialog ref={root} className="app-confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== "Tab") return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const target = event.shiftKey && document.activeElement === buttons[0] ? buttons.at(-1)
        : !event.shiftKey && document.activeElement === buttons.at(-1) ? buttons[0] : null;
      if (target) { event.preventDefault(); target.focus(); }
    }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onAnswer(false); }}
    onMouseDown={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onAnswer(false);
    }}>
    <div className="app-confirmation-content">
      <span className="app-confirmation-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 7v6m0 4h.01"/><circle cx="12" cy="12" r="9"/></svg></span>
      <div><h2 id={titleId}>{options.title}</h2><p id={descriptionId}>{options.description}</p></div>
    </div>
    <div className="app-confirmation-actions">
      <button ref={cancel} type="button" className="app-confirmation-cancel" onClick={() => onAnswer(false)}>{options.cancelLabel ?? "Остаться"}</button>
      <button type="button" className="app-confirmation-accept" onClick={() => onAnswer(true)}>{options.confirmLabel ?? "Продолжить без сохранения"}</button>
    </div>
  </dialog>, document.body);
}

/** One outstanding question per workspace; extra requests cannot discard twice. */
export function useConfirmationDialog() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);
  const confirm = useCallback((next: ConfirmationOptions): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    return new Promise(resolve => { pending.current = resolve; setOptions(next); });
  }, []);
  const answer = useCallback((confirmed: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setOptions(null);
    resolve?.(confirmed);
  }, []);
  useEffect(() => () => {
    // A workspace removed by logout/permission changes must not run its queued action.
    pending.current?.(false);
    pending.current = null;
  }, []);
  return { confirm, dialog: options ? <ConfirmationDialog options={options} onAnswer={answer}/> : null };
}
