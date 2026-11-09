type PopupGeometry = {
  anchor: { top: number; bottom: number; left: number };
  width: number;
  height: number;
  preferredHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

/** Constrain the list on one side of its button, keeping the button clickable. */
export function gridFilterPopupGeometry({ anchor, width, height, preferredHeight, viewportWidth, viewportHeight }: PopupGeometry) {
  const margin = 12, gap = 6;
  const below = Math.max(0, viewportHeight - anchor.bottom - margin - gap);
  const above = Math.max(0, anchor.top - margin - gap);
  const preferred = Math.max(0, Math.min(preferredHeight, viewportHeight - margin * 2));
  const placeBelow = below >= preferred || below >= above;
  const maxHeight = Math.floor(Math.min(preferred, placeBelow ? below : above));
  const visibleHeight = Math.min(height, maxHeight);
  return {
    left: Math.round(Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin))),
    top: Math.round(Math.max(margin, placeBelow ? anchor.bottom + gap : anchor.top - visibleHeight - gap)),
    maxHeight,
  };
}
