const HEADER_SCROLL_START = 48;
const HEADER_COLLAPSE_DISTANCE = 104;
const HEADER_STYLE_PROPERTIES = [
  "--timesheet-heading-height",
  "--timesheet-summary-height",
  "--timesheet-header-gap",
  "--timesheet-summary-padding-block",
  "--timesheet-summary-border-y",
  "--timesheet-header-opacity",
  "--timesheet-heading-shift",
  "--timesheet-summary-shift",
] as const;

function workspaceFor(element: HTMLElement | null) {
  if (!element) return null;
  return element.matches(".timesheet-workspace-page")
    ? element
    : element.closest<HTMLElement>(".timesheet-workspace-page");
}

export function resetTimesheetHeaderScroll(element: HTMLElement | null) {
  const workspace = workspaceFor(element);
  if (!workspace) return;
  for (const property of HEADER_STYLE_PROPERTIES) workspace.style.removeProperty(property);
}

export function syncTimesheetHeaderScroll(scrollContainer: HTMLElement) {
  const workspace = workspaceFor(scrollContainer);
  if (!workspace) return;
  if (window.matchMedia("(max-width: 760px)").matches) {
    resetTimesheetHeaderScroll(workspace);
    return;
  }

  const progress = Math.min(1, Math.max(0, (scrollContainer.scrollTop - HEADER_SCROLL_START) / HEADER_COLLAPSE_DISTANCE));
  const remaining = 1 - progress;
  const px = (value: number) => `${Math.max(0, value).toFixed(3)}px`;
  const signedPx = (value: number) => `${value.toFixed(3)}px`;

  workspace.style.setProperty("--timesheet-heading-height", px(52 * remaining));
  workspace.style.setProperty("--timesheet-summary-height", px(42 * remaining));
  workspace.style.setProperty("--timesheet-header-gap", px(10 * remaining));
  workspace.style.setProperty("--timesheet-summary-padding-block", px(4 * remaining));
  workspace.style.setProperty("--timesheet-summary-border-y", px(remaining));
  workspace.style.setProperty("--timesheet-header-opacity", remaining.toFixed(4));
  workspace.style.setProperty("--timesheet-heading-shift", signedPx(-8 * progress));
  workspace.style.setProperty("--timesheet-summary-shift", signedPx(-6 * progress));
}
