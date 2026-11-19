"use client";

import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";

/** History of plain draft data only. A new entity/server baseline is a new
 * scope: undo never replays a save, server action or another entity's edits. */
export function createDraftUndo<T>(initial: T, initialScope: string, nativeTextFields: readonly (keyof T)[] = []) {
  const copy = (value: T): T => structuredClone(value);
  const signature = (value: unknown) => JSON.stringify(value);
  let present = copy(initial), incoming = signature(initial), scope = initialScope;
  let past: T[] = [], future: T[] = [];
  let nativeHistory: "undo" | "redo" | null = null;
  const expected: string[] = [], listeners = new Set<() => void>();
  let replace: ((value: T) => void) | undefined;
  let snapshot = { canUndo: false, canRedo: false };
  const publish = () => {
    const next = { canUndo: Boolean(replace && past.length), canRedo: Boolean(replace && future.length) };
    if (next.canUndo !== snapshot.canUndo || next.canRedo !== snapshot.canRedo) {
      snapshot = next;
      listeners.forEach(listener => listener());
    }
  };
  const reset = (value: T = present) => {
    present = copy(value); incoming = signature(value);
    past = []; future = []; expected.length = 0;
    nativeHistory = null;
    publish();
  };
  const apply = (value: T, nextPast: T[], nextFuture: T[]) => {
    const next = copy(value);
    // Do not advance history when a controlled consumer rejects restoration.
    replace?.(copy(next));
    present = next; past = nextPast; future = nextFuture;
    expected.push(signature(next));
    publish();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    noteNativeHistory(direction: "undo" | "redo") { nativeHistory = direction; },
    synchronize(value: T, nextScope: string, onChange: (value: T) => void) {
      replace = onChange;
      const next = signature(value), acknowledgement = expected.lastIndexOf(next);
      const native = nativeHistory;
      nativeHistory = null;
      if (scope !== nextScope) { scope = nextScope; reset(value); }
      else if (native && next !== signature(present)) {
        // Native text undo owns only explicitly tracked text fields. Rebase
        // those fields, never permissions/project grants, across app snapshots
        // and remove now-duplicate text-only steps. A later application undo
        // can still undo a checkbox without reapplying native-undone text.
        const changed = nativeTextFields.filter(field => signature(present[field]) !== signature(value[field]));
        const rebase = (item: T) => {
          const rebased = copy(item);
          for (const field of changed) rebased[field] = structuredClone(value[field]);
          return rebased;
        };
        const withoutTextChanges = rebase(present);
        if (!changed.length || signature(withoutTextChanges) !== next) reset(value);
        else {
          const collapse = (items: T[]) => items.filter((item, index) => index === 0 || signature(item) !== signature(items[index - 1]));
          past = collapse([...past, present].map(rebase)).slice(0, -1);
          future = collapse([value, ...future.map(rebase)]).slice(1);
          present = copy(value); expected.length = 0;
        }
      }
      else if (acknowledgement >= 0) expected.splice(0, acknowledgement + 1);
      else if (next !== incoming) {
        if (next !== signature(present)) { past = [...past, present].slice(-50); present = copy(value); future = []; }
        expected.length = 0;
      }
      incoming = next;
      publish();
    },
    reset,
    undo() { if (replace && past.length) apply(past.at(-1)!, past.slice(0, -1), [present, ...future].slice(0, 50)); },
    redo() { if (replace && future.length) apply(future[0], [...past, present].slice(-50), future.slice(1)); },
  };
}

export function useDraftUndo<T>({ value, onChange, scopeKey, nativeRootRef, nativeTextFields = [] }: { value: T; onChange: (value: T) => void; scopeKey: string; nativeRootRef?: RefObject<HTMLElement | null>; nativeTextFields?: readonly (keyof T)[] }) {
  const [history] = useState(() => createDraftUndo(value, scopeKey, nativeTextFields));
  useLayoutEffect(() => { history.synchronize(value, scopeKey, onChange); }, [history, value, scopeKey, onChange]);
  useEffect(() => {
    if (!nativeRootRef) return;
    const document = nativeRootRef.current?.ownerDocument ?? globalThis.document;
    if (!document) return;
    const nativeInput = (event: Event) => {
      if (!(event instanceof InputEvent) || !(event.target instanceof Element) || event.target.closest("input[type='search'], [role='searchbox']")) return;
      const root = nativeRootRef.current;
      if (!root || root !== event.target && !root.contains(event.target)) return;
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") history.noteNativeHistory(event.inputType === "historyUndo" ? "undo" : "redo");
    };
    document.addEventListener("input", nativeInput, true);
    return () => document.removeEventListener("input", nativeInput, true);
  }, [history, nativeRootRef]);
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);
  return { undo: history.undo, redo: history.redo, reset: history.reset, ...snapshot };
}
