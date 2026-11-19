import { isTableSelectionEscape } from "./useTableEscapeSelection";

type FilterOwner = {
  root: () => HTMLElement | null;
  hasFilters: () => boolean;
  isEditing: () => boolean;
  reset: () => void;
};

function visible(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected && !element.closest("[aria-hidden='true'], [hidden]")
    && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}

/** One dispatcher chooses the nearest table, including nested detail grids.
 * Window capture runs before selection and popup handlers can change the DOM. */
export function createTableFilterEscapeController(doc: Document) {
  const owners = new Set<FilterOwner>();
  let lastOwner: FilterOwner | undefined;
  let dragging = false;
  const live = () => [...owners].filter(owner => visible(owner.root()));
  const closest = (target: EventTarget | null, candidates: FilterOwner[]) => {
    if (!(target instanceof Node)) return undefined;
    return candidates.filter(owner => owner.root()?.contains(target)).reduce<FilterOwner | undefined>((nearest, owner) =>
      !nearest || nearest.root()?.contains(owner.root()) ? owner : nearest, undefined);
  };
  const remember = (event: Event) => {
    const owner = closest(event.target, live());
    if (owner) lastOwner = owner;
  };
  const dragStart = () => { dragging = true; };
  const dragEnd = () => { dragging = false; };
  const escape = (event: KeyboardEvent) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || dragging
      || doc.body.classList.contains("timesheet-column-resizing") || !isTableSelectionEscape(event)) return;
    // Editors and pointer gestures still own Escape after focus leaves them.
    if (Array.from(doc.querySelectorAll<HTMLElement>(".ag-cell-inline-editing, .timesheet-cell-inline-editor, .ag-column-resizing, .ag-dnd-ghost")).some(visible)) return;
    const candidates = live();
    if (candidates.some(owner => owner.isEditing())) return;
    const owner = closest(event.target, candidates) ?? closest(doc.activeElement, candidates)
      ?? (lastOwner && candidates.includes(lastOwner) ? lastOwner : candidates.length === 1 ? candidates[0] : undefined);
    if (!owner?.hasFilters()) return;
    event.preventDefault();
    event.stopPropagation();
    owner.reset();
  };
  return {
    register(owner: FilterOwner) {
      if (!owners.size) {
        doc.defaultView?.addEventListener("keydown", escape, true);
        doc.addEventListener("pointerdown", remember, true);
        doc.addEventListener("focusin", remember, true);
        doc.addEventListener("dragstart", dragStart, true);
        doc.addEventListener("dragend", dragEnd, true);
        doc.addEventListener("drop", dragEnd, true);
        doc.defaultView?.addEventListener("blur", dragEnd);
      }
      owners.add(owner);
      return () => {
        owners.delete(owner);
        if (lastOwner === owner) lastOwner = undefined;
        if (owners.size) return;
        dragging = false;
        doc.defaultView?.removeEventListener("keydown", escape, true);
        doc.removeEventListener("pointerdown", remember, true);
        doc.removeEventListener("focusin", remember, true);
        doc.removeEventListener("dragstart", dragStart, true);
        doc.removeEventListener("dragend", dragEnd, true);
        doc.removeEventListener("drop", dragEnd, true);
        doc.defaultView?.removeEventListener("blur", dragEnd);
      };
    },
  };
}

const controllers = new WeakMap<Document, ReturnType<typeof createTableFilterEscapeController>>();
export function registerTableFilterEscape(owner: FilterOwner) {
  let controller = controllers.get(document);
  if (!controller) { controller = createTableFilterEscapeController(document); controllers.set(document, controller); }
  return controller.register(owner);
}
