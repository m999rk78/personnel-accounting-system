import type { PostgresDatabase } from "../db/client";
import { rememberPersonnelImportOrder } from "./personnelImportOrderServer.ts";

export const normalizeExcelDirectoryName = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

function importIds(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 2000) throw new Error("В файле должно быть от 1 до 2000 сотрудников.");
  if (value.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("В файле указаны некорректные сотрудники.");
  return [...new Set(value as number[])];
}

function importSiteId(siteId: number) {
  if (!Number.isSafeInteger(siteId) || siteId <= 0) throw new Error("Выберите действующий проект.");
}

/** Validate and assign the complete workbook in one transaction, preserving other projects. */
export async function importProjectEmployeesExcel(database: PostgresDatabase, siteId: number, inputIds: unknown, beforeAssign?: (db: Pick<PostgresDatabase, "prepare">, employeeIds: number[]) => Promise<void>) {
  importSiteId(siteId);
  const employeeIds = importIds(inputIds);
  return database.transaction(async db => {
    const site = await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    const employees = await db.prepare("SELECT id FROM employees WHERE id = ANY(?::integer[]) AND active = 1 ORDER BY id FOR UPDATE").bind(employeeIds).all<{ id: number }>();
    if (employees.results.length !== employeeIds.length) throw new Error("Один из сотрудников не найден или уже архивирован. Обновите справочник и повторите импорт.");
    await beforeAssign?.(db, employeeIds);
    const assigned = await db.prepare("SELECT employee_id AS employeeId FROM employee_project_assignments WHERE employee_id = ANY(?::integer[]) AND site_id = ? AND active = 1 FOR UPDATE").bind(employeeIds, siteId).all<{ employeeId: number }>();
    const existing = new Set(assigned.results.map(row => row.employeeId));
    const added = employeeIds.filter(id => !existing.has(id));
    for (const employeeId of added) {
      await db.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date) VALUES (?, ?, 'excel', CURRENT_DATE)").bind(employeeId, siteId).run();
      const updated = await db.prepare(`UPDATE employees SET site_id = COALESCE(site_id, ?),
        availability_status = CASE WHEN source = 'bitrix24' THEN availability_status ELSE 'on_site' END
        WHERE id = ? AND active = 1`).bind(siteId, employeeId).run();
      if (updated.meta.changes !== 1) throw new Error("Не удалось добавить одного из сотрудников. Изменения импорта отменены.");
    }
    await rememberPersonnelImportOrder(db, "project-personnel", siteId, employeeIds);
    return { count: added.length, skipped: employeeIds.length - added.length };
  });
}

/** Work types have a separate hierarchy importer; shifts and global options are not project imports. */
export async function importProjectDirectoryExcel(database: PostgresDatabase, siteId: number, entity: unknown, input: { names?: unknown; employeeIds?: unknown }) {
  importSiteId(siteId);
  if (entity !== "zone" && entity !== "master") throw new Error("Этот справочник не поддерживает такой импорт. Для видов и подвидов работ используйте их общий шаблон.");
  const employeeIds = entity === "master" ? importIds(input.employeeIds) : [];
  const names = entity === "zone" ? input.names : [];
  if (!Array.isArray(names) || (entity === "zone" && (!names.length || names.length > 2000))) throw new Error("В файле должно быть от 1 до 2000 значений справочника.");
  const requestedNames = names.map((name, index) => {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 240) throw new Error(`Строка ${index + 1}: укажите название до 240 символов.`);
    return name.trim();
  });
  const table = entity === "zone" ? "zones" : "masters";
  return database.transaction(async db => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`directory-import:${siteId}:${entity}`).first();
    const site = await db.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    let allNames = requestedNames;
    if (entity === "master") {
      const employees = await db.prepare(`SELECT e.id, e.full_name AS fullName FROM employees e
        JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
        WHERE e.active = 1 ORDER BY e.id FOR SHARE OF e, epa`).bind(siteId).all<{ id: number; fullName: string }>();
      const byId = new Map(employees.results.map(row => [row.id, row.fullName]));
      if (employeeIds.some(id => !byId.has(id))) throw new Error("Один из мастеров не относится к текущему проекту или уже архивирован. Обновите список и повторите импорт.");
      allNames = employeeIds.map(id => byId.get(id)!);
      const counts = new Map<string, Set<number>>();
      for (const employee of employees.results) {
        const key = normalizeExcelDirectoryName(employee.fullName);
        const ids = counts.get(key) ?? new Set<number>(); ids.add(employee.id); counts.set(key, ids);
      }
      if (allNames.some(name => (counts.get(normalizeExcelDirectoryName(name))?.size ?? 0) > 1)) throw new Error("Среди сотрудников проекта есть одинаковые ФИО выбранных мастеров. Назначение неоднозначно; уточните ФИО в справочнике сотрудников.");
    }
    const existing = await db.prepare(`SELECT id, name FROM ${table} WHERE site_id = ? AND active = 1 FOR UPDATE`).bind(siteId).all<{ id: number; name: string }>();
    const existingByName = new Map<string, number[]>();
    for (const row of existing.results) {
      const key = normalizeExcelDirectoryName(row.name);
      existingByName.set(key, [...(existingByName.get(key) ?? []), row.id]);
    }
    const uniqueNames = [...new Map(allNames.map(name => [normalizeExcelDirectoryName(name), name])).values()];
    for (const name of uniqueNames) if ((existingByName.get(normalizeExcelDirectoryName(name))?.length ?? 0) > 1) throw new Error(`Значение «${name}» неоднозначно. Сначала исправьте дубликаты в справочнике.`);
    const added = uniqueNames.filter(name => !existingByName.has(normalizeExcelDirectoryName(name)));
    for (const name of added) await db.prepare(`INSERT INTO ${table} (site_id, name) VALUES (?, ?)`).bind(siteId, name).run();
    return { count: added.length, skipped: allNames.length - added.length };
  });
}

export type EmployeeExcelInput = { fullName?: string; employmentType?: string; department?: string; position?: string; projectCode?: string };
type Site = { id: number; code: string; name: string };
type Employee = { id: number; fullName: string };

/** Resolve the entire workbook before writing, without silently choosing a namesake or project. */
export function prepareEmployeeExcelImport(input: unknown, sites: Site[], employees: Employee[]) {
  if (!Array.isArray(input) || !input.length || input.length > 2000) throw new Error("В файле должно быть от 1 до 2000 сотрудников.");
  const sitesByKey = new Map<string, Set<number>>();
  for (const site of sites) for (const text of [site.code, site.name]) {
    const key = normalizeExcelDirectoryName(text);
    const ids = sitesByKey.get(key) ?? new Set<number>();
    ids.add(site.id); sitesByKey.set(key, ids);
  }
  const employeesByName = new Map<string, Employee[]>();
  for (const employee of employees) {
    const key = normalizeExcelDirectoryName(employee.fullName);
    employeesByName.set(key, [...(employeesByName.get(key) ?? []), employee]);
  }
  const importedNames = new Set<string>();
  const unassigned = new Set(["без объекта", "не назначен", "не назначена", "без проекта", "-", "—"]);
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Строка ${index + 1}: некорректные данные сотрудника.`);
    const row = raw as EmployeeExcelInput;
    const text = (field: keyof EmployeeExcelInput) => {
      if (row[field] != null && typeof row[field] !== "string") throw new Error(`Строка ${index + 1}: некорректное значение поля сотрудника.`);
      return row[field]?.trim() ?? "";
    };
    const fullName = text("fullName"); const employmentType = text("employmentType"); const department = text("department"); const position = text("position");
    if (!fullName || !employmentType || !department || !position) throw new Error(`Строка ${index + 1}: заполните ФИО, тип, отдел и должность.`);
    const normalizedName = normalizeExcelDirectoryName(fullName);
    if (importedNames.has(normalizedName)) throw new Error(`Строка ${index + 1}: сотрудник «${fullName}» повторяется в файле.`);
    importedNames.add(normalizedName);
    const matches = employeesByName.get(normalizedName) ?? [];
    if (matches.length > 1) throw new Error(`Строка ${index + 1}: ФИО «${fullName}» неоднозначно. Уточните дубликаты в справочнике сотрудников.`);
    const rawProjects = text("projectCode");
    const projectNames = !rawProjects || unassigned.has(normalizeExcelDirectoryName(rawProjects)) ? []
      : sitesByKey.has(normalizeExcelDirectoryName(rawProjects)) ? [rawProjects]
      : rawProjects.split(/[;\n]/.test(rawProjects) ? /[;\n]/ : /,/).map(name => name.trim()).filter(Boolean);
    const siteIds = [...new Set(projectNames.map(name => {
      const ids = sitesByKey.get(normalizeExcelDirectoryName(name));
      if (!ids?.size) throw new Error(`Строка ${index + 1}: проект «${name}» не найден.`);
      if (ids.size > 1) throw new Error(`Строка ${index + 1}: проект «${name}» неоднозначен. Укажите его уникальный код.`);
      return [...ids][0];
    }))];
    return { fullName, normalizedName, employmentType, department, position, siteIds, existingId: matches[0]?.id };
  });
}
