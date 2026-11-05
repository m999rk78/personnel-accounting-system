import { assertSameOrigin, getAuthUser } from "../../auth";
import { hasRestrictedProjectAccess, accessibleProjectIds, canAccessProject } from "../../roles";
import { projectEntitiesAllowed } from "../../projectScopedData";
import { unauthorized, forbidden, approvalRequired, placementErrorResponse } from "./responses";
import { ensureDatabaseInitialized } from "./bootstrap";
import { canDeleteEntity } from "./access";
import { asPositiveInteger } from "./validation";
import { directoryTable, reconcilePositionCatalogOptions, PERSONNEL_COLUMNS } from "./catalogs";
import { env } from "./context";
import { existingPlacementEntriesStatement, assertPlacementOwnership, lockPlacementHours, touchForemanContribution } from "./placement";
import { type ExistingPlacementEntry } from "./types";

export async function handleDELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    if (authUser.role === "viewer") return forbidden();
    await ensureDatabaseInitialized();
    const url = new URL(request.url);
    const entity = url.searchParams.get("entity");
    if (!canDeleteEntity(authUser, entity, url.searchParams.get("kind"))) return forbidden();
    if (hasRestrictedProjectAccess(authUser)) {
      if (!accessibleProjectIds(authUser)?.length || ["user", "site", "position"].includes(entity ?? "")) return forbidden();
      const requestedSiteId = url.searchParams.get("siteId");
      if (requestedSiteId !== null && !canAccessProject(authUser, asPositiveInteger(requestedSiteId))) return forbidden();
      if (entity === "directory" && directoryTable(url.searchParams.get("kind"))?.global) return forbidden();
    }
    if (!entity) {
      if (authUser.role === "foreman") return approvalRequired();
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await request.json() as { ids?: unknown[] }
        : null;
      const ids = [...new Set((body?.ids ?? [url.searchParams.get("id")]).map(asPositiveInteger).filter((id): id is number => id !== null))];
      if (!ids.length) throw new Error("Не указаны строки для удаления.");
      if (ids.length > 5_000) throw new Error("За один раз можно удалить не более 5000 строк.");
      const result = await env.DB.transaction(async (db) => {
        const entries = await existingPlacementEntriesStatement(db, ids, true).all<ExistingPlacementEntry>();
        if (entries.results.length !== ids.length) throw new Error("Одна или несколько строк не найдены.");
        assertPlacementOwnership(authUser, entries.results);
        await lockPlacementHours(db, [], entries.results);
        const deletion = await db.prepare(`UPDATE placement_entries
          SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
            updated_by_user_id = ?, revision = revision + 1
          WHERE id = ANY(?) AND deleted_at IS NULL RETURNING id`)
          .bind(authUser.id, ids).all();
        const first = entries.results[0];
        const contribution = first
          ? await touchForemanContribution(db, authUser, first.siteId, first.workDate, false, undefined, true)
          : null;
        return { ok: true, count: deletion.meta.changes, contribution };
      });
      return Response.json(result);
    }
    if (entity === "employee") {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await request.json() as { ids?: unknown[] }
        : null;
      const ids = [...new Set((body?.ids ?? [url.searchParams.get("id")]).map(asPositiveInteger).filter((value): value is number => value !== null))];
      if (!ids.length) throw new Error("Выберите хотя бы одного сотрудника.");
      if (ids.length > 5_000) throw new Error("За один раз можно удалить не более 5000 сотрудников.");
      if (!await projectEntitiesAllowed(env.DB, authUser, "employee", ids, true)) return forbidden();
      return await env.DB.transaction(async db => {
        if (hasRestrictedProjectAccess(authUser)) {
          await db.prepare("SELECT id FROM employees WHERE id = ANY(?) AND active = 1 ORDER BY id FOR UPDATE").bind(ids).all();
          if (!await projectEntitiesAllowed(db, authUser, "employee", ids, true)) return forbidden();
        }
        const employeesResult = await db.prepare("SELECT id, full_name AS fullName FROM employees WHERE id = ANY(?) AND active = 1").bind(ids).all<{ id: number; fullName: string }>();
        const employees = employeesResult.results as Array<{ id: number; fullName: string }>;
        if (employees.length !== ids.length) {
          const existingIds = new Set(employees.map((employee) => employee.id));
          const missingCount = ids.filter((id) => !existingIds.has(id)).length;
          throw new Error(`${missingCount === 1 ? "Один сотрудник уже удалён" : `Сотрудники уже удалены (${missingCount})`}. Таблица обновлена — выберите строки заново.`);
        }
        const results = await db.batch([
          db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, DATE('now')) WHERE employee_id = ANY(?) AND active = 1").bind(ids),
          db.prepare(`UPDATE masters SET active = 0 WHERE active = 1 AND name IN (SELECT full_name FROM employees WHERE id = ANY(?))${hasRestrictedProjectAccess(authUser) ? " AND site_id = ANY(?::integer[])" : ""}`).bind(ids, ...(hasRestrictedProjectAccess(authUser) ? [accessibleProjectIds(authUser)] : [])),
          db.prepare("UPDATE employees SET active = 0, site_id = NULL WHERE id = ANY(?) AND active = 1").bind(ids),
        ]);
        return Response.json({ ok: true, count: results[2].meta.changes });
      });
    }
    const id = asPositiveInteger(url.searchParams.get("id"));
    if (!id) throw new Error("Не указана строка для удаления.");
    if (url.searchParams.get("entity") === "user") {
      if (id === authUser.id) throw new Error("Нельзя удалить собственную учётную запись.");
      return await env.DB.transaction(async db => {
        // Role replacement and deletion must protect the same last-admin count.
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind("user-role-management").first();
        const deletingUser = await db.prepare("SELECT role FROM app_users WHERE id = ? AND active = 1 FOR UPDATE").bind(id).first<{ role: string }>();
        if (!deletingUser) throw new Error("Пользователь не найден.");
        if (deletingUser.role === "superadmin" || deletingUser.role === "office") {
          const adminCount = await db.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role IN ('superadmin', 'office') AND active = 1").first<{ count: number }>();
          if (Number(adminCount?.count ?? 0) <= 1) throw new Error("Нельзя удалить последнего администратора.");
        }
        const results = await db.batch([
          db.prepare("UPDATE app_users SET active = 0 WHERE id = ? AND active = 1").bind(id),
          db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").bind(id),
          db.prepare("UPDATE user_invitations SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(id),
        ]);
        if (!results[0].meta.changes) throw new Error("Пользователь не найден.");
        return Response.json({ ok: true });
      });
    }
    if (url.searchParams.get("entity") === "employee-assignment") {
      const siteId = asPositiveInteger(url.searchParams.get("siteId"));
      if (!siteId) throw new Error("Не указан проект сотрудника.");
      if (!canAccessProject(authUser, siteId)) return forbidden();
      const result = await env.DB.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, DATE('now'))
        WHERE employee_id = ? AND site_id = ? AND active = 1
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND active = 1)`).bind(id, siteId, id).run();
      if (!result.meta.changes) throw new Error("Сотрудник не относится к проекту.");
      await env.DB.prepare(`UPDATE employees SET
        site_id = (SELECT MIN(site_id) FROM employee_project_assignments WHERE employee_id = ? AND active = 1),
        availability_status = CASE
          WHEN source = 'bitrix24' THEN availability_status
          WHEN EXISTS (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND active = 1) THEN 'on_site'
          ELSE 'unassigned'
        END
        WHERE id = ?`).bind(id, id, id).run();
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "site") {
      const [activeSites, employees, users, entries] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS count FROM sites WHERE active = 1"),
        env.DB.prepare("SELECT id FROM employee_project_assignments WHERE site_id = ? AND active = 1 LIMIT 1").bind(id),
        env.DB.prepare(`SELECT target.id FROM app_users target WHERE target.active = 1 AND (
          EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = target.id AND access.all_projects = 1)
          OR EXISTS (SELECT 1 FROM user_project_access access JOIN user_project_access_sites grant_site ON grant_site.user_id = access.user_id
            WHERE access.user_id = target.id AND access.all_projects = 0 AND grant_site.site_id = ?)
          OR (NOT EXISTS (SELECT 1 FROM user_project_access access WHERE access.user_id = target.id) AND target.assigned_site_id = ?)
        ) LIMIT 1`).bind(id, id),
        env.DB.prepare("SELECT id FROM placement_entries WHERE site_id = ? AND deleted_at IS NULL LIMIT 1").bind(id),
      ]);
      const count = Number((activeSites.results[0] as { count?: number } | undefined)?.count ?? 0);
      if (count <= 1) throw new Error("Нельзя удалить единственный активный проект.");
      if (employees.results.length || users.results.length || entries.results.length) throw new Error("Проект используется сотрудниками, пользователями или отчётами. Сначала перенесите связанные данные.");
      const result = await env.DB.prepare("UPDATE sites SET active = 0 WHERE id = ? AND active = 1").bind(id).run();
      if (!result.meta.changes) throw new Error("Проект не найден.");
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "position") {
      const position = await env.DB.prepare("SELECT employment_type AS employmentType, department, position FROM position_catalog WHERE id = ? AND active = 1").bind(id).first<{ employmentType: string; department: string; position: string }>();
      if (!position) throw new Error("Должность не найдена.");
      const usage = await env.DB.prepare("SELECT id FROM employees WHERE employment_type = ? AND department = ? AND position = ? AND active = 1 LIMIT 1").bind(position.employmentType, position.department, position.position).first();
      if (usage) throw new Error("Должность используется сотрудниками. Сначала измените их карточки.");
      const results = await env.DB.batch([
        env.DB.prepare("DELETE FROM position_catalog WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM personnel_options WHERE kind = 'position' AND name = ? AND NOT EXISTS (SELECT 1 FROM employees WHERE position = ? AND active = 1) AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE position = ? AND active = 1)").bind(position.position, position.position, position.position),
      ]);
      if (!results[0].meta.changes) throw new Error("Должность не найдена.");
      await reconcilePositionCatalogOptions();
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "directory") {
      const directory = directoryTable(url.searchParams.get("kind"));
      const siteId = asPositiveInteger(url.searchParams.get("siteId"));
      if (!directory || (!directory.global && !siteId)) throw new Error("Не указан справочник или объект.");
      if (!directory.global && !canAccessProject(authUser, siteId)) return forbidden();
      if (directory.key === "shift") throw new Error("Смены фиксированы для всех проектов: день и ночь.");
      let result;
      if (directory.global) {
        const option = await env.DB.prepare("SELECT name FROM personnel_options WHERE id = ? AND kind = ? AND active = 1").bind(id, directory.key).first<{ name: string }>();
        if (!option) throw new Error("Значение справочника не найдено.");
        const column = PERSONNEL_COLUMNS[directory.key as keyof typeof PERSONNEL_COLUMNS];
        const usage = await env.DB.prepare(`SELECT id FROM employees WHERE ${column} = ? AND active = 1 LIMIT 1`).bind(option.name).first();
        if (usage) throw new Error("Значение используется в карточках рабочих. Сначала измените данные этих рабочих.");
        result = await env.DB.prepare("UPDATE personnel_options SET active = 0 WHERE id = ? AND kind = ? AND active = 1").bind(id, directory.key).run();
      } else {
        result = await env.DB.transaction(async transaction => {
          const archived = await transaction.prepare(`UPDATE ${directory.table} SET active = 0 WHERE id = ? AND site_id = ? AND active = 1`).bind(id, siteId).run();
          if (directory.key === "mainWorkType" && archived.meta.changes) await transaction.prepare("UPDATE subwork_types SET active = 0 WHERE main_work_type_id = ? AND site_id = ? AND active = 1").bind(id, siteId).run();
          return archived;
        });
      }
      if (!result.meta.changes) throw new Error("Значение справочника не найдено.");
      return Response.json({ ok: true });
    }
    throw new Error("Неизвестный тип данных для удаления.");
  } catch (error) {
    return placementErrorResponse(error, "Не удалось удалить строку.");
  }
}
