"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { GridEmployeeDraft } from "./AgDataGrids";

type HistoryProps = {
  drafts: GridEmployeeDraft[];
  onReplaceDrafts?: (drafts: GridEmployeeDraft[]) => void;
};
type Snapshot = { canUndo: boolean; canRedo: boolean };
const copy = (drafts: GridEmployeeDraft[]) => drafts.map(draft => ({ ...draft }));
const signature = (drafts: GridEmployeeDraft[]) => JSON.stringify(drafts.map(draft => [
  draft.key, draft.id ?? null, draft.fullName, draft.employmentType, draft.department, draft.position, draft.projectSiteId,
]));

/** A small external store keeps consecutive edits current before React acknowledges them. */
export function createEmployeeSpreadsheetHistory() {
  let present: GridEmployeeDraft[] = [];
  let presentSignature = signature(present);
  let incomingSignature: string | undefined;
  let past: GridEmployeeDraft[][] = [];
  let future: GridEmployeeDraft[][] = [];
  const expected: string[] = [];
  let onReplace: HistoryProps["onReplaceDrafts"];
  let snapshot: Snapshot = { canUndo: false, canRedo: false };
  const listeners = new Set<() => void>();

  const publish = () => {
    const next = { canUndo: Boolean(onReplace && past.length), canRedo: Boolean(onReplace && future.length) };
    if (next.canUndo === snapshot.canUndo && next.canRedo === snapshot.canRedo) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const apply = (next: GridEmployeeDraft[]) => {
    present = copy(next);
    presentSignature = signature(present);
    expected.push(presentSignature);
    onReplace?.(copy(present));
    publish();
  };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    synchronize({ drafts, onReplaceDrafts }: HistoryProps) {
      onReplace = onReplaceDrafts;
      const incoming = signature(drafts);
      // React may acknowledge only the last of several batched edits, or an
      // earlier edit while a newer one is already waiting. Neither resets undo.
      const acknowledgement = expected.lastIndexOf(incoming);
      if (acknowledgement >= 0) expected.splice(0, acknowledgement + 1);
      else if (incoming !== incomingSignature) {
        present = copy(drafts);
        presentSignature = incoming;
        past = [];
        future = [];
        expected.length = 0;
      }
      incomingSignature = incoming;
      publish();
    },
    prepare(draft: GridEmployeeDraft) {
      if (!onReplace || typeof draft.id !== "number" || !Number.isSafeInteger(draft.id) || draft.id <= 0 || !draft.key
        || present.some(current => current.id === draft.id || current.key === draft.key)) return;
      // Opening another employee is preparation for editing, not an edit itself.
      // Give all undo/redo states that employee's original server values too.
      const seed = (drafts: GridEmployeeDraft[]) => drafts.some(current => current.id === draft.id || current.key === draft.key)
        ? drafts : [...drafts, { ...draft }];
      past = past.map(seed);
      future = future.map(seed);
      apply(seed(present));
    },
    replace(nextDrafts: GridEmployeeDraft[]) {
      if (!onReplace || signature(nextDrafts) === presentSignature) return;
      past = [...past, present].slice(-50);
      future = [];
      apply(nextDrafts);
    },
    undo() {
      if (!onReplace || !past.length) return;
      const previous = past[past.length - 1];
      past = past.slice(0, -1);
      future = [present, ...future].slice(0, 50);
      apply(previous);
    },
    redo() {
      if (!onReplace || !future.length) return;
      const next = future[0];
      future = future.slice(1);
      past = [...past, present].slice(-50);
      apply(next);
    },
  };
}

export function useEmployeeSpreadsheetHistory({ drafts, onReplaceDrafts }: HistoryProps) {
  const controller = useMemo(() => createEmployeeSpreadsheetHistory(), []);
  useLayoutEffect(() => { controller.synchronize({ drafts, onReplaceDrafts }); }, [controller, drafts, onReplaceDrafts]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return useMemo(() => ({ prepare: controller.prepare, replace: controller.replace, undo: controller.undo, redo: controller.redo, ...snapshot }), [controller, snapshot]);
}
