"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createUndoShortcutController } from "./undoShortcut";

type UndoShortcutOptions = {
  rootRef: RefObject<HTMLElement | null>;
  undo: () => unknown;
  redo?: () => unknown;
  canUndo?: boolean;
  canRedo?: boolean;
  disabled?: boolean;
};

const controllers = new WeakMap<Document, ReturnType<typeof createUndoShortcutController>>();
function controller(document: Document) {
  let current = controllers.get(document);
  if (!current) { current = createUndoShortcutController(document); controllers.set(document, current); }
  return current;
}

/** Grid capture handlers may route before AG Grid consumes the native event.
 * The document listener sees defaultPrevented and cannot execute it twice. */
export function dispatchUndoShortcut(event: KeyboardEvent) {
  if (typeof document === "undefined") return false;
  const targetDocument = (event.target as Node | null)?.ownerDocument ?? document;
  return controllers.get(targetDocument)?.dispatch(event) ?? false;
}

export function useUndoShortcut({ rootRef, undo, redo, canUndo, canRedo, disabled }: UndoShortcutOptions) {
  const latest = useRef({ undo, redo, canUndo, canRedo, disabled });
  useLayoutEffect(() => { latest.current = { undo, redo, canUndo, canRedo, disabled }; });
  useEffect(() => {
    const document = rootRef.current?.ownerDocument ?? globalThis.document;
    if (!document) return;
    return controller(document).register({
      root: () => rootRef.current,
      undo: () => latest.current.undo(),
      redo: () => latest.current.redo?.(),
      canUndo: () => latest.current.canUndo ?? true,
      canRedo: () => Boolean(latest.current.redo) && (latest.current.canRedo ?? true),
      disabled: () => latest.current.disabled ?? false,
    });
  }, [rootRef]);
}
