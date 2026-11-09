import type { PostgresDatabase } from "../db/client";
import type { AuthUser } from "./auth";
import { canAccessProject } from "./roles";
import { parsePersonnelReportDraftSnapshot, PersonnelReportDraftBufferError, type PersonnelReportDraftBuffer } from "./personnelReportDraftBuffer";

type Executor = Pick<PostgresDatabase, "prepare">;
type StoredBuffer = { revision: number; snapshot: string | null };
const schema = `CREATE TABLE IF NOT EXISTS personnel_report_draft_buffers (
  user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), snapshot TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, site_id)
)`;
let schemaPromise: Promise<unknown> | null = null;
export async function ensurePersonnelReportDraftBufferSchema(db: Executor) {
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true") return;
  if (!schemaPromise) schemaPromise = db.prepare(schema).run().catch(error => { schemaPromise = null; throw error; });
  await schemaPromise;
}

export function assertPersonnelReportDraftBufferAccess(user: AuthUser, siteId: number) {
  const permission = user.permissions.workers_report;
  if (!Number.isSafeInteger(siteId) || siteId < 1 || siteId > 2_147_483_647) throw new PersonnelReportDraftBufferError("Укажите проект.");
  if (user.role === "viewer" || !permission?.view || !permission.create && !permission.update || !canAccessProject(user, siteId)) {
    throw new PersonnelReportDraftBufferError("Нет доступа к черновику этого проекта.", 403, "DRAFT_BUFFER_FORBIDDEN");
  }
}

async function assertActiveSite(db: Executor, user: AuthUser, siteId: number) {
  assertPersonnelReportDraftBufferAccess(user, siteId);
  if (!await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first()) throw new PersonnelReportDraftBufferError("Проект не найден.", 404, "SITE_NOT_FOUND");
}

function decodeBuffer(row: StoredBuffer | null, userId: number, siteId: number): PersonnelReportDraftBuffer {
  return row ? { revision: row.revision, snapshot: parsePersonnelReportDraftSnapshot(row.snapshot === null ? null : JSON.parse(row.snapshot), userId, siteId) } : { revision: 0, snapshot: null };
}

async function readBuffer(db: Executor, userId: number, siteId: number) {
  const row = await db.prepare("SELECT revision, snapshot FROM personnel_report_draft_buffers WHERE user_id = ? AND site_id = ?").bind(userId, siteId).first<StoredBuffer>();
  return decodeBuffer(row, userId, siteId);
}

export async function readPersonnelReportDraftBuffer(db: Executor, user: AuthUser, siteId: number): Promise<PersonnelReportDraftBuffer> {
  await assertActiveSite(db, user, siteId);
  return readBuffer(db, user.id, siteId);
}

/** A null snapshot is a versioned tombstone, so another tab cannot resurrect an old draft. */
export async function writePersonnelReportDraftBuffer(db: Executor, user: AuthUser, siteId: number, expectedRevision: unknown, snapshotValue: unknown): Promise<PersonnelReportDraftBuffer> {
  await assertActiveSite(db, user, siteId);
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2_147_483_647) throw new PersonnelReportDraftBufferError("Обновите черновик перед сохранением.");
  const snapshot = parsePersonnelReportDraftSnapshot(snapshotValue, user.id, siteId);
  const encoded = snapshot === null ? null : JSON.stringify(snapshot);
  const row = expectedRevision === 0
    ? await db.prepare(`INSERT INTO personnel_report_draft_buffers(user_id, site_id, snapshot)
        VALUES (?, ?, ?) ON CONFLICT(user_id, site_id) DO NOTHING RETURNING revision, snapshot`).bind(user.id, siteId, encoded).first<StoredBuffer>()
    : await db.prepare(`UPDATE personnel_report_draft_buffers SET snapshot = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND site_id = ? AND revision = ? RETURNING revision, snapshot`).bind(encoded, user.id, siteId, expectedRevision).first<StoredBuffer>();
  if (!row) throw new PersonnelReportDraftBufferError("Черновик уже изменён в другой вкладке или на другом устройстве. Ваши изменения сохранены в этом браузере.", 409, "DRAFT_BUFFER_CONFLICT", await readBuffer(db, user.id, siteId));
  return decodeBuffer(row, user.id, siteId);
}
