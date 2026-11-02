import type { GridDraftRow, GridEmployee, GridOption } from "./AgDataGrids";
import { subworkOptions, workTypeChanges } from "./workTypeHierarchy.ts";

export const personnelEditableFields = ["employeeName", "shift", "zone", "mainWork", "subwork", "master", "hours", "note"] as const;
export type PersonnelCellField = typeof personnelEditableFields[number];
export type PersonnelSpreadsheetDraft = GridDraftRow & {
  reportRowId?: number;
  importBatchId?: string;
  createdAt?: string;
  updatedAt?: string;
  referenceIds?: Partial<Record<"employeeId" | "shiftId" | "zoneId" | "mainWorkTypeId" | "subworkTypeId" | "masterId", number | null>>;
  inputValues?: Partial<Record<PersonnelCellField, string>>;
};
export type PersonnelImportBatch = { id: string; rows: readonly Pick<PersonnelSpreadsheetDraft, "key" | "employeeId">[] };

/** A workbook can span several dates; every saved day retains the same file order. */
export function personnelImportedEmployeeOrder(drafts: readonly PersonnelSpreadsheetDraft[], batches: readonly PersonnelImportBatch[], allDrafts: readonly PersonnelSpreadsheetDraft[] = drafts): number[] | undefined {
  const activeBatches = new Set(drafts.flatMap(row => row.importBatchId ? [row.importBatchId] : []));
  const latest = batches.findLast(batch => activeBatches.has(batch.id));
  if (!latest) return undefined;
  const live = new Map(allDrafts.map(row => [row.key, row.employeeId]));
  const ids = [...new Set(latest.rows.map(row => Number(live.get(row.key) ?? row.employeeId)).filter(id => Number.isSafeInteger(id) && id > 0))];
  return ids.length ? ids : undefined;
}
export type PersonnelSpreadsheetCatalogs = {
  employees: GridEmployee[]; shifts: GridOption[]; zones: GridOption[]; mainWorkTypes: GridOption[]; subworkTypes: GridOption[]; masters: GridOption[];
};

/** Timestamp committed content changes, leaving no-op edits and row moves alone. */
export function timestampPersonnelDraft(previous: PersonnelSpreadsheetDraft, next: PersonnelSpreadsheetDraft, time = new Date().toISOString()): PersonnelSpreadsheetDraft {
  const fields = ["employeeId", "employeeQuery", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "masterId", "hours", "note"] as const;
  const changed = fields.some((field) => previous[field] !== next[field])
    || personnelEditableFields.some((field) => previous.inputValues?.[field] !== next.inputValues?.[field]);
  return changed ? { ...next, updatedAt: time } : previous;
}
export const personnelOptionFields = {
  shift: { draft: "shiftId", options: "shifts", label: "Смена" },
  zone: { draft: "zoneId", options: "zones", label: "Зона" },
  mainWork: { draft: "mainWorkTypeId", options: "mainWorkTypes", label: "Вид работы" },
  subwork: { draft: "subworkTypeId", options: "subworkTypes", label: "Подвид работы" },
  master: { draft: "masterId", options: "masters", label: "Мастер" },
} as const;
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

/** Keep unrecognised text alongside IDs, so a bad cell never discards its neighbours. */
export function pastePersonnelCells(draft: PersonnelSpreadsheetDraft, values: Record<string, string>, catalogs: PersonnelSpreadsheetCatalogs): PersonnelSpreadsheetDraft {
  const next = { ...draft, inputValues: { ...draft.inputValues } };
  if (values.employeeName !== undefined && !draft.lockedEmployee) {
    const raw = values.employeeName;
    const matches = catalogs.employees.filter(employee => normalize(employee.fullName) === normalize(raw));
    const employee = matches.length === 1 ? matches[0] : undefined;
    next.employeeId = employee ? String(employee.id) : "";
    next.employeeQuery = employee?.fullName ?? raw;
    if (raw.trim() && !employee) next.inputValues.employeeName = raw;
    else delete next.inputValues.employeeName;
  }
  for (const [field, config] of Object.entries(personnelOptionFields)) {
    if (values[field] === undefined) continue;
    const raw = values[field];
    const options = field === "subwork" ? subworkOptions(catalogs.subworkTypes, next.mainWorkTypeId) : catalogs[config.options];
    const matches = options.filter(option => normalize(option.name) === normalize(raw) || String(option.id) === raw.trim());
    const option = matches.length === 1 ? matches[0] : undefined;
    next[config.draft] = option ? String(option.id) : "";
    if (raw.trim() && !option) next.inputValues[field as PersonnelCellField] = raw;
    else delete next.inputValues[field as PersonnelCellField];
  }
  if (values.mainWork !== undefined && values.subwork === undefined && next.mainWorkTypeId !== draft.mainWorkTypeId) {
    Object.assign(next, workTypeChanges(draft, { mainWorkTypeId: next.mainWorkTypeId }, catalogs.subworkTypes));
    delete next.inputValues.subwork;
  }
  if (values.hours !== undefined) {
    const raw = values.hours.trim();
    const hours = Number(raw.replace(",", "."));
    const valid = raw !== "" && Number.isInteger(hours) && hours >= 1 && hours <= 10;
    next.hours = valid ? String(hours) : raw;
    if (raw && !valid) next.inputValues.hours = values.hours;
    else delete next.inputValues.hours;
  }
  if (values.note !== undefined) next.note = values.note;
  return next;
}

export function personnelCellErrors(draft: PersonnelSpreadsheetDraft, catalogs: PersonnelSpreadsheetCatalogs, required = false): Partial<Record<PersonnelCellField, string>> {
  const errors: Partial<Record<PersonnelCellField, string>> = {};
  const unchangedReference = (field: keyof NonNullable<PersonnelSpreadsheetDraft["referenceIds"]>) => Boolean(draft[field] && draft.referenceIds?.[field] === Number(draft[field]));
  if (draft.inputValues?.employeeName !== undefined || draft.employeeId && !catalogs.employees.some(employee => String(employee.id) === draft.employeeId) && !unchangedReference("employeeId")) errors.employeeName = "Сотрудник не найден в справочнике проекта или ФИО неоднозначно. Выберите сотрудника из списка.";
  else if (required && !draft.employeeId) errors.employeeName = "Выберите сотрудника.";
  for (const [field, config] of Object.entries(personnelOptionFields)) {
    if (draft.inputValues?.[field as PersonnelCellField] !== undefined || draft[config.draft] && !catalogs[config.options].some(option => String(option.id) === draft[config.draft]) && !unchangedReference(config.draft)) errors[field as PersonnelCellField] = `Значение не найдено в справочнике «${config.label}» или неоднозначно. Выберите значение из списка.`;
    else if (required && !draft[config.draft]) errors[field as PersonnelCellField] = `Заполните поле «${config.label}».`;
  }
  if (draft.subworkTypeId && !subworkOptions(catalogs.subworkTypes, draft.mainWorkTypeId).some(option => String(option.id) === draft.subworkTypeId) && !(unchangedReference("mainWorkTypeId") && unchangedReference("subworkTypeId"))) errors.subwork = "Подвид не относится к выбранному виду работы. Выберите подходящий подвид.";
  if (draft.hours !== "" && (!Number.isInteger(Number(draft.hours)) || Number(draft.hours) < 1 || Number(draft.hours) > 10)) errors.hours = "Укажите целое число от 1 до 10.";
  else if (required && draft.hours === "") errors.hours = "Укажите часы.";
  if (draft.note.length > 4000) errors.note = "Примечание должно быть не длиннее 4000 символов.";
  return errors;
}

export type DraftHistory<T> = { present: T; past: T[]; future: T[] };
export type DraftHistoryAction<T> = { type: "change"; update: T | ((value: T) => T) } | { type: "undo" | "redo" } | { type: "reset"; value: T };
export function draftHistoryReducer<T>(state: DraftHistory<T>, action: DraftHistoryAction<T>): DraftHistory<T> {
  if (action.type === "reset") return { present: action.value, past: [], future: [] };
  if (action.type === "undo") return state.past.length ? { present: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.present, ...state.future] } : state;
  if (action.type === "redo") return state.future.length ? { present: state.future[0], past: [...state.past, state.present], future: state.future.slice(1) } : state;
  if (action.type !== "change") return state;
  const next = typeof action.update === "function" ? (action.update as (value: T) => T)(state.present) : action.update;
  return next === state.present ? state : { present: next, past: [...state.past.slice(-49), state.present], future: [] };
}
