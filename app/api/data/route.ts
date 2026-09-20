import { getDatabase } from "../../../db/client";
import { assertSameOrigin, createInvitation, ensureAuthSchema, getAuthUser, sendInvitationEmail, type AuthUser } from "../../auth";

const env = { get DB() { return getDatabase(); } };

type EntryPayload = {
  id?: number;
  siteId?: number;
  workDate?: string;
  employeeId?: number;
  shiftId?: number;
  zoneId?: number;
  mainWorkTypeId?: number;
  subworkTypeId?: number;
  note?: string;
  masterId?: number;
  hours?: number;
};

type UserPayload = {
  action?: "create-user" | "update-user" | "create-employee" | "update-employee" | "import-employees" | "create-position" | "update-position" | "import-positions" | "create-site" | "update-site" | "create-directory" | "update-directory" | "assign-employee-project";
  userId?: number;
  employeeId?: number;
  positionId?: number;
  directoryId?: number;
  entity?: DirectoryEntity;
  fullName?: string;
  email?: string;
  role?: "foreman" | "office";
  assignedSiteId?: number | null;
  employmentType?: string;
  department?: string;
  position?: string;
  name?: string;
  code?: string;
  timezone?: string;
  projectSiteId?: number | null;
  employees?: Array<{ fullName?: string; employmentType?: string; department?: string; position?: string; projectCode?: string }>;
  positions?: Array<{ employmentType?: string; department?: string; position?: string }>;
};

type DirectoryEntity = "employmentType" | "department" | "position" | "shift" | "zone" | "mainWorkType" | "subworkType" | "master";

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
const PERSONNEL_COLUMNS = { employmentType: "employment_type", department: "department", position: "position" } as const;

function directoryTable(entity: unknown) {
  if (typeof entity !== "string" || !(entity in DIRECTORY_TABLES)) return null;
  const key = entity as DirectoryEntity;
  return { table: DIRECTORY_TABLES[key], key, global: key === "employmentType" || key === "department" || key === "position" };
}

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bitrix24_id TEXT UNIQUE,
    full_name TEXT NOT NULL,
    employment_type TEXT NOT NULL DEFAULT 'ОПР',
    department TEXT NOT NULL DEFAULT 'УСР',
    position TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'excel',
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS employee_project_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    start_date TEXT,
    end_date TEXT,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS personnel_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS position_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employment_type TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    assigned_site_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS main_work_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS subwork_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS placement_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    employee_id INTEGER NOT NULL,
    shift_id INTEGER NOT NULL,
    zone_id INTEGER NOT NULL,
    main_work_type_id INTEGER NOT NULL,
    subwork_type_id INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    master_id INTEGER NOT NULL,
    hours INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 10),
    position_snapshot TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'demo-user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_site_date ON placement_entries(site_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_employee_date ON placement_entries(employee_id, work_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_project_assignment_active ON employee_project_assignments(employee_id, site_id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_employee_project_assignment_site ON employee_project_assignments(site_id, active)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_options_kind_name ON personnel_options(kind, name) WHERE active = 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_position_catalog_values ON position_catalog(employment_type, department, position) WHERE active = 1`,
];

async function initializeDatabase() {
  const db = env.DB;
  await ensureAuthSchema();
  await db.batch(TABLE_STATEMENTS.map((statement) => db.prepare(statement)));

  const employeeColumns = await db.prepare("PRAGMA table_info(employees)").all<{ name: string }>();
  const employeeColumnNames = new Set(employeeColumns.results.map((column) => column.name));
  if (!employeeColumnNames.has("employment_type")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'ОПР'").run();
  }
  if (!employeeColumnNames.has("department")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN department TEXT NOT NULL DEFAULT 'УСР'").run();
  }
  if (!employeeColumnNames.has("site_id")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN site_id INTEGER").run();
  }
  const userColumns = await db.prepare("PRAGMA table_info(app_users)").all<{ name: string }>();
  if (!userColumns.results.some((column) => column.name === "email")) {
    await db.prepare("ALTER TABLE app_users ADD COLUMN email TEXT NOT NULL DEFAULT ''").run();
  }
  async function repairNumericPersonnelValues() {
    const [optionsResult, positionsResult, employeesResult] = await db.batch([
      db.prepare("SELECT id, kind, name FROM personnel_options WHERE active = 1"),
      db.prepare("SELECT id, employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1"),
      db.prepare("SELECT id, employment_type AS employmentType, department, position FROM employees WHERE active = 1"),
    ]);
    const optionNames = new Map((optionsResult.results as Array<{ id: number; kind: string; name: string }>).map((option) => [`${option.kind}:${option.id}`, option.name]));
    const resolveValue = (kind: string, value: string) => /^\d+$/.test(value) ? optionNames.get(`${kind}:${value}`) ?? value : value;
    const positions = (positionsResult.results as Array<{ id: number; employmentType: string; department: string; position: string }>).map((row) => ({
      ...row,
      resolvedEmploymentType: resolveValue("employmentType", row.employmentType),
      resolvedDepartment: resolveValue("department", row.department),
      resolvedPosition: resolveValue("position", row.position),
      numericCount: [row.employmentType, row.department, row.position].filter((value) => /^\d+$/.test(value)).length,
    })).sort((left, right) => left.numericCount - right.numericCount || left.id - right.id);
    const seenPositions = new Set<string>();
    const repairs = [];
    for (const row of positions) {
      const key = `${row.resolvedEmploymentType}\u0000${row.resolvedDepartment}\u0000${row.resolvedPosition}`;
      if (seenPositions.has(key)) {
        repairs.push(db.prepare("DELETE FROM position_catalog WHERE id = ?").bind(row.id));
        continue;
      }
      seenPositions.add(key);
      if (row.employmentType !== row.resolvedEmploymentType || row.department !== row.resolvedDepartment || row.position !== row.resolvedPosition) {
        repairs.push(db.prepare("UPDATE position_catalog SET employment_type = ?, department = ?, position = ? WHERE id = ?").bind(row.resolvedEmploymentType, row.resolvedDepartment, row.resolvedPosition, row.id));
      }
    }
    for (const row of employeesResult.results as Array<{ id: number; employmentType: string; department: string; position: string }>) {
      const employmentType = resolveValue("employmentType", row.employmentType);
      const department = resolveValue("department", row.department);
      const position = resolveValue("position", row.position);
      if (row.employmentType !== employmentType || row.department !== department || row.position !== position) {
        repairs.push(db.prepare("UPDATE employees SET employment_type = ?, department = ?, position = ? WHERE id = ?").bind(employmentType, department, position, row.id));
      }
    }
    for (let offset = 0; offset < repairs.length; offset += 100) await db.batch(repairs.slice(offset, offset + 100));
    await db.batch([
      db.prepare("DELETE FROM personnel_options WHERE kind = 'employmentType' AND name <> '' AND name NOT GLOB '*[^0-9]*' AND NOT EXISTS (SELECT 1 FROM employees WHERE employment_type = personnel_options.name AND active = 1) AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE employment_type = personnel_options.name AND active = 1)"),
      db.prepare("DELETE FROM personnel_options WHERE kind = 'department' AND name <> '' AND name NOT GLOB '*[^0-9]*' AND NOT EXISTS (SELECT 1 FROM employees WHERE department = personnel_options.name AND active = 1) AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE department = personnel_options.name AND active = 1)"),
      db.prepare("DELETE FROM personnel_options WHERE kind = 'position' AND name <> '' AND name NOT GLOB '*[^0-9]*' AND NOT EXISTS (SELECT 1 FROM employees WHERE position = personnel_options.name AND active = 1) AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE position = personnel_options.name AND active = 1)"),
      db.prepare("DELETE FROM position_catalog WHERE active = 0"),
      db.prepare("DELETE FROM employees WHERE active = 0 AND NOT EXISTS (SELECT 1 FROM placement_entries WHERE employee_id = employees.id)"),
    ]);
  }
  const syncPersonnelOptions = () => db.batch([
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'employmentType', employment_type FROM employees WHERE employment_type <> ''"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'department', department FROM employees WHERE department <> ''"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'position', position FROM employees WHERE position <> ''"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'employmentType', employment_type FROM position_catalog WHERE employment_type <> '' AND active = 1"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'department', department FROM position_catalog WHERE department <> '' AND active = 1"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'position', position FROM position_catalog WHERE position <> '' AND active = 1"),
  ]);
  const syncPositionCatalog = () => db.prepare("INSERT OR IGNORE INTO position_catalog (employment_type, department, position) SELECT DISTINCT employment_type, department, position FROM employees WHERE employment_type <> '' AND department <> '' AND position <> ''").run();
  const syncEmployeeAssignments = () => db.prepare("INSERT OR IGNORE INTO employee_project_assignments (employee_id, site_id, source) SELECT id, site_id, source FROM employees WHERE active = 1 AND site_id IS NOT NULL").run();
  const syncMasterEmployees = async () => {
    await db.prepare(`INSERT INTO employees (full_name, employment_type, department, position, source, site_id)
      SELECT m.name, 'ОПР', 'УСР', 'Мастер строительно-монтажных работ', 'master-directory', m.site_id
      FROM masters m
      WHERE m.active = 1 AND NOT EXISTS (
        SELECT 1 FROM employees e WHERE e.full_name = m.name AND e.active = 1
      )`).run();
    await db.prepare(`INSERT OR IGNORE INTO employee_project_assignments (employee_id, site_id, source)
      SELECT e.id, m.site_id, 'master-directory'
      FROM masters m JOIN employees e ON e.full_name = m.name AND e.active = 1
      WHERE m.active = 1 AND NOT EXISTS (
        SELECT 1 FROM employee_project_assignments epa
        WHERE epa.employee_id = e.id AND epa.site_id = m.site_id AND epa.active = 1
      )`).run();
    await db.prepare(`UPDATE employees SET site_id = (
      SELECT MIN(m.site_id) FROM masters m WHERE m.name = employees.full_name AND m.active = 1
    ) WHERE site_id IS NULL AND active = 1 AND EXISTS (
      SELECT 1 FROM masters m WHERE m.name = employees.full_name AND m.active = 1
    )`).run();
  };
  const ensureStandardShifts = async () => {
    const sites = await db.prepare("SELECT id FROM sites WHERE active = 1").all<{ id: number }>();
    const statements = sites.results.flatMap((site) => [
      db.prepare("UPDATE shifts SET active = 1 WHERE site_id = ? AND name IN ('день', 'ночь')").bind(site.id),
      db.prepare("INSERT INTO shifts (site_id, name) SELECT ?, 'день' WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE site_id = ? AND name = 'день')").bind(site.id, site.id),
      db.prepare("INSERT INTO shifts (site_id, name) SELECT ?, 'ночь' WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE site_id = ? AND name = 'ночь')").bind(site.id, site.id),
      db.prepare("UPDATE shifts SET active = 0 WHERE site_id = ? AND name NOT IN ('день', 'ночь')").bind(site.id),
    ]);
    for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
  };
  const syncIdentitySequences = () => db.batch([
    "sites", "app_users", "user_invitations", "user_sessions", "login_attempts", "employees",
    "employee_project_assignments", "position_catalog", "personnel_options", "shifts", "zones",
    "main_work_types", "subwork_types", "masters", "placement_entries",
  ].map((table) => db.prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS (SELECT 1 FROM ${table}))`)));

  const siteCount = await db.prepare("SELECT COUNT(*) AS count FROM sites").first<{ count: number }>();
  if ((siteCount?.count ?? 0) > 0) {
    await db.prepare("UPDATE sites SET timezone = 'Europe/Moscow' WHERE timezone <> 'Europe/Moscow'").run();
    await db.prepare("UPDATE employees SET site_id = 1 WHERE site_id IS NULL").run();
    await repairNumericPersonnelValues();
    await syncMasterEmployees();
    await syncPersonnelOptions();
    await syncPositionCatalog();
    await syncEmployeeAssignments();
    await ensureStandardShifts();
    await db.prepare("INSERT INTO app_users (id, full_name, email, role, assigned_site_id) SELECT 1, ?, 'mark@yums.ru', 'foreman', 1 WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE id = 1)").bind("Марк Аванесов").run();
    await db.prepare("UPDATE app_users SET email = 'mark@yums.ru' WHERE id = 1 AND email = ''").run();
    await syncIdentitySequences();
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  await db.batch([
    db.prepare("INSERT INTO sites (id, name, code, timezone) VALUES (1, ?, ?, 'Europe/Moscow')").bind("ГПЗ — Установка 2", "GPZ-U2"),
    db.prepare("INSERT INTO sites (id, name, code, timezone) VALUES (2, ?, ?, 'Europe/Moscow')").bind("Площадка Северная", "NORTH"),
    db.prepare("INSERT INTO app_users (id, full_name, email, role, assigned_site_id) VALUES (1, ?, 'mark@yums.ru', 'foreman', 1)").bind("Марк Аванесов"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position) VALUES (1, ?, 'ОПР', 'УСР', ?)").bind("Иванов Сергей Петрович", "Монтажник технологических трубопроводов"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position) VALUES (2, ?, 'ОПР', 'УСР', ?)").bind("Абдуллаев Рустам Каримович", "Электрогазосварщик"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position) VALUES (3, ?, 'ОПР', 'МУВСП', ?)").bind("Петров Алексей Николаевич", "Стропальщик"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position) VALUES (4, ?, 'ОПР', 'МУТТ', ?)").bind("Саидов Джамшед Махмудович", "Монтажник металлоконструкций"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position) VALUES (5, ?, 'ИТР', 'УСР', ?)").bind("Ким Андрей Викторович", "Мастер строительно-монтажных работ"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position) VALUES (6, ?, 'ОПР', 'УОВ', ?)").bind("Смирнов Николай Олегович", "Подсобный рабочий"),
    db.prepare("INSERT INTO shifts (id, site_id, name) VALUES (1, 1, 'день'), (2, 1, 'ночь'), (4, 2, 'день'), (5, 2, 'ночь')"),
    db.prepare("INSERT INTO zones (id, site_id, name) VALUES (1, 1, 'G4-C1810BX0'), (2, 1, 'G3-B1110BX0'), (3, 1, 'G1-B6710RX0'), (4, 1, 'отсутствует'), (5, 2, 'Секция A'), (6, 2, 'Секция B')"),
    db.prepare("INSERT INTO main_work_types (id, site_id, name) VALUES (1, 1, 'Трубопроводы /// Монтаж'), (2, 1, 'Трубопроводы /// Сварка'), (3, 1, 'Металлоконструкции /// Эстакады'), (4, 1, 'Вспомогательные и прочие работы'), (5, 2, 'Монтаж оборудования'), (6, 2, 'Подготовительные работы')"),
    db.prepare("INSERT INTO subwork_types (id, site_id, name) VALUES (1, 1, 'Вспомогательные или прочие работы'), (2, 1, 'Погрузо-разгрузка, сортировка, склад'), (3, 1, 'Подготовка к сварочным работам'), (4, 1, 'Подкрасочные работы'), (5, 2, 'Сортировка материала'), (6, 2, 'Дополнительные работы')"),
    db.prepare("INSERT INTO masters (id, site_id, name) VALUES (1, 1, 'Ниязметов Анвар Аминбаевич'), (2, 1, 'Мурзаев Алишер'), (3, 1, 'Раджабов Султонназир'), (4, 2, 'Кузнецов Артём Игоревич'), (5, 2, 'Орлов Максим Павлович')"),
    db.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (1, ?, 1, 1, 1, 1, 1, '', 1, 6, ?)`)
      .bind(today, "Монтажник технологических трубопроводов"),
    db.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (1, ?, 1, 1, 2, 4, 2, 'Перемещение материала', 2, 4, ?)`)
      .bind(today, "Монтажник технологических трубопроводов"),
    db.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (1, ?, 2, 1, 1, 2, 3, '', 1, 10, ?)`)
      .bind(today, "Электрогазосварщик"),
  ]);
  await db.prepare("UPDATE employees SET site_id = 1 WHERE site_id IS NULL").run();
  await syncMasterEmployees();
  await syncPersonnelOptions();
  await syncPositionCatalog();
  await syncEmployeeAssignments();
  await ensureStandardShifts();
  await syncIdentitySequences();
  await db.prepare("PRAGMA optimize").run();
}

function unauthorized() {
  return Response.json({ error: "Требуется вход в систему." }, { status: 401 });
}

function forbidden() {
  return Response.json({ error: "У вас нет прав для этого действия." }, { status: 403 });
}

function todayInMoscow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canManagePlacement(user: AuthUser, siteId: number | undefined, workDate: string | undefined) {
  return user.role === "office" || (user.assignedSiteId === siteId && workDate === todayInMoscow());
}

function asPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function validatePayload(payload: EntryPayload, excludedId?: number) {
  const siteId = asPositiveInteger(payload.siteId);
  const employeeId = asPositiveInteger(payload.employeeId);
  const shiftId = asPositiveInteger(payload.shiftId);
  const zoneId = asPositiveInteger(payload.zoneId);
  const mainWorkTypeId = asPositiveInteger(payload.mainWorkTypeId);
  const subworkTypeId = asPositiveInteger(payload.subworkTypeId);
  const masterId = asPositiveInteger(payload.masterId);
  const hours = asPositiveInteger(payload.hours);

  if (!siteId || !employeeId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !masterId || !hours || !validDate(payload.workDate)) {
    throw new Error("Заполните все обязательные поля строки.");
  }
  if (hours < 1 || hours > 10) throw new Error("Количество часов должно быть от 1 до 10.");

  const employee = await env.DB.prepare("SELECT e.position FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1 WHERE e.id = ? AND e.active = 1")
    .bind(siteId, employeeId).first<{ position: string }>();
  if (!employee?.position) throw new Error("Сотрудник не относится к выбранному проекту или у него не заполнена должность.");

  const refs = await env.DB.batch([
    env.DB.prepare("SELECT id FROM shifts WHERE id = ? AND site_id = ? AND active = 1").bind(shiftId, siteId),
    env.DB.prepare("SELECT id FROM zones WHERE id = ? AND site_id = ? AND active = 1").bind(zoneId, siteId),
    env.DB.prepare("SELECT id FROM main_work_types WHERE id = ? AND site_id = ? AND active = 1").bind(mainWorkTypeId, siteId),
    env.DB.prepare("SELECT id FROM subwork_types WHERE id = ? AND site_id = ? AND active = 1").bind(subworkTypeId, siteId),
    env.DB.prepare("SELECT id FROM masters WHERE id = ? AND site_id = ? AND active = 1").bind(masterId, siteId),
  ]);
  if (refs.some((result) => result.results.length === 0)) throw new Error("Одно из значений не относится к выбранному объекту.");

  const excluded = excludedId ? "AND id <> ?" : "";
  const statement = env.DB.prepare(`SELECT COALESCE(SUM(hours), 0) AS used FROM placement_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL ${excluded}`);
  const total = excludedId
    ? await statement.bind(employeeId, payload.workDate, excludedId).first<{ used: number }>()
    : await statement.bind(employeeId, payload.workDate).first<{ used: number }>();
  const used = Number(total?.used ?? 0);
  if (used + hours > 10) throw new Error(`У сотрудника уже учтено ${used} ч. После сохранения получится ${used + hours} ч., максимум — 10.`);

  return { siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate: payload.workDate, note: payload.note?.trim() ?? "", position: employee.position };
}

async function validateBulkPayloads(payloads: EntryPayload[]) {
  if (payloads.length === 0) throw new Error("Добавьте хотя бы одного сотрудника.");
  if (payloads.length > 1000) throw new Error("За один раз можно сохранить не более 1000 строк.");

  const siteId = asPositiveInteger(payloads[0].siteId);
  const workDate = payloads[0].workDate;
  if (!siteId || !validDate(workDate)) throw new Error("Не указан объект или рабочий день.");
  if (payloads.some((payload) => asPositiveInteger(payload.siteId) !== siteId || payload.workDate !== workDate)) {
    throw new Error("Все строки группы должны относиться к одному объекту и дню.");
  }

  const [employeesResult, shiftsResult, zonesResult, mainWorksResult, subworksResult, mastersResult, totalsResult] = await env.DB.batch([
    env.DB.prepare("SELECT e.id, e.position FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1 WHERE e.active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM shifts WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM zones WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM main_work_types WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM subwork_types WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM masters WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT employee_id AS employeeId, SUM(hours) AS used FROM placement_entries WHERE work_date = ? AND deleted_at IS NULL GROUP BY employee_id").bind(workDate),
  ]);

  const employees = new Map((employeesResult.results as Array<{ id: number; position: string }>).map((employee) => [employee.id, employee.position]));
  const shifts = new Set((shiftsResult.results as Array<{ id: number }>).map((item) => item.id));
  const zones = new Set((zonesResult.results as Array<{ id: number }>).map((item) => item.id));
  const mainWorks = new Set((mainWorksResult.results as Array<{ id: number }>).map((item) => item.id));
  const subworks = new Set((subworksResult.results as Array<{ id: number }>).map((item) => item.id));
  const masters = new Set((mastersResult.results as Array<{ id: number }>).map((item) => item.id));
  const totals = new Map((totalsResult.results as Array<{ employeeId: number; used: number }>).map((item) => [item.employeeId, Number(item.used)]));
  const added = new Map<number, number>();

  return payloads.map((payload, index) => {
    const employeeId = asPositiveInteger(payload.employeeId);
    const shiftId = asPositiveInteger(payload.shiftId);
    const zoneId = asPositiveInteger(payload.zoneId);
    const mainWorkTypeId = asPositiveInteger(payload.mainWorkTypeId);
    const subworkTypeId = asPositiveInteger(payload.subworkTypeId);
    const masterId = asPositiveInteger(payload.masterId);
    const hours = asPositiveInteger(payload.hours);
    const position = employeeId ? employees.get(employeeId) : undefined;

    if (!employeeId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !masterId || !hours) {
      throw new Error(`Строка ${index + 1}: заполните все обязательные поля.`);
    }
    if (hours < 1 || hours > 10) throw new Error(`Строка ${index + 1}: количество часов должно быть от 1 до 10.`);
    if (!position) throw new Error(`Строка ${index + 1}: сотрудник не найден или у него не заполнена должность.`);
    if (!shifts.has(shiftId) || !zones.has(zoneId) || !mainWorks.has(mainWorkTypeId) || !subworks.has(subworkTypeId) || !masters.has(masterId)) {
      throw new Error(`Строка ${index + 1}: одно из значений не относится к объекту.`);
    }

    const employeeTotal = (totals.get(employeeId) ?? 0) + (added.get(employeeId) ?? 0) + hours;
    if (employeeTotal > 10) throw new Error(`Строка ${index + 1}: у сотрудника получится ${employeeTotal} ч., максимум — 10.`);
    added.set(employeeId, (added.get(employeeId) ?? 0) + hours);

    return { siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate, note: payload.note?.trim() ?? "", position };
  });
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await initializeDatabase();
    const url = new URL(request.url);
    const requestedSiteId = asPositiveInteger(url.searchParams.get("siteId")) ?? 1;
    const siteId = authUser.role === "foreman" ? authUser.assignedSiteId ?? requestedSiteId : requestedSiteId;
    const workDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const [sites, employees, placementEmployees, positionCatalog, employmentTypes, departments, positions, shifts, zones, mainWorkTypes, subworkTypes, masters, entries, users] = await env.DB.batch([
      env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
      env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source,
        (SELECT MIN(epa.site_id) FROM employee_project_assignments epa JOIN sites assigned_site ON assigned_site.id = epa.site_id WHERE epa.employee_id = e.id AND epa.active = 1 AND assigned_site.active = 1) AS siteId,
        (SELECT GROUP_CONCAT(assigned_site.name, ', ') FROM employee_project_assignments epa JOIN sites assigned_site ON assigned_site.id = epa.site_id WHERE epa.employee_id = e.id AND epa.active = 1 AND assigned_site.active = 1) AS siteName
        FROM employees e WHERE e.active = 1 ORDER BY e.full_name`),
      env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source, epa.site_id AS siteId, s.name AS siteName
        FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1 JOIN sites s ON s.id = epa.site_id AND s.active = 1
        WHERE e.active = 1 AND epa.site_id = ? ORDER BY e.full_name`).bind(siteId),
      env.DB.prepare("SELECT id, employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1 ORDER BY employment_type, department, position"),
      env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'employmentType' ORDER BY name"),
      env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'department' ORDER BY name"),
      env.DB.prepare("SELECT id, name FROM personnel_options WHERE active = 1 AND kind = 'position' ORDER BY name"),
      env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM masters WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare(`SELECT pe.id, pe.site_id AS siteId, pe.work_date AS workDate, pe.employee_id AS employeeId,
        pe.shift_id AS shiftId, pe.zone_id AS zoneId, pe.main_work_type_id AS mainWorkTypeId,
        pe.subwork_type_id AS subworkTypeId, pe.note, pe.master_id AS masterId, pe.hours,
        pe.position_snapshot AS positionSnapshot, e.full_name AS employeeName,
        e.employment_type AS employmentType, e.department, s.name AS shiftName,
        z.name AS zoneName, mw.name AS mainWorkTypeName, sw.name AS subworkTypeName, m.name AS masterName
        FROM placement_entries pe
        JOIN employees e ON e.id = pe.employee_id
        JOIN shifts s ON s.id = pe.shift_id
        JOIN zones z ON z.id = pe.zone_id
        JOIN main_work_types mw ON mw.id = pe.main_work_type_id
        JOIN subwork_types sw ON sw.id = pe.subwork_type_id
        JOIN masters m ON m.id = pe.master_id
        WHERE pe.site_id = ? AND pe.work_date = ? AND pe.deleted_at IS NULL
        ORDER BY e.full_name, pe.created_at, pe.id`).bind(siteId, workDate),
      env.DB.prepare("SELECT id, full_name AS fullName, email, role, assigned_site_id AS assignedSiteId, CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END AS status FROM app_users WHERE active = 1 ORDER BY full_name"),
    ]);
    return Response.json({
      sites: authUser.role === "office" ? sites.results : sites.results.filter((site) => (site as { id: number }).id === siteId),
      employees: authUser.role === "office" ? employees.results : placementEmployees.results,
      placementEmployees: placementEmployees.results,
      positionCatalog: positionCatalog.results,
      employmentTypes: employmentTypes.results,
      departments: departments.results,
      positions: positions.results,
      shifts: shifts.results,
      zones: zones.results,
      mainWorkTypes: mainWorkTypes.results,
      subworkTypes: subworkTypes.results,
      masters: masters.results,
      entries: entries.results,
      users: authUser.role === "office" ? users.results : [],
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить данные." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await initializeDatabase();
    const payload = (await request.json()) as EntryPayload & UserPayload & { entries?: EntryPayload[] };
    if (payload.action && authUser.role !== "office") return forbidden();
    if (!payload.action) {
      const placementRows = payload.entries?.length ? payload.entries : [payload];
      if (placementRows.some((row) => !canManagePlacement(authUser, asPositiveInteger(row.siteId), row.workDate))) return forbidden();
    }
    if (payload.action === "create-user") {
      const fullName = payload.fullName?.trim() ?? "";
      const email = payload.email?.trim().toLocaleLowerCase() ?? "";
      const role = payload.role;
      const assignedSiteId = role === "foreman" ? asPositiveInteger(payload.assignedSiteId) : null;
      if (!fullName || !/^\S+@\S+\.\S+$/.test(email) || !role || (role === "foreman" && !assignedSiteId)) throw new Error("Заполните ФИО, корректный email, роль и объект прораба.");
      const duplicate = await env.DB.prepare("SELECT id FROM app_users WHERE email = ? AND active = 1").bind(email).first();
      if (duplicate) throw new Error("Пользователь с таким email уже существует.");
      const result = await env.DB.prepare("INSERT INTO app_users (full_name, email, role, assigned_site_id) VALUES (?, ?, ?, ?)").bind(fullName, email, role, assignedSiteId).run();
      const userId = Number(result.meta.last_row_id);
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
      if (!fullName || !employmentType || !department || !position || !projectSiteId) throw new Error("Заполните ФИО, тип, отдел, должность и проект рабочего.");
      const project = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(projectSiteId).first();
      if (!project) throw new Error("Выбранный проект не найден или уже закрыт.");
      const duplicate = await env.DB.prepare("SELECT id FROM employees WHERE full_name = ? AND active = 1").bind(fullName).first();
      if (duplicate) throw new Error("Рабочий с таким ФИО уже существует.");
      const result = await env.DB.prepare("INSERT INTO employees (full_name, employment_type, department, position, source, site_id) VALUES (?, ?, ?, ?, 'manual', ?)").bind(fullName, employmentType, department, position, projectSiteId).run();
      await env.DB.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source) VALUES (?, ?, 'manual')").bind(Number(result.meta.last_row_id), projectSiteId).run();
      return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (payload.action === "assign-employee-project") {
      const employeeId = asPositiveInteger(payload.employeeId);
      const siteId = asPositiveInteger(payload.siteId);
      if (!employeeId || !siteId) throw new Error("Выберите сотрудника и проект.");
      const [employee, site] = await env.DB.batch([
        env.DB.prepare("SELECT id FROM employees WHERE id = ? AND active = 1").bind(employeeId),
        env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId),
      ]);
      if (!employee.results.length || !site.results.length) throw new Error("Сотрудник или проект не найден.");
      const active = await env.DB.prepare("SELECT id FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1").bind(employeeId, siteId).first();
      if (active) throw new Error("Сотрудник уже добавлен в этот проект.");
      const existing = await env.DB.prepare("SELECT id FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? ORDER BY id DESC LIMIT 1").bind(employeeId, siteId).first<{ id: number }>();
      if (existing) await env.DB.prepare("UPDATE employee_project_assignments SET active = 1, end_date = NULL, source = 'manual' WHERE id = ?").bind(existing.id).run();
      else await env.DB.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source) VALUES (?, ?, 'manual')").bind(employeeId, siteId).run();
      await env.DB.prepare("UPDATE employees SET site_id = COALESCE(site_id, ?) WHERE id = ?").bind(siteId, employeeId).run();
      return Response.json({ ok: true }, { status: 201 });
    }
    if (payload.action === "create-position") {
      const employmentType = payload.employmentType?.trim() ?? "";
      const department = payload.department?.trim() ?? "";
      const position = payload.position?.trim() ?? "";
      if (!employmentType || !department || !position) throw new Error("Заполните тип, отдел и должность.");
      const result = await env.DB.prepare("INSERT OR IGNORE INTO position_catalog (employment_type, department, position) VALUES (?, ?, ?)").bind(employmentType, department, position).run();
      if (!result.meta.changes) throw new Error("Такая должность уже есть в списке.");
      return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (payload.action === "import-positions") {
      const rows = payload.positions ?? [];
      if (!rows.length || rows.length > 2000) throw new Error("В файле должно быть от 1 до 2000 должностей.");
      const statements = rows.map((row, index) => {
        const employmentType = row.employmentType?.trim() ?? "";
        const department = row.department?.trim() ?? "";
        const position = row.position?.trim() ?? "";
        if (!employmentType || !department || !position) throw new Error(`Строка ${index + 1}: заполните тип, отдел и должность.`);
        return env.DB.prepare("INSERT OR IGNORE INTO position_catalog (employment_type, department, position) VALUES (?, ?, ?)").bind(employmentType, department, position);
      });
      for (let offset = 0; offset < statements.length; offset += 100) await env.DB.batch(statements.slice(offset, offset + 100));
      return Response.json({ count: rows.length }, { status: 201 });
    }
    if (payload.action === "import-employees") {
      const rows = payload.employees ?? [];
      if (!rows.length || rows.length > 2000) throw new Error("В файле должно быть от 1 до 2000 сотрудников.");
      const [sitesResult, employeesResult] = await env.DB.batch([
        env.DB.prepare("SELECT id, code, name FROM sites WHERE active = 1"),
        env.DB.prepare("SELECT id, full_name AS fullName FROM employees WHERE active = 1"),
      ]);
      const sitesByKey = new Map<string, number>();
      for (const site of sitesResult.results as Array<{ id: number; code: string; name: string }>) { sitesByKey.set(site.code.toLocaleLowerCase(), site.id); sitesByKey.set(site.name.toLocaleLowerCase(), site.id); }
      const employeesByName = new Map((employeesResult.results as Array<{ id: number; fullName: string }>).map((employee) => [employee.fullName.toLocaleLowerCase(), employee.id]));
      const statements = rows.map((row, index) => {
        const fullName = row.fullName?.trim() ?? "";
        const employmentType = row.employmentType?.trim() ?? "";
        const department = row.department?.trim() ?? "";
        const position = row.position?.trim() ?? "";
        const projectSiteId = sitesByKey.get((row.projectCode?.trim() ?? "").toLocaleLowerCase());
        if (!fullName || !employmentType || !department || !position || !projectSiteId) throw new Error(`Строка ${index + 1}: проверьте ФИО, тип, отдел, должность и проект.`);
        const existingId = employeesByName.get(fullName.toLocaleLowerCase());
        return existingId
          ? env.DB.prepare("UPDATE employees SET employment_type = ?, department = ?, position = ?, site_id = ?, source = 'excel' WHERE id = ?").bind(employmentType, department, position, projectSiteId, existingId)
          : env.DB.prepare("INSERT INTO employees (full_name, employment_type, department, position, source, site_id) VALUES (?, ?, ?, ?, 'excel', ?)").bind(fullName, employmentType, department, position, projectSiteId);
      });
      for (let offset = 0; offset < statements.length; offset += 100) await env.DB.batch(statements.slice(offset, offset + 100));
      return Response.json({ count: rows.length }, { status: 201 });
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
    if (payload.action === "create-directory") {
      const directory = directoryTable(payload.entity);
      const siteId = asPositiveInteger(payload.siteId);
      let name = payload.name?.trim() ?? "";
      if (!directory || !name || (!directory.global && !siteId)) throw new Error("Укажите справочник, объект и название значения.");
      if (directory.key === "shift") throw new Error("Смены фиксированы для всех проектов: день и ночь.");
      if (directory.key === "master") {
        const employeeId = asPositiveInteger(payload.employeeId);
        const employee = employeeId ? await env.DB.prepare(`SELECT e.full_name AS fullName FROM employees e
          JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
          WHERE e.id = ? AND e.active = 1`).bind(siteId, employeeId).first<{ fullName: string }>() : null;
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
    if (Array.isArray(payload.entries)) {
      const rows = await validateBulkPayloads(payload.entries);
      for (let offset = 0; offset < rows.length; offset += 100) {
        await env.DB.batch(rows.slice(offset, offset + 100).map((data) => env.DB.prepare(`INSERT INTO placement_entries
          (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position)));
      }
      return Response.json({ count: rows.length }, { status: 201 });
    }
    const data = await validatePayload(payload);
    const result = await env.DB.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position).run();
    return Response.json({ id: result.meta.last_row_id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить строку." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await initializeDatabase();
    const payload = (await request.json()) as EntryPayload & UserPayload;
    if (payload.action && authUser.role !== "office") return forbidden();
    if (!payload.action && !canManagePlacement(authUser, asPositiveInteger(payload.siteId), payload.workDate)) return forbidden();
    if (payload.action === "update-user") {
      const userId = asPositiveInteger(payload.userId);
      const fullName = payload.fullName?.trim() ?? "";
      const email = payload.email?.trim().toLocaleLowerCase() ?? "";
      const role = payload.role;
      const assignedSiteId = role === "foreman" ? asPositiveInteger(payload.assignedSiteId) : null;
      if (!userId || !fullName || !/^\S+@\S+\.\S+$/.test(email) || !role || (role === "foreman" && !assignedSiteId)) throw new Error("Заполните ФИО, корректный email, роль и объект прораба.");
      const duplicate = await env.DB.prepare("SELECT id FROM app_users WHERE email = ? AND id <> ? AND active = 1").bind(email, userId).first();
      if (duplicate) throw new Error("Пользователь с таким email уже существует.");
      const currentUserRecord = await env.DB.prepare("SELECT role, password_hash AS passwordHash FROM app_users WHERE id = ? AND active = 1").bind(userId).first<{ role: string; passwordHash: string | null }>();
      if (currentUserRecord?.role === "office" && role !== "office") {
        const officeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'office' AND active = 1").first<{ count: number }>();
        if (Number(officeCount?.count ?? 0) <= 1) throw new Error("Нельзя убрать роль «Офис» у последнего администратора.");
      }
      const result = await env.DB.prepare("UPDATE app_users SET full_name = ?, email = ?, role = ?, assigned_site_id = ? WHERE id = ? AND active = 1").bind(fullName, email, role, assignedSiteId, userId).run();
      if (!result.meta.changes) throw new Error("Пользователь не найден.");
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
      if (!employeeId || !fullName || !employmentType || !department || !position || !projectSiteId) throw new Error("Заполните ФИО, тип, отдел, должность и проект рабочего.");
      const project = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(projectSiteId).first();
      if (!project) throw new Error("Выбранный проект не найден или уже закрыт.");
      const duplicate = await env.DB.prepare("SELECT id FROM employees WHERE full_name = ? AND id <> ? AND active = 1").bind(fullName, employeeId).first();
      if (duplicate) throw new Error("Рабочий с таким ФИО уже существует.");
      const result = await env.DB.prepare("UPDATE employees SET full_name = ?, employment_type = ?, department = ?, position = ?, site_id = ? WHERE id = ? AND active = 1").bind(fullName, employmentType, department, position, projectSiteId, employeeId).run();
      if (!result.meta.changes) throw new Error("Рабочий не найден.");
      const existingAssignment = await env.DB.prepare("SELECT id FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? ORDER BY id DESC LIMIT 1").bind(employeeId, projectSiteId).first<{ id: number }>();
      if (existingAssignment) await env.DB.prepare("UPDATE employee_project_assignments SET active = 1, end_date = NULL WHERE id = ?").bind(existingAssignment.id).run();
      else await env.DB.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source) VALUES (?, ?, 'manual')").bind(employeeId, projectSiteId).run();
      return Response.json({ ok: true });
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
      const result = await env.DB.prepare("UPDATE app_users SET assigned_site_id = ? WHERE id = ? AND role = 'foreman' AND active = 1").bind(assignedSiteId, userId).run();
      if (!result.meta.changes) throw new Error("Прораб не найден.");
      return Response.json({ ok: true });
    }
    const id = asPositiveInteger(payload.id);
    if (!id) throw new Error("Не указана строка для изменения.");
    const data = await validatePayload(payload, id);
    await env.DB.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
      main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL`)
      .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position, id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось изменить строку." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await initializeDatabase();
    const url = new URL(request.url);
    const id = asPositiveInteger(url.searchParams.get("id"));
    if (!id) throw new Error("Не указана строка для удаления.");
    const entity = url.searchParams.get("entity");
    if (entity && authUser.role !== "office") return forbidden();
    if (!entity && authUser.role === "foreman") {
      const entry = await env.DB.prepare("SELECT site_id AS siteId, work_date AS workDate FROM placement_entries WHERE id = ? AND deleted_at IS NULL").bind(id).first<{ siteId: number; workDate: string }>();
      if (!entry || !canManagePlacement(authUser, entry.siteId, entry.workDate)) return forbidden();
    }
    if (url.searchParams.get("entity") === "user") {
      if (id === authUser.id) throw new Error("Нельзя удалить собственную учётную запись.");
      const deletingUser = await env.DB.prepare("SELECT role FROM app_users WHERE id = ? AND active = 1").bind(id).first<{ role: string }>();
      if (deletingUser?.role === "office") {
        const officeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role = 'office' AND active = 1").first<{ count: number }>();
        if (Number(officeCount?.count ?? 0) <= 1) throw new Error("Нельзя удалить последнего администратора.");
      }
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE app_users SET active = 0 WHERE id = ? AND active = 1").bind(id),
        env.DB.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").bind(id),
        env.DB.prepare("UPDATE user_invitations SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(id),
      ]);
      const result = results[0];
      if (!result.meta.changes) throw new Error("Пользователь не найден.");
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "employee") {
      const usage = await env.DB.prepare("SELECT id FROM placement_entries WHERE employee_id = ? LIMIT 1").bind(id).first();
      if (usage) throw new Error("Сотрудник используется в отчётах. Сначала удалите связанные строки отчётов.");
      const results = await env.DB.batch([
        env.DB.prepare("DELETE FROM employee_project_assignments WHERE employee_id = ?").bind(id),
        env.DB.prepare("DELETE FROM employees WHERE id = ?").bind(id),
      ]);
      if (!results[1].meta.changes) throw new Error("Рабочий не найден.");
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "employee-assignment") {
      const siteId = asPositiveInteger(url.searchParams.get("siteId"));
      if (!siteId) throw new Error("Не указан проект сотрудника.");
      const result = await env.DB.prepare("UPDATE employee_project_assignments SET active = 0, end_date = DATE('now') WHERE employee_id = ? AND site_id = ? AND active = 1").bind(id, siteId).run();
      if (!result.meta.changes) throw new Error("Сотрудник не относится к выбранному проекту.");
      await env.DB.prepare(`UPDATE employees SET site_id = (
        SELECT MIN(site_id) FROM employee_project_assignments WHERE employee_id = ? AND active = 1
      ) WHERE id = ? AND site_id = ?`).bind(id, id, siteId).run();
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "site") {
      const [activeSites, employees, users, entries] = await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS count FROM sites WHERE active = 1"),
        env.DB.prepare("SELECT id FROM employee_project_assignments WHERE site_id = ? AND active = 1 LIMIT 1").bind(id),
        env.DB.prepare("SELECT id FROM app_users WHERE assigned_site_id = ? AND active = 1 LIMIT 1").bind(id),
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
      return Response.json({ ok: true });
    }
    if (url.searchParams.get("entity") === "directory") {
      const directory = directoryTable(url.searchParams.get("kind"));
      const siteId = asPositiveInteger(url.searchParams.get("siteId"));
      if (!directory || (!directory.global && !siteId)) throw new Error("Не указан справочник или объект.");
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
        result = await env.DB.prepare(`UPDATE ${directory.table} SET active = 0 WHERE id = ? AND site_id = ? AND active = 1`).bind(id, siteId).run();
      }
      if (!result.meta.changes) throw new Error("Значение справочника не найдено.");
      return Response.json({ ok: true });
    }
    await env.DB.prepare("UPDATE placement_entries SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось удалить строку." }, { status: 400 });
  }
}
