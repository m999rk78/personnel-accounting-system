type EquipmentDisplayIdentity = { model: string; registrationNumber: string };

/** Shared equipment label for reports and timesheets. */
export function equipmentDisplayName(unit: EquipmentDisplayIdentity | undefined) {
  if (!unit) return "";
  const model = unit.model?.trim();
  const registrationNumber = unit.registrationNumber?.trim();
  return `${model && model !== "-" ? model : "—"} // ${registrationNumber && registrationNumber !== "-" ? registrationNumber : "—"}`;
}
