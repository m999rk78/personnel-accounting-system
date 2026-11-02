export const IMPORT_ORDER_COLUMN = "__importOrder";
export const importOrderSortOption = { label: "Порядок импорта", columnId: IMPORT_ORDER_COLUMN, sort: "asc" } as const;
export const importOrderScopes = new Set(["employees", "project-personnel"]);

/** Rank file identities independently of the saved manual row order. New rows keep source order at the end. */
export function createImportOrderRank<T>(source: readonly T[], importIds: readonly number[], getId: (row: T) => number | string | undefined) {
  const ids = [...new Set(importIds)];
  const rank = new Map<number | string, number>(ids.map((id, index) => [id, index]));
  const sourceRank = new Map(source.map((row, index) => [row, index]));
  return (row: T) => rank.get(getId(row) ?? "") ?? ids.length + (sourceRank.get(row) ?? source.length);
}

export function importOrderColumnState() {
  return { state: [{ colId: IMPORT_ORDER_COLUMN, sort: "asc" as const, sortIndex: 0 }], defaultState: { sort: null, sortIndex: null } };
}

/** An import is explicit; a normal GET must preserve an already chosen/manual order. */
export function shouldApplyImportOrder({ activated, firstLoad, defaultImport, sorted }: { activated: boolean; firstLoad: boolean; defaultImport: boolean; sorted: boolean }) {
  return activated || firstLoad && defaultImport && !sorted;
}
