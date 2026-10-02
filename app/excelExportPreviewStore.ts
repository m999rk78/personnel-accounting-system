import type { EquipmentPlacementExportRow, EquipmentTimesheetExportRow, PersonnelTimesheetExportRow, PlacementExportRow } from "./placementXlsx";

export type ExcelPreviewCell = string | number;

type PlacementWorkbook = {
  kind: "placement";
  siteName: string;
  rangeStart: string;
  rangeEnd: string;
  rows: PlacementExportRow[];
};

type EquipmentPlacementWorkbook = {
  kind: "equipment-placement";
  siteName: string;
  rangeStart: string;
  rangeEnd: string;
  rows: EquipmentPlacementExportRow[];
};

type TableWorkbook = {
  kind: "table";
  sheetName: string;
  workbookTitle: string;
  rows: ExcelPreviewCell[][];
  rangeStart?: string;
  rangeEnd?: string;
};

type PersonnelTimesheetWorkbook = {
  kind: "personnel-timesheet";
  siteName: string;
  monthLabel: string;
  dates: string[];
  rows: PersonnelTimesheetExportRow[];
  dayTotals: number[];
  totalHours: number;
  totalDifference: number;
};

type EquipmentTimesheetWorkbook = {
  kind: "equipment-timesheet";
  siteName: string;
  monthLabel: string;
  dates: string[];
  rows: EquipmentTimesheetExportRow[];
  dayTotals: number[];
  productiveTotal: number;
  downtimeTotal: number;
  totalHours: number;
};

type PersonnelPreviewSource = {
  kind: "personnel";
  siteId: number;
  siteCode: string;
  siteName: string;
  initialDate: string;
};

type EquipmentPreviewSource = {
  kind: "equipment";
  siteId: number;
  siteName: string;
  initialDate: string;
};

type PersonnelTimesheetPreviewSource = {
  kind: "personnel-timesheet";
  siteId: number;
  siteName: string;
  initialDate: string;
};

type EquipmentTimesheetPreviewSource = {
  kind: "equipment-timesheet";
  siteId: number;
  siteName: string;
  initialDate: string;
};

export type ExcelExportPreviewPayload = {
  version: 1;
  title: string;
  description: string;
  fileName: string;
  headers: string[];
  rows: ExcelPreviewCell[][];
  workbook: PlacementWorkbook | EquipmentPlacementWorkbook | TableWorkbook | PersonnelTimesheetWorkbook | EquipmentTimesheetWorkbook;
  source?: PersonnelPreviewSource | EquipmentPreviewSource | PersonnelTimesheetPreviewSource | EquipmentTimesheetPreviewSource;
};

export function prepareExcelExportPreview(payload: ExcelExportPreviewPayload) {
  const payloadUrl = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
  return `/excel-preview?payload=${encodeURIComponent(payloadUrl)}`;
}

export function openExcelExportPreview(payload: ExcelExportPreviewPayload) {
  const previewUrl = prepareExcelExportPreview(payload);
  const previewWindow = window.open(previewUrl, "_blank");
  if (!previewWindow) {
    const payloadUrl = new URLSearchParams(previewUrl.split("?")[1]).get("payload");
    if (payloadUrl) URL.revokeObjectURL(payloadUrl);
    throw new Error("Браузер заблокировал новую вкладку. Разрешите всплывающие окна для этого сайта.");
  }
  previewWindow.opener = null;
}

export async function takeExcelExportPreview(payloadUrl: string) {
  if (!payloadUrl.startsWith(`blob:${window.location.origin}/`)) return null;
  try {
    const response = await fetch(payloadUrl);
    if (!response.ok) return null;
    const payload = await response.json() as ExcelExportPreviewPayload;
    return payload.version === 1 ? payload : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(payloadUrl);
  }
}
