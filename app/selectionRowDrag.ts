import type { ICellRendererParams } from "ag-grid-community";

export type SelectionRowDragParams = Pick<ICellRendererParams, "eGridCell" | "node" | "api" | "registerRowDragger"> & { canDrag: () => boolean };

/** Add dragging to the native checkbox without replacing its selection/keyboard behavior. */
export function attachSelectionRowDrag({ eGridCell, node, api, registerRowDragger, canDrag }: SelectionRowDragParams) {
  const checkbox = eGridCell.querySelector<HTMLElement>(".ag-selection-checkbox");
  if (!checkbox) return;
  let dragged = false;
  const available = () => node.selectable !== false && node.isSelected() === true && canDrag();
  const update = () => {
    checkbox.classList.toggle("table-selection-drag-ready", available());
    checkbox.title = available() ? "Перетащите отмеченную строку или все выбранные строки" : "Выберите строку. Отмеченную галочку можно перетащить для переноса";
  };
  const start = (event: Event) => {
    dragged = false;
    // Do not prevent the default checkbox action: a click must still select/deselect normally.
    if (!available()) event.stopPropagation();
  };
  const dragEntered = (event: { node: unknown }) => { if (event.node === node) dragged = true; };
  const click = (event: MouseEvent) => {
    // Keyboard/assistive clicks have no pointer click count and are never the drop's click.
    if (event.detail === 0) { dragged = false; return; }
    if (!dragged) return;
    // A drop can produce a trailing click. It must not uncheck the dragged selection.
    dragged = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  checkbox.addEventListener("pointerdown", start, true);
  checkbox.addEventListener("mousedown", start, true);
  checkbox.addEventListener("touchstart", start, true);
  eGridCell.addEventListener("click", click, true);
  node.addEventListener("rowSelected", update);
  node.addEventListener("selectableChanged", update);
  api.addEventListener("rowDragEnter", dragEntered);
  update();
  // Always visible is essential: suppressRowDrag must never hide the selection checkbox.
  // Capture listeners independently guard dragging when selection/permissions change.
  registerRowDragger(checkbox, 5, undefined, true);
  return () => {
    checkbox.removeEventListener("pointerdown", start, true);
    checkbox.removeEventListener("mousedown", start, true);
    checkbox.removeEventListener("touchstart", start, true);
    eGridCell.removeEventListener("click", click, true);
    checkbox.classList.remove("table-selection-drag-ready");
    checkbox.removeAttribute("title");
    node.removeEventListener("rowSelected", update);
    node.removeEventListener("selectableChanged", update);
    if (!api.isDestroyed()) api.removeEventListener("rowDragEnter", dragEntered);
  };
}
