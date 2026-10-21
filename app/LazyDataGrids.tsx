"use client";

import { lazy, Suspense, type ComponentType } from "react";
export type * from "./AgDataGrids";

// The registry/report grid engine is not needed to open a monthly timesheet.
// All loaders resolve to the same cached chunk when a grid is actually visited.
function deferredGrid<Props extends object>(load: () => Promise<{ default: ComponentType<Props> }>) {
  const Grid = lazy(load);
  return function DeferredGrid(props: Props) {
    return <Suspense fallback={<div className="ag-grid-shell" role="status">Загружаем таблицу…</div>}><Grid {...props} /></Suspense>;
  };
}

export const PlacementAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["PlacementAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.PlacementAgGrid })));
export const EmployeeAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["EmployeeAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.EmployeeAgGrid })));
export const ProjectEmployeeAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["ProjectEmployeeAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.ProjectEmployeeAgGrid })));
export const DirectoryAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["DirectoryAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.DirectoryAgGrid })));
export const PositionAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["PositionAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.PositionAgGrid })));
export const UserAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["UserAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.UserAgGrid })));
export const ProjectAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["ProjectAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.ProjectAgGrid })));
export const EquipmentDailyAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["EquipmentDailyAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.EquipmentDailyAgGrid })));
export const EquipmentRegistryAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["EquipmentRegistryAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.EquipmentRegistryAgGrid })));
export const ProjectEquipmentAgGrid = deferredGrid<Parameters<typeof import("./AgDataGrids")["ProjectEquipmentAgGrid"]>[0]>(() => import("./AgDataGrids").then((module) => ({ default: module.ProjectEquipmentAgGrid })));
