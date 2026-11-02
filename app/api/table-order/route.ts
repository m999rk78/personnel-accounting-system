import { withAuditTrail } from "../../auditLog";
import { getDatabase } from "../../../db/client";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { moveRowBlock, reconcileRowOrder, type RowMove, type RowOrderId } from "../../tableRowOrder";
import { isPersonnelReportOrderId, isUnsavedPersonnelReportOrderId, movePersonnelReportRows, remapPersonnelReportOrder, personnelReportOrderScope } from "../../personnelReportRowOrder";
import { equipmentReportOrderScope, isEquipmentReportOrderId, isUnsavedEquipmentReportOrderId, moveEquipmentReportRows, remapEquipmentReportOrder } from "../../equipmentReportRowOrder";
import { ensureEquipmentReportSchema } from "../../equipmentReportStore";
import { canonicalRowIds, ensureTableOrderSchema, readTableOrder, rowOrderAccess, TableOrderAccessError } from "../../tableRowOrderServer";
import { isWorkTypesOrderId, workTypesOrderScope } from "../../workTypesRowOrder";
import { readPersonnelImportOrder } from "../../personnelImportOrderServer";

const positiveId = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) return Response.json({ error: "Войдите в систему." }, { status: 401 });
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") ?? "";
    const siteId = positiveId(url.searchParams.get("siteId"));
    const access = rowOrderAccess(user, scope, siteId);
    if (!access.canRead) return Response.json({ error: "Нет права просмотра таблицы." }, { status: 403 });
    if (scope === equipmentReportOrderScope) await ensureEquipmentReportSchema(getDatabase());
    const [ids, saved] = await Promise.all([
      readTableOrder(scope, siteId, user),
      ensureTableOrderSchema().then(() => getDatabase().prepare("SELECT id FROM table_row_orders WHERE id = ?").bind(access.key).first()),
    ]);
    const importOrder = scope === "employees" || scope === "project-personnel"
      ? await readPersonnelImportOrder(getDatabase(), scope, siteId, (await canonicalRowIds(scope, siteId, getDatabase(), user)).filter((id): id is number => typeof id === "number"))
      : { importIds: [], hasImportOrder: false };
    return Response.json({ ids, canWrite: access.canWrite, hasSavedOrder: Boolean(saved), ...importOrder }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить порядок строк." }, { status: error instanceof TableOrderAccessError ? error.status : 400 });
  }
}

async function moveRows(request: Request) {
  const user = await getAuthUser(request);
  if (!user) return Response.json({ error: "Войдите в систему." }, { status: 401 });
  try {
    assertSameOrigin(request);
    const input = await request.json();
    const scope = typeof input.scope === "string" ? input.scope : "";
    const siteId = positiveId(input.siteId);
    const access = rowOrderAccess(user, scope, siteId);
    if (!access.canRead || !access.canWrite) return Response.json({ error: "Нет права менять порядок строк." }, { status: 403 });
    const equipmentReportRows = scope === equipmentReportOrderScope;
    const reportRows = scope === personnelReportOrderScope || equipmentReportRows;
    const isReportOrderId = equipmentReportRows ? isEquipmentReportOrderId : isPersonnelReportOrderId;
    const isUnsavedReportOrderId = equipmentReportRows ? isUnsavedEquipmentReportOrderId : isUnsavedPersonnelReportOrderId;
    const remapReportOrder = equipmentReportRows ? remapEquipmentReportOrder : remapPersonnelReportOrder;
    const moveReportRows = equipmentReportRows ? moveEquipmentReportRows : movePersonnelReportRows;
    if (equipmentReportRows) await ensureEquipmentReportSchema(getDatabase());
    if (reportRows && input.action === "remap") {
      if (!input.aliases || typeof input.aliases !== "object" || Array.isArray(input.aliases) || Object.keys(input.aliases).length > 40000) throw new Error("Некорректное сопоставление строк.");
      await ensureTableOrderSchema();
      const ids = await getDatabase().transaction(async db => {
        const saved = await db.prepare("SELECT row_ids AS ids FROM table_row_orders WHERE id = ? FOR UPDATE").bind(access.key).first<{ ids: string[] }>();
        const available = await canonicalRowIds(scope, siteId, db, user) as string[];
        const ids = remapReportOrder(saved?.ids ?? [], input.aliases, new Set(available));
        if (saved) await db.prepare("UPDATE table_row_orders SET row_ids = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(ids), access.key).run();
        const drafts = ids.filter(isUnsavedReportOrderId);
        return reconcileRowOrder([...available, ...drafts], ids);
      });
      return Response.json({ ids });
    }
    const workTypes = scope === workTypesOrderScope;
    const stringIds = reportRows || workTypes;
    const validId = reportRows ? isReportOrderId : workTypes ? isWorkTypesOrderId : (id: unknown) => Boolean(positiveId(id));
    const limit = reportRows ? 40000 : workTypes ? 100000 : 5000;
    if (!Array.isArray(input.movingIds) || !input.movingIds.length || input.movingIds.length > limit || input.movingIds.some((id: unknown) => !validId(id))) throw new Error("Выберите строки для переноса.");
    const movingIds: RowOrderId[] = stringIds ? input.movingIds : input.movingIds.map(Number);
    if (new Set(movingIds).size !== movingIds.length) throw new Error("Выбранные строки повторяются.");
    if (!["start", "end", "before", "after"].includes(input.placement)) throw new Error("Выберите место переноса.");
    const move: RowMove = { movingIds, placement: input.placement, targetId: stringIds ? input.targetId : positiveId(input.targetId) ?? undefined };
    if ((move.placement === "before" || move.placement === "after") && !validId(move.targetId)) throw new Error("Выберите строку назначения.");
    if (input.displayedIds !== undefined) {
      if (!Array.isArray(input.displayedIds) || !input.displayedIds.length || input.displayedIds.length > limit || input.displayedIds.some((id: unknown) => !validId(id))) throw new Error("Некорректный видимый порядок строк.");
      move.displayedIds = stringIds ? input.displayedIds : input.displayedIds.map(Number);
      if (new Set(move.displayedIds).size !== move.displayedIds!.length) throw new Error("Видимый порядок содержит повторяющиеся строки.");
    }
    await ensureTableOrderSchema();
    const ids = await getDatabase().transaction(async (db) => {
      // Serialize moves within one table; concurrent requests apply to the latest saved order.
      await db.prepare("INSERT INTO table_row_orders (id) VALUES (?) ON CONFLICT (id) DO NOTHING").bind(access.key).run();
      const saved = await db.prepare("SELECT row_ids AS ids FROM table_row_orders WHERE id = ? FOR UPDATE").bind(access.key).first<{ ids: RowOrderId[] }>();
      const available = await canonicalRowIds(scope, siteId, db, user);
      if (reportRows) {
        // Draft UUIDs have no database row yet. They only affect display order;
        // persisted record IDs still have to belong to this project and user.
        const drafts = [...(saved?.ids ?? []), ...movingIds, ...(move.displayedIds ?? []), ...(move.targetId ? [move.targetId] : [])]
          .filter((id): id is string => typeof id === "string" && isUnsavedReportOrderId(id));
        available.push(...new Set(drafts.slice(-limit)));
      }
      const allowed = new Set(available);
      if (movingIds.some((id) => !allowed.has(id)) || move.displayedIds?.some((id) => !allowed.has(id)) || (move.targetId && !allowed.has(move.targetId))) throw new Error("Состав таблицы изменился. Обновите страницу и повторите перенос.");
      const current = reconcileRowOrder(available, saved?.ids ?? []);
      const ordered = reportRows ? moveReportRows(current as string[], move as RowMove<string>) : moveRowBlock(current, move);
      await db.prepare("UPDATE table_row_orders SET row_ids = ?::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(ordered), access.key).run();
      return ordered;
    });
    return Response.json({ ids });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить порядок строк." }, { status: error instanceof TableOrderAccessError ? error.status : 400 });
  }
}

export async function POST(request: Request) { return withAuditTrail(request, moveRows); }
