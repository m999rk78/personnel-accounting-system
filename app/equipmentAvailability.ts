export type EquipmentAvailabilityMark = {
  productiveHours: number;
  downtimeHours: number;
  note: string;
};

export function isEquipmentUnavailable(mark: EquipmentAvailabilityMark) {
  return Number(mark.productiveHours) === 0 && Number(mark.downtimeHours) > 0;
}

export function equipmentUnavailableReason(mark: EquipmentAvailabilityMark) {
  return mark.note.trim() || `запланирован простой ${Number(mark.downtimeHours)} ч.`;
}
