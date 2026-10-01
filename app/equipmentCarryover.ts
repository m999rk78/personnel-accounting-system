import type { GridEquipmentDraft, GridEquipmentEntry, GridEquipmentUnit, GridOption } from "./AgDataGrids";

type EquipmentCarryoverContext = {
  reportSubmitted: boolean;
  workDate: string;
  units: GridEquipmentUnit[];
  entries: GridEquipmentEntry[];
  shifts: GridOption[];
  zones: GridOption[];
  mainWorkTypes: GridOption[];
  subworkTypes: GridOption[];
};

export function buildEquipmentCarryoverDrafts(context: EquipmentCarryoverContext, previousEntries: GridEquipmentEntry[]) {
  if (context.reportSubmitted) return [];
  const available = (options: GridOption[], id: number) => options.some((option) => option.id === id) ? String(id) : "";
  const currentUnits = new Set(context.units.map((unit) => unit.id));
  const savedEquipment = new Set(context.entries
    .filter((entry) => entry.workDate === context.workDate)
    .map((entry) => entry.equipmentId));

  return previousEntries.flatMap((entry): GridEquipmentDraft[] => {
    if (!currentUnits.has(entry.equipmentId) || savedEquipment.has(entry.equipmentId)) return [];
    return [{
      key: `previous-equipment-${entry.equipmentId}-${entry.id}`,
      carriedFromPreviousDay: true,
      equipmentId: String(entry.equipmentId),
      shiftId: available(context.shifts, entry.shiftId),
      zoneId: available(context.zones, entry.zoneId),
      mainWorkTypeId: available(context.mainWorkTypes, entry.mainWorkTypeId),
      subworkTypeId: available(context.subworkTypes, entry.subworkTypeId),
      hours: String(entry.hours),
      note: entry.note,
    }];
  });
}
