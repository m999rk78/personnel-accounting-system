import { assertSameOrigin, getAuthUser, createInvitation, sendInvitationEmail } from "../../auth";
import { scopedDataActionAllowed, projectEntitiesAllowed } from "../../projectScopedData";
import { fetchBitrixEmployeeSnapshot } from "../../bitrix24Sync";
import { ensureCustomRolesSchema } from "../../customRolesServer";
import { requiresAssignedProject } from "../../roles";
import { saveUserProjectAccess } from "../../projectAccessServer";
import { importProjectEmployeesExcel, importProjectDirectoryExcel, normalizeExcelDirectoryName, prepareEmployeeExcelImport } from "../../excelDirectoryImports";
import { hasPermission } from "../../permissionModel";
import { rememberPersonnelImportOrder } from "../../personnelImportOrderServer";
import { currentEmployeeDirectoryFilter } from "../../employeeDirectoryEligibility";
import { saveSubworkDirectory } from "../../workTypeHierarchyServer";
import { unauthorized, forbidden, approvalRequired, PlacementRequestError, placementErrorResponse } from "./responses";
import { ensureDatabaseInitialized } from "./bootstrap";
import { type EntryPayload, type UserPayload } from "./types";
import { canRunAction, canManagePlacement } from "./access";
import { asPositiveInteger } from "./validation";
import { reserveBitrix24Action, Bitrix24CooldownError } from "./bitrixCooldown";
import { synchronizeBitrixEmployees } from "./bitrixSync";
import { buildBitrixInspection, linkBitrixEmployees, createBitrixEmployee, updateBitrixEmployee, updateSelectedBitrixEmployees, deleteBitrixEmployee } from "./bitrixReview";
import { env } from "./context";
import { resolveUserRole, validateEmployeeDirectoryValues, reconcilePositionCatalogOptions, directoryTable } from "./catalogs";

export async function handlePOST(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await ensureDatabaseInitialized();
    const payload = (await request.json()) as EntryPayload & UserPayload & { entries?: EntryPayload[] };
    if (payload.action && (!canRunAction(authUser, payload) || !scopedDataActionAllowed(authUser, payload))) return forbidden();
    if (!payload.action) {
      const placementRows = payload.entries?.length ? payload.entries : [payload];
      if (placementRows.some((row) => !canManagePlacement(authUser, asPositiveInteger(row.siteId) ?? undefined, row.workDate, "create"))) return forbidden();
      return approvalRequired();
    }
    if (payload.action === "sync-bitrix24") {
      const cooldown = await reserveBitrix24Action(payload.action);
      return Response.json({ ...await synchronizeBitrixEmployees(), cooldown });
    }
    if (payload.action === "inspect-bitrix24") {
      const cooldown = await reserveBitrix24Action(payload.action);
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      const inspection = await buildBitrixInspection(sourceSnapshot, { observeArchivedStatuses: true });
      return Response.json({ ...inspection.response, cooldown });
    }
    if (payload.action === "link-bitrix24-employees") {
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      return Response.json(await linkBitrixEmployees(sourceSnapshot, payload.links, {
        allowArchivedLink: payload.allowArchivedLink === true,
        archiveLinkRevision: payload.archiveLinkRevision,
        autoLinkBitrixIds: payload.autoLinkBitrixIds,
        archiveTransferLinks: payload.archiveTransferLinks,
      }));
    }
    if (payload.action === "create-bitrix24-employee") {
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      return Response.json(await createBitrixEmployee(sourceSnapshot, payload), { status: 201 });
    }
    if (payload.action === "update-bitrix24-employee") {
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      return Response.json(await updateBitrixEmployee(sourceSnapshot, payload, {
        mayArchiveLegacy: hasPermission(authUser.permissions, "employees", "delete"),
      }));
    }
    if (payload.action === "update-selected-bitrix24-employees") {
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      return Response.json(await updateSelectedBitrixEmployees(sourceSnapshot, payload, {
        mayArchiveDismissed: hasPermission(authUser.permissions, "employees", "delete"),
      }));
    }
    if (payload.action === "delete-bitrix24-employee") {
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      return Response.json(await deleteBitrixEmployee(sourceSnapshot, payload));
    }
    if (payload.action === "acknowledge-bitrix24-difference") {
      const employeeId = asPositiveInteger(payload.employeeId);
      if (!employeeId) throw new Error("Сотрудник не указан.");
      const expected = payload.warningFingerprints === undefined ? null : payload.warningFingerprints?.[employeeId];
      if (payload.warningFingerprints !== undefined && typeof expected !== "string") throw new Error("Выполните проверку ещё раз: предупреждение изменилось.");
      const result = await env.DB.prepare(`UPDATE bitrix24_employee_check_states SET acknowledged_at = CURRENT_TIMESTAMP,
        acknowledged_by_user_id = ? WHERE employee_id = ? AND status <> 'blacklisted_in_bitrix'
          AND fingerprint NOT LIKE 'office_transfer:%'
          AND EXISTS (SELECT 1 FROM employees e WHERE e.id = bitrix24_employee_check_states.employee_id AND e.active = 1)
          AND (CAST(? AS text) IS NULL OR fingerprint = ?)`).bind(authUser.id, employeeId, expected, expected).run();
      if (!result.meta.changes) throw new Error("Предупреждение уже неактуально. Выполните проверку ещё раз.");
      return Response.json({ ok: true, employeeId });
    }
    if (payload.action === "acknowledge-selected-bitrix24-differences") {
      const employeeIds = [...new Set((Array.isArray(payload.employeeIds) ? payload.employeeIds : [])
        .map(asPositiveInteger).filter((id): id is number => Boolean(id)))];
      if (!employeeIds.length) throw new Error("Не выбраны сотрудники для подтверждения предупреждений.");
      if (employeeIds.length > 200) throw new Error("За один раз можно подтвердить не более 200 предупреждений.");
      const expected = payload.warningFingerprints === undefined ? null : JSON.stringify(Object.fromEntries(employeeIds.flatMap(id => {
        const fingerprint = payload.warningFingerprints?.[id];
        return typeof fingerprint === "string" ? [[id, fingerprint]] : [];
      })));
      const acknowledged = await env.DB.prepare(`UPDATE bitrix24_employee_check_states
        SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_user_id = ?
        WHERE employee_id = ANY(?) AND acknowledged_at IS NULL AND status <> 'blacklisted_in_bitrix'
          AND fingerprint NOT LIKE 'office_transfer:%'
          AND EXISTS (SELECT 1 FROM employees e WHERE e.id = bitrix24_employee_check_states.employee_id AND e.active = 1)
          AND (CAST(? AS jsonb) IS NULL OR fingerprint = (CAST(? AS jsonb) ->> CAST(employee_id AS text)))
        RETURNING employee_id AS "employeeId"`).bind(authUser.id, employeeIds, expected, expected).all<{ employeeId: number }>();
      if (!acknowledged.results.length) throw new Error("Выбранные предупреждения уже неактуальны или уже подтверждены.");
      return Response.json({ ok: true, acknowledgedCount: acknowledged.results.length, employeeIds: acknowledged.results.map((row) => row.employeeId) });
    }
    if (payload.action === "create-user") {
      const fullName = payload.fullName?.trim() ?? "";
      const email = payload.email?.trim().toLocaleLowerCase() ?? "";
      await ensureCustomRolesSchema();
      const { role, customRoleId } = await resolveUserRole(payload, env.DB);
      const assignedSiteId = role && requiresAssignedProject(role) ? asPositiveInteger(payload.assignedSiteId) : null;
      if (!fullName || !/^\S+@\S+\.\S+$/.test(email) || !role || (role && requiresAssignedProject(role) && !assignedSiteId && payload.projectAccess === undefined)) throw new Error("Заполните ФИО, корректный email, роль и доступ к проектам.");
      if (customRoleId && payload.projectAccess === undefined) throw new Error("Укажите доступ пользователя к проектам.");
      if (assignedSiteId && !await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(assignedSiteId).first()) throw new Error("Выбранный проект не найден или архивирован.");
      const duplicate = await env.DB.prepare("SELECT id FROM app_users WHERE email = ? AND active = 1").bind(email).first();
      if (duplicate) throw new Error("Пользователь с таким email уже существует.");
      const userId = await env.DB.transaction(async db => {
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind("user-role-management").first();
        const freshRole = await resolveUserRole(payload, db);
        if (freshRole.role !== role || freshRole.customRoleId !== customRoleId) throw new Error("Роль изменилась. Обновите список ролей.");
        const result = await db.prepare("INSERT INTO app_users (full_name, email, role, assigned_site_id, custom_role_id) VALUES (?, ?, ?, ?, ?)").bind(fullName, email, role, assignedSiteId, customRoleId).run();
        const id = Number(result.meta.last_row_id);
        if (payload.projectAccess !== undefined || payload.canViewPendingReports !== undefined || role === "viewer" || customRoleId) {
          await saveUserProjectAccess(id, { projectAccess: payload.projectAccess, canViewPendingReports: payload.canViewPendingReports }, authUser.id, db);
        }
        return id;
      });
      const invitationUrl = await createInvitation(userId, request);
      const delivery = await sendInvitationEmail({ to: email, fullName, invitationUrl, userId });
      return Response.json({ id: userId, invitationUrl, emailSent: delivery.sent }, { status: 201 });
    }
    if (payload.action === "create-employee") {
      const fullName = payload.fullName?.trim() ?? "";
      const employmentType = payload.employmentType?.trim() ?? "";
      const department = payload.department?.trim() ?? "";
      const position = payload.position?.trim() ?? "";
      const projectSiteId = asPositiveInteger(payload.projectSiteId);
      if (!fullName || !employmentType || !department || !position) throw new Error("Заполните ФИО, тип, отдел и должность сотрудника.");
      await validateEmployeeDirectoryValues(employmentType, department, position, projectSiteId);
      const duplicate = await env.DB.prepare("SELECT id FROM employees WHERE full_name = ? AND active = 1").bind(fullName).first();
      if (duplicate) throw new Error("Рабочий с таким ФИО уже существует.");
      const result = await env.DB.prepare("INSERT INTO employees (full_name, employment_type, department, position, source, site_id, availability_status, sort_order) VALUES (?, ?, ?, ?, 'manual', ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM employees))")
        .bind(fullName, employmentType, department, position, projectSiteId, projectSiteId ? "on_site" : "unassigned").run();
      if (projectSiteId) {
        await env.DB.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date) VALUES (?, ?, 'manual', CURRENT_DATE)")
          .bind(Number(result.meta.last_row_id), projectSiteId).run();
      }
      return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (payload.action === "reorder-employees") {
      const rawIds = Array.isArray(payload.employeeIds) ? payload.employeeIds : [];
      const employeeIds = rawIds.map(asPositiveInteger);
      if (!employeeIds.length) throw new Error("Передайте новый порядок сотрудников.");
      if (employeeIds.length > 5000) throw new Error("За один раз можно упорядочить не более 5000 сотрудников.");
      if (employeeIds.some((id) => !id) || new Set(employeeIds).size !== employeeIds.length) throw new Error("Список порядка содержит некорректные или повторяющиеся строки.");
      const orderedIds = employeeIds as number[];
      await env.DB.transaction(async (db) => {
        const activeEmployees = await db.prepare(`SELECT id FROM employees WHERE ${currentEmployeeDirectoryFilter("employees")}`).all<{ id: number }>();
        const activeIds = new Set(activeEmployees.results.map((employee) => employee.id));
        if (activeIds.size !== orderedIds.length || orderedIds.some((id) => !activeIds.has(id))) {
          throw new Error("Список сотрудников изменился. Обновите таблицу и повторите перенос строки.");
        }
        const updates = orderedIds.map((employeeId, index) => db.prepare(`UPDATE employees SET sort_order = ? WHERE id = ? AND ${currentEmployeeDirectoryFilter("employees")}`).bind(index + 1, employeeId));
        for (let offset = 0; offset < updates.length; offset += 100) await db.batch(updates.slice(offset, offset + 100));
      });
      return Response.json({ ok: true, count: orderedIds.length });
    }
    if (payload.action === "assign-employee-project") {
      const employeeId = asPositiveInteger(payload.employeeId);
      const siteId = asPositiveInteger(payload.siteId);
      if (!employeeId || !siteId) throw new Error("Выберите сотрудника и проект.");
      return await env.DB.transaction(async db => {
        const employee = await db.prepare(`SELECT id FROM employees WHERE id = ? AND ${currentEmployeeDirectoryFilter("employees")} FOR UPDATE`).bind(employeeId).first();
        if (!employee || !await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first()) throw new Error("Сотрудник или проект не найден.");
        if (!await projectEntitiesAllowed(db, authUser, "employee", [employeeId], false, true)) return forbidden();
        const active = await db.prepare("SELECT id FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1").bind(employeeId, siteId).first();
        if (active) throw new Error("Сотрудник уже добавлен в этот проект.");
        await db.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date) VALUES (?, ?, 'manual', CURRENT_DATE)").bind(employeeId, siteId).run();
        await db.prepare(`UPDATE employees SET site_id = COALESCE(site_id, ?),
          availability_status = CASE WHEN source = 'bitrix24' THEN availability_status ELSE 'on_site' END
          WHERE id = ?`).bind(siteId, employeeId).run();
        return Response.json({ ok: true }, { status: 201 });
      });
    }
    if (payload.action === "create-position") {
      const employmentType = payload.employmentType?.trim() ?? "";
      const department = payload.department?.trim() ?? "";
      const position = payload.position?.trim() ?? "";
      if (!employmentType || !department || !position) throw new Error("Заполните тип, отдел и должность.");
      const result = await env.DB.prepare("INSERT OR IGNORE INTO position_catalog (employment_type, department, position) VALUES (?, ?, ?)").bind(employmentType, department, position).run();
      if (!result.meta.changes) throw new Error("Такая должность уже есть в списке.");
      await reconcilePositionCatalogOptions();
      return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (payload.action === "import-project-employees") {
      if (!await projectEntitiesAllowed(env.DB, authUser, "employee", (payload.employeeIds ?? []).map(Number), false, true)) return forbidden();
      const result = await importProjectEmployeesExcel(env.DB, Number(payload.siteId), payload.employeeIds, async (db, employeeIds) => {
        if (!await projectEntitiesAllowed(db, authUser, "employee", employeeIds, false, true)) throw new PlacementRequestError("Нет доступа к сотрудникам другого проекта.", 403, "PROJECT_MEMBERSHIP_FORBIDDEN");
      });
      return Response.json(result, { status: 201 });
    }
    if (payload.action === "import-project-directory") {
      if (payload.employeeIds?.length && !await projectEntitiesAllowed(env.DB, authUser, "employee", payload.employeeIds.map(Number))) return forbidden();
      const result = await importProjectDirectoryExcel(env.DB, Number(payload.siteId), payload.entity, { names: payload.names, employeeIds: payload.employeeIds });
      return Response.json(result, { status: 201 });
    }
    if (payload.action === "import-positions") {
      const rows = payload.positions;
      if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error("В файле должно быть от 1 до 2000 должностей.");
      const prepared = rows.map((row, index) => {
        const employmentType = typeof row?.employmentType === "string" ? row.employmentType.trim() : "";
        const department = typeof row?.department === "string" ? row.department.trim() : "";
        const position = typeof row?.position === "string" ? row.position.trim() : "";
        if (!employmentType || !department || !position) throw new Error(`Строка ${index + 1}: заполните тип, отдел и должность.`);
        return { employmentType, department, position };
      });
      const result = await env.DB.transaction(async db => {
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext('personnel-position-import'))").first();
        const existing = await db.prepare("SELECT employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1 FOR UPDATE").all<{ employmentType: string; department: string; position: string }>();
        const key = (row: { employmentType: string; department: string; position: string }) => [row.employmentType, row.department, row.position].map(normalizeExcelDirectoryName).join("\u0000");
        const occupied = new Set(existing.results.map(key));
        let count = 0;
        for (const row of prepared) {
          const rowKey = key(row);
          if (occupied.has(rowKey)) continue;
          const inserted = await db.prepare("INSERT INTO position_catalog (employment_type, department, position) VALUES (?, ?, ?)").bind(row.employmentType, row.department, row.position).run();
          count += inserted.meta.changes;
          occupied.add(rowKey);
        }
        await reconcilePositionCatalogOptions(db);
        return { count, skipped: rows.length - count };
      });
      return Response.json(result, { status: 201 });
    }
    if (payload.action === "import-employees") {
      const result = await env.DB.transaction(async db => {
        await db.prepare("SELECT pg_advisory_xact_lock(hashtext('personnel-employee-excel-import'))").first();
        const sites = await db.prepare("SELECT id, code, name FROM sites WHERE active = 1 ORDER BY id FOR SHARE").all<{ id: number; code: string; name: string }>();
        const employees = await db.prepare("SELECT id, full_name AS fullName FROM employees WHERE active = 1 ORDER BY id FOR UPDATE").all<{ id: number; fullName: string }>();
        const rows = prepareEmployeeExcelImport(payload.employees, sites.results, employees.results);
        if (rows.some(row => row.existingId) && !hasPermission(authUser.permissions, "employees", "update")) {
          throw new PlacementRequestError("Файл содержит сотрудников, которые уже есть в справочнике. Для обновления таких строк нужно право редактирования.", 403, "IMPORT_UPDATE_FORBIDDEN");
        }
        if (rows.some(row => !row.existingId) && !hasPermission(authUser.permissions, "employees", "create")) {
          throw new PlacementRequestError("Файл содержит новых сотрудников. Для их импорта нужно право добавления.", 403, "IMPORT_CREATE_FORBIDDEN");
        }
        // Resolve every name, project and permission before the first write.
        // Keep profile changes and all project assignments in this same transaction.
        const importedEmployeeIds: number[] = [];
        const importedProjectEmployees = new Map<number, number[]>();
        for (const row of rows) {
          let employeeId = row.existingId;
          if (employeeId) {
            const updated = await db.prepare(`UPDATE employees SET employment_type = ?, department = ?, position = ?, site_id = ?,
              availability_status = CASE WHEN source = 'bitrix24' THEN availability_status ELSE ? END
              WHERE id = ? AND ${currentEmployeeDirectoryFilter("employees")}`).bind(row.employmentType, row.department, row.position, row.siteIds[0] ?? null, row.siteIds.length ? "on_site" : "unassigned", employeeId).run();
            if (updated.meta.changes !== 1) throw new Error(`Не удалось обновить сотрудника «${row.fullName}». Изменения импорта отменены.`);
          } else {
            const inserted = await db.prepare("INSERT INTO employees (full_name, employment_type, department, position, source, site_id, availability_status, sort_order) VALUES (?, ?, ?, ?, 'excel', ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM employees))")
              .bind(row.fullName, row.employmentType, row.department, row.position, row.siteIds[0] ?? null, row.siteIds.length ? "on_site" : "unassigned").run();
            employeeId = Number(inserted.meta.last_row_id);
            if (!Number.isSafeInteger(employeeId) || employeeId <= 0) throw new Error(`Не удалось добавить сотрудника «${row.fullName}». Изменения импорта отменены.`);
          }
          importedEmployeeIds.push(employeeId);
          for (const siteId of row.siteIds) {
            const employeeIds = importedProjectEmployees.get(siteId) ?? [];
            employeeIds.push(employeeId);
            importedProjectEmployees.set(siteId, employeeIds);
          }
          if (!row.siteIds.length) {
            await db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1").bind(employeeId).run();
            continue;
          }
          await db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, CURRENT_DATE) WHERE employee_id = ? AND active = 1 AND site_id <> ALL(?::integer[])").bind(employeeId, row.siteIds).run();
          for (const siteId of row.siteIds) {
            await db.prepare("UPDATE employee_project_assignments SET source = 'excel', end_date = NULL WHERE employee_id = ? AND site_id = ? AND active = 1").bind(employeeId, siteId).run();
            await db.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date) SELECT ?, ?, 'excel', CURRENT_DATE WHERE NOT EXISTS (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1)").bind(employeeId, siteId, employeeId, siteId).run();
          }
        }
        await rememberPersonnelImportOrder(db, "employees", null, importedEmployeeIds);
        for (const [siteId, employeeIds] of importedProjectEmployees) await rememberPersonnelImportOrder(db, "project-personnel", siteId, employeeIds);
        return { count: rows.length, unassigned: rows.filter(row => row.siteIds.length === 0).length };
      });
      return Response.json(result, { status: 201 });
    }
    if (payload.action === "create-site") {
      const name = payload.name?.trim() ?? "";
      if (!name) throw new Error("Заполните название объекта.");
      const duplicate = await env.DB.prepare("SELECT id FROM sites WHERE name = ? AND active = 1").bind(name).first();
      if (duplicate) throw new Error("Объект с таким названием уже существует.");
      const code = `SITE-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toLocaleUpperCase()}`;
      const result = await env.DB.prepare("INSERT INTO sites (name, code, timezone) VALUES (?, ?, 'Europe/Moscow')").bind(name, code).run();
      const newSiteId = Number(result.meta.last_row_id);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO shifts (site_id, name) VALUES (?, 'день')").bind(newSiteId),
        env.DB.prepare("INSERT INTO shifts (site_id, name) VALUES (?, 'ночь')").bind(newSiteId),
      ]);
      return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (payload.action === "save-directory-items") {
      const directory = directoryTable(payload.entity);
      const siteId = asPositiveInteger(payload.siteId);
      const rows = payload.directories ?? [];
      if (!directory || directory.global || directory.key === "shift" || !siteId) throw new Error("Укажите проект и доступный справочник.");
      if (!rows.length || rows.length > 500) throw new Error("Подготовьте от 1 до 500 строк справочника.");
      const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first();
      if (!site) throw new Error("Выбранный проект не найден или уже закрыт.");
      if (directory.key === "subworkType") {
        const ids = await saveSubworkDirectory(env.DB, siteId, rows);
        return Response.json({ count: ids.length }, { status: 201 });
      }
      const existing = await env.DB.prepare(`SELECT id, name FROM ${directory.table} WHERE site_id = ? AND active = 1`).bind(siteId).all<{ id: number; name: string }>();
      const existingById = new Map(existing.results.map((item) => [item.id, item]));
      const editedIds = rows.map((row) => asPositiveInteger(row.directoryId)).filter((id): id is number => Boolean(id));
      if (new Set(editedIds).size !== editedIds.length) throw new Error("Одна строка справочника добавлена в редактирование несколько раз.");
      const employeeById = new Map<number, string>();
      if (directory.key === "master") {
        const employees = await env.DB.prepare(`SELECT e.id, e.full_name AS fullName FROM employees e
          JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
          WHERE ${currentEmployeeDirectoryFilter("e")}`).bind(siteId).all<{ id: number; fullName: string }>();
        employees.results.forEach((employee) => employeeById.set(employee.id, employee.fullName));
      }
      const normalizeName = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
      const occupiedNames = new Set(existing.results.filter((item) => !editedIds.includes(item.id)).map((item) => normalizeName(item.name)));
      const prepared = rows.map((row, index) => {
        const directoryId = asPositiveInteger(row.directoryId);
        if (directoryId && !existingById.has(directoryId)) throw new Error(`Строка ${index + 1}: значение справочника не найдено.`);
        const employeeId = asPositiveInteger(row.employeeId);
        const name = directory.key === "master" ? employeeById.get(employeeId ?? 0) ?? "" : row.name?.trim() ?? "";
        if (!name) throw new Error(`Строка ${index + 1}: ${directory.key === "master" ? "выберите мастера из сотрудников текущего проекта" : "заполните название"}.`);
        const normalizedName = normalizeName(name);
        if (occupiedNames.has(normalizedName)) throw new Error(`Строка ${index + 1}: значение «${name}» уже есть в справочнике.`);
        occupiedNames.add(normalizedName);
        return { directoryId, name };
      });
      const statements = prepared.map((row) => row.directoryId
        ? env.DB.prepare(`UPDATE ${directory.table} SET name = ? WHERE id = ? AND site_id = ? AND active = 1`).bind(row.name, row.directoryId, siteId)
        : env.DB.prepare(`INSERT INTO ${directory.table} (site_id, name) VALUES (?, ?)`).bind(siteId, row.name));
      const results = await env.DB.batch(statements);
      if (results.some((result) => !result.meta.changes)) throw new Error("Не удалось сохранить одну из строк справочника.");
      return Response.json({ count: prepared.length }, { status: 201 });
    }
    if (payload.action === "create-directory") {
      const directory = directoryTable(payload.entity);
      const siteId = asPositiveInteger(payload.siteId);
      let name = payload.name?.trim() ?? "";
      if (!directory || !name || (!directory.global && !siteId)) throw new Error("Укажите справочник, объект и название значения.");
      if (directory.key === "shift") throw new Error("Смены фиксированы для всех проектов: день и ночь.");
      if (directory.key === "subworkType") {
        const ids = await saveSubworkDirectory(env.DB, siteId!, [{ name, mainWorkTypeId: payload.mainWorkTypeId }]);
        return Response.json({ id: ids[0] }, { status: 201 });
      }
      if (directory.key === "master") {
        const employeeId = asPositiveInteger(payload.employeeId);
        const employee = employeeId ? await env.DB.prepare(`SELECT e.full_name AS fullName FROM employees e
          JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
          WHERE e.id = ? AND ${currentEmployeeDirectoryFilter("e")}`).bind(siteId, employeeId).first<{ fullName: string }>() : null;
        if (!employee) throw new Error("Выберите мастера из сотрудников текущего проекта.");
        name = employee.fullName;
      }
      const duplicate = directory.global
        ? await env.DB.prepare("SELECT id FROM personnel_options WHERE kind = ? AND name = ? AND active = 1").bind(directory.key, name).first()
        : await env.DB.prepare(`SELECT id FROM ${directory.table} WHERE site_id = ? AND name = ? AND active = 1`).bind(siteId, name).first();
      if (duplicate) throw new Error("Такое значение уже есть в выбранном справочнике.");
      const result = directory.global
        ? await env.DB.prepare("INSERT INTO personnel_options (kind, name) VALUES (?, ?)").bind(directory.key, name).run()
        : await env.DB.prepare(`INSERT INTO ${directory.table} (site_id, name) VALUES (?, ?)`).bind(siteId, name).run();
      return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    // Directory actions above return explicitly. No POST fallback may publish
    // personnel hours, including a stale/misrouted action from an older client.
    return approvalRequired();
  } catch (error) {
    if (error instanceof Bitrix24CooldownError) {
      return Response.json({ error: error.message, cooldown: error.cooldown }, {
        status: 429,
        headers: { "Retry-After": String(error.cooldown.remainingSeconds) },
      });
    }
    return placementErrorResponse(error, "Не удалось сохранить строку.");
  }
}
