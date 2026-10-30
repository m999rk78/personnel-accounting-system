export type EquipmentTimesheetFilterCell = {
  productive: number;
  downtime: number;
  mark?: unknown;
  mismatch: boolean;
};

export const equipmentTimesheetDayPresets = [
  { value: "filled", label: "Есть значение" },
  { value: "empty", label: "Нет значения" },
  { value: "productive", label: "Есть работа" },
  { value: "downtime", label: "Есть простой" },
  { value: "manual", label: "Ручная правка" },
  { value: "mismatch", label: "Расхождение" },
] as const;

/** Preserve the distinction between an empty day, an explicit zero and downtime. */
export function equipmentTimesheetFilterValue(cell?: EquipmentTimesheetFilterCell): number | string | null {
  if (!cell || !cell.productive && !cell.downtime && !cell.mark) return null;
  if (cell.downtime > 0) return cell.productive > 0 ? `${cell.productive}/${cell.downtime}` : `П ${cell.downtime}`;
  return cell.productive;
}

export function matchesEquipmentTimesheetDayPreset(preset: string, cell?: EquipmentTimesheetFilterCell): boolean {
  const filled = Boolean(cell && (cell.productive || cell.downtime || cell.mark));
  switch (preset) {
    case "filled": return filled;
    case "empty": return !filled;
    case "productive": return Number(cell?.productive ?? 0) > 0;
    case "downtime": return Number(cell?.downtime ?? 0) > 0;
    case "manual": return Boolean(cell?.mark);
    case "mismatch": return Boolean(cell?.mismatch);
    default: return false;
  }
}
