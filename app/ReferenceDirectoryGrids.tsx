"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import type { GridDirectoryDraft, GridEmployee, GridOption, GridPosition, GridPositionDraft, GridProjectEmployeeDraft } from "./AgDataGrids";
import { CatalogSpreadsheetGrid, type CatalogColumn, type CatalogDraftSelectionActions } from "./CatalogSpreadsheetGrid";
import { exactCustomSelectOption } from "./customSelectOptionMatch";

type AdapterProps<D> = {
  canCreate?: boolean;
  loading?: boolean;
  scopeKey?: string;
  preferenceScope?: { userId: number; siteId?: number };
  onReplaceDrafts?: (drafts: D[]) => void;
  onValidationError?: (message: string) => void;
  renderFooter?: (selection: CatalogDraftSelectionActions) => ReactNode;
};
type KeyedDraft = { key: string; id?: number };
const emptyEmployees: GridEmployee[] = [];
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

function findEmployee(employees: GridEmployee[], value: string) {
  const option = exactCustomSelectOption(employees.map(employee => ({ value: String(employee.id), label: employee.fullName })), value);
  return option ? employees.find(employee => String(employee.id) === option.value) : undefined;
}

function validateDistinct<R extends { id: number }, D extends KeyedDraft>(records: R[], drafts: D[], changedKeys: string[], recordValue: (record: R) => string, draftValue: (draft: D) => string, label: string) {
  const editedIds = new Set(drafts.flatMap(draft => draft.id === undefined ? [] : [draft.id]));
  const counts = new Map<string, number>();
  const count = (value: string) => { const key = normalize(value); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); };
  records.forEach(record => { if (!editedIds.has(record.id)) count(recordValue(record)); });
  drafts.forEach(draft => count(draftValue(draft)));
  const changed = new Set(changedKeys);
  const errors = drafts.flatMap((draft, index) => {
    const value = draftValue(draft);
    return changed.has(draft.key) && value && (counts.get(normalize(value)) ?? 0) > 1
      ? [`Строка ${index + 1}: ${label} «${value}» уже есть в таблице или выбран в другой строке.`] : [];
  });
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Preserve former consumers while requiring replacement for additions/removals. */
function replaceCompatible<D extends KeyedDraft>(drafts: D[], current: D[], replace: ((drafts: D[]) => void) | undefined, patch: (key: string, changes: Partial<D>) => void, editExisting?: (draft: D) => void) {
  if (replace) { replace(drafts); return; }
  const nextKeys = new Set(drafts.map(draft => draft.key));
  const existingKeys = new Set(current.map(draft => draft.key));
  if (current.some(draft => !nextKeys.has(draft.key)) || drafts.some(draft => !existingKeys.has(draft.key) && (draft.id === undefined || !editExisting))) {
    throw new Error("Добавьте пустые строки перед вставкой. Для удаления новых строк используйте отмену редактирования.");
  }
  for (const draft of drafts) {
    if (existingKeys.has(draft.key)) patch(draft.key, draft);
    else editExisting?.(draft);
  }
}

type DirectoryGridProps = AdapterProps<GridDirectoryDraft> & {
  title: string;
  directoryEntity?: string;
  rows: GridOption[];
  drafts: GridDirectoryDraft[];
  employees?: GridEmployee[];
  selectEmployee?: boolean;
  pendingDeletes: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
  onEdit: (item: GridOption) => void;
  onSelectionChange: (ids: number[]) => void;
  onVisibleIdsChange?: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridDirectoryDraft>) => void;
};

export function DirectoryAgGrid(props: DirectoryGridProps) {
  const employees = props.employees ?? emptyEmployees;
  const employeeFor = useCallback((draft?: GridDirectoryDraft, item?: GridOption & { employeeId?: number }) => {
    const employeeId = draft?.employeeId || item?.employeeId;
    return employeeId ? employees.find(employee => employee.id === Number(employeeId)) : findEmployee(employees, draft?.name ?? item?.name ?? "");
  }, [employees]);
  const toDraft = (item: GridOption & { employeeId?: number }): GridDirectoryDraft => {
    const employee = props.selectEmployee ? employeeFor(undefined, item) : undefined;
    return { key: `directory-${item.id}`, id: item.id, name: employee?.fullName ?? item.name, ...(employee ? { employeeId: String(employee.id) } : {}), ...(props.directoryEntity ? { entity: props.directoryEntity } : {}) };
  };
  const columns = useMemo(() => {
    const result: CatalogColumn<GridOption, GridDirectoryDraft>[] = [{
      field: "name", headerName: props.selectEmployee ? "ФИО" : props.title,
      minWidth: props.selectEmployee ? 250 : 260, initialFlex: props.selectEmployee ? 1.5 : 1, pinned: props.selectEmployee ? "left" : undefined,
      value: (item, draft) => draft?.name ?? item?.name ?? "",
      ...(props.selectEmployee ? {
        editValue: (draft: GridDirectoryDraft) => draft.employeeId ?? "",
        options: () => employees.map(employee => ({ value: String(employee.id), label: employee.fullName })),
      } : {}),
    }];
    if (props.selectEmployee) {
      for (const [field, headerName, minWidth, initialFlex] of [["employmentType", "Тип", 110, .65], ["department", "Отдел", 125, .75], ["position", "Должность", 210, 1.35]] as const) {
        result.push({ field, headerName, minWidth, initialFlex, editable: false, value: (item, draft) => employeeFor(draft, item)?.[field] ?? "—" });
      }
    }
    return result;
  }, [props.selectEmployee, props.title, employees, employeeFor]);
  const patchDraft = (draft: GridDirectoryDraft, values: Record<string, string>) => {
    if (values.name === undefined) return draft;
    const name = values.name.trim();
    if (!props.selectEmployee) return { ...draft, name };
    if (!name) return { ...draft, name: "", employeeId: "" };
    const employee = findEmployee(employees, name);
    if (!employee) throw new Error(`Значение «${name}» не найдено или неоднозначно в столбце «ФИО». Выберите сотрудника текущего проекта.`);
    return { ...draft, name: employee.fullName, employeeId: String(employee.id) };
  };
  return <CatalogSpreadsheetGrid<GridOption, GridDirectoryDraft>
    rows={props.rows} drafts={props.drafts} columns={columns} scopeKey={props.scopeKey ?? `directory:${props.preferenceScope?.siteId ?? 0}:${props.selectEmployee ? "master" : props.title}`}
    canCreate={props.canCreate ?? !props.readOnly} canUpdate={!props.readOnly} canSelect={!props.selectionDisabled} loading={props.loading} preferenceScope={props.preferenceScope}
    newDraft={key => ({ key, name: "", ...(props.selectEmployee ? { employeeId: "" } : {}), ...(props.directoryEntity ? { entity: props.directoryEntity } : {}) })} toDraft={toDraft} patchDraft={patchDraft}
    validateDrafts={(drafts, changedKeys) => validateDistinct(props.rows, drafts, changedKeys, item => item.name, draft => draft.name, props.selectEmployee ? "сотрудник" : "значение")}
    selectedIds={props.pendingDeletes} onSelectionChange={props.onSelectionChange} onVisibleIdsChange={props.onVisibleIdsChange} onValidationError={props.onValidationError} renderFooter={props.renderFooter}
    onReplaceDrafts={drafts => replaceCompatible(drafts, props.drafts, props.onReplaceDrafts, props.onPatchDraft, draft => { const item = props.rows.find(item => item.id === draft.id); if (!item) throw new Error("Значение справочника больше не существует."); props.onEdit(item); props.onPatchDraft(draft.key, draft); })}
  />;
}

type PositionGridProps = AdapterProps<GridPositionDraft> & {
  rows: GridPosition[];
  drafts: GridPositionDraft[];
  employmentTypes: GridOption[];
  departments: GridOption[];
  pendingDeletes: number[];
  fullRowEditIds: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
  onEdit: (position: GridPosition, changes?: Partial<GridPositionDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onPatchDraft: (key: string, changes: Partial<GridPositionDraft>) => void;
  onVisibleIdsChange: (ids: number[]) => void;
};

export function PositionAgGrid(props: PositionGridProps) {
  const columns = useMemo<CatalogColumn<GridPosition, GridPositionDraft>[]>(() => [
    { field: "employmentType", headerName: "Тип", minWidth: 110, initialFlex: .7, value: (record, draft) => draft?.employmentType ?? record?.employmentType ?? "", options: () => props.employmentTypes.map(option => ({ value: option.name, label: option.name })) },
    { field: "department", headerName: "Отдел", minWidth: 125, initialFlex: 1, value: (record, draft) => draft?.department ?? record?.department ?? "", options: () => props.departments.map(option => ({ value: option.name, label: option.name })) },
    { field: "position", headerName: "Должность", minWidth: 210, initialFlex: 2.2, value: (record, draft) => draft?.position ?? record?.position ?? "" },
  ], [props.employmentTypes, props.departments]);
  const patchDraft = (draft: GridPositionDraft, values: Record<string, string>) => {
    const next = { ...draft };
    for (const field of ["employmentType", "department"] as const) {
      if (values[field] === undefined) continue;
      const value = values[field].trim();
      const options = (field === "employmentType" ? props.employmentTypes : props.departments).map(option => ({ value: option.name, label: option.name }));
      const option = value ? exactCustomSelectOption(options, value) : undefined;
      if (value && !option) throw new Error(`Значение «${value}» не найдено или неоднозначно в столбце «${field === "employmentType" ? "Тип" : "Отдел"}». Выберите значение из списка.`);
      next[field] = option?.value ?? "";
    }
    if (values.position !== undefined) next.position = values.position.trim();
    return next;
  };
  const identity = (position: Pick<GridPosition, "employmentType" | "department" | "position">) => position.employmentType.trim() && position.department.trim() && position.position.trim()
    ? `${position.employmentType.trim()}|${position.department.trim()}|${position.position.trim()}` : "";
  return <CatalogSpreadsheetGrid<GridPosition, GridPositionDraft>
    rows={props.rows} drafts={props.drafts} columns={columns} scopeKey={props.scopeKey ?? "positions"} canCreate={props.canCreate ?? !props.readOnly} canUpdate={!props.readOnly} canSelect={!props.selectionDisabled} loading={props.loading} preferenceScope={props.preferenceScope}
    newDraft={key => ({ key, employmentType: "", department: "", position: "" })} toDraft={position => ({ key: `position-${position.id}`, ...position })} patchDraft={patchDraft}
    validateDrafts={(drafts, changedKeys) => validateDistinct(props.rows, drafts, changedKeys, identity, identity, "должность")}
    selectedIds={props.pendingDeletes} onSelectionChange={props.onSelectionChange} onVisibleIdsChange={props.onVisibleIdsChange} onValidationError={props.onValidationError} renderFooter={props.renderFooter}
    onReplaceDrafts={drafts => replaceCompatible(drafts, props.drafts, props.onReplaceDrafts, props.onPatchDraft, draft => { const record = props.rows.find(record => record.id === draft.id); if (!record) throw new Error("Должность больше не существует."); props.onEdit(record, draft); })}
  />;
}

type ProjectEmployeeDraft = GridProjectEmployeeDraft & { id?: number };
type ProjectEmployeeGridProps = AdapterProps<GridProjectEmployeeDraft> & {
  rows: GridEmployee[];
  allEmployees: GridEmployee[];
  drafts: GridProjectEmployeeDraft[];
  pendingDeletes: number[];
  readOnly?: boolean;
  selectionDisabled?: boolean;
  onPatchDraft: (key: string, changes: Partial<GridProjectEmployeeDraft>) => void;
  onSelectionChange: (ids: number[]) => void;
  onVisibleIdsChange?: (ids: number[]) => void;
};

export function ProjectEmployeeAgGrid(props: ProjectEmployeeGridProps) {
  const columns = useMemo(() => {
    const employeeFor = (record?: GridEmployee, draft?: GridProjectEmployeeDraft) => draft ? props.allEmployees.find(employee => employee.id === Number(draft.employeeId)) : record;
    const result: CatalogColumn<GridEmployee, ProjectEmployeeDraft>[] = [{
      field: "fullName", headerName: "ФИО", minWidth: 250, initialFlex: 1.5, pinned: "left", editable: record => !record,
      value: (record, draft) => draft?.employeeQuery ?? record?.fullName ?? "", editValue: draft => draft.employeeId,
      options: (draft, drafts) => {
        const unavailable = new Set([...props.rows.map(employee => employee.id), ...drafts.filter(candidate => candidate.key !== draft.key).map(candidate => Number(candidate.employeeId))]);
        return props.allEmployees.filter(employee => !unavailable.has(employee.id)).map(employee => ({ value: String(employee.id), label: employee.fullName }));
      },
    }];
    for (const [field, headerName, minWidth, initialFlex] of [["employmentType", "Тип", 110, .6], ["department", "Отдел", 125, .75], ["position", "Должность", 210, 1.35]] as const) {
      result.push({ field, headerName, minWidth, initialFlex, editable: false, value: (record, draft) => employeeFor(record, draft)?.[field] ?? "—" });
    }
    return result;
  }, [props.allEmployees, props.rows]);
  const patchDraft = (draft: ProjectEmployeeDraft, values: Record<string, string>) => {
    if (values.fullName === undefined) return draft;
    const value = values.fullName.trim();
    if (!value) return { ...draft, employeeId: "", employeeQuery: "" };
    const employee = findEmployee(props.allEmployees, value);
    if (!employee) throw new Error(`Значение «${value}» не найдено или неоднозначно в столбце «ФИО». Выберите сотрудника из списка.`);
    return { ...draft, employeeId: String(employee.id), employeeQuery: employee.fullName };
  };
  return <CatalogSpreadsheetGrid<GridEmployee, ProjectEmployeeDraft>
    rows={props.rows} drafts={props.drafts} columns={columns} scopeKey={props.scopeKey ?? `projectEmployees:${props.preferenceScope?.siteId ?? 0}`}
    canCreate={props.canCreate ?? !props.readOnly} canUpdate={false} canSelect={!props.selectionDisabled} loading={props.loading} preferenceScope={props.preferenceScope}
    newDraft={key => ({ key, employeeId: "", employeeQuery: "" })} toDraft={employee => ({ key: `project-employee-${employee.id}`, id: employee.id, employeeId: String(employee.id), employeeQuery: employee.fullName })} patchDraft={patchDraft}
    validateDrafts={(drafts, changedKeys) => validateDistinct(props.rows, drafts, changedKeys, employee => String(employee.id), draft => draft.employeeId, "сотрудник")}
    selectedIds={props.pendingDeletes} onSelectionChange={props.onSelectionChange} onVisibleIdsChange={props.onVisibleIdsChange} onValidationError={props.onValidationError} renderFooter={props.renderFooter}
    onReplaceDrafts={drafts => replaceCompatible(drafts, props.drafts, props.onReplaceDrafts, props.onPatchDraft)}
  />;
}
