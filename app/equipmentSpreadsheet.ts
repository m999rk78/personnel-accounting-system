import type { GridEquipmentDraft, GridEquipmentUnit, GridOption } from "./AgDataGrids";
import { equipmentUnavailableReason, isEquipmentUnavailable } from "./equipmentAvailability.ts";
import { equipmentExcelName } from "./equipmentExcel.ts";
import { subworkOptions, workTypeChanges } from "./workTypeHierarchy.ts";

export const equipmentEditableFields = ["equipment", "shift", "zone", "mainWork", "subwork", "hours", "note"] as const;
export type EquipmentCellField = typeof equipmentEditableFields[number];
export type EquipmentSpreadsheetDraft = GridEquipmentDraft & {
  reportRowId?: number;
  createdAt?: string;
  updatedAt?: string;
  lockedEquipment?: boolean;
  equipmentQuery?: string;
  referenceIds?: Partial<Record<"equipmentId" | "shiftId" | "zoneId" | "mainWorkTypeId" | "subworkTypeId", number | null>>;
  inputValues?: Partial<Record<EquipmentCellField, string>>;
};
export type EquipmentAvailabilityMark = { equipmentId: number; workDate: string; productiveHours: number; downtimeHours: number; note: string };
export type EquipmentSpreadsheetCatalogs = {
  units: GridEquipmentUnit[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
  dailyTimesheetMarks?: EquipmentAvailabilityMark[];
  workDate?: string;
};
export const equipmentOptionFields = {
  shift: { draft: "shiftId", options: "shifts", label: "Смена" },
  zone: { draft: "zoneId", options: "zones", label: "Зона" },
  mainWork: { draft: "mainWorkTypeId", options: "mainWorkTypes", label: "Вид работы" },
  subwork: { draft: "subworkTypeId", options: "subworkTypes", label: "Подвид работы" },
} as const;
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

export function equipmentSpreadsheetName(unit: Pick<GridEquipmentUnit, "equipmentType" | "brand" | "model" | "registrationNumber"> | undefined) {
  return unit ? [unit.equipmentType, unit.brand, unit.model, unit.registrationNumber && unit.registrationNumber !== "-" && unit.registrationNumber !== "—" ? `• ${unit.registrationNumber}` : ""].filter(Boolean).join(" ") : "";
}

export function equipmentUnavailableFor(catalogs: EquipmentSpreadsheetCatalogs, equipmentId: string | number, workDate?: string) {
  if (!workDate) return undefined;
  const mark = catalogs.dailyTimesheetMarks?.find(item => item.equipmentId === Number(equipmentId) && item.workDate === workDate && isEquipmentUnavailable(item));
  return mark ? equipmentUnavailableReason(mark) : undefined;
}

/** Row order changes and no-op edits must not update the modification timestamp. */
export function timestampEquipmentDraft(previous: EquipmentSpreadsheetDraft, next: EquipmentSpreadsheetDraft, time = new Date().toISOString()): EquipmentSpreadsheetDraft {
  const fields = ["equipmentId", "equipmentQuery", "shiftId", "zoneId", "mainWorkTypeId", "subworkTypeId", "hours", "note"] as const;
  const changed = fields.some(field => previous[field] !== next[field])
    || equipmentEditableFields.some(field => previous.inputValues?.[field] !== next.inputValues?.[field]);
  return changed ? { ...next, updatedAt: time } : previous;
}

/** Preserve invalid cell text, while applying valid neighbours in the same paste. */
export function pasteEquipmentCells(draft: EquipmentSpreadsheetDraft, values: Record<string, string>, catalogs: EquipmentSpreadsheetCatalogs): EquipmentSpreadsheetDraft {
  const next = { ...draft, inputValues: { ...draft.inputValues } };
  if (values.equipment !== undefined && !draft.lockedEquipment) {
    const raw = values.equipment;
    const normalized = normalize(raw);
    const matches = catalogs.units.filter(unit => [equipmentSpreadsheetName(unit), `${equipmentSpreadsheetName(unit)} · ${unit.organization}`, equipmentExcelName(unit), String(unit.id)].some(name => normalize(name) === normalized));
    const unit = matches.length === 1 ? matches[0] : undefined;
    next.equipmentId = unit ? String(unit.id) : "";
    next.equipmentQuery = unit ? equipmentSpreadsheetName(unit) : raw;
    if (raw.trim() && !unit) next.inputValues.equipment = raw;
    else delete next.inputValues.equipment;
  }
  for (const [field, config] of Object.entries(equipmentOptionFields)) {
    if (values[field] === undefined) continue;
    const raw = values[field];
    const options = field === "subwork" ? subworkOptions(catalogs.subworkTypes, next.mainWorkTypeId) : catalogs[config.options];
    const matches = options.filter(option => normalize(option.name) === normalize(raw) || String(option.id) === raw.trim());
    const option = matches.length === 1 ? matches[0] : undefined;
    next[config.draft] = option ? String(option.id) : "";
    if (raw.trim() && !option) next.inputValues[field as EquipmentCellField] = raw;
    else delete next.inputValues[field as EquipmentCellField];
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

export function equipmentCellErrors(draft: EquipmentSpreadsheetDraft, catalogs: EquipmentSpreadsheetCatalogs, required = false, workDate = catalogs.workDate): Partial<Record<EquipmentCellField, string>> {
  const errors: Partial<Record<EquipmentCellField, string>> = {};
  const unchangedReference = (field: keyof NonNullable<EquipmentSpreadsheetDraft["referenceIds"]>) => Boolean(draft[field] && draft.referenceIds?.[field] === Number(draft[field]));
  if (draft.inputValues?.equipment !== undefined || !draft.lockedEquipment && draft.equipmentId && !catalogs.units.some(unit => String(unit.id) === draft.equipmentId) && !unchangedReference("equipmentId")) errors.equipment = "Техника не найдена в проекте или наименование неоднозначно. Выберите единицу из списка.";
  else if (required && !draft.equipmentId) errors.equipment = "Выберите технику.";
  const unavailable = equipmentUnavailableFor(catalogs, draft.equipmentId, workDate);
  if (unavailable) errors.equipment = `Техника недоступна по табелю: ${unavailable}. Исправьте отметку в табеле техники или выберите другую единицу.`;
  for (const [field, config] of Object.entries(equipmentOptionFields)) {
    if (draft.inputValues?.[field as EquipmentCellField] !== undefined || draft[config.draft] && !catalogs[config.options].some(option => String(option.id) === draft[config.draft]) && !unchangedReference(config.draft)) errors[field as EquipmentCellField] = `Значение не найдено в справочнике «${config.label}» или неоднозначно. Выберите значение из списка.`;
    else if (required && !draft[config.draft]) errors[field as EquipmentCellField] = `Заполните поле «${config.label}».`;
  }
  if (draft.subworkTypeId && !subworkOptions(catalogs.subworkTypes, draft.mainWorkTypeId).some(option => String(option.id) === draft.subworkTypeId) && !(unchangedReference("mainWorkTypeId") && unchangedReference("subworkTypeId"))) errors.subwork = "Подвид не относится к выбранному виду работы. Выберите подходящий подвид.";
  if (draft.hours !== "" && (!Number.isInteger(Number(draft.hours)) || Number(draft.hours) < 1 || Number(draft.hours) > 10)) errors.hours = "Укажите целое число от 1 до 10.";
  else if (required && draft.hours === "") errors.hours = "Укажите часы.";
  if (draft.note.length > 4000) errors.note = "Примечание должно быть не длиннее 4000 символов.";
  return errors;
}
