import type { PostgresDatabase } from "../db/client";
import type { AuthUser } from "./auth";
import { canAccessProject } from "./roles";
import { getReportStatusPermission } from "./permissionModel.ts";
import { parseEquipmentReportDraftSnapshot, EquipmentReportDraftBufferError, type EquipmentReportDraftBuffer } from "./equipmentReportDraftBuffer";

type Executor = Pick<PostgresDatabase, "prepare">;
type StoredBuffer = { revision: number; snapshot: string | null };
const schema = `CREATE TABLE IF NOT EXISTS equipment_report_draft_buffers (
  user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), snapshot TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, site_id)
)`;
let schemaPromise: Promise<unknown> | null = null;
export async function ensureEquipmentReportDraftBufferSchema(db: Executor) {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true") return;
  if (!schemaPromise) schemaPromise = db.prepare(schema).run().catch(error => { schemaPromise = null; throw error; });
  await schemaPromise;
}

export function assertEquipmentReportDraftBufferAccess(user: AuthUser, siteId: number) {
  const permission = getReportStatusPermission(user.permissions, "equipment_report", "draft");
  if (!Number.isSafeInteger(siteId) || siteId < 1 || siteId > 2_147_483_647) throw new EquipmentReportDraftBufferError("Укажите проект.");
  if (!permission?.view || !permission.create && !permission.update || !canAccessProject(user, siteId)) {
    throw new EquipmentReportDraftBufferError("Нет доступа к черновику этого проекта.", 403, "DRAFT_BUFFER_FORBIDDEN");
  }
}

async function assertActiveSite(db: Executor, user: AuthUser, siteId: number) {
  assertEquipmentReportDraftBufferAccess(user, siteId);
  if (!await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first()) throw new EquipmentReportDraftBufferError("Проект не найден.", 404, "SITE_NOT_FOUND");
}

function decodeBuffer(row: StoredBuffer | null, userId: number, siteId: number): EquipmentReportDraftBuffer {
  return row ? { revision: row.revision, snapshot: parseEquipmentReportDraftSnapshot(row.snapshot === null ? null : JSON.parse(row.snapshot), userId, siteId) } : { revision: 0, snapshot: null };
}

async function readBuffer(db: Executor, userId: number, siteId: number) {
  const row = await db.prepare("SELECT revision, snapshot FROM equipment_report_draft_buffers WHERE user_id = ? AND site_id = ?").bind(userId, siteId).first<StoredBuffer>();
  return decodeBuffer(row, userId, siteId);
}

export async function readEquipmentReportDraftBuffer(db: Executor, user: AuthUser, siteId: number): Promise<EquipmentReportDraftBuffer> {
  await assertActiveSite(db, user, siteId);
  return readBuffer(db, user.id, siteId);
}

/** A null snapshot is a versioned tombstone, so another tab cannot resurrect an old draft. */
export async function writeEquipmentReportDraftBuffer(db: Executor, user: AuthUser, siteId: number, expectedRevision: unknown, snapshotValue: unknown): Promise<EquipmentReportDraftBuffer> {
  await assertActiveSite(db, user, siteId);
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2_147_483_647) throw new EquipmentReportDraftBufferError("Обновите черновик перед сохранением.");
  const snapshot = parseEquipmentReportDraftSnapshot(snapshotValue, user.id, siteId);
  const encoded = snapshot === null ? null : JSON.stringify(snapshot);
  const row = expectedRevision === 0
    ? await db.prepare(`INSERT INTO equipment_report_draft_buffers(user_id, site_id, snapshot)
        VALUES (?, ?, ?) ON CONFLICT(user_id, site_id) DO NOTHING RETURNING revision, snapshot`).bind(user.id, siteId, encoded).first<StoredBuffer>()
    : await db.prepare(`UPDATE equipment_report_draft_buffers SET snapshot = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND site_id = ? AND revision = ? RETURNING revision, snapshot`).bind(encoded, user.id, siteId, expectedRevision).first<StoredBuffer>();
  if (!row) throw new EquipmentReportDraftBufferError("Черновик уже изменён в другой вкладке или на другом устройстве. Ваши изменения сохранены в этом браузере.", 409, "DRAFT_BUFFER_CONFLICT", await readBuffer(db, user.id, siteId));
  return decodeBuffer(row, user.id, siteId);
}
