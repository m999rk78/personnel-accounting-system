import type { PersonnelReportGridRow } from "./PersonnelReportGrid";
import type { WorkTypeOption } from "./workTypeHierarchy";

/** Keep parent/child references together, including types that have no subtypes yet. */
export function personnelExcelWorkTypePairs(parents: WorkTypeOption[], children: WorkTypeOption[]) {
  const byParent = new Map<number, WorkTypeOption[]>();
  for (const child of children) {
    if (child.mainWorkTypeId == null) continue;
    const group = byParent.get(child.mainWorkTypeId) ?? [];
    group.push(child);
    byParent.set(child.mainWorkTypeId, group);
  }
  return parents.flatMap(parent => {
    const group = byParent.get(parent.id);
    return group?.length
      ? group.map(child => ({ mainWorkTypeName: parent.name, subworkTypeName: child.name }))
      : [{ mainWorkTypeName: parent.name, subworkTypeName: "" }];
  });
}

type ExportRow = PersonnelReportGridRow & { draftGroupKey?: string };

/** Export exactly the visible grid order, narrowed to selection and saved approved rows. */
export function personnelReportExcelRows<T extends ExportRow>(rows: T[], visibleKeys: string[] | null, selectedKeys: string[], dirtyOwners: string[]) {
  const byKey = new Map(rows.map(row => [row.rowKey, row]));
  const keys = visibleKeys ?? rows.map(row => row.rowKey);
  const selected = new Set(selectedKeys);
  const dirty = new Set(dirtyOwners);
  const seen = new Set<string>();
  const approved = keys.flatMap(key => {
    const row = byKey.get(key);
    if (!row || seen.has(key) || selected.size && !selected.has(key) || row.status !== "approved" || !row.entry) return [];
    seen.add(key);
    const owner = row.proposalId ? String(row.proposalId) : row.draftGroupKey;
    if (owner && dirty.has(owner)) throw new Error("В выбранных подтверждённых строках есть несохранённые изменения. Сохраните их перед экспортом.");
    return [{ ...row.entry, workDate: row.workDate }];
  });
  if (!approved.length) throw new Error(selected.size
    ? "Среди выбранных видимых строк нет подтверждённых записей для экспорта."
    : "В текущем представлении нет подтверждённых записей для экспорта. Проверьте раздел и фильтры.");
  return approved;
}
