import type { WorkTypeRow } from "./workTypesWorkspace.ts";

/** One contract for the combined directory, including its legacy navigation URLs. */
export const WORK_TYPES_EXCEL_HEADERS = ["Вид работы", "Подвид работы"];
export const WORK_TYPES_EXCEL_WIDTHS = [45, 70];
export const WORK_TYPES_EXCEL_SHEET = "Виды и подвиды работ";
export const workTypesTemplateRows = () => Array.from({ length: 25 }, () => ["", ""]);

export function workTypesExcelValues(parents: readonly WorkTypeRow[], childrenFor: (parent: WorkTypeRow) => readonly WorkTypeRow[]): string[][] {
  return parents.flatMap(parent => {
    const children = childrenFor(parent);
    return children.length ? children.map(child => [parent.unassigned ? "" : parent.name, child.name]) : parent.unassigned ? [] : [[parent.name, ""]];
  });
}
