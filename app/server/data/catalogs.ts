import { type AuthUser } from "../../auth";
import { accessibleProjectIds, isUserRole, visibleUserProjectAccess } from "../../roles";
import { loadCustomRole } from "../../customRolesServer";
import { loadUserProjectAccess } from "../../projectAccessServer";
import { currentEmployeeDirectoryFilter, currentMasterDirectoryFilter } from "../../employeeDirectoryEligibility";
import { getDatabase } from "../../../db/client";
import { type DatabaseExecutor, env } from "./context";
import { type DirectoryEntity, type UserPayload } from "./types";
import { asPositiveInteger } from "./validation";

export async function reconcilePositionCatalogOptions(db: DatabaseExecutor = env.DB) {
  await db.batch([
    db.prepare("UPDATE personnel_options SET active = 0 WHERE kind = 'employmentType' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND employment_type = personnel_options.name)"),
    db.prepare("UPDATE personnel_options SET active = 0 WHERE kind = 'department' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND department = personnel_options.name)"),
    db.prepare("UPDATE personnel_options SET active = 0 WHERE kind = 'position' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND position = personnel_options.name)"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'employmentType', employment_type FROM position_catalog WHERE employment_type <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'employmentType' AND name = position_catalog.employment_type AND active = 1)"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'department', department FROM position_catalog WHERE department <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'department' AND name = position_catalog.department AND active = 1)"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'position', position FROM position_catalog WHERE position <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'position' AND name = position_catalog.position AND active = 1)"),
  ]);
}

const DIRECTORY_TABLES: Record<DirectoryEntity, string> = {
  employmentType: "personnel_options",
  department: "personnel_options",
  position: "personnel_options",
  shift: "shifts",
  zone: "zones",
  mainWorkType: "main_work_types",
  subworkType: "subwork_types",
  master: "masters",
};

export const PERSONNEL_COLUMNS = { employmentType: "employment_type", department: "department", position: "position" } as const;

export function directoryTable(entity: unknown) {
  if (typeof entity !== "string" || !(entity in DIRECTORY_TABLES)) return null;
  const key = entity as DirectoryEntity;
  return { table: DIRECTORY_TABLES[key], key, global: key === "employmentType" || key === "department" || key === "position" };
}

export async function validateEmployeeDirectoryValues(employmentType: string, department: string, position: string, projectSiteId: number | null, db: DatabaseExecutor = env.DB) {
  const statements = [
    db.prepare("SELECT id FROM personnel_options WHERE kind = 'employmentType' AND name = ? AND active = 1").bind(employmentType),
    db.prepare("SELECT id FROM personnel_options WHERE kind = 'department' AND name = ? AND active = 1").bind(department),
    db.prepare("SELECT id FROM personnel_options WHERE kind = 'position' AND name = ? AND active = 1").bind(position),
    db.prepare("SELECT id FROM position_catalog WHERE employment_type = ? AND department = ? AND position = ? AND active = 1").bind(employmentType, department, position),
  ];
  if (projectSiteId) statements.push(db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(projectSiteId));
  const refs = await db.batch(statements);
  if (!refs[0].results.length) throw new Error(`Значение «${employmentType}» не относится к столбцу «Тип».`);
  if (!refs[1].results.length) throw new Error(`Значение «${department}» не относится к столбцу «Отдел».`);
  if (!refs[2].results.length) throw new Error(`Значение «${position}» не относится к столбцу «Должность».`);
  if (!refs[3].results.length) throw new Error("Сочетание типа, отдела и должности отсутствует в справочнике должностей.");
  if (projectSiteId && !refs[4]?.results.length) throw new Error("Выбранный проект не найден или уже закрыт.");
}

export function employeeCatalogStatement(user: AuthUser, includeFormer = false) {
  const siteIds = accessibleProjectIds(user);
  const scoped = siteIds !== null;
  const statement = env.DB.prepare(`SELECT e.id, e.bitrix24_id AS bitrix24Id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source, e.sort_order AS sortOrder,
          e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError, e.last_synced_at AS lastSyncedAt,
          check_state.status AS bitrixCheckStatus, check_state.details AS bitrixCheckDetails,
          CASE WHEN check_state.acknowledged_at IS NOT NULL THEN 1 ELSE 0 END AS bitrixCheckAcknowledged,
          CASE WHEN check_state.fingerprint LIKE 'office_transfer:%' THEN 1 ELSE 0 END AS bitrixCheckOfficeTransfer,
          MIN(epa.site_id) AS siteId, STRING_AGG(assigned_site.name, ', ' ORDER BY assigned_site.name) AS siteName,
          STRING_AGG(assigned_site.code, '; ' ORDER BY assigned_site.name) AS projectCodes
          FROM employees e
          LEFT JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1
          LEFT JOIN sites assigned_site ON assigned_site.id = epa.site_id AND assigned_site.active = 1
          LEFT JOIN bitrix24_employee_check_states check_state ON check_state.employee_id = e.id
          WHERE ${currentEmployeeDirectoryFilter("e")}${scoped ? includeFormer
            ? ` AND (epa.site_id = ANY(?::integer[]) OR (epa.site_id IS NULL AND EXISTS (
                SELECT 1 FROM employee_project_assignments former_assignment
                WHERE former_assignment.employee_id = e.id AND former_assignment.site_id = ANY(?::integer[]))))`
            : " AND epa.site_id = ANY(?::integer[])" : ""}
          GROUP BY e.id, e.bitrix24_id, e.full_name, e.employment_type, e.department, e.position, e.source, e.sort_order, e.bitrix24_stage, e.availability_status, e.sync_error, e.last_synced_at,
            check_state.status, check_state.details, check_state.acknowledged_at, check_state.fingerprint
          ORDER BY e.sort_order, e.full_name, e.id`);
  return scoped ? statement.bind(siteIds, ...(includeFormer ? [siteIds] : [])) : statement;
}

export function projectEmployeeCatalogStatement(siteId: number) {
  return env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source, e.sort_order AS sortOrder,
    e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError,
    epa.site_id AS siteId, s.name AS siteName
    FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1 JOIN sites s ON s.id = epa.site_id AND s.active = 1
    WHERE ${currentEmployeeDirectoryFilter("e")} AND epa.site_id = ? ORDER BY e.sort_order, e.full_name, e.id`).bind(siteId);
}

export function projectMasterCatalogStatement(siteId: number) {
  return env.DB.prepare(`SELECT id, name, employee_id AS employeeId FROM masters
    WHERE ${currentMasterDirectoryFilter("masters")} AND site_id = ? ORDER BY id`).bind(siteId);
}

export function userCatalogStatement(user: AuthUser) {
  const siteIds = accessibleProjectIds(user);
  const scoped = siteIds !== null;
  const statement = env.DB.prepare(`SELECT id, full_name AS fullName, email, CASE WHEN role = 'office' THEN 'superadmin' WHEN role = 'admin' THEN 'engineer' ELSE role END AS role,
    assigned_site_id AS assignedSiteId, custom_role_id AS customRoleId, CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END AS status
    FROM app_users target WHERE active = 1${scoped ? ` AND (
      EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = target.id AND access.all_projects = 1)
      OR EXISTS (SELECT 1 FROM user_project_access_sites grant_site WHERE grant_site.user_id = target.id AND grant_site.site_id = ANY(?::integer[]))
      OR (NOT EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = target.id)
        AND target.custom_role_id IS NULL AND (target.role IN ('engineer', 'superadmin', 'office', 'admin') OR target.role = 'foreman' AND target.assigned_site_id = ANY(?::integer[]))))` : ""} ORDER BY full_name`);
  return scoped ? statement.bind(siteIds, siteIds) : statement;
}

export async function usersWithProjectAccess(rows: Record<string, unknown>[], observer: AuthUser) {
  return Promise.all(rows.map(async row => {
    if (!isUserRole(row.role)) return null;
    const customRoleId = asPositiveInteger(row.customRoleId);
    const customRole = customRoleId ? await loadCustomRole(customRoleId) : null;
    if (customRoleId && (!customRole || customRole.baseRole !== row.role)) throw new Error("Пользовательская роль недоступна.");
    const user = { ...row, role: row.role, assignedSiteId: asPositiveInteger(row.assignedSiteId), customRoleId,
      customRoleName: customRole?.name ?? null,
      ...await loadUserProjectAccess({ id: Number(row.id), role: row.role, assignedSiteId: asPositiveInteger(row.assignedSiteId), customRoleId }) };
    return visibleUserProjectAccess(user, observer);
  }));
}

export async function resolveUserRole(payload: UserPayload, db: Pick<ReturnType<typeof getDatabase>, "prepare">, previous?: { role: string; customRoleId?: number | null }) {
  const preserve = payload.customRoleId === undefined && previous && (payload.role === undefined || payload.role === previous.role);
  const requestedId = preserve ? previous.customRoleId : payload.customRoleId;
  let customRoleId = requestedId === undefined || requestedId === null ? null : asPositiveInteger(requestedId);
  if (requestedId !== undefined && requestedId !== null && (!customRoleId || customRoleId > 2147483647)) throw new Error("Выберите роль из списка.");
  let customRole = customRoleId ? await loadCustomRole(customRoleId, db) : null;
  const legacyKey = payload.role ?? previous?.role;
  if (!customRoleId && (legacyKey === "foreman" || legacyKey === "engineer" || legacyKey === "viewer")) {
    const managed = await db.prepare("SELECT id, active FROM custom_roles WHERE legacy_role_key = ?").bind(legacyKey).first<{ id: number; active: number }>();
    if (managed) {
      if (!managed.active) throw new Error("Эта роль удалена. Выберите действующую роль из справочника.");
      customRoleId = managed.id;
      customRole = await loadCustomRole(managed.id, db);
    }
  }
  if (customRoleId && !customRole) throw new Error("Выбранная роль не найдена. Обновите список ролей.");
  if (customRole && payload.role !== undefined && payload.role !== customRole.baseRole) throw new Error("Настройки выбранной роли изменились. Выберите роль повторно.");
  const role = customRole?.baseRole ?? payload.role ?? previous?.role;
  if (!isUserRole(role)) throw new Error("Выберите роль из списка.");
  return { role, customRoleId };
}
