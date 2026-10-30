export { personnelExcelWorkTypePairs as equipmentExcelWorkTypePairs } from "./personnelReportExcel.ts";

type EquipmentExportRow<Entry extends object> = {
  rowKey: string;
  workDate: string;
  status: string;
  entry?: Entry;
  proposalId?: number;
  draftGroupKey?: string;
};

/** Use the filtered grid order and export only saved, approved equipment records. */
export function equipmentReportExcelRows<Entry extends object>(rows: readonly EquipmentExportRow<Entry>[], visibleKeys: readonly string[] | null, selectedKeys: readonly string[], dirtyOwners: readonly string[]): (Entry & { workDate: string })[] {
  const byKey = new Map(rows.map(row => [row.rowKey, row]));
  const selected = new Set(selectedKeys);
  const dirty = new Set(dirtyOwners);
  const seen = new Set<string>();
  const approved = (visibleKeys ?? rows.map(row => row.rowKey)).flatMap(key => {
    const row = byKey.get(key);
    if (!row || seen.has(key) || selected.size && !selected.has(key) || row.status !== "approved" || !row.entry) return [];
    seen.add(key);
    const owner = row.proposalId ? String(row.proposalId) : row.draftGroupKey;
    if (owner && dirty.has(owner)) throw new Error("В выбранных подтверждённых строках техники есть несохранённые изменения. Сохраните их перед экспортом.");
    return [{ ...row.entry, workDate: row.workDate }];
  });
  if (!approved.length) throw new Error(selected.size
    ? "Среди выбранных видимых строк нет подтверждённых записей техники для экспорта."
    : "В текущем представлении нет подтверждённых записей техники для экспорта. Проверьте раздел и фильтры.");
  return approved;
}
