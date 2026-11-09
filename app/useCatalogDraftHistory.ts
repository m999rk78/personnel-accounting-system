"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { CatalogDraft } from "./catalogSpreadsheetModel";

export function createCatalogDraftHistory<D extends CatalogDraft>() {
  const copy = (rows: D[]) => rows.map(row => ({ ...row }));
  let present: D[] = [], signature = "[]", incoming: string | undefined;
  let past: D[][] = [], future: D[][] = [];
  let replace: ((drafts: D[]) => void) | undefined;
  const expected: string[] = [], listeners = new Set<() => void>();
  let snapshot = { canUndo: false, canRedo: false };
  const publish = () => {
    const next = { canUndo: Boolean(replace && past.length), canRedo: Boolean(replace && future.length) };
    if (next.canUndo !== snapshot.canUndo || next.canRedo !== snapshot.canRedo) { snapshot = next; listeners.forEach(listener => listener()); }
  };
  const apply = (rows: D[], nextPast = past, nextFuture = future) => {
    const next = copy(rows);
    // A failed consumer callback must not advance local undo state.
    replace?.(copy(next));
    present = next; past = nextPast; future = nextFuture;
    signature = JSON.stringify(present); expected.push(signature); publish();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    synchronize(drafts: D[], onReplace: (drafts: D[]) => void) {
      replace = onReplace;
      const value = JSON.stringify(drafts), acknowledgement = expected.lastIndexOf(value);
      if (acknowledgement >= 0) expected.splice(0, acknowledgement + 1);
      else if (value !== incoming) { present = copy(drafts); signature = value; past = []; future = []; expected.length = 0; }
      incoming = value; publish();
    },
    prepare(draft: D) {
      if (!replace || draft.id === undefined || present.some(row => row.key === draft.key || row.id === draft.id)) return;
      const seed = (rows: D[]) => rows.some(row => row.key === draft.key || row.id === draft.id) ? rows : [...rows, { ...draft }];
      apply(seed(present), past.map(seed), future.map(seed));
    },
    replace(rows: D[]) { if (replace && JSON.stringify(rows) !== signature) apply(rows, [...past, present].slice(-50), []); },
    undo() { if (replace && past.length) apply(past.at(-1)!, past.slice(0, -1), [present, ...future].slice(0, 50)); },
    redo() { if (replace && future.length) apply(future[0], [...past, present].slice(-50), future.slice(1)); },
  };
}

export function useCatalogDraftHistory<D extends CatalogDraft>(drafts: D[], onReplace: (drafts: D[]) => void) {
  const history = useMemo(() => createCatalogDraftHistory<D>(), []);
  useLayoutEffect(() => { history.synchronize(drafts, onReplace); }, [history, drafts, onReplace]);
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);
  return useMemo(() => ({ prepare: history.prepare, replace: history.replace, undo: history.undo, redo: history.redo, ...snapshot }), [history, snapshot]);
}
