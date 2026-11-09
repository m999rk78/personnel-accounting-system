import { assertSameOrigin, getAuthUser, createInvitation, sendInvitationEmail } from "../../auth";
import { scopedDataActionAllowed, projectEntitiesAllowed } from "../../projectScopedData";
import { ensureCustomRolesSchema } from "../../customRolesServer";
import { ensurePermissionSchema, resetUserPermissions } from "../../permissions";
import { requiresAssignedProject, hasRestrictedProjectAccess } from "../../roles";
import { saveUserProjectAccess } from "../../projectAccessServer";
import { saveSubworkDirectory } from "../../workTypeHierarchyServer";
import { unauthorized, forbidden, approvalRequired, placementErrorResponse } from "./responses";
import { ensureDatabaseInitialized } from "./bootstrap";
import { type EntryPayload, type UserPayload, type ReportFinalizationPayload, type ExistingPlacementEntry } from "./types";
import { asPositiveInteger, validDate } from "./validation";
import { canRunAction, canManagePlacement } from "./access";
import { env } from "./context";
import { resolveUserRole, validateEmployeeDirectoryValues, reconcilePositionCatalogOptions, directoryTable, PERSONNEL_COLUMNS } from "./catalogs";
import { existingPlacementEntriesStatement, assertPlacementOwnership, assertEntryRevisions, assertLinkedReportDates, lockPlacementHours, validateBulkPayloads, resolveResponsibleUsers, touchForemanContribution, finalizeGlobalReport, validatePayload } from "./placement";

export async function handlePATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await ensureDatabaseInitialized();
    const payload = (await request.json()) as EntryPayload & UserPayload & {
      entries?: EntryPayload[];
      newEntries?: EntryPayload[];
      submitOwnReport?: ReportFinalizationPayload;
      finalizeReport?: ReportFinalizationPayload;
    };
    const placementUpdates = Array.isArray(payload.entries) ? payload.entries : null;
    const placementCreates = Array.isArray(payload.newEntries) ? payload.newEntries : null;
    const ownSubmission = payload.submitOwnReport;
    const finalization = payload.finalizeReport;
    const ownSubmissionSiteId = ownSubmission ? asPositiveInteger(ownSubmission.siteId) : null;
    const ownSubmissionWorkDate = ownSubmission?.workDate;
    const finalizationSiteId = finalization ? asPositiveInteger(finalization.siteId) : null;
    const finalizationWorkDate = finalization?.workDate;
    if (payload.action && (!canRunAction(authUser, payload) || !scopedDataActionAllowed(authUser, payload))) return forbidden();
    if (!payload.action) {
      const placementRows = placementUpdates || placementCreates ? [] : ownSubmission || finalization ? [] : [payload];
      if ((placementUpdates ?? []).some((entry) => !canManagePlacement(authUser, asPositiveInteger(entry.siteId) ?? undefined, entry.workDate, "update"))) return forbidden();
      if ((placementCreates ?? []).some((entry) => !canManagePlacement(authUser, asPositiveInteger(entry.siteId) ?? undefined, entry.workDate, "create"))) return forbidden();
      if (placementRows.some((entry) => !canManagePlacement(authUser, asPositiveInteger(entry.siteId) ?? undefined, entry.workDate, "update"))) return forbidden();
      if (ownSubmission && (!ownSubmissionSiteId || !validDate(ownSubmissionWorkDate) || !canManagePlacement(authUser, ownSubmissionSiteId, ownSubmissionWorkDate, "update"))) return forbidden();
      if (finalization && (!finalizationSiteId || !validDate(finalizationWorkDate) || !canManagePlacement(authUser, finalizationSiteId, finalizationWorkDate, "update"))) return forbidden();
      // Publication always goes through the report workflow, irrespective of
      // the actor's role name. This endpoint only corrects existing history.
      if (placementCreates || ownSubmission || finalization) return approvalRequired();
    }
    if (payload.action === "update-user") {
      const userId = asPositiveInteger(payload.userId);
      const fullName = payload.fullName?.trim() ?? "";
      const email = payload.email?.trim().toLocaleLowerCase() ?? "";
      if (!userId || !fullName || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Заполните ФИО и корректный email.");
      const duplicate = await env.DB.prepare("SELECT id FROM app_users WHERE email = ? AND id <> ? AND active = 1").bind(email, userId).first();
      if (duplicate) throw new Error("Пользователь с таким email уже существует.");
      await ensureCustomRolesSchema();
      await ensurePermissionSchema();
      const currentUserRecord = await env.DB.transaction(async db => {
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind("user-role-management").first();
        const previous = await db.prepare("SELECT role, password_hash AS passwordHash, custom_role_id AS customRoleId FROM app_users WHERE id = ? AND active = 1 FOR UPDATE").bind(userId).first<{ role: string; passwordHash: string | null; customRoleId?: number | null }>();
        if (!previous) throw new Error("Пользователь не найден.");
        const { role, customRoleId } = await resolveUserRole(payload, db, previous);
        const assignedSiteId = requiresAssignedProject(role) ? asPositiveInteger(payload.assignedSiteId) : null;
        if (requiresAssignedProject(role) && !assignedSiteId && payload.projectAccess === undefined) throw new Error("Укажите доступ пользователя к проектам.");
        if (assignedSiteId && !await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(assignedSiteId).first()) throw new Error("Выбранный проект не найден или архивирован.");
        if ((previous.role === "superadmin" || previous.role === "office") && role !== "superadmin") {
          const adminCount = await db.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role IN ('superadmin', 'office') AND active = 1").first<{ count: number }>();
          if (Number(adminCount?.count ?? 0) <= 1) throw new Error("Нельзя убрать роль «Супер-админ» у последнего администратора.");
        }
        const result = await db.prepare("UPDATE app_users SET full_name = ?, email = ?, role = ?, assigned_site_id = ?, custom_role_id = ? WHERE id = ? AND active = 1").bind(fullName, email, role, assignedSiteId, customRoleId, userId).run();
        if (!result.meta.changes) throw new Error("Пользователь не найден.");
        const identityChanged = role !== previous.role || customRoleId !== (previous.customRoleId ?? null);
        if (identityChanged) await resetUserPermissions(userId, db);
        const closeProjectsByDefault = identityChanged && (role === "viewer" || Boolean(customRoleId));
        if (payload.projectAccess !== undefined || payload.canViewPendingReports !== undefined || closeProjectsByDefault) {
          await saveUserProjectAccess(userId, { projectAccess: payload.projectAccess ?? (closeProjectsByDefault ? { mode: "selected", siteIds: [] } : undefined), canViewPendingReports: payload.canViewPendingReports ?? (role === "viewer" && identityChanged ? false : undefined) }, authUser.id, db);
        }
        return previous;
      });
      if (!currentUserRecord?.passwordHash) {
        const invitationUrl = await createInvitation(userId, request);
        const delivery = await sendInvitationEmail({ to: email, fullName, invitationUrl, userId });
        return Response.json({ ok: true, invitationUrl, emailSent: delivery.sent });
      }
      return Response.json({ ok: true });
    }
    if (payload.action === "update-employee") {
      const employeeId = asPositiveInteger(payload.employeeId);
      const fullName = payload.fullName?.trim() ?? "";
      const employmentType = payload.employmentType?.trim() ?? "";
      const department = payload.department?.trim() ?? "";
      const position = payload.position?.trim() ?? "";
      const projectSiteId = asPositiveInteger(payload.projectSiteId);
      if (employeeId && !await projectEntitiesAllowed(env.DB, authUser, "employee", [employeeId], true)) return forbidden();
      if (!employeeId || !fullName || !employmentType || !department || !position) throw new Error("Заполните ФИО, тип, отдел и должность сотрудника.");
      return await env.DB.transaction(async db => {
        if (hasRestrictedProjectAccess(authUser)) {
          await db.prepare("SELECT id FROM employees WHERE id = ? AND active = 1 FOR UPDATE").bind(employeeId).first();
          if (!await projectEntitiesAllowed(db, authUser, "employee", [employeeId], true)) return forbidden();
        }
        await validateEmployeeDirectoryValues(employmentType, department, position, projectSiteId, db);
        const duplicate = await db.prepare("SELECT id FROM employees WHERE full_name = ? AND id <> ? AND active = 1").bind(fullName, employeeId).first();
        if (duplicate) throw new Error("Рабочий с таким ФИО уже существует.");
        const result = await db.prepare(`UPDATE employees SET full_name = ?, employment_type = ?, department = ?, position = ?, site_id = ?,
          availability_status = CASE WHEN source = 'bitrix24' THEN availability_status ELSE ? END
          WHERE id = ? AND active = 1`)
          .bind(fullName, employmentType, department, position, projectSiteId, projectSiteId ? "on_site" : "unassigned", employeeId).run();
        if (!result.meta.changes) throw new Error("Рабочий не найден.");
        if (projectSiteId) {
          await db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1 AND site_id <> ?")
            .bind(employeeId, projectSiteId).run();
          const activeAssignment = await db.prepare("SELECT id FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1").bind(employeeId, projectSiteId).first();
          if (!activeAssignment) {
            await db.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date) VALUES (?, ?, 'manual', CURRENT_DATE)")
              .bind(employeeId, projectSiteId).run();
          }
        } else {
          await db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1")
            .bind(employeeId).run();
        }
        return Response.json({ ok: true });
      });
    }
    if (payload.action === "update-position") {
      const positionId = asPositiveInteger(payload.positionId);
      const employmentType = payload.employmentType?.trim() ?? "";
      const department = payload.department?.trim() ?? "";
      const position = payload.position?.trim() ?? "";
      if (!positionId || !employmentType || !department || !position) throw new Error("Заполните тип, отдел и должность.");
      const current = await env.DB.prepare("SELECT employment_type AS employmentType, department, position FROM position_catalog WHERE id = ? AND active = 1").bind(positionId).first<{ employmentType: string; department: string; position: string }>();
      if (!current) throw new Error("Должность не найдена.");
      const duplicate = await env.DB.prepare("SELECT id FROM position_catalog WHERE employment_type = ? AND department = ? AND position = ? AND id <> ? AND active = 1").bind(employmentType, department, position, positionId).first();
      if (duplicate) throw new Error("Такая должность уже есть в списке.");
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE position_catalog SET employment_type = ?, department = ?, position = ? WHERE id = ? AND active = 1").bind(employmentType, department, position, positionId),
          env.DB.prepare("UPDATE employees SET employment_type = ?, department = ?, position = ? WHERE employment_type = ? AND department = ? AND position = ? AND active = 1").bind(employmentType, department, position, current.employmentType, current.department, current.position),
      ]);
      if (!results[0].meta.changes) throw new Error("Должность не найдена.");
      await reconcilePositionCatalogOptions();
      return Response.json({ ok: true });
    }
    if (payload.action === "update-site") {
      const siteId = asPositiveInteger(payload.siteId);
      const name = payload.name?.trim() ?? "";
      if (!siteId || !name) throw new Error("Заполните название объекта.");
      const duplicate = await env.DB.prepare("SELECT id FROM sites WHERE name = ? AND id <> ? AND active = 1").bind(name, siteId).first();
      if (duplicate) throw new Error("Объект с таким названием уже существует.");
      const result = await env.DB.prepare("UPDATE sites SET name = ?, timezone = 'Europe/Moscow' WHERE id = ? AND active = 1").bind(name, siteId).run();
      if (!result.meta.changes) throw new Error("Объект не найден.");
      return Response.json({ ok: true });
    }
    if (payload.action === "update-directory") {
      const directory = directoryTable(payload.entity);
      const directoryId = asPositiveInteger(payload.directoryId);
      const siteId = asPositiveInteger(payload.siteId);
      let name = payload.name?.trim() ?? "";
      if (!directory || !directoryId || !name || (!directory.global && !siteId)) throw new Error("Укажите справочник, объект и название значения.");
      if (directory.key === "shift") throw new Error("Смены фиксированы для всех проектов: день и ночь.");
      if (directory.key === "subworkType") {
        await saveSubworkDirectory(env.DB, siteId!, [{ directoryId, name, mainWorkTypeId: payload.mainWorkTypeId }]);
        return Response.json({ ok: true });
      }
      if (directory.key === "master") {
        const employeeId = asPositiveInteger(payload.employeeId);
        const employee = employeeId ? await env.DB.prepare(`SELECT e.full_name AS fullName FROM employees e
          JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
          WHERE e.id = ? AND e.active = 1`).bind(siteId, employeeId).first<{ fullName: string }>() : null;
        if (!employee) throw new Error("Выберите мастера из сотрудников текущего проекта.");
        name = employee.fullName;
      }
      const duplicate = directory.global
        ? await env.DB.prepare("SELECT id FROM personnel_options WHERE kind = ? AND name = ? AND id <> ? AND active = 1").bind(directory.key, name, directoryId).first()
        : await env.DB.prepare(`SELECT id FROM ${directory.table} WHERE site_id = ? AND name = ? AND id <> ? AND active = 1`).bind(siteId, name, directoryId).first();
      if (duplicate) throw new Error("Такое значение уже есть в выбранном справочнике.");
      let result;
      if (directory.global) {
        const current = await env.DB.prepare("SELECT name FROM personnel_options WHERE id = ? AND kind = ? AND active = 1").bind(directoryId, directory.key).first<{ name: string }>();
        if (!current) throw new Error("Значение справочника не найдено.");
        const column = PERSONNEL_COLUMNS[directory.key as keyof typeof PERSONNEL_COLUMNS];
        const updates = await env.DB.batch([
          env.DB.prepare("UPDATE personnel_options SET name = ? WHERE id = ? AND kind = ? AND active = 1").bind(name, directoryId, directory.key),
          env.DB.prepare(`UPDATE employees SET ${column} = ? WHERE ${column} = ? AND active = 1`).bind(name, current.name),
        ]);
        result = updates[0];
      } else {
        result = await env.DB.prepare(`UPDATE ${directory.table} SET name = ? WHERE id = ? AND site_id = ? AND active = 1`).bind(name, directoryId, siteId).run();
      }
      if (!result.meta.changes) throw new Error("Значение справочника не найдено.");
      return Response.json({ ok: true });
    }
    if (payload.action === "assign-site") {
      const userId = asPositiveInteger(payload.userId);
      const assignedSiteId = asPositiveInteger(payload.assignedSiteId);
      if (!userId || !assignedSiteId) throw new Error("Не указан пользователь или объект.");
      const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(assignedSiteId).first();
      if (!site) throw new Error("Объект не найден.");
      await env.DB.transaction(async db => {
        const result = await db.prepare("UPDATE app_users SET assigned_site_id = ? WHERE id = ? AND active = 1").bind(assignedSiteId, userId).run();
        if (!result.meta.changes) throw new Error("Пользователь не найден.");
        await saveUserProjectAccess(userId, { projectAccess: { mode: "selected", siteIds: [assignedSiteId] } }, authUser.id, db);
      });
      return Response.json({ ok: true });
    }
    if (payload.action) return Response.json({ error: "Это действие недоступно для данного запроса." }, { status: 400 });
    if (placementCreates || ownSubmission || finalization) {
      const updates = placementUpdates ?? [];
      const creates = placementCreates ?? [];
      if (!updates.length && !creates.length && !ownSubmission && !finalization) throw new Error("Нет строк для сохранения.");
      if (updates.length + creates.length > 1000) throw new Error("За один раз можно сохранить не более 1000 строк.");
      const ids = updates.map((entry) => asPositiveInteger(entry.id));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Некорректный список строк для изменения.");
      const entryIds = ids as number[];
      const payloadRows = [...updates, ...creates];
      if (finalization && payloadRows.some((entry) => asPositiveInteger(entry.siteId) !== finalizationSiteId || entry.workDate !== finalizationWorkDate)) {
        throw new Error("Сохраняемые строки и подтверждение отчёта относятся к разным объектам или датам.");
      }
      if (ownSubmission && payloadRows.some((entry) => asPositiveInteger(entry.siteId) !== ownSubmissionSiteId || entry.workDate !== ownSubmissionWorkDate)) {
        throw new Error("Сохраняемые строки и сдача части отчёта относятся к разным объектам или датам.");
      }
      const result = await env.DB.transaction(async (db) => {
        const existingResult = entryIds.length
          ? await existingPlacementEntriesStatement(db, entryIds, true).all<ExistingPlacementEntry>()
          : { results: [] as ExistingPlacementEntry[] };
        if (existingResult.results.length !== entryIds.length) throw new Error("Одна или несколько строк не найдены.");
        assertPlacementOwnership(authUser, existingResult.results);
        assertEntryRevisions(updates, existingResult.results);
        await assertLinkedReportDates(db, updates, existingResult.results);
        await lockPlacementHours(db, payloadRows, existingResult.results);
        const rows = payloadRows.length ? await validateBulkPayloads(db, payloadRows, existingResult.results) : [];
        const responsibleUsers = await resolveResponsibleUsers(db, authUser, payloadRows, existingResult.results);
        const updateRows = rows.slice(0, updates.length);
        const createRows = rows.slice(updates.length);
        let updatedCount = 0;
        for (let offset = 0; offset < updateRows.length; offset += 100) {
          const results = await db.batch(updateRows.slice(offset, offset + 100).map((data, index) => db.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
            main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?,
            employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?,
            responsible_user_id = ?, updated_by_user_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted_at IS NULL RETURNING id, revision`)
            .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
              data.employeeName, data.employmentType, data.department, data.masterName, responsibleUsers[offset + index], authUser.id, entryIds[offset + index])));
          updatedCount += results.reduce((sum, updateResult) => sum + Number(updateResult.meta.changes ?? 0), 0);
        }
        for (let offset = 0; offset < createRows.length; offset += 100) {
          await db.batch(createRows.slice(offset, offset + 100).map((data, index) => db.prepare(`INSERT INTO placement_entries
            (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot,
             employee_name_snapshot, employment_type_snapshot, department_snapshot, master_name_snapshot, created_by,
             responsible_user_id, created_by_user_id, updated_by_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
            .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
              data.employeeName, data.employmentType, data.department, data.masterName, authUser.fullName,
              responsibleUsers[updates.length + offset + index], authUser.id, authUser.id)));
        }
        let contribution = null;
        if (authUser.role === "foreman") {
          const contributionSiteId = ownSubmissionSiteId ?? rows[0]?.siteId;
          const contributionWorkDate = ownSubmissionWorkDate ?? rows[0]?.workDate;
          if (!contributionSiteId || !contributionWorkDate) throw new Error("Не указан объект или день части отчёта.");
          contribution = await touchForemanContribution(
            db,
            authUser,
            contributionSiteId,
            contributionWorkDate,
            Boolean(ownSubmission),
            asPositiveInteger(ownSubmission?.revision) ?? undefined,
          );
        }
        if (finalization && finalizationSiteId && finalizationWorkDate) {
          await finalizeGlobalReport(db, authUser, finalizationSiteId, finalizationWorkDate);
        }
        return {
          ok: true,
          updatedCount,
          createdCount: createRows.length,
          reportSubmitted: authUser.role === "foreman" ? contribution?.status === "submitted" : Boolean(finalization),
          contribution,
        };
      });
      return Response.json(result);
    }
    if (placementUpdates) {
      if (!placementUpdates.length) throw new Error("Нет строк для изменения.");
      if (placementUpdates.length > 1000) throw new Error("За один раз можно изменить не более 1000 строк.");
      const ids = placementUpdates.map((entry) => asPositiveInteger(entry.id));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Некорректный список строк для изменения.");
      const entryIds = ids as number[];
      const result = await env.DB.transaction(async (db) => {
        const existing = await existingPlacementEntriesStatement(db, entryIds, true).all<ExistingPlacementEntry>();
        if (existing.results.length !== entryIds.length) throw new Error("Одна или несколько строк не найдены.");
        assertPlacementOwnership(authUser, existing.results);
        assertEntryRevisions(placementUpdates, existing.results);
        await assertLinkedReportDates(db, placementUpdates, existing.results);
        await lockPlacementHours(db, placementUpdates, existing.results);
        const rows = await validateBulkPayloads(db, placementUpdates, existing.results);
        const responsibleUsers = await resolveResponsibleUsers(db, authUser, placementUpdates, existing.results);
        let changed = 0;
        for (let offset = 0; offset < rows.length; offset += 100) {
          const results = await db.batch(rows.slice(offset, offset + 100).map((data, index) => db.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
            main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?,
            employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?,
            responsible_user_id = ?, updated_by_user_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND deleted_at IS NULL RETURNING id, revision`)
            .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
              data.employeeName, data.employmentType, data.department, data.masterName, responsibleUsers[offset + index], authUser.id, entryIds[offset + index])));
          changed += results.reduce((sum, updateResult) => sum + Number(updateResult.meta.changes ?? 0), 0);
        }
        return { ok: true, count: changed, contribution: null };
      });
      return Response.json(result);
    }
    const id = asPositiveInteger(payload.id);
    if (!id) throw new Error("Не указана строка для изменения.");
    const result = await env.DB.transaction(async (db) => {
      const existingResult = await existingPlacementEntriesStatement(db, [id], true).all<ExistingPlacementEntry>();
      const existing = existingResult.results[0];
      if (!existing) throw new Error("Строка не найдена.");
      assertPlacementOwnership(authUser, [existing]);
      assertEntryRevisions([payload], [existing]);
      await assertLinkedReportDates(db, [payload], [existing]);
      await lockPlacementHours(db, [payload], [existing]);
      const data = await validatePayload(db, payload, id);
      const [responsibleUserId] = await resolveResponsibleUsers(db, authUser, [payload], [existing]);
      const update = await db.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
        main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?,
        employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?,
        responsible_user_id = ?, updated_by_user_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND deleted_at IS NULL RETURNING id, revision`)
        .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
          data.employeeName, data.employmentType, data.department, data.masterName, responsibleUserId, authUser.id, id)
        .first<{ id: number; revision: number }>();
      return { ok: true, revision: update?.revision, contribution: null };
    });
    return Response.json(result);
  } catch (error) {
    return placementErrorResponse(error, "Не удалось изменить строку.");
  }
}
