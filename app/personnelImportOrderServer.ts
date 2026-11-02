import type { PostgresDatabase } from "../db/client";

type Executor = Pick<PostgresDatabase, "prepare">;
export type PersonnelImportOrderScope = "employees" | "project-personnel";

const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;

function importOrderKey(scope: PersonnelImportOrderScope, siteId: number | null) {
  if (scope === "employees") return "import-order:employees:0";
  if (scope !== "project-personnel" || !validId(siteId)) throw new Error("Укажите проект для порядка импорта.");
  return `import-order:project-personnel:${siteId}`;
}

/** Latest workbook first; retain unrelated employees in their previous order. */
export function mergePersonnelImportOrder(employeeIds: readonly number[], previous: readonly number[]) {
  if (!Array.isArray(employeeIds) || employeeIds.some(id => !validId(id))) throw new Error("Некорректный порядок сотрудников из файла.");
  return [...new Set([...employeeIds, ...previous.filter(validId)])];
}

/** Call inside the import/save transaction; never replace a manual-order key. */
export async function rememberPersonnelImportOrder(db: Executor, scope: PersonnelImportOrderScope, siteId: number | null, employeeIds: readonly number[]): Promise<void> {
  const key = importOrderKey(scope, siteId);
  const prefix = mergePersonnelImportOrder(employeeIds, []);
  if (!prefix.length) return;
  await db.prepare("INSERT INTO table_row_orders (id) VALUES (?) ON CONFLICT (id) DO NOTHING").bind(key).run();
  const previous = await db.prepare("SELECT row_ids AS ids FROM table_row_orders WHERE id = ? FOR UPDATE").bind(key).first<{ ids: number[] }>();
  const ids = mergePersonnelImportOrder(prefix, Array.isArray(previous?.ids) ? previous.ids : []);
  await db.prepare("UPDATE table_row_orders SET row_ids = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(ids), key).run();
}

/** availableIds must come from the caller's authorised canonical roster. */
export async function readPersonnelImportOrder(db: Executor, scope: PersonnelImportOrderScope, siteId: number | null, availableIds: readonly number[]): Promise<{ importIds: number[]; hasImportOrder: boolean }> {
  const key = importOrderKey(scope, siteId);
  const saved = await db.prepare("SELECT row_ids AS ids FROM table_row_orders WHERE id = ?").bind(key).first<{ ids: number[] }>();
  const available = [...new Set(availableIds.filter(validId))];
  const allowed = new Set(available);
  const imported = Array.isArray(saved?.ids) ? [...new Set(saved.ids)].filter(id => validId(id) && allowed.has(id)) : [];
  return { importIds: [...new Set([...imported, ...available])], hasImportOrder: Boolean(saved) };
}
