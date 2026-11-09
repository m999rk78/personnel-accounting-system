import type { DataSet, DirectoryEntity, DirectoryFocus, Site, View, WorkspaceUnsavedState } from "./types";

export function emptyDataSet(sites: Site[] = []): DataSet {
  return {
    sites,
    employees: [],
    reportEmployees: [],
    placementEmployees: [],
    projectEmployees: [],
    positionCatalog: [],
    employmentTypes: [],
    departments: [],
    positions: [],
    shifts: [],
    zones: [],
    mainWorkTypes: [],
    subworkTypes: [],
    masters: [],
    users: [],
  };
}

export function workspaceNavigationDiscards(current: WorkspaceUnsavedState, nextView: View, nextFocus: DirectoryFocus, changingProject = false) {
  const leavingTable = changingProject || current.view !== nextView || current.view === "directories" && current.focus !== nextFocus;
  const leavingWorkTypes = changingProject || nextView !== "directories" || nextFocus !== "mainWorkType" && nextFocus !== "subworkType";
  return {
    settings: current.settings && leavingTable,
    report: current.report && (changingProject || nextView !== "placement"),
    equipment: current.equipment && (changingProject || nextView !== "equipment"),
    workTypes: current.workTypes && leavingWorkTypes,
  };
}

export function pendingWorkspaceGridInput() {
  const input = document.activeElement;
  const changed = (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && input.value !== input.defaultValue;
  if (!changed) return { settings: false, report: false, equipment: false, workTypes: false };
  const report = Boolean(input.closest(".personnel-report-workspace:not(.equipment-report-workspace)"));
  const savedDraft = report && Boolean(input.closest('[data-draft-autosave-protected="true"]'));
  const equipment = Boolean(input.closest(".equipment-report-workspace"));
  const workTypes = Boolean(input.closest(".work-types-directory"));
  return {
    report: report && !savedDraft,
    equipment,
    workTypes,
    settings: !report && !equipment && !workTypes && Boolean(input.closest(".ag-grid-shell")),
  };
}

export function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

export function directoryExcelHeader(entity: DirectoryEntity) {
  if (entity === "zone") return "Зона";
  if (entity === "mainWorkType") return "Вид работы";
  if (entity === "subworkType") return "Вид подработ";
  if (entity === "master") return "ФИО";
  return "Название";
}

export const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
export const newKey = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
