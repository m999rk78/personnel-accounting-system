import { equipmentExcelName } from "./equipmentExcel.ts";
import { parsePersonnelImportDate } from "./personnelImportDates.ts";

export type EquipmentImportUnit = {
  id: number;
  organization: string;
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
};
export type EquipmentImportOption = { id: number; name: string; mainWorkTypeId?: number | null; active?: number };
export type EquipmentImportRow = {
  rowNumber: number;
  workDate: string;
  equipmentName: string;
  shiftName: string;
  zoneName: string;
  mainWorkTypeName: string;
  subworkTypeName: string;
  note: string;
  hours: number;
};

export const normalizeEquipmentImportName = (name: string) => name.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

export function equipmentRegistryProjectIndex(projects: readonly { id: number; name: string }[]) {
  const result = new Map<string, number[]>();
  for (const project of projects) {
    const key = normalizeEquipmentImportName(project.name);
    const ids = result.get(key) ?? [];
    ids.push(project.id);
    result.set(key, ids);
  }
  return result;
}

export function resolveEquipmentRegistryProject(index: ReturnType<typeof equipmentRegistryProjectIndex>, value: unknown, hasProjectColumn: boolean) {
  if (!hasProjectColumn) return undefined;
  if (typeof value !== "string") throw new Error("название проекта должно быть текстом");
  const name = value.trim();
  if (name.length > 240) throw new Error("название проекта должно содержать не более 240 символов");
  const normalized = normalizeEquipmentImportName(name);
  if (!normalized || ["не назначена", "не назначен", "без проекта", "-", "—"].includes(normalized)) return null;
  const matches = index.get(normalized) ?? [];
  if (!matches.length) throw new Error(`проект «${name}» не найден`);
  if (matches.length !== 1) throw new Error(`название проекта «${name}» неоднозначно: найдены несколько проектов; задайте уникальные названия перед импортом`);
  return matches[0];
}

export function assertUniqueEquipmentImportIdentities(rows: readonly { identityKey: string }[]) {
  const seen = new Map<string, number>();
  rows.forEach((row, index) => {
    const previous = seen.get(row.identityKey);
    if (previous !== undefined) throw new Error(`Строка ${index + 1}: эта техника уже указана в строке ${previous + 1}. Оставьте одну строку на единицу техники.`);
    seen.set(row.identityKey, index);
  });
}

function identifierKey(value: string) {
  return value.split("//").map((part, index) => {
    const normalized = normalizeEquipmentImportName(part);
    // Registration spacing and the two common empty-number markers are equivalent.
    return index === 2 ? (normalized === "—" ? "-" : normalized.replaceAll(" ", "")) : normalized;
  }).join("//");
}

/** Never select equipment using a registration number alone: every identity field must match. */
export function equipmentImportIndex(units: readonly EquipmentImportUnit[]) {
  const index = new Map<string, EquipmentImportUnit[]>();
  for (const unit of units) {
    const identifiers = [equipmentExcelName(unit), equipmentExcelName({ ...unit, brand: "" })];
    for (const key of new Set(identifiers.map(identifierKey))) {
      const candidates = index.get(key) ?? [];
      if (!candidates.some((candidate) => candidate.id === unit.id)) candidates.push(unit);
      index.set(key, candidates);
    }
  }
  return index;
}

export function matchEquipmentImportUnit(index: ReturnType<typeof equipmentImportIndex>, identifier: string) {
  const candidates = index.get(identifierKey(identifier)) ?? [];
  if (!candidates.length) throw new Error("техника с таким полным наименованием не найдена в проекте; скопируйте наименование из листа «Справочники»");
  if (candidates.length !== 1) throw new Error("полное наименование техники неоднозначно: найдены разные единицы; уточните карточки реестра");
  return candidates[0];
}

export function normalizeEquipmentImportRows(input: unknown): EquipmentImportRow[] {
  if (!Array.isArray(input) || !input.length || input.length > 5000) throw new Error("В файле должно быть от 1 до 5000 заполненных строк отчёта техники.");
  return input.map((value, index) => {
    const rowNumber = index + 1;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Строка ${rowNumber}: некорректные данные отчёта.`);
    const row = value as Record<string, unknown>;
    const field = (key: string, label: string, maximum = 240, optional = false) => {
      const value = row[key];
      if (optional && (value === undefined || value === null)) return "";
      if (typeof value !== "string") throw new Error(`Строка ${rowNumber}: ${label} должно быть текстом.`);
      const result = value.trim();
      if ((!optional && (!result || result === "-" || result === "—")) || result.length > maximum) throw new Error(`Строка ${rowNumber}: заполните ${label} (до ${maximum} символов).`);
      return result;
    };
    const workDate = field("workDate", "дату", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error(`Строка ${rowNumber}: некорректная дата отчёта.`);
    try { parsePersonnelImportDate(workDate); }
    catch { throw new Error(`Строка ${rowNumber}: некорректная календарная дата отчёта.`); }
    const rawHours = row.hours;
    const hours = typeof rawHours === "number" ? rawHours : typeof rawHours === "string" && /^\d{1,2}$/.test(rawHours.trim()) ? Number(rawHours.trim()) : NaN;
    if (!Number.isInteger(hours) || hours < 1 || hours > 10) throw new Error(`Строка ${rowNumber}: часы должны быть целым числом от 1 до 10.`);
    return {
      rowNumber, workDate,
      equipmentName: field("equipmentName", "полное наименование техники", 1000),
      shiftName: field("shiftName", "смену"),
      zoneName: field("zoneName", "зону"),
      mainWorkTypeName: field("mainWorkTypeName", "вид работы"),
      subworkTypeName: field("subworkTypeName", "подвид работы"),
      note: field("note", "примечание", 500, true),
      hours,
    };
  });
}

function optionIndex(rows: readonly EquipmentImportOption[]) {
  const index = new Map<string, EquipmentImportOption[]>();
  for (const row of rows) {
    const key = normalizeEquipmentImportName(row.name);
    const candidates = index.get(key) ?? [];
    candidates.push(row);
    index.set(key, candidates);
  }
  return index;
}

function findOption(index: ReadonlyMap<string, EquipmentImportOption[]>, name: string, label: string) {
  const key = normalizeEquipmentImportName(name);
  const candidates = index.get(key) ?? [];
  if (!candidates.length) throw new Error(`${label} «${name}» не найден в справочниках проекта`);
  if (candidates.length > 1) throw new Error(`${label} «${name}» неоднозначен: в справочнике есть повторяющиеся названия`);
  return candidates[0].id;
}

export function planEquipmentImport(rows: readonly EquipmentImportRow[], references: {
  units: readonly EquipmentImportUnit[];
  shifts: readonly EquipmentImportOption[];
  mainWorkTypes: readonly EquipmentImportOption[];
  subworkTypes: readonly EquipmentImportOption[];
}) {
  const index = equipmentImportIndex(references.units);
  const shifts = optionIndex(references.shifts);
  const mainWorkTypes = optionIndex(references.mainWorkTypes);
  const childrenByParent = new Map<number, EquipmentImportOption[]>();
  for (const child of references.subworkTypes) {
    if (!child.mainWorkTypeId) continue;
    const children = childrenByParent.get(child.mainWorkTypeId) ?? [];
    children.push(child);
    childrenByParent.set(child.mainWorkTypeId, children);
  }
  const subworkTypes = new Map([...childrenByParent].map(([id, children]) => [id, optionIndex(children)]));
  const issues: string[] = [];
  const result = rows.flatMap((row) => {
    try {
      const unit = matchEquipmentImportUnit(index, row.equipmentName);
      const shiftId = findOption(shifts, row.shiftName, "Смена");
      const mainWorkTypeId = findOption(mainWorkTypes, row.mainWorkTypeName, "Вид работы");
      const subworkTypeId = findOption(subworkTypes.get(mainWorkTypeId) ?? new Map(), row.subworkTypeName, "Подвид работы выбранного вида");
      return [{ ...row, equipmentId: unit.id, shiftId, mainWorkTypeId, subworkTypeId }];
    } catch (error) {
      issues.push(`Строка ${row.rowNumber}: ${error instanceof Error ? error.message : "не удалось сопоставить справочники"}`);
      return [];
    }
  });
  if (issues.length) throw new Error(`Импорт остановлен. ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; ещё ошибок: ${issues.length - 5}` : ""}.`);
  return result;
}
