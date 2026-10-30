export type ChoiceMenuPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
};

/** Keep a scrollable choice list next to its field and inside the viewport. */
export function choiceMenuPosition(
  anchor: { top: number; bottom: number; left: number; width: number },
  viewport: { width: number; height: number },
  preferredWidth: number,
  preferredHeight = 420,
): ChoiceMenuPosition {
  const padding = 8;
  const gap = 6;
  const width = Math.max(0, Math.min(Math.max(anchor.width, preferredWidth), viewport.width - padding * 2));
  const left = Math.max(padding, Math.min(anchor.left, viewport.width - width - padding));
  const roomBelow = Math.max(0, viewport.height - anchor.bottom - padding - gap);
  const roomAbove = Math.max(0, anchor.top - padding - gap);
  const placement = roomBelow < Math.min(preferredHeight, 240) && roomAbove > roomBelow ? "top" : "bottom";
  const maxHeight = Math.min(preferredHeight, placement === "top" ? roomAbove : roomBelow);
  return {
    ...(placement === "top" ? { bottom: viewport.height - anchor.top + gap } : { top: anchor.bottom + gap }),
    left, width, maxHeight, placement,
  };
}

/** Measure labels in the field's font, allowing room for padding, checks and scrollbars. */
export function choiceMenuWidth(anchor: HTMLElement, labels: readonly string[], minimum = 280) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return minimum;
  context.font = getComputedStyle(anchor).font;
  let width = minimum;
  for (const label of labels) width = Math.max(width, context.measureText(label).width + 64);
  return Math.min(640, Math.ceil(width));
}
