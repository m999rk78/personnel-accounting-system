export type NativeRowSelection = { key: string; ids: number[] };

export function nativeSelectedRowIds(selection: NativeRowSelection, key: string, availableIds: readonly number[]): number[] {
  const available = new Set(availableIds);
  return selection.key === key ? [...new Set(selection.ids)].filter(id => available.has(id)) : [];
}

export function toggleNativeRowSelection(selection: NativeRowSelection, key: string, availableIds: readonly number[], id: number, checked: boolean): NativeRowSelection {
  const selected = nativeSelectedRowIds(selection, key, availableIds);
  return { key, ids: checked && availableIds.includes(id) ? [...new Set([...selected, id])] : selected.filter(value => value !== id) };
}

export function nativeRowDragIds(selected: readonly number[], id: number, blocked: boolean): number[] {
  return blocked ? [] : selected.includes(id) ? [...selected] : [id];
}

/** A scope switch or a removed row cancels the entire gesture, never part of it. */
export function nativeRowDropIds(dragged: NativeRowSelection, key: string, availableIds: readonly number[], targetId: number, blocked: boolean): number[] {
  const available = new Set(availableIds);
  if (blocked || dragged.key !== key || !dragged.ids.length || !available.has(targetId) || dragged.ids.includes(targetId) || dragged.ids.some(id => !available.has(id))) return [];
  return [...dragged.ids];
}
