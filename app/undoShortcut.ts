export type HistoryShortcut = "undo" | "redo";

type HistoryKeyEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

/** Physical codes work in every layout; the Cyrillic fallbacks cover synthetic
 * events and platforms which don't supply KeyboardEvent.code. */
export function historyShortcut(event: HistoryKeyEvent): HistoryShortcut | null {
  if (event.defaultPrevented || event.altKey || event.isComposing || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLocaleLowerCase("en-US");
  if (event.code === "KeyZ" || key === "z" || key === "я") return event.shiftKey ? "redo" : "undo";
  if (event.code === "KeyY" || key === "y" || key === "н") return "redo";
  return null;
}

function elementTarget(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  return target as Element;
}

/** Keep the browser's native text undo, but let checkboxes, buttons and closed
 * select controls undo their enclosing application draft. */
export function isHistoryTextEntryTarget(target: EventTarget | null) {
  const element = elementTarget(target);
  if (!element) return false;
  if (element.closest("textarea, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='searchbox']")) return true;
  const input = element.closest<HTMLInputElement>("input");
  return Boolean(input && !["checkbox", "radio", "button", "submit", "reset", "image", "range", "color", "file", "hidden"].includes(input.type));
}

function visible(element: HTMLElement) {
  if (!element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']") || !element.getClientRects().length) return false;
  const visibility = element.ownerDocument.defaultView?.getComputedStyle(element).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

export type UndoShortcutOwner = {
  root: () => HTMLElement | null;
  undo: () => unknown;
  redo?: () => unknown;
  canUndo?: () => boolean;
  canRedo?: () => boolean;
  disabled?: () => boolean;
};

const popupSelector = "[role='menu'], [role='listbox'], .ag-popup-child, .ag-popup-editor, .ag-filter, .ag-menu, .personnel-filter, .custom-select-menu, .table-context-menu, .report-date-popover, .report-date-calendar, .timesheet-cell-popover, .timesheet-month-picker-popover, .calendar-popover, .statistics-period-calendar";
const modalSelector = "dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true']";
const tableSelector = "table, [role='table'], [role='grid'], [role='treegrid'], [role='application'], .ag-root";

/** One document-level dispatcher owns all histories. A history without undo
 * steps is still an owner, so another table's history cannot run in its place. */
export function createUndoShortcutController(document: Document) {
  const owners = new Map<symbol, UndoShortcutOwner>();
  const inFlight = new Set<symbol>();
  let active: symbol | null = null;

  const available = () => [...owners].flatMap(([id, owner]) => {
    const root = owner.root();
    return root && visible(root) ? [{ id, owner, root }] : [];
  });
  type Candidate = ReturnType<typeof available>[number];
  const nearest = (candidates: Candidate[], target: EventTarget | null) => {
    const element = elementTarget(target);
    if (!element) return undefined;
    return candidates.filter(({ root }) => root === element || root.contains(element))
      .reduce<Candidate | undefined>((best, candidate) => !best || best.root.contains(candidate.root) ? candidate : best, undefined);
  };
  const rememberActive = (event: Event) => {
    const candidate = nearest(available(), event.target);
    if (candidate) active = candidate.id;
  };

  const dispatch = (event: KeyboardEvent) => {
    const direction = historyShortcut(event);
    if (!direction || isHistoryTextEntryTarget(event.target) || isHistoryTextEntryTarget(document.activeElement)) return false;
    if ([...document.querySelectorAll<HTMLElement>(popupSelector)].some(visible)) return false;
    const modal = [...document.querySelectorAll<HTMLElement>(modalSelector)].filter(visible).at(-1);
    const candidates = available().filter(({ root }) => !modal || modal === root || modal.contains(root));
    let candidate = nearest(candidates, event.target);
    // A click/key in an unrelated table wins even if the browser left focus
    // behind in a previously edited, registered table.
    if (!candidate && elementTarget(event.target)?.closest(tableSelector)) return false;
    candidate ??= nearest(candidates, document.activeElement);
    if (!candidate) {
      // A non-registered read-only table owns its keyboard too. Never undo a
      // previous table simply because a different table does not have history.
      candidate = candidates.find(({ id }) => id === active) ?? (candidates.length === 1 ? candidates[0] : undefined);
    }
    if (!candidate || candidate.owner.disabled?.() || inFlight.has(candidate.id)) return false;
    const { id, owner } = candidate;
    const action = direction === "undo" ? owner.undo : owner.redo;
    if (!action || (direction === "undo" ? owner.canUndo?.() === false : owner.canRedo?.() === false)) return false;
    active = id;
    event.preventDefault();
    event.stopPropagation();
    try {
      const result = action();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        inFlight.add(id);
        void Promise.resolve(result).catch(error => console.error("History shortcut failed", error)).finally(() => inFlight.delete(id));
      }
    } catch (error) {
      console.error("History shortcut failed", error);
    }
    return true;
  };

  return {
    dispatch,
    register(owner: UndoShortcutOwner) {
      const id = Symbol("undo-owner");
      owners.set(id, owner);
      if (owners.size === 1) {
        document.addEventListener("keydown", dispatch);
        document.addEventListener("pointerdown", rememberActive, true);
        document.addEventListener("focusin", rememberActive, true);
      }
      return () => {
        owners.delete(id);
        inFlight.delete(id);
        if (active === id) active = null;
        if (!owners.size) {
          document.removeEventListener("keydown", dispatch);
          document.removeEventListener("pointerdown", rememberActive, true);
          document.removeEventListener("focusin", rememberActive, true);
        }
      };
    },
  };
}
