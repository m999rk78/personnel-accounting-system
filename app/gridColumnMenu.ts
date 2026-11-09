import type { Column, DefaultMenuItem, GetMainMenuItemsParams, MenuItemDef } from "ag-grid-community";
import { resetGridColumnPreferences } from "./gridPreferences";

const utilityColumns = new Set(["number", "rowOrder", "actions", "ag-Grid-SelectionColumn", "reportDateGroup", "__import_order__"]);
export function isMenuDataColumn(column: Column): boolean {
  const definition = column.getColDef();
  return !utilityColumns.has(column.getColId()) && !definition.suppressColumnsToolPanel;
}

/** Keep native capability checks (especially grouping/pinning) and add hiding. */
export function tableColumnMenuItems<T>(params: GetMainMenuItemsParams<T>): (DefaultMenuItem | MenuItemDef<T>)[] {
  const { api, column } = params;
  const items: (DefaultMenuItem | MenuItemDef<T>)[] = params.defaultItems.map(item => {
    if (item === "autoSizeThis") return { name: "Ширина по содержимому", action: () => { if (column && !api.isDestroyed()) api.autoSizeColumns([column]); } };
    if (item === "autoSizeAll") return { name: "Подобрать ширину всех", action: () => { if (!api.isDestroyed()) api.autoSizeAllColumns(); } };
    if (item === "resetColumns") return { name: "Сбросить столбцы", icon: '<span class="ag-icon ag-icon-cancel" aria-hidden="true"></span>', action: () => resetGridColumnPreferences(api) };
    return item;
  });
  if (!column || !isMenuDataColumn(column)) return items;

  if (column.isSortable() && !items.includes("sortUnSort")) {
    const index = items.indexOf("sortDescending");
    if (index >= 0) items.splice(index + 1, 0, { name: "Сбросить сортировку", disabled: true });
  }
  const visibleData = (api.getColumns() ?? []).filter(candidate => candidate.isVisible() && isMenuDataColumn(candidate));
  const locked = Boolean(column.getColDef().lockVisible);
  const hide: MenuItemDef<T> = {
    name: "Скрыть столбец",
    icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M8.5 5.6A10 10 0 0 1 12 5c6 0 10 7 10 7a19 19 0 0 1-4.4 4.7M6.2 6.2A23 23 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4-.8"/></svg>',
    disabled: locked || visibleData.length <= 1,
    tooltip: locked ? "Этот столбец должен оставаться видимым" : visibleData.length <= 1 ? "Нужно оставить хотя бы один столбец с данными" : undefined,
    action: () => {
      if (api.isDestroyed() || column.getColDef().lockVisible) return;
      const remaining = (api.getColumns() ?? []).filter(candidate => candidate.isVisible() && isMenuDataColumn(candidate));
      if (remaining.length > 1) api.setColumnsVisible([column], false);
    },
  };
  const chooser = items.indexOf("columnChooser");
  const index = chooser >= 0 ? chooser : items.length;
  items.splice(index, 0, hide, "separator");
  return items;
}
