export type CatalogDraft = { key: string; id?: number };
export type CatalogRow<R, D> = { rowKey: string; kind: "entry" | "draft"; record?: R; draft?: D };

/** Apply a whole range before publishing any changed catalog rows. */
export function applyCatalogBatch<R extends { id: number }, D extends CatalogDraft>({ rows, drafts, canCreate, canUpdate, newDraft, toDraft, patchDraft, editableFields, validateDrafts, newKey }: {
  rows: { row?: CatalogRow<R, D>; values: Record<string, string> }[];
  drafts: D[];
  canCreate: boolean;
  canUpdate: boolean;
  newDraft: (key: string) => D;
  toDraft: (record: R) => D;
  patchDraft: (draft: D, values: Record<string, string>, drafts: D[]) => D;
  editableFields: (record: R | undefined, draft: D) => string[];
  validateDrafts?: (drafts: D[], changedKeys: string[]) => void;
  newKey: () => string;
}): D[] {
  if (rows.length > 1000) throw new Error("За один раз можно изменить не более 1000 строк.");
  const next = [...drafts], byKey = new Map(drafts.map(draft => [draft.key, draft]));
  const byId = new Map(drafts.filter(draft => draft.id !== undefined).map(draft => [draft.id, draft]));
  const firstRecord = rows[0]?.row?.record;
  if (firstRecord && editableFields(firstRecord, byId.get(firstRecord.id) ?? toDraft(firstRecord)).length === 0) return drafts;
  const slots = drafts.filter(draft => draft.id === undefined);
  const startDraft = rows[0]?.row?.draft;
  const start = startDraft && startDraft.id === undefined ? slots.findIndex(draft => draft.key === startDraft.key) : -1;
  const changed = new Set<string>(), errors: string[] = [];
  for (const [index, input] of rows.entries()) {
    const record = start >= 0 ? undefined : input.row?.record;
    let draft = start >= 0 ? slots[start + index] : input.row?.draft ? byKey.get(input.row.draft.key) : record ? byId.get(record.id) ?? toDraft(record) : undefined;
    if (input.row?.draft && start < 0 && !draft) { errors.push(`Строка ${index + 1}: черновик больше не существует.`); continue; }
    draft ??= newDraft(newKey());
    const fields = new Set(editableFields(record, draft));
    const values = Object.fromEntries(Object.entries(input.values).filter(([field]) => fields.has(field)));
    if (!Object.keys(values).length) continue;
    const existing = Boolean(record || draft.id !== undefined);
    if (existing ? !canUpdate : !canCreate) { errors.push(`Строка ${index + 1}: нет права ${existing ? "редактировать" : "добавлять"} записи.`); continue; }
    try {
      const result = patchDraft({ ...draft }, values, next);
      if (result.key !== draft.key || result.id !== draft.id) throw new Error("Редактирование не может менять идентификатор строки.");
      const existing = next.findIndex(candidate => candidate.key === result.key);
      if (existing < 0) next.push(result); else next[existing] = result;
      byKey.set(result.key, result);
      if (result.id !== undefined) byId.set(result.id, result);
      changed.add(result.key);
    } catch (error) { errors.push(`Строка ${index + 1}: ${error instanceof Error ? error.message : "не удалось изменить значения."}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  if (changed.size) validateDrafts?.(next, [...changed]);
  return changed.size ? next : drafts;
}

/** Saved records are never removed by a local draft operation. */
export function removeCatalogDrafts<D extends CatalogDraft>(drafts: D[], keys: readonly string[]) {
  const selected = new Set(keys);
  return drafts.filter(draft => draft.id !== undefined || !selected.has(draft.key));
}
