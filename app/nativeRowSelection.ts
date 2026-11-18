export type NativeRowSelection = { key: string; ids: number[]; anchorId?: number };

export function nativeSelectedRowIds(selection: NativeRowSelection, key: string, availableIds: readonly number[]): number[] {
  const available = new Set(availableIds);
  return selection.key === key ? [...new Set(selection.ids)].filter(id => available.has(id)) : [];
}

export function toggleNativeRowSelection(selection: NativeRowSelection, key: string, availableIds: readonly number[], id: number, checked: boolean): NativeRowSelection {
  const selected = nativeSelectedRowIds(selection, key, availableIds);
  return { key, ids: checked && availableIds.includes(id) ? [...new Set([...selected, id])] : selected.filter(value => value !== id) };
}

/** Range selection follows the displayed order, including rows outside the viewport. */
export function selectNativeRow(selection: NativeRowSelection, key: string, availableIds: readonly number[], id: number, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}): NativeRowSelection {
  const selected = nativeSelectedRowIds(selection, key, availableIds);
  if (!availableIds.includes(id)) return { key, ids: selected };
  const additive = modifiers.ctrlKey || modifiers.metaKey;
  if (!modifiers.shiftKey) return {
    key,
    ids: additive ? toggleNativeRowSelection(selection, key, availableIds, id, !selected.includes(id)).ids : [id],
    anchorId: id,
  };
  const anchorId = selected.length && selection.key === key && selection.anchorId !== undefined && availableIds.includes(selection.anchorId)
    ? selection.anchorId : selected[0] ?? id;
  const from = availableIds.indexOf(anchorId);
  const to = availableIds.indexOf(id);
  const range = availableIds.slice(Math.min(from, to), Math.max(from, to) + 1);
  return { key, ids: [...new Set(additive ? [...selected, ...range] : range)], anchorId };
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
