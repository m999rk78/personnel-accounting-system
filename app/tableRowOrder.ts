export type RowMovePlacement = "start" | "end" | "before" | "after";
export type RowOrderId = number | string;
export type RowMove<Id extends RowOrderId = RowOrderId> = {
  movingIds: Id[];
  placement: RowMovePlacement;
  targetId?: Id;
  displayedIds?: Id[];
  /** Seed the first manual order from the displayed default without replaying it over a later save. */
  displayedIdsOnlyIfUnsaved?: true;
};

export function rowMoveIsBlocked({ editing, loading, filtered, sorted, switchSort, hasDraftRows }: {
  editing: boolean; loading: boolean; filtered: boolean; sorted: boolean; switchSort: boolean; hasDraftRows: boolean;
}): boolean {
  return editing || loading || filtered || hasDraftRows || (sorted && !switchSort);
}

/** A failed save must leave the user's sorting intact. */
export async function saveManualRowMove(operation: RowMove, save: (operation: RowMove) => Promise<boolean>, activateManualOrder: () => void): Promise<boolean> {
  const saved = await save(operation);
  if (saved) activateManualOrder();
  return saved;
}

/** Keep existing rows, append new rows, and forget removed rows without duplicating IDs. */
export function reconcileRowOrder<Id extends RowOrderId>(availableIds: readonly Id[], savedIds: readonly Id[]): Id[] {
  const available = new Set(availableIds);
  return [...new Set([...savedIds.filter((id) => available.has(id)), ...availableIds])];
}

/** Move a block in its existing order. A destination inside that block is a no-op. */
export function moveRowBlock<Id extends RowOrderId>(order: readonly Id[], move: RowMove<Id>): Id[] {
  const selected = new Set(move.movingIds);
  if ((move.placement === "before" || move.placement === "after") && selected.has(move.targetId!)) return [...order];
  // When leaving an automatic sort, start from the order the user actually saw.
  // Only reorder visible entities inside their existing slots; unrelated project rows stay intact.
  if (move.displayedIds) {
    const visible = new Set(move.displayedIds);
    const available = new Set(order);
    const displayed = [...new Set(move.displayedIds)].filter((id) => available.has(id));
    let index = 0;
    order = order.map((id) => visible.has(id) ? displayed[index++] : id);
  }
  const moving = order.filter((id) => selected.has(id));
  const remaining = order.filter((id) => !selected.has(id));
  let index = move.placement === "end" ? remaining.length : 0;
  if (move.placement === "before" || move.placement === "after") {
    index = remaining.indexOf(move.targetId!);
    if (index < 0) throw new Error("Строка назначения больше не существует. Обновите таблицу.");
    if (move.placement === "after") index++;
  }
  return [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
}

/** Sort by the identity of this table's rows, without modifying their content. */
export function orderRowsByIds<T>(rows: readonly T[], ids: readonly RowOrderId[], getId: (row: T) => RowOrderId | undefined): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (rank.get(getId(a)!) ?? ids.length) - (rank.get(getId(b)!) ?? ids.length));
}

export function gridRowEntityId(row: unknown): number | undefined {
  const data = row as { kind?: string; employee?: { id: number }; unit?: { id: number }; entry?: { employeeId?: number; equipmentId?: number }; item?: { id: number }; record?: { id: number }; user?: { id: number }; site?: { id: number } };
  if (data.kind === "draft") return undefined;
  return data.employee?.id ?? data.unit?.id ?? data.entry?.employeeId ?? data.entry?.equipmentId ?? data.item?.id ?? data.record?.id ?? data.user?.id ?? data.site?.id;
}

export function tableOrderScope(view: string, directory: string): string | null {
  if (view === "placement") return "personnel-report-rows";
  if (view === "equipment") return "equipment-report-rows";
  if (["timesheet", "projectEmployees"].includes(view)) return "project-personnel";
  if (["equipmentTimesheet", "projectEquipment"].includes(view)) return "project-equipment";
  if (view === "equipmentRegistry") return "equipment";
  if (["employees", "positions", "users", "projects"].includes(view)) return view;
  if (view === "directories" && ["mainWorkType", "subworkType"].includes(directory)) return "directory-work-types";
  if (view === "directories" && ["zone", "master"].includes(directory)) return `directory-${directory}`;
  return null;
}
