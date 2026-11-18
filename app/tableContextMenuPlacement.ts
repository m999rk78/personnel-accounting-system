type MenuAnchor = { left: number; right: number; top: number; bottom: number };

export function placeTableContextMenu({ x, y, width, height, viewportWidth, viewportHeight, anchor }: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  anchor?: MenuAnchor;
}) {
  const margin = 8;
  let left = x;
  let top = y;
  let maxHeight = Math.max(0, viewportHeight - margin * 2);

  if (anchor) {
    top = anchor.top;
    if (anchor.right + width <= viewportWidth - margin) {
      left = anchor.right;
    } else if (anchor.left - width >= margin) {
      left = anchor.left - width;
    } else {
      // Clamping a sideways flyout on a narrow screen would cover its trigger:
      // pointerenter could then turn the opening click into a submenu action.
      left = anchor.left;
      const below = Math.max(0, viewportHeight - margin - anchor.bottom);
      const above = Math.max(0, anchor.top - margin);
      const openBelow = height <= below || below >= above;
      maxHeight = openBelow ? below : above;
      top = openBelow ? anchor.bottom : anchor.top - Math.min(height, maxHeight);
    }
  }

  return {
    left: Math.max(margin, Math.min(left, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(top, viewportHeight - Math.min(height, maxHeight) - margin)),
    maxHeight,
  };
}
