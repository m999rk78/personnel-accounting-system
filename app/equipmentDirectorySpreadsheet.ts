import type { GridEquipmentRegistryDraft, GridEquipmentUnit, GridOption, GridProjectEquipmentDraft } from "./AgDataGrids";
import { exactCustomSelectOption } from "./customSelectOptionMatch.ts";
import { equipmentExcelName } from "./equipmentExcel.ts";
import { profileProjectChangeAllowed } from "./userAccessModel.ts";

export const equipmentDirectoryTextFields = ["equipmentType", "brand", "model", "registrationNumber", "organization", "note"] as const;
const limits = { organization: 120, equipmentType: 120, brand: 120, model: 180, registrationNumber: 80, note: 300 } as const;
const labels = { organization: "Организация", equipmentType: "Тип техники", brand: "Марка", model: "Модель", registrationNumber: "ГРЗ / инв. №", note: "Примечание" } as const;
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const noProject = new Set(["", "не назначена", "не назначен", "без проекта", "без объекта", "—", "-"]);
export type EquipmentDirectoryReferences = { sites: GridOption[]; requiredSiteId?: number | readonly number[] };

export function equipmentRegistryDraft(unit: GridEquipmentUnit): GridEquipmentRegistryDraft {
  return { key: `equipment-unit-${unit.id}`, id: unit.id, organization: unit.organization, equipmentType: unit.equipmentType, brand: unit.brand, model: unit.model, registrationNumber: unit.registrationNumber, note: unit.note, projectSiteId: unit.assignedSiteId ? String(unit.assignedSiteId) : "" };
}

export function emptyEquipmentRegistryDraft(key: string, projectSiteId = ""): GridEquipmentRegistryDraft {
  return { key, organization: "", equipmentType: "", brand: "", model: "", registrationNumber: "", note: "", projectSiteId };
}

/** Incomplete text can remain in a draft; references and bounds are always exact. */
export function patchEquipmentRegistryDraft(draft: GridEquipmentRegistryDraft, values: Record<string, string>, references: EquipmentDirectoryReferences): GridEquipmentRegistryDraft {
  const next = { ...draft };
  for (const field of equipmentDirectoryTextFields) {
    if (values[field] === undefined) continue;
    const value = values[field].trim();
    if (value.length > limits[field]) throw new Error(`Поле «${labels[field]}» должно содержать не более ${limits[field]} символов.`);
    next[field] = value;
  }
  if (values.siteName !== undefined) {
    const value = values.siteName.trim();
    const option = noProject.has(normalize(value)) ? undefined : exactCustomSelectOption(references.sites.map(site => ({ value: String(site.id), label: site.name })), value);
    if (!noProject.has(normalize(value)) && !option) throw new Error(`Значение «${value}» не найдено или неоднозначно в столбце «Проект». Выберите существующий проект.`);
    const projectSiteId = option?.value ?? "";
    if (!profileProjectChangeAllowed(references.requiredSiteId, projectSiteId)) throw new Error("Техника должна относиться к одному из доступных проектов. Для снятия с проекта используйте настройки проекта.");
    next.projectSiteId = projectSiteId;
  }
  return next;
}

function registryIdentity(unit: Pick<GridEquipmentRegistryDraft, "organization" | "equipmentType" | "brand" | "model" | "registrationNumber" | "note">) {
  const registration = normalize(unit.registrationNumber).replaceAll(" ", "");
  if (registration && registration !== "-") return `грз:${registration}`;
  if (!unit.organization.trim() || !unit.equipmentType.trim() || !unit.model.trim()) return "";
  return `единица:${[unit.organization, unit.equipmentType, unit.brand, unit.model, unit.note].map(normalize).join("|")}`;
}

/** Validate every selected change before a batch or explicit save can publish anything. */
export function validateEquipmentRegistryDrafts(drafts: GridEquipmentRegistryDraft[], rows: GridEquipmentUnit[], references: EquipmentDirectoryReferences, changedKeys = drafts.map(draft => draft.key), requireComplete = false) {
  const edited = new Set(drafts.flatMap(draft => draft.id === undefined ? [] : [draft.id]));
  const counts = new Map<string, number>();
  const add = (key: string) => { if (key) counts.set(key, (counts.get(key) ?? 0) + 1); };
  rows.forEach(row => { if (!edited.has(row.id)) add(registryIdentity(row)); });
  drafts.forEach(draft => add(registryIdentity(draft)));
  const changed = new Set(changedKeys), errors: string[] = [];
  drafts.forEach((draft, index) => {
    if (!changed.has(draft.key)) return;
    const issues: string[] = [];
    if (requireComplete && (!draft.organization.trim() || !draft.equipmentType.trim() || !draft.model.trim())) issues.push("заполните организацию, тип техники и модель");
    for (const field of equipmentDirectoryTextFields) if (draft[field].trim().length > limits[field]) issues.push(`поле «${labels[field]}» должно содержать не более ${limits[field]} символов`);
    if (draft.projectSiteId && !references.sites.some(site => String(site.id) === draft.projectSiteId)) issues.push("выберите существующий проект");
    if (!profileProjectChangeAllowed(references.requiredSiteId, draft.projectSiteId)) issues.push("техника должна относиться к одному из доступных проектов");
    const identity = registryIdentity(draft);
    if (identity && (counts.get(identity) ?? 0) > 1) issues.push("такая техника уже есть в реестре или повторяется в новых строках");
    if (issues.length) errors.push(`Строка ${index + 1}: ${issues.join("; ")}.`);
  });
  if (errors.length) throw new Error(errors.join("\n"));
}

export function equipmentAssignmentOptions(units: GridEquipmentUnit[], assigned: GridEquipmentUnit[], draft: GridProjectEquipmentDraft, drafts: GridProjectEquipmentDraft[]) {
  const unavailable = new Set([...assigned.map(unit => unit.id), ...drafts.filter(candidate => candidate.key !== draft.key).map(candidate => Number(candidate.equipmentId))]);
  return units.filter(unit => !unavailable.has(unit.id)).map(unit => ({ value: String(unit.id), label: equipmentExcelName(unit) }));
}

export function patchEquipmentAssignmentDraft(draft: GridProjectEquipmentDraft, values: Record<string, string>, units: GridEquipmentUnit[]): GridProjectEquipmentDraft {
  if (values.equipmentType === undefined) return draft;
  const value = values.equipmentType.trim();
  if (!value) return { ...draft, equipmentId: "" };
  const option = exactCustomSelectOption(units.map(unit => ({ value: String(unit.id), label: equipmentExcelName(unit) })), value);
  if (!option) throw new Error(`Значение «${value}» не найдено или неоднозначно в столбце «Тип техники». Выберите технику из общего реестра.`);
  return { ...draft, equipmentId: option.value };
}

export function validateEquipmentAssignmentDrafts(drafts: GridProjectEquipmentDraft[], units: GridEquipmentUnit[], assigned: GridEquipmentUnit[], changedKeys = drafts.map(draft => draft.key), requireComplete = false) {
  const counts = new Map<number, number>();
  assigned.forEach(unit => counts.set(unit.id, 1));
  drafts.forEach(draft => { const id = Number(draft.equipmentId); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); });
  const changed = new Set(changedKeys);
  const errors = drafts.flatMap((draft, index) => {
    if (!changed.has(draft.key)) return [];
    const id = Number(draft.equipmentId);
    if (!draft.equipmentId && !requireComplete) return [];
    if (!Number.isSafeInteger(id) || id <= 0 || !units.some(unit => unit.id === id)) return [`Строка ${index + 1}: выберите технику из общего реестра.`];
    return (counts.get(id) ?? 0) > 1 ? [`Строка ${index + 1}: техника уже добавлена в проект или выбрана в другой строке.`] : [];
  });
  if (errors.length) throw new Error(errors.join("\n"));
}
