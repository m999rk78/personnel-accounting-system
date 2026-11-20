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

function copyTableThroughDocument(text: string, html?: string) {
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.className = "table-clipboard-fallback";
  (focused?.closest("dialog[open]") ?? document.body).appendChild(input);
  const copy = (event: ClipboardEvent) => {
    if (!html || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", html);
  };
  document.addEventListener("copy", copy);
  try {
    input.focus({ preventScroll: true });
    input.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", copy);
    input.remove();
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
  }
}

/** Write spreadsheet cells synchronously during the menu/button gesture. */
export async function writeTableClipboardText(text: string, html?: string) {
  if (html && copyTableThroughDocument(text, html)) return;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the browser's legacy clipboard path. */ }
  }
  if (!copyTableThroughDocument(text)) throw new Error("Не удалось скопировать.");
}
