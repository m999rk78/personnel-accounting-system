"use client";

import type { ReactNode } from "react";
import type { GridEquipmentRegistryDraft, GridEquipmentUnit, GridOption, GridProjectEquipmentDraft } from "./AgDataGrids";
import { CatalogSpreadsheetGrid, type CatalogColumn, type CatalogDraftSelectionActions } from "./CatalogSpreadsheetGrid";
import { emptyEquipmentRegistryDraft, equipmentAssignmentOptions, equipmentDirectoryTextFields, equipmentRegistryDraft, patchEquipmentAssignmentDraft, patchEquipmentRegistryDraft, validateEquipmentAssignmentDrafts, validateEquipmentRegistryDrafts } from "./equipmentDirectorySpreadsheet";

type CommonProps<D> = {
  rows: GridEquipmentUnit[]; drafts: D[]; selectedIds: number[]; loading: boolean; canCreate: boolean; canSelect: boolean;
  preferenceScope?: { userId: number; siteId?: number };
  onReplaceDrafts?: (drafts: D[]) => void;
  onSelectionChange: (ids: number[]) => void;
  onVisibleIdsChange?: (ids: number[]) => void;
  onValidationError?: (message: string) => void;
  renderFooter?: (selection: CatalogDraftSelectionActions) => ReactNode;
};
type EquipmentRegistryGridProps = CommonProps<GridEquipmentRegistryDraft> & {
  sites: GridOption[]; requiredSiteId?: number | readonly number[]; defaultProjectSiteId?: string;
  fullRowEditIds: number[]; canUpdate: boolean;
  onEdit: (unit: GridEquipmentUnit, changes?: Partial<GridEquipmentRegistryDraft>) => void;
  onPatchDraft: (key: string, changes: Partial<GridEquipmentRegistryDraft>) => void;
};
type ProjectEquipmentDraft = GridProjectEquipmentDraft & { id?: number };
type ProjectEquipmentGridProps = CommonProps<GridProjectEquipmentDraft> & {
  allUnits: GridEquipmentUnit[];
  onPatchDraft: (key: string, changes: Partial<GridProjectEquipmentDraft>) => void;
};

/** Legacy callbacks remain accepted; production parents provide atomic draft replacement. */
function replaceCompatible<D extends { key: string; id?: number }>(next: D[], current: D[], replace: ((drafts: D[]) => void) | undefined, patch: (key: string, changes: Partial<D>) => void, edit?: (draft: D) => void) {
  if (replace) { replace(next); return; }
  const previous = new Set(current.map(draft => draft.key)), retained = new Set(next.map(draft => draft.key));
  if (current.some(draft => !retained.has(draft.key)) || next.some(draft => !previous.has(draft.key) && (draft.id === undefined || !edit))) throw new Error("Добавьте пустые строки перед вставкой. Для удаления новых строк используйте отмену редактирования.");
  next.forEach(draft => { if (previous.has(draft.key)) patch(draft.key, draft); else edit?.(draft); });
}

export function EquipmentRegistryAgGrid(props: EquipmentRegistryGridProps) {
  const references = { sites: props.sites, requiredSiteId: props.requiredSiteId };
  const labels = { equipmentType: "Тип техники", brand: "Марка", model: "Модель", registrationNumber: "ГРЗ / инв. №", organization: "Организация", note: "Примечание" } as const;
  const columns: CatalogColumn<GridEquipmentUnit, GridEquipmentRegistryDraft>[] = equipmentDirectoryTextFields.map(field => ({
    field, headerName: labels[field], minWidth: field === "note" ? 190 : field === "model" ? 180 : field === "brand" ? 125 : 160,
    initialFlex: field === "note" ? 1.3 : field === "model" ? 1.2 : .95,
    ...(field === "equipmentType" ? { pinned: "left" as const } : {}),
    value: (unit, draft) => draft?.[field] ?? unit?.[field] ?? "",
  }));
  columns.splice(columns.length - 1, 0, {
    field: "siteName", headerName: "Проект", minWidth: 180, initialFlex: 1,
    value: (unit, draft) => draft ? props.sites.find(site => String(site.id) === draft.projectSiteId)?.name ?? "" : unit?.assignedSiteName ?? "",
    editValue: draft => draft.projectSiteId,
    options: () => [...(props.requiredSiteId === undefined ? [{ value: "", label: "Не назначена" }] : []), ...props.sites.map(site => ({ value: String(site.id), label: site.name }))],
  });
  const scope = props.requiredSiteId;
  const defaultSite = props.defaultProjectSiteId ?? (typeof scope === "number" ? String(scope) : scope?.length === 1 ? String(scope[0]) : "");
  return <CatalogSpreadsheetGrid<GridEquipmentUnit, GridEquipmentRegistryDraft>
    rows={props.rows} drafts={props.drafts} columns={columns} scopeKey="equipmentRegistry" preferenceScope={props.preferenceScope}
    canCreate={props.canCreate} canUpdate={props.canUpdate} canSelect={props.canSelect} loading={props.loading}
    newDraft={key => emptyEquipmentRegistryDraft(key, defaultSite)} toDraft={equipmentRegistryDraft}
    patchDraft={(draft, values) => patchEquipmentRegistryDraft(draft, values, references)}
    validateDrafts={(drafts, changedKeys) => validateEquipmentRegistryDrafts(drafts, props.rows, references, changedKeys)}
    selectedIds={props.selectedIds} onSelectionChange={props.onSelectionChange} onVisibleIdsChange={props.onVisibleIdsChange} onValidationError={props.onValidationError} renderFooter={props.renderFooter}
    onReplaceDrafts={drafts => replaceCompatible(drafts, props.drafts, props.onReplaceDrafts, props.onPatchDraft, draft => { const unit = props.rows.find(unit => unit.id === draft.id); if (!unit) throw new Error("Единица техники больше не существует."); props.onEdit(unit, draft); })}
  />;
}

export function ProjectEquipmentAgGrid(props: ProjectEquipmentGridProps) {
  const resolve = (unit: GridEquipmentUnit | undefined, draft: GridProjectEquipmentDraft | undefined) => draft ? props.allUnits.find(unit => String(unit.id) === draft.equipmentId) : unit;
  const columns: CatalogColumn<GridEquipmentUnit, ProjectEquipmentDraft>[] = [{
    field: "equipmentType", headerName: "Тип техники", minWidth: 190, initialFlex: 1.15, pinned: "left", editable: unit => !unit,
    value: (unit, draft) => resolve(unit, draft)?.equipmentType ?? "", editValue: draft => draft.equipmentId,
    options: (draft, drafts) => equipmentAssignmentOptions(props.allUnits, props.rows, draft, drafts),
  }];
  for (const [field, headerName, minWidth, initialFlex] of [["brand", "Марка", 125, .8], ["model", "Модель", 180, 1.2], ["registrationNumber", "ГРЗ / инв. №", 160, .95], ["organization", "Организация", 165, 1.05], ["note", "Примечание", 190, 1.25]] as const) columns.push({ field, headerName, minWidth, initialFlex, editable: false, value: (unit, draft) => resolve(unit, draft)?.[field] ?? "" });
  return <CatalogSpreadsheetGrid<GridEquipmentUnit, ProjectEquipmentDraft>
    rows={props.rows} drafts={props.drafts} columns={columns} scopeKey="projectEquipment" preferenceScope={props.preferenceScope}
    canCreate={props.canCreate} canUpdate={false} canSelect={props.canSelect} loading={props.loading}
    newDraft={key => ({ key, equipmentId: "" })} toDraft={unit => ({ key: `project-equipment-${unit.id}`, id: unit.id, equipmentId: String(unit.id) })}
    patchDraft={(draft, values) => patchEquipmentAssignmentDraft(draft, values, props.allUnits)}
    validateDrafts={(drafts, changedKeys) => validateEquipmentAssignmentDrafts(drafts, props.allUnits, props.rows, changedKeys)}
    selectedIds={props.selectedIds} onSelectionChange={props.onSelectionChange} onVisibleIdsChange={props.onVisibleIdsChange} onValidationError={props.onValidationError} renderFooter={props.renderFooter}
    onReplaceDrafts={drafts => replaceCompatible(drafts, props.drafts, props.onReplaceDrafts, props.onPatchDraft)}
  />;
}
