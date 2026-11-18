import type { GridApi } from "ag-grid-community";

export type GridNavigationFilter = {
  columnId: string;
  value: string;
  ready: boolean;
  onCleared?: () => void;
};

const keyOf = (filter: GridNavigationFilter | undefined) => filter ? JSON.stringify([filter.columnId, filter.value]) : "";
const copyModel = (model: unknown) => model == null ? null : JSON.parse(JSON.stringify(model));
const sameModel = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
type NavigationModel = { filterType?: string; filterModels?: Array<{ filterType?: string; values?: unknown[] } | null> };
const targetModel = (model: unknown, value: string) => {
  const column = model as NavigationModel | null;
  const values = column?.filterModels?.[1];
  return column?.filterType === "multi" && values?.filterType === "set" && Array.isArray(values.values)
    && (values.values.length === 0 || values.values.length === 1 && String(values.values[0]) === value)
    && column.filterModels?.every((child, index) => index === 1 || child == null);
};
export type GridNavigationFilterStatus = { pending: boolean; error: string };

/** A deep link seeds a normal column filter once; subsequent edits belong to the user. */
export function createGridNavigationFilter<T>(api: GridApi<T>, onStatus: (key: string, status: GridNavigationFilterStatus) => void = () => {}) {
  let request: GridNavigationFilter | undefined;
  let applied: { key: string; columnId: string; value: string; model: unknown } | undefined;
  let consumedKey = "";
  let pending = false;
  let disposed = false;

  const changed = () => {
    if (disposed || pending || !applied || applied.key !== keyOf(request)) return;
    const model = api.getColumnFilterModel(applied.columnId);
    if (targetModel(model, applied.value)) {
      // The native handler can normalize an unavailable ID to an explicit empty
      // selection later. It must still remain a filter, rather than showing all.
      applied.model = copyModel(model);
    } else if (!sameModel(model, applied.model)) {
      // Preserve the user's replacement model when the parent clears its URL state.
      consumedKey = applied.key;
      applied = undefined;
      onStatus(keyOf(request), { pending: false, error: "" });
      request?.onCleared?.();
    }
  };
  const sync = async () => {
    if (disposed || pending || api.isDestroyed()) return;
    const requestedKey = keyOf(request);
    if (applied && applied.key !== requestedKey) {
      const previous = applied;
      applied = undefined;
      if (sameModel(api.getColumnFilterModel(previous.columnId), previous.model)) {
        pending = true;
        try {
          await api.setColumnFilterModel(previous.columnId, null);
          if (!disposed && !api.isDestroyed()) api.onFilterChanged();
        } catch (error) {
          onStatus(keyOf(request), { pending: false, error: error instanceof Error ? error.message : "Не удалось сбросить фильтр перехода." });
          return;
        } finally { pending = false; }
        if (disposed || api.isDestroyed()) return;
      }
    }
    const target = request;
    if (!target) { onStatus("", { pending: false, error: "" }); return; }
    if (!target.ready || applied || consumedKey === keyOf(target)) return;
    // LocalizedGrid upgrades its column definitions after gridReady. Applying a
    // Multi model before that upgrade would silently target the fallback filter.
    if (api.getColumn(target.columnId)?.getColDef().filter !== "agMultiColumnFilter") return;
    pending = true;
    try {
      await api.setColumnFilterModel(target.columnId, {
        filterType: "multi", filterModels: [null, { filterType: "set", values: [target.value] }],
      });
      if (disposed || api.isDestroyed()) return;
      const model = api.getColumnFilterModel(target.columnId);
      if (!targetModel(model, target.value)) throw new Error("Не удалось применить фильтр перехода. Сбросьте фильтры и повторите переход.");
      applied = { key: keyOf(target), columnId: target.columnId, value: target.value, model: copyModel(model) };
      api.onFilterChanged();
      onStatus(keyOf(target), { pending: false, error: "" });
    } catch (error) {
      consumedKey = keyOf(target);
      if (!disposed) onStatus(keyOf(target), { pending: false, error: error instanceof Error ? error.message : "Не удалось применить фильтр перехода." });
    } finally {
      pending = false;
      // A late old target cannot win over a newer navigation or URL reset.
      if (!disposed && keyOf(target) !== keyOf(request)) void sync();
    }
  };
  const retry = () => { void sync(); };
  api.addEventListener("filterChanged", changed);
  api.addEventListener("newColumnsLoaded", retry);
  api.addEventListener("rowDataUpdated", retry);
  return {
    update(next: GridNavigationFilter | undefined) {
      if (keyOf(next) !== keyOf(request)) {
        consumedKey = "";
        onStatus(keyOf(next), { pending: Boolean(next), error: "" });
      }
      request = next;
      void sync();
    },
    destroy() {
      disposed = true;
      if (api.isDestroyed()) return;
      api.removeEventListener("filterChanged", changed);
      api.removeEventListener("newColumnsLoaded", retry);
      api.removeEventListener("rowDataUpdated", retry);
    },
  };
}
