import type { WorkTypeOption } from "./workTypeHierarchy.ts";

export type WorkTypesScope = "all" | "unassigned" | number;
export type WorkTypesParentStatus = "all" | "empty" | "filled";
export type WorkTypeDirectoryParent = WorkTypeOption & { childCount: number };

/** A child is unassigned when its parent is missing from the active directory. */
export type WorkTypeDirectoryChild = {
  id: number;
  name: string;
  parentId: number | null;
  parentName: string;
  assigned: boolean;
};

/** A flat table keeps empty work types visible without adding grouping rows. */
export type WorkTypesTableRow = {
  key: string;
  kind: "parent" | "child";
  id: number;
  name: string;
  parentId: number | null;
  parentName: string;
  childCount?: number;
};

export type WorkTypesIndex = {
  parents: WorkTypeDirectoryParent[];
  byParent: Map<number, WorkTypeOption[]>;
  unassigned: WorkTypeOption[];
  children: WorkTypeDirectoryChild[];
  rowsByParent: Map<number, WorkTypeDirectoryChild[]>;
  unassignedRows: WorkTypeDirectoryChild[];
  /** Cached names keep each keystroke from normalizing the complete directory. */
  parentSearch: Map<number, string>;
  childSearch: Map<number, string>;
};

export function normalizeWorkTypeSearch(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .normalize("NFD")
    .replace(/[\u0300\u0301]/g, "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");
}

/** Build once per catalog update, in O(parents + children), preserving catalog order. */
export function buildWorkTypesIndex(mainWorkTypes: readonly WorkTypeOption[], subworkTypes: readonly WorkTypeOption[]): WorkTypesIndex {
  const parents = mainWorkTypes.map(parent => ({ ...parent, childCount: 0 }));
  const parentById = new Map(parents.map(parent => [parent.id, parent]));
  const byParent = new Map<number, WorkTypeOption[]>();
  const rowsByParent = new Map<number, WorkTypeDirectoryChild[]>();
  const parentSearch = new Map<number, string>();
  const childSearch = new Map<number, string>();
  const children: WorkTypeDirectoryChild[] = [];
  const unassigned: WorkTypeOption[] = [];
  const unassignedRows: WorkTypeDirectoryChild[] = [];
  for (const parent of parents) {
    byParent.set(parent.id, []);
    rowsByParent.set(parent.id, []);
    parentSearch.set(parent.id, normalizeWorkTypeSearch(parent.name));
  }
  for (const child of subworkTypes) {
    const parent = child.mainWorkTypeId == null ? undefined : parentById.get(child.mainWorkTypeId);
    const row: WorkTypeDirectoryChild = {
      id: child.id,
      name: child.name,
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? "Не распределены",
      assigned: parent !== undefined,
    };
    children.push(row);
    childSearch.set(child.id, normalizeWorkTypeSearch(child.name));
    if (parent) {
      parent.childCount += 1;
      byParent.get(parent.id)!.push(child);
      rowsByParent.get(parent.id)!.push(row);
    } else {
      unassigned.push(child);
      unassignedRows.push(row);
    }
  }
  return { parents, byParent, unassigned, children, rowsByParent, unassignedRows, parentSearch, childSearch };
}

/** Search a parent's title and its children while applying its total child count. */
export function filterWorkTypeParents(index: WorkTypesIndex, filter: { query?: string; status?: WorkTypesParentStatus } = {}): WorkTypeDirectoryParent[] {
  const query = normalizeWorkTypeSearch(filter.query ?? "");
  const status = filter.status ?? "all";
  if (!query && status === "all") return index.parents;
  return index.parents.filter(parent => {
    if (status === "empty" && parent.childCount !== 0 || status === "filled" && parent.childCount === 0) return false;
    if (!query || index.parentSearch.get(parent.id)!.includes(query)) return true;
    return index.byParent.get(parent.id)!.some(child => index.childSearch.get(child.id)!.includes(query));
  });
}

/** Select virtualized table rows; searching a parent's title includes all its children. */
export function workTypeChildRows(index: WorkTypesIndex, scope: WorkTypesScope = "all", query = ""): WorkTypeDirectoryChild[] {
  const rows = scope === "all" ? index.children : scope === "unassigned" ? index.unassignedRows : index.rowsByParent.get(scope) ?? [];
  const normalized = normalizeWorkTypeSearch(query);
  if (!normalized) return rows;
  return rows.filter(row => index.childSearch.get(row.id)!.includes(normalized) || row.parentId !== null && index.parentSearch.get(row.parentId)!.includes(normalized));
}

/** Build flat rows in O(parents + children), searching cached names only. */
export function workTypesTableRows(index: WorkTypesIndex, query = ""): WorkTypesTableRow[] {
  const normalized = normalizeWorkTypeSearch(query);
  const rows: WorkTypesTableRow[] = [];
  for (const parent of index.parents) {
    const children = index.rowsByParent.get(parent.id) ?? [];
    const parentMatches = !normalized || index.parentSearch.get(parent.id)!.includes(normalized);
    if (children.length === 0) {
      if (parentMatches) rows.push({ key: `parent-${parent.id}`, kind: "parent", id: parent.id, name: "", parentId: parent.id, parentName: parent.name, childCount: 0 });
      continue;
    }
    for (const child of children) {
      if (parentMatches || index.childSearch.get(child.id)!.includes(normalized)) {
        rows.push({ key: `child-${child.id}`, kind: "child", id: child.id, name: child.name, parentId: parent.id, parentName: parent.name });
      }
    }
  }
  const unassignedMatches = !normalized || "не назначен".includes(normalized);
  for (const child of index.unassignedRows) {
    if (unassignedMatches || index.childSearch.get(child.id)!.includes(normalized)) {
      rows.push({ key: `child-${child.id}`, kind: "child", id: child.id, name: child.name, parentId: null, parentName: "Не назначен" });
    }
  }
  return rows;
}
