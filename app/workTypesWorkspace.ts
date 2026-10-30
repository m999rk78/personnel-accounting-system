import type { WorkTypeOption } from "./workTypeHierarchy.ts";

export type WorkTypeDraft = {
  key: string;
  directoryKind: "parent" | "child";
  id?: number;
  name: string;
  parentKey?: string;
  originalName?: string;
  originalParentId?: number | null;
};
export type WorkTypeRow = WorkTypeDraft & {
  kind: "entry" | "edit" | "draft";
  unassigned?: boolean;
  childCount?: number;
  searchText?: string;
};
export type WorkTypeEdits = Record<string, WorkTypeDraft>;
export const workTypeNameKey = (name: string) => name.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

export function workTypeDraft(row: WorkTypeRow): WorkTypeDraft {
  return { key: row.key, directoryKind: row.directoryKind, id: row.id, name: row.name, parentKey: row.parentKey, originalName: row.originalName, originalParentId: row.originalParentId };
}

/** Each work type is a master row; subtypes appear only in its detail grid. */
export function workTypesWorkspace(parents: readonly WorkTypeOption[], children: readonly WorkTypeOption[], edits: WorkTypeEdits) {
  const parentRows: WorkTypeRow[] = parents.map(parent => ({ key: `parent-${parent.id}`, directoryKind: "parent", kind: "entry", id: parent.id, name: parent.name, originalName: parent.name }));
  const activeParents = new Set(parentRows.map(row => row.key));
  const childRows: WorkTypeRow[] = children.map(child => ({ key: `child-${child.id}`, directoryKind: "child", kind: "entry", id: child.id, name: child.name, originalName: child.name, originalParentId: child.mainWorkTypeId ?? null, parentKey: activeParents.has(`parent-${child.mainWorkTypeId}`) ? `parent-${child.mainWorkTypeId}` : "unassigned" }));
  const overlay = (rows: WorkTypeRow[], directoryKind: WorkTypeDraft["directoryKind"]): WorkTypeRow[] => {
    const existing = new Set(rows.map(row => row.key));
    return [...rows.map(row => edits[row.key] ? { ...row, ...edits[row.key], kind: "edit" as const } : row), ...Object.values(edits).filter(row => row.directoryKind === directoryKind && !existing.has(row.key)).map(row => ({ ...row, kind: "draft" as const }))];
  };
  const masters = overlay(parentRows, "parent");
  const details = new Map<string, WorkTypeRow[]>();
  for (const row of masters) details.set(row.key, []);
  for (const row of overlay(childRows, "child")) {
    const key = row.parentKey && details.has(row.parentKey) ? row.parentKey : "unassigned";
    if (!details.has(key)) details.set(key, []);
    details.get(key)!.push(row);
  }
  if (details.has("unassigned")) masters.push({ key: "unassigned", directoryKind: "parent", kind: "entry", name: "Без вида работы", unassigned: true });
  for (const row of masters) {
    const nested = details.get(row.key) ?? [];
    row.childCount = nested.length;
    row.searchText = [row.name, ...nested.map(child => child.name)].join("\n");
  }
  return { masters, details };
}

export function workTypesDraftErrors(parents: readonly WorkTypeOption[], children: readonly WorkTypeOption[], edits: WorkTypeEdits) {
  const { masters, details } = workTypesWorkspace(parents, children, edits);
  const errors: Record<string, { name?: string; parentKey?: string }> = {};
  const check = (rows: WorkTypeRow[]) => {
    const names = new Map<string, WorkTypeRow[]>();
    for (const row of rows) {
      if (row.unassigned) continue;
      const name = workTypeNameKey(row.name);
      if (edits[row.key] && (!name || row.name.trim().length > 240)) errors[row.key] = { name: "Укажите название от 1 до 240 символов." };
      names.set(name, [...names.get(name) ?? [], row]);
    }
    for (const matches of names.values()) if (matches.length > 1) for (const row of matches) if (edits[row.key]) errors[row.key] = { name: row.directoryKind === "parent" ? "Вид работы с таким названием уже существует." : "В этом виде работы уже есть подвид с таким названием." };
  };
  check(masters);
  for (const nested of details.values()) check(nested);
  for (const row of Object.values(edits)) if (row.directoryKind === "child" && (!row.id && (!row.parentKey || row.parentKey === "unassigned") || row.parentKey !== "unassigned" && !masters.some(parent => parent.key === row.parentKey))) errors[row.key] = { ...errors[row.key], parentKey: "Выберите вид работы." };
  return errors;
}

export function workTypesSavePayload(edits: WorkTypeEdits) {
  return {
    parents: Object.values(edits).filter(row => row.directoryKind === "parent").map(row => ({ id: row.id, clientKey: row.key, name: row.name.trim(), originalName: row.originalName })),
    children: Object.values(edits).filter(row => row.directoryKind === "child").map(row => ({ id: row.id, clientKey: row.key, name: row.name.trim(), parentId: row.parentKey?.startsWith("parent-") ? Number(row.parentKey.slice(7)) : null, ...(row.parentKey?.startsWith("new-parent-") ? { parentKey: row.parentKey } : {}), originalName: row.originalName, originalParentId: row.originalParentId })),
  };
}

/** Selecting the unassigned group archives its children, never a synthetic parent. */
export function workTypesArchiveSelection(rows: readonly WorkTypeRow[], parents: readonly WorkTypeOption[], children: readonly WorkTypeOption[]) {
  const parentIds = [...new Set(rows.filter(row => row.directoryKind === "parent" && !row.unassigned && row.id).map(row => row.id!))];
  const childIds = new Set(rows.filter(row => row.directoryKind === "child" && row.id).map(row => row.id!));
  if (rows.some(row => row.key === "unassigned" && row.directoryKind === "parent" && row.unassigned)) {
    const activeParentIds = new Set(parents.map(parent => parent.id));
    for (const child of children) if (child.mainWorkTypeId == null || !activeParentIds.has(child.mainWorkTypeId)) childIds.add(child.id);
  }
  const allChildren = new Set(childIds);
  const selectedParents = new Set(parentIds);
  for (const child of children) if (child.mainWorkTypeId != null && selectedParents.has(child.mainWorkTypeId)) allChildren.add(child.id);
  return { parents: parentIds, children: [...childIds], parentCount: parentIds.length, childCount: allChildren.size };
}
