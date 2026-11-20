export const FILTER_POPUP_MIN_WIDTH = 260;
export const FILTER_POPUP_MIN_HEIGHT = 220;
const margin = 12;

type PopupSize = { left: number; top: number; width: number; height: number };
type ResizeState = { size: PopupSize | null; width: string; height: string };
const popups = new WeakMap<HTMLElement, ResizeState>();

/** Adopt dimensions written by the browser's native CSS resize control. */
export function constrainResizedFilterPopup(popup: HTMLElement) {
  const state = popups.get(popup), view = popup.ownerDocument.defaultView;
  if (!state || !view) return false;
  if (popup.style.height && (popup.style.height !== state.height || popup.style.width !== state.width)) {
    const rect = popup.getBoundingClientRect();
    state.size = { left: rect.left, top: rect.top, width: Number.parseFloat(popup.style.width) || rect.width, height: Number.parseFloat(popup.style.height) || rect.height };
    popup.classList.add("filter-popup-manually-sized");
  }
  const size = state.size;
  if (!size) return false;
  const availableWidth = Math.max(0, view.innerWidth - margin * 2);
  const availableHeight = Math.max(0, view.innerHeight - margin * 2);
  const width = Math.min(size.width, availableWidth), height = Math.min(size.height, availableHeight);
  const left = Math.max(margin, Math.min(size.left, view.innerWidth - width - margin));
  const top = Math.max(margin, Math.min(size.top, view.innerHeight - height - margin));
  const styles = {
    position: "fixed", width: `${width}px`, height: `${height}px`,
    left: `${left}px`, top: `${top}px`, maxWidth: `${availableWidth}px`, maxHeight: `${availableHeight}px`, visibility: "visible",
  };
  for (const [property, value] of Object.entries(styles)) {
    if (popup.style[property as keyof typeof styles] !== value) popup.style[property as keyof typeof styles] = value;
  }
  state.width = popup.style.width;
  state.height = popup.style.height;
  return true;
}

/** CSS resize: both supplies the browser's standard corner. This adapter only
 * keeps AG's anchored positioning from resetting the dimensions chosen there. */
export function makeFilterPopupResizable(popup: HTMLElement): () => void {
  const view = popup.ownerDocument.defaultView;
  if (!view) return () => {};
  const previousTitle = popup.getAttribute("title");
  const state: ResizeState = { size: null, width: popup.style.width, height: popup.style.height };
  popups.set(popup, state);
  popup.classList.add("resizable-filter-popup");
  popup.style.setProperty("--filter-popup-min-width", `${FILTER_POPUP_MIN_WIDTH}px`);
  popup.style.setProperty("--filter-popup-min-height", `${FILTER_POPUP_MIN_HEIGHT}px`);
  popup.title = "Потяните за край или угол, чтобы изменить размер";
  const prepare = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const rect = popup.getBoundingClientRect();
    if (event.clientX < rect.right - 18 || event.clientX > rect.right || event.clientY < rect.bottom - 18 || event.clientY > rect.bottom) return;
    // postProcessPopup can run before React mounts the filter contents.
    popup.style.setProperty("--filter-popup-min-width", `${Math.min(FILTER_POPUP_MIN_WIDTH, rect.width)}px`);
    popup.style.setProperty("--filter-popup-min-height", `${Math.min(FILTER_POPUP_MIN_HEIGHT, rect.height)}px`);
    // Release the automatic anchor-side height cap before native dragging starts.
    state.size = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    popup.classList.add("filter-popup-manually-sized");
    constrainResizedFilterPopup(popup);
  };
  const update = () => { constrainResizedFilterPopup(popup); };
  const observer = new view.MutationObserver(update);
  observer.observe(popup, { attributes: true, attributeFilter: ["style"] });
  // AG's submenu hover guard watches its filter panel. The browser's resize
  // corner belongs to the outer popup, so entering it must keep that panel open.
  const panel = popup.matches(".ag-filter-menu") ? null : popup.querySelector<HTMLElement>(".ag-filter-body-wrapper");
  const enter = () => { panel?.dispatchEvent(new view.MouseEvent("mouseenter")); };
  popup.addEventListener("mouseenter", enter);
  popup.addEventListener("pointerdown", prepare, true);
  view.addEventListener("resize", update);
  return () => {
    observer.disconnect();
    popup.removeEventListener("mouseenter", enter);
    popup.removeEventListener("pointerdown", prepare, true);
    view.removeEventListener("resize", update);
    popup.classList.remove("resizable-filter-popup", "filter-popup-manually-sized");
    popup.style.removeProperty("--filter-popup-min-width");
    popup.style.removeProperty("--filter-popup-min-height");
    if (previousTitle === null) popup.removeAttribute("title"); else popup.setAttribute("title", previousTitle);
    if (popups.get(popup) === state) popups.delete(popup);
  };
}
