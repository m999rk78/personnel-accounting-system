type EquipmentIdentity = {
  equipmentType: string;
  brand: string;
  model: string;
  registrationNumber: string;
  organization: string;
};

/** Shared by the report and its reference sheet so an exported name imports unchanged. */
export function equipmentExcelName(unit: EquipmentIdentity) {
  return `${unit.equipmentType} // ${[unit.brand, unit.model].filter(Boolean).join(" ")} // ${unit.registrationNumber || "-"} // ${unit.organization}`;
}
