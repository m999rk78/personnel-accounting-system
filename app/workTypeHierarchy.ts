export type WorkTypeOption = { id: number; name: string; mainWorkTypeId?: number | null };

export function subworkOptions<T extends WorkTypeOption>(options: T[], mainWorkTypeId: string | number | null | undefined): T[] {
  const parent = Number(mainWorkTypeId);
  return parent > 0 ? options.filter(option => option.mainWorkTypeId === parent) : [];
}

export function compatibleSubworkId(options: WorkTypeOption[], mainWorkTypeId: string | number | null | undefined, subworkTypeId: string | number | null | undefined): string {
  return subworkOptions(options, mainWorkTypeId).some(option => option.id === Number(subworkTypeId)) ? String(subworkTypeId) : "";
}

/** Apply the parent first, including paste and bulk edits, then validate its child. */
export function workTypeChanges<T extends { mainWorkTypeId: string; subworkTypeId: string }>(draft: T, changes: Partial<T>, options: WorkTypeOption[]): Partial<T> {
  if (changes.mainWorkTypeId === undefined && changes.subworkTypeId === undefined) return changes;
  const mainWorkTypeId = changes.mainWorkTypeId ?? draft.mainWorkTypeId;
  const subworkTypeId = compatibleSubworkId(options, mainWorkTypeId, changes.subworkTypeId ?? draft.subworkTypeId);
  return { ...changes, subworkTypeId };
}
