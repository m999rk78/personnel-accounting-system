"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./tableStatusToast.css";

export function TableStatusToast({ message, container }: { message: string; container?: HTMLElement }) {
  if (!message || typeof document === "undefined") return null;
  return createPortal(<div className="table-status-toast" role="status">{message}</div>, container ?? document.body);
}

export function useTableCopyToast(anchorRef?: RefObject<HTMLElement | null>) {
  const [toast, setToast] = useState<{ message: string; container?: HTMLElement } | null>(null);
  const showCopyToast = useCallback((message: string) => {
    const dialog = anchorRef?.current?.closest<HTMLDialogElement>("dialog[open]");
    setToast({ message, container: dialog ?? undefined });
  }, [anchorRef]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  return { showCopyToast, copyToast: toast ? <TableStatusToast {...toast} /> : null };
}

/** Native grid menus supply the clipboard payload and expect the app to write it. */
export async function writeTableClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the browser's legacy clipboard path. */ }
  }
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.className = "table-clipboard-fallback";
  (focused?.closest("dialog[open]") ?? document.body).appendChild(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("Не удалось скопировать.");
  } finally {
    input.remove();
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
  }
}
