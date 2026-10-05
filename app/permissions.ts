import { getDatabase } from "../db/client";
import { normalizePermissionSet, rolePermissionTemplate, type PermissionResource, type PermissionSet, type ResourcePermission } from "./permissionModel";
import type { UserRole } from "./roles";

let permissionSchemaPromise: Promise<void> | null = null;

export function ensurePermissionSchema() {
  if (!permissionSchemaPromise) {
    const schemaTask = process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true"
      ? Promise.resolve()
      : (() => {
        const db = getDatabase();
        return db.batch([
          db.prepare(`CREATE TABLE IF NOT EXISTS user_permissions (
            user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            resource TEXT NOT NULL,
            can_view INTEGER NOT NULL DEFAULT 0,
            can_create INTEGER NOT NULL DEFAULT 0,
            can_update INTEGER NOT NULL DEFAULT 0,
            can_delete INTEGER NOT NULL DEFAULT 0,
            updated_by_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, resource)
          )`),
          db.prepare("CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id)"),
        ]).then(() => undefined);
      })();
    permissionSchemaPromise = schemaTask.catch((error) => {
      permissionSchemaPromise = null;
      throw error;
    });
  }
  return permissionSchemaPromise;
}

type PermissionRow = {
  resource: PermissionResource;
  canView: number | boolean;
  canCreate: number | boolean;
  canUpdate: number | boolean;
  canDelete: number | boolean;
};

export async function loadEffectivePermissions(userId: number, role: UserRole): Promise<{ permissions: PermissionSet; permissionsCustomized: boolean }> {
  await ensurePermissionSchema();
  const result = await getDatabase().prepare(`SELECT resource, can_view AS "canView", can_create AS "canCreate",
      can_update AS "canUpdate", can_delete AS "canDelete"
    FROM user_permissions WHERE user_id = ?`).bind(userId).all<PermissionRow>();
  const overrides = Object.fromEntries(result.results.map((row) => [row.resource, {
    view: Boolean(row.canView), create: Boolean(row.canCreate), update: Boolean(row.canUpdate), delete: Boolean(row.canDelete),
  }])) as Partial<Record<PermissionResource, ResourcePermission>>;
  return { permissions: normalizePermissionSet(overrides, rolePermissionTemplate(role)), permissionsCustomized: result.results.length > 0 };
}

export async function saveUserPermissions(userId: number, permissions: PermissionSet, updatedByUserId: number) {
  await ensurePermissionSchema();
  const normalized = normalizePermissionSet(permissions);
  await getDatabase().transaction(async (db) => {
    await db.prepare("DELETE FROM user_permissions WHERE user_id = ?").bind(userId).run();
    for (const [resource, row] of Object.entries(normalized)) {
      await db.prepare(`INSERT INTO user_permissions
          (user_id, resource, can_view, can_create, can_update, can_delete, updated_by_user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        // user_permissions has a composite primary key and intentionally has no
        // standalone `id` column. `run()` asks the PostgreSQL adapter to return
        // an inserted `id`, so execute this insert without that implicit clause.
        .bind(userId, resource, row.view ? 1 : 0, row.create ? 1 : 0, row.update ? 1 : 0, row.delete ? 1 : 0, updatedByUserId).all();
    }
  });
  return normalized;
}

export async function resetUserPermissions(userId: number) {
  await ensurePermissionSchema();
  await getDatabase().prepare("DELETE FROM user_permissions WHERE user_id = ?").bind(userId).run();
}
