import { getDatabase } from "../../../db/client";
import { assertSameOrigin, createInvitation, ensureAuthSchema, getAuthUser, sendInvitationEmail, type AuthUser } from "../../auth";
import { bitrix24Cooldown, type Bitrix24Action, type Bitrix24Cooldowns } from "../../bitrix24Cooldown";
import { fetchBitrixEmployeeSnapshot, normalizeBitrixText, selectBitrixEmployeesForImport, type BitrixEmployeeSnapshot, type EmployeeAvailabilityStatus } from "../../bitrix24Sync";
import { canEditGlobalEmployees, canEditGlobalReferences, canEditProjectSettings, canManageBitrix24, canViewAllProjects, isUserRole, type UserRole } from "../../roles";

const env = { get DB() { return getDatabase(); } };

async function reconcilePositionCatalogOptions() {
  const db = env.DB;
  await db.batch([
    db.prepare("UPDATE personnel_options SET active = 0 WHERE kind = 'employmentType' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND employment_type = personnel_options.name)"),
    db.prepare("UPDATE personnel_options SET active = 0 WHERE kind = 'department' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND department = personnel_options.name)"),
    db.prepare("UPDATE personnel_options SET active = 0 WHERE kind = 'position' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND position = personnel_options.name)"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'employmentType', employment_type FROM position_catalog WHERE employment_type <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'employmentType' AND name = position_catalog.employment_type AND active = 1)"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'department', department FROM position_catalog WHERE department <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'department' AND name = position_catalog.department AND active = 1)"),
    db.prepare("INSERT OR IGNORE INTO personnel_options (kind, name) SELECT DISTINCT 'position', position FROM position_catalog WHERE position <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'position' AND name = position_catalog.position AND active = 1)"),
  ]);
}

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

type ExistingPlacementEntry = {
  id: number;
  siteId: number;
  workDate: string;
  employeeId: number;
  masterId: number;
  hours: number;
  positionSnapshot: string;
  employeeNameSnapshot: string;
  employmentTypeSnapshot: string;
  departmentSnapshot: string;
  masterNameSnapshot: string;
};

type UserPayload = {
  action?: "create-user" | "update-user" | "create-employee" | "update-employee" | "import-employees" | "inspect-bitrix24" | "sync-bitrix24" | "create-position" | "update-position" | "import-positions" | "create-site" | "update-site" | "create-directory" | "update-directory" | "save-directory-items" | "assign-employee-project" | "assign-site";
  userId?: number;
  employeeId?: number;
  positionId?: number;
  directoryId?: number;
  entity?: DirectoryEntity;
  fullName?: string;
  email?: string;
  role?: UserRole;
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
  directories?: Array<{ directoryId?: number; name?: string; employeeId?: number }>;
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
    bitrix24_stage TEXT NOT NULL DEFAULT '',
    availability_status TEXT NOT NULL DEFAULT 'on_site',
    bitrix24_updated_at TEXT,
    last_synced_at TEXT,
    sync_error TEXT,
    sync_miss_count INTEGER NOT NULL DEFAULT 0,
    full_name TEXT NOT NULL,
    employment_type TEXT NOT NULL DEFAULT 'ОПР',
    department TEXT NOT NULL DEFAULT 'УСР',
    position TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'excel',
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS employee_profile_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    employment_type TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    bitrix24_stage TEXT NOT NULL DEFAULT '',
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    source TEXT NOT NULL DEFAULT 'bitrix24'
  )`,
  `CREATE TABLE IF NOT EXISTS employee_availability_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    source TEXT NOT NULL DEFAULT 'bitrix24'
  )`,
  `CREATE TABLE IF NOT EXISTS employee_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'bitrix24',
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    summary TEXT,
    error_text TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS employee_sync_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    bitrix24_id TEXT,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS bitrix24_action_limits (
    action_key TEXT PRIMARY KEY,
    last_started_at TEXT NOT NULL
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
    employee_name_snapshot TEXT NOT NULL DEFAULT '',
    employment_type_snapshot TEXT NOT NULL DEFAULT '',
    department_snapshot TEXT NOT NULL DEFAULT '',
    master_name_snapshot TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT 'demo-user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_site_date ON placement_entries(site_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_active_site_date ON placement_entries(site_id, work_date) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_entries_employee_date ON placement_entries(employee_id, work_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_project_assignment_active ON employee_project_assignments(employee_id, site_id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_employee_project_assignment_site ON employee_project_assignments(site_id, active)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_profile_versions_period ON employee_profile_versions(employee_id, valid_from, valid_to)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_availability_periods_period ON employee_availability_periods(employee_id, valid_from, valid_to)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_sync_issues_run ON employee_sync_issues(run_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_options_kind_name ON personnel_options(kind, name) WHERE active = 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_position_catalog_values ON position_catalog(employment_type, department, position) WHERE active = 1`,
];

async function initializeDatabase() {
  const db = env.DB;
  await ensureAuthSchema();
  await db.batch(TABLE_STATEMENTS.map((statement) => db.prepare(statement)));
  await db.prepare(`INSERT INTO bitrix24_action_limits (action_key, last_started_at)
    SELECT 'sync-bitrix24', MAX(started_at) FROM employee_sync_runs WHERE source = 'bitrix24' HAVING COUNT(*) > 0
    ON CONFLICT (action_key) DO NOTHING`).all();

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
  if (!employeeColumnNames.has("bitrix24_stage")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN bitrix24_stage TEXT NOT NULL DEFAULT ''").run();
  }
  if (!employeeColumnNames.has("availability_status")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'on_site'").run();
  }
  if (!employeeColumnNames.has("bitrix24_updated_at")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN bitrix24_updated_at TEXT").run();
  }
  if (!employeeColumnNames.has("last_synced_at")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN last_synced_at TEXT").run();
  }
  if (!employeeColumnNames.has("sync_error")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN sync_error TEXT").run();
  }
  if (!employeeColumnNames.has("sync_miss_count")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN sync_miss_count INTEGER NOT NULL DEFAULT 0").run();
  }
  const placementColumns = await db.prepare("PRAGMA table_info(placement_entries)").all<{ name: string }>();
  const placementColumnNames = new Set(placementColumns.results.map((column) => column.name));
  for (const column of ["employee_name_snapshot", "employment_type_snapshot", "department_snapshot", "master_name_snapshot"]) {
    if (!placementColumnNames.has(column)) await db.prepare(`ALTER TABLE placement_entries ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`).run();
  }
  await db.batch([
    db.prepare(`UPDATE placement_entries pe SET employee_name_snapshot = e.full_name, employment_type_snapshot = e.employment_type, department_snapshot = e.department
      FROM employees e WHERE pe.employee_id = e.id AND (pe.employee_name_snapshot = '' OR pe.employment_type_snapshot = '' OR pe.department_snapshot = '')`),
    db.prepare(`UPDATE placement_entries pe SET master_name_snapshot = m.name FROM masters m WHERE pe.master_id = m.id AND pe.master_name_snapshot = ''`),
  ]);
  const userColumns = await db.prepare("PRAGMA table_info(app_users)").all<{ name: string }>();
  if (!userColumns.results.some((column) => column.name === "email")) {
    await db.prepare("ALTER TABLE app_users ADD COLUMN email TEXT NOT NULL DEFAULT ''").run();
  }
  async function repairNumericPersonnelValues() {
    const [optionsResult, positionsResult, employeesResult] = await db.batch([
      db.prepare("SELECT id, kind, name FROM personnel_options WHERE active = 1"),
      db.prepare("SELECT id, employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1"),
      db.prepare("SELECT id, employment_type AS employmentType, department, position FROM employees WHERE active = 1 AND source <> 'bitrix24'"),
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
      db.prepare(`DELETE FROM employees
        WHERE active = 0
          AND source <> 'bitrix24'
          AND NOT EXISTS (SELECT 1 FROM placement_entries WHERE employee_id = employees.id)
          AND NOT EXISTS (SELECT 1 FROM employee_project_assignments WHERE employee_id = employees.id)`),
    ]);
  }
  const syncPositionCatalog = () => db.prepare("INSERT OR IGNORE INTO position_catalog (employment_type, department, position) SELECT DISTINCT employment_type, department, position FROM employees WHERE employment_type <> '' AND department <> '' AND position <> '' AND source <> 'bitrix24'").run();
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
    "employee_profile_versions", "employee_availability_periods", "employee_sync_runs", "employee_sync_issues",
    "employee_project_assignments", "position_catalog", "personnel_options", "shifts", "zones",
    "main_work_types", "subwork_types", "masters", "placement_entries",
  ].map((table) => db.prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS (SELECT 1 FROM ${table}))`)));

  const siteCount = await db.prepare("SELECT COUNT(*) AS count FROM sites").first<{ count: number }>();
  if ((siteCount?.count ?? 0) > 0) {
    await db.prepare("UPDATE sites SET timezone = 'Europe/Moscow' WHERE timezone <> 'Europe/Moscow'").run();
    await db.prepare("UPDATE employees SET site_id = 1 WHERE site_id IS NULL AND source <> 'bitrix24'").run();
    await repairNumericPersonnelValues();
    await syncMasterEmployees();
    await syncPositionCatalog();
    await reconcilePositionCatalogOptions();
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
  await syncPositionCatalog();
  await reconcilePositionCatalogOptions();
  await syncEmployeeAssignments();
  await ensureStandardShifts();
  await syncIdentitySequences();
  await db.prepare("PRAGMA optimize").run();
}

type DataGlobals = typeof globalThis & {
  personnelDatabaseInitializationPromise?: Promise<void>;
};

function ensureDatabaseInitialized() {
  const globals = globalThis as DataGlobals;
  if (!globals.personnelDatabaseInitializationPromise) {
    const initializationTask = process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true"
      ? env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_entries_active_site_date ON placement_entries(site_id, work_date) WHERE deleted_at IS NULL").run().then(() => undefined)
      : initializeDatabase();
    globals.personnelDatabaseInitializationPromise = initializationTask.catch((error) => {
      delete globals.personnelDatabaseInitializationPromise;
      throw error;
    });
  }
  return globals.personnelDatabaseInitializationPromise;
}

function unauthorized() {
  return Response.json({ error: "Требуется вход в систему." }, { status: 401 });
}

function forbidden() {
  return Response.json({ error: "У вас нет прав для этого действия." }, { status: 403 });
}

type Bitrix24ActionLimitRow = { actionKey: Bitrix24Action; lastStartedAt: string | Date };

class Bitrix24CooldownError extends Error {
  constructor(readonly cooldown: ReturnType<typeof bitrix24Cooldown>) {
    super(`Повторный запрос к Битрикс24 будет доступен через ${Math.max(1, Math.ceil(cooldown.remainingSeconds / 60))} мин.`);
  }
}

function mapBitrix24Cooldowns(rows: Bitrix24ActionLimitRow[]): Bitrix24Cooldowns {
  const byAction = new Map(rows.map((row) => [row.actionKey, row.lastStartedAt]));
  return {
    inspect: bitrix24Cooldown(byAction.get("inspect-bitrix24")),
    sync: bitrix24Cooldown(byAction.get("sync-bitrix24")),
  };
}

async function reserveBitrix24Action(action: Bitrix24Action) {
  return env.DB.transaction(async (db) => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`personnel-${action}-cooldown`).first();
    const previous = await db.prepare("SELECT last_started_at AS lastStartedAt FROM bitrix24_action_limits WHERE action_key = ?")
      .bind(action).first<{ lastStartedAt: string | Date }>();
    const cooldown = bitrix24Cooldown(previous?.lastStartedAt);
    if (cooldown.remainingSeconds > 0) throw new Bitrix24CooldownError(cooldown);
    const startedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO bitrix24_action_limits (action_key, last_started_at) VALUES (?, ?)
      ON CONFLICT (action_key) DO UPDATE SET last_started_at = EXCLUDED.last_started_at`).bind(action, startedAt).all();
    return bitrix24Cooldown(startedAt);
  });
}

function todayInMoscow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canManagePlacement(user: AuthUser, siteId: number | undefined, workDate: string | undefined) {
  return user.role !== "foreman" || (user.assignedSiteId === siteId && workDate === todayInMoscow());
}

function canRunAction(role: UserRole, payload: UserPayload) {
  const action = payload.action;
  if (!action) return true;
  if (action === "inspect-bitrix24" || action === "sync-bitrix24") return canManageBitrix24(role);
  if (action === "create-employee" || action === "update-employee" || action === "import-employees") return canEditGlobalEmployees(role);
  if (action === "assign-employee-project" || action === "save-directory-items") return canEditProjectSettings(role);
  if (action === "create-directory" || action === "update-directory") {
    const directory = directoryTable(payload.entity);
    return directory?.global ? canEditGlobalReferences(role) : canEditProjectSettings(role);
  }
  return canEditGlobalReferences(role);
}

function canDeleteEntity(role: UserRole, entity: string | null, kind: string | null) {
  if (!entity) return true;
  if (entity === "employee") return canEditGlobalEmployees(role);
  if (entity === "employee-assignment") return canEditProjectSettings(role);
  if (entity === "directory") {
    const directory = directoryTable(kind);
    return directory?.global ? canEditGlobalReferences(role) : canEditProjectSettings(role);
  }
  return canEditGlobalReferences(role);
}

function asPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function placementEntriesStatement(siteId: number, workDate: string) {
  return env.DB.prepare(`SELECT pe.id, pe.site_id AS siteId, pe.work_date AS workDate, pe.employee_id AS employeeId,
    pe.shift_id AS shiftId, pe.zone_id AS zoneId, pe.main_work_type_id AS mainWorkTypeId,
    pe.subwork_type_id AS subworkTypeId, pe.note, pe.master_id AS masterId, pe.hours,
    pe.position_snapshot AS positionSnapshot,
    COALESCE(NULLIF(pe.employee_name_snapshot, ''), e.full_name) AS employeeName,
    COALESCE(NULLIF(pe.employment_type_snapshot, ''), e.employment_type) AS employmentType,
    COALESCE(NULLIF(pe.department_snapshot, ''), e.department) AS department,
    s.name AS shiftName, z.name AS zoneName, mw.name AS mainWorkTypeName, sw.name AS subworkTypeName,
    COALESCE(NULLIF(pe.master_name_snapshot, ''), m.name) AS masterName
    FROM placement_entries pe
    JOIN employees e ON e.id = pe.employee_id
    JOIN shifts s ON s.id = pe.shift_id
    JOIN zones z ON z.id = pe.zone_id
    JOIN main_work_types mw ON mw.id = pe.main_work_type_id
    JOIN subwork_types sw ON sw.id = pe.subwork_type_id
    JOIN masters m ON m.id = pe.master_id
    WHERE pe.site_id = ? AND pe.work_date = ? AND pe.deleted_at IS NULL
    ORDER BY e.full_name, pe.created_at, pe.id`).bind(siteId, workDate);
}

function filledDatesStatement(siteId: number, rangeStart: string, rangeEnd: string) {
  return env.DB.prepare(`SELECT DISTINCT work_date AS "workDate"
    FROM placement_entries
    WHERE site_id = ? AND work_date >= ? AND work_date <= ? AND deleted_at IS NULL
    ORDER BY work_date`).bind(siteId, rangeStart, rangeEnd);
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

  const existing = excludedId ? await env.DB.prepare(`SELECT employee_id AS employeeId, site_id AS siteId, master_id AS masterId,
    position_snapshot AS positionSnapshot, employee_name_snapshot AS employeeNameSnapshot,
    employment_type_snapshot AS employmentTypeSnapshot, department_snapshot AS departmentSnapshot,
    master_name_snapshot AS masterNameSnapshot FROM placement_entries WHERE id = ? AND deleted_at IS NULL`)
    .bind(excludedId).first<Omit<ExistingPlacementEntry, "id" | "workDate" | "hours">>() : null;
  const keepHistoricalEmployee = existing?.employeeId === employeeId && existing.siteId === siteId;
  const employee = keepHistoricalEmployee
    ? { position: existing.positionSnapshot, fullName: existing.employeeNameSnapshot, employmentType: existing.employmentTypeSnapshot, department: existing.departmentSnapshot }
    : await env.DB.prepare(`SELECT e.position, e.full_name AS fullName, e.employment_type AS employmentType, e.department
      FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
      WHERE e.id = ? AND e.active = 1 AND e.availability_status = 'on_site' AND e.sync_error IS NULL`)
      .bind(siteId, employeeId).first<{ position: string; fullName: string; employmentType: string; department: string }>();
  if (!employee?.position) throw new Error("Сотрудник недоступен для выбранного объекта или у него не заполнена должность.");

  const refs = await env.DB.batch([
    env.DB.prepare("SELECT id FROM shifts WHERE id = ? AND site_id = ? AND active = 1").bind(shiftId, siteId),
    env.DB.prepare("SELECT id FROM zones WHERE id = ? AND site_id = ? AND active = 1").bind(zoneId, siteId),
    env.DB.prepare("SELECT id FROM main_work_types WHERE id = ? AND site_id = ? AND active = 1").bind(mainWorkTypeId, siteId),
    env.DB.prepare("SELECT id FROM subwork_types WHERE id = ? AND site_id = ? AND active = 1").bind(subworkTypeId, siteId),
    keepHistoricalEmployee && existing?.masterId === masterId
      ? env.DB.prepare("SELECT id FROM masters WHERE id = ? AND site_id = ?").bind(masterId, siteId)
      : env.DB.prepare("SELECT id FROM masters WHERE id = ? AND site_id = ? AND active = 1").bind(masterId, siteId),
  ]);
  if (refs.some((result) => result.results.length === 0)) throw new Error("Одно из значений не относится к выбранному объекту.");

  const excluded = excludedId ? "AND id <> ?" : "";
  const statement = env.DB.prepare(`SELECT COALESCE(SUM(hours), 0) AS used FROM placement_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL ${excluded}`);
  const total = excludedId
    ? await statement.bind(employeeId, payload.workDate, excludedId).first<{ used: number }>()
    : await statement.bind(employeeId, payload.workDate).first<{ used: number }>();
  const used = Number(total?.used ?? 0);
  if (used + hours > 10) throw new Error(`У сотрудника уже учтено ${used} ч. После сохранения получится ${used + hours} ч., максимум — 10.`);

  const master = keepHistoricalEmployee && existing?.masterId === masterId
    ? { name: existing.masterNameSnapshot }
    : await env.DB.prepare("SELECT name FROM masters WHERE id = ?").bind(masterId).first<{ name: string }>();
  return {
    siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate: payload.workDate,
    note: payload.note?.trim() ?? "", position: employee.position, employeeName: employee.fullName,
    employmentType: employee.employmentType, department: employee.department, masterName: master?.name ?? "",
  };
}

async function validateBulkPayloads(payloads: EntryPayload[], existingRows: ExistingPlacementEntry[] = []) {
  if (payloads.length === 0) throw new Error("Добавьте хотя бы одного сотрудника.");
  if (payloads.length > 1000) throw new Error("За один раз можно сохранить не более 1000 строк.");

  const siteId = asPositiveInteger(payloads[0].siteId);
  const workDate = payloads[0].workDate;
  if (!siteId || !validDate(workDate)) throw new Error("Не указан объект или рабочий день.");
  if (payloads.some((payload) => asPositiveInteger(payload.siteId) !== siteId || payload.workDate !== workDate)) {
    throw new Error("Все строки группы должны относиться к одному объекту и дню.");
  }

  const [employeesResult, shiftsResult, zonesResult, mainWorksResult, subworksResult, mastersResult, totalsResult] = await env.DB.batch([
    env.DB.prepare(`SELECT e.id, e.position, e.full_name AS fullName, e.employment_type AS employmentType, e.department
      FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
      WHERE e.active = 1 AND e.availability_status = 'on_site' AND e.sync_error IS NULL`).bind(siteId),
    env.DB.prepare("SELECT id FROM shifts WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM zones WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM main_work_types WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id FROM subwork_types WHERE site_id = ? AND active = 1").bind(siteId),
    env.DB.prepare("SELECT id, name, active FROM masters WHERE site_id = ?").bind(siteId),
    env.DB.prepare("SELECT employee_id AS employeeId, SUM(hours) AS used FROM placement_entries WHERE work_date = ? AND deleted_at IS NULL GROUP BY employee_id").bind(workDate),
  ]);

  const employees = new Map((employeesResult.results as Array<{ id: number; position: string; fullName: string; employmentType: string; department: string }>).map((employee) => [employee.id, employee]));
  const shifts = new Set((shiftsResult.results as Array<{ id: number }>).map((item) => item.id));
  const zones = new Set((zonesResult.results as Array<{ id: number }>).map((item) => item.id));
  const mainWorks = new Set((mainWorksResult.results as Array<{ id: number }>).map((item) => item.id));
  const subworks = new Set((subworksResult.results as Array<{ id: number }>).map((item) => item.id));
  const masters = new Map((mastersResult.results as Array<{ id: number; name: string; active: number }>).map((item) => [item.id, item]));
  const existingById = new Map(existingRows.map((entry) => [entry.id, entry]));
  const totals = new Map((totalsResult.results as Array<{ employeeId: number; used: number }>).map((item) => [item.employeeId, Number(item.used)]));
  for (const existing of existingRows) {
    if (existing.workDate !== workDate) continue;
    totals.set(existing.employeeId, Math.max(0, (totals.get(existing.employeeId) ?? 0) - Number(existing.hours)));
  }
  const added = new Map<number, number>();

  return payloads.map((payload, index) => {
    const employeeId = asPositiveInteger(payload.employeeId);
    const shiftId = asPositiveInteger(payload.shiftId);
    const zoneId = asPositiveInteger(payload.zoneId);
    const mainWorkTypeId = asPositiveInteger(payload.mainWorkTypeId);
    const subworkTypeId = asPositiveInteger(payload.subworkTypeId);
    const masterId = asPositiveInteger(payload.masterId);
    const hours = asPositiveInteger(payload.hours);
    const existing = payload.id ? existingById.get(payload.id) : undefined;
    const keepHistoricalEmployee = existing?.employeeId === employeeId && existing.siteId === siteId;
    const currentEmployee = employeeId ? employees.get(employeeId) : undefined;
    const employee = keepHistoricalEmployee && existing
      ? { position: existing.positionSnapshot, fullName: existing.employeeNameSnapshot, employmentType: existing.employmentTypeSnapshot, department: existing.departmentSnapshot }
      : currentEmployee;
    const master = masterId ? masters.get(masterId) : undefined;
    const keepHistoricalMaster = existing?.masterId === masterId && existing.siteId === siteId;

    if (!employeeId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !masterId || !hours) {
      throw new Error(`Строка ${index + 1}: заполните все обязательные поля.`);
    }
    if (hours < 1 || hours > 10) throw new Error(`Строка ${index + 1}: количество часов должно быть от 1 до 10.`);
    if (!employee?.position) throw new Error(`Строка ${index + 1}: сотрудник недоступен или у него не заполнена должность.`);
    if (!shifts.has(shiftId) || !zones.has(zoneId) || !mainWorks.has(mainWorkTypeId) || !subworks.has(subworkTypeId) || !master || (!master.active && !keepHistoricalMaster)) {
      throw new Error(`Строка ${index + 1}: одно из значений не относится к объекту.`);
    }

    const employeeTotal = (totals.get(employeeId) ?? 0) + (added.get(employeeId) ?? 0) + hours;
    if (employeeTotal > 10) throw new Error(`Строка ${index + 1}: у сотрудника получится ${employeeTotal} ч., максимум — 10.`);
    added.set(employeeId, (added.get(employeeId) ?? 0) + hours);

    return {
      siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate,
      note: payload.note?.trim() ?? "", position: employee.position, employeeName: employee.fullName,
      employmentType: employee.employmentType, department: employee.department,
      masterName: keepHistoricalMaster && existing ? existing.masterNameSnapshot : master.name,
    };
  });
}

async function validateEmployeeDirectoryValues(employmentType: string, department: string, position: string, projectSiteId: number) {
  const refs = await env.DB.batch([
    env.DB.prepare("SELECT id FROM personnel_options WHERE kind = 'employmentType' AND name = ? AND active = 1").bind(employmentType),
    env.DB.prepare("SELECT id FROM personnel_options WHERE kind = 'department' AND name = ? AND active = 1").bind(department),
    env.DB.prepare("SELECT id FROM personnel_options WHERE kind = 'position' AND name = ? AND active = 1").bind(position),
    env.DB.prepare("SELECT id FROM position_catalog WHERE employment_type = ? AND department = ? AND position = ? AND active = 1").bind(employmentType, department, position),
    env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(projectSiteId),
  ]);
  if (!refs[0].results.length) throw new Error(`Значение «${employmentType}» не относится к столбцу «Тип».`);
  if (!refs[1].results.length) throw new Error(`Значение «${department}» не относится к столбцу «Отдел».`);
  if (!refs[2].results.length) throw new Error(`Значение «${position}» не относится к столбцу «Должность».`);
  if (!refs[3].results.length) throw new Error("Сочетание типа, отдела и должности отсутствует в справочнике должностей.");
  if (!refs[4].results.length) throw new Error("Выбранный проект не найден или уже закрыт.");
}

type ExistingBitrixEmployee = {
  id: number;
  bitrix24Id: string;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  bitrix24Stage: string;
  availabilityStatus: EmployeeAvailabilityStatus;
  active: number;
  syncMissCount: number;
  siteId: number | null;
};

type EmployeeSyncIssue = { bitrix24Id: string | null; code: string; message: string };

function employeeProfileChanged(existing: ExistingBitrixEmployee | undefined, employee: BitrixEmployeeSnapshot) {
  return !existing || existing.fullName !== employee.fullName || existing.employmentType !== employee.employmentType
    || existing.department !== employee.department || existing.position !== employee.position || existing.bitrix24Stage !== employee.stageName;
}

function projectOverrides() {
  const raw = process.env.BITRIX24_PROJECT_MAP?.trim();
  if (!raw) return {} as Record<string, string>;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("BITRIX24_PROJECT_MAP должен содержать корректный JSON-объект."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BITRIX24_PROJECT_MAP должен быть JSON-объектом.");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [normalizeBitrixText(key), String(value)]));
}

async function synchronizeBitrixEmployees() {
  if (process.env.BITRIX24_SYNC_ENABLED !== "true") {
    throw new Error("Применение данных Битрикс24 отключено. После проверки подключения установите BITRIX24_SYNC_ENABLED=true.");
  }
  const rootDb = env.DB;
  const startedAt = new Date().toISOString();
  const runResult = await rootDb.prepare("INSERT INTO employee_sync_runs (source, status, started_at) VALUES ('bitrix24', 'running', ?)").bind(startedAt).run();
  const runId = Number(runResult.meta.last_row_id);
  try {
    const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
    if (!sourceSnapshot.length) throw new Error("Битрикс24 вернул пустой список сотрудников. Изменения не применены.");
    const snapshot = selectBitrixEmployeesForImport(sourceSnapshot);
    if (!snapshot.length) throw new Error("По настроенным стадиям и объектам не найдено ни одного сотрудника. Изменения не применены.");
    const sourceById = new Map(sourceSnapshot.filter((employee) => employee.bitrix24Id).map((employee) => [employee.bitrix24Id, employee]));
    return await rootDb.transaction(async (db) => {
    const lock = await db.prepare("SELECT pg_try_advisory_xact_lock(hashtext('personnel-bitrix24-employee-sync')) AS locked").first<{ locked: boolean }>();
    if (!lock?.locked) throw new Error("Актуализация из Битрикс24 уже выполняется. Дождитесь её завершения.");
    const [sitesResult, positionsResult, existingResult, manualEmployeesResult, profileVersionsResult] = await db.readBatch([
      db.prepare("SELECT id, name, code FROM sites WHERE active = 1"),
      db.prepare("SELECT employment_type AS employmentType, department, position FROM position_catalog WHERE active = 1"),
      db.prepare(`SELECT id, bitrix24_id AS bitrix24Id, full_name AS fullName, employment_type AS employmentType, department, position,
        bitrix24_stage AS bitrix24Stage, availability_status AS availabilityStatus, active, sync_miss_count AS syncMissCount, site_id AS siteId
        FROM employees WHERE source = 'bitrix24' AND bitrix24_id IS NOT NULL`),
      db.prepare("SELECT id, full_name AS fullName FROM employees WHERE source <> 'bitrix24' AND active = 1"),
      db.prepare("SELECT employee_id AS employeeId FROM employee_profile_versions WHERE valid_to IS NULL"),
    ]);
    const sites = sitesResult.results as Array<{ id: number; name: string; code: string }>;
    const siteByKey = new Map<string, number>();
    sites.forEach((site) => { siteByKey.set(normalizeBitrixText(site.name), site.id); siteByKey.set(normalizeBitrixText(site.code), site.id); });
    const overrides = projectOverrides();
    const positions = new Set((positionsResult.results as Array<{ employmentType: string; department: string; position: string }>).map((row) =>
      [row.employmentType, row.department, row.position].map(normalizeBitrixText).join("\u0000")));
    const existingByBitrixId = new Map((existingResult.results as ExistingBitrixEmployee[]).map((employee) => [employee.bitrix24Id, employee]));
    const profileVersionEmployeeIds = new Set((profileVersionsResult.results as Array<{ employeeId: number }>).map((version) => version.employeeId));
    const manualNames = new Set((manualEmployeesResult.results as Array<{ fullName: string }>).map((employee) => normalizeBitrixText(employee.fullName)));
    const seen = new Set<string>();
    const issues: EmployeeSyncIssue[] = [];
    const prepared: Array<BitrixEmployeeSnapshot & { siteIds: number[]; syncError: string | null; active: number }> = [];

    for (const employee of snapshot) {
      if (!employee.bitrix24Id) { issues.push({ bitrix24Id: null, code: "missing_id", message: `Карточка «${employee.fullName || "Без названия"}» не содержит ID.` }); continue; }
      if (seen.has(employee.bitrix24Id)) { issues.push({ bitrix24Id: employee.bitrix24Id, code: "duplicate_id", message: "Один ID сотрудника повторяется в ответе Битрикс24." }); continue; }
      seen.add(employee.bitrix24Id);
      const errors: string[] = [];
      if (!employee.fullName || !employee.employmentType || !employee.department || !employee.position) errors.push("не заполнены ФИО, тип, отдел или должность");
      const positionKey = [employee.employmentType, employee.department, employee.position].map(normalizeBitrixText).join("\u0000");
      if (employee.employmentType && employee.department && employee.position && !positions.has(positionKey)) errors.push("сочетание типа, отдела и должности отсутствует в справочнике");
      const siteIds = [...new Set(employee.projectKeys.flatMap((key) => {
        const normalized = normalizeBitrixText(key);
        const target = overrides[normalized] ?? key;
        const siteId = siteByKey.get(normalizeBitrixText(target));
        if (!siteId) errors.push(`проект «${key}» не найден`);
        return siteId ? [siteId] : [];
      }))];
      if (employee.availabilityStatus === "on_site" && !siteIds.length) errors.push("для стадии на объекте не указан распознанный проект");
      if (employee.availabilityStatus === "unknown") errors.push(`для стадии «${employee.stageName || employee.stageId || "не указана"}» не настроена доступность`);
      if (!existingByBitrixId.has(employee.bitrix24Id) && manualNames.has(normalizeBitrixText(employee.fullName))) {
        issues.push({ bitrix24Id: employee.bitrix24Id, code: "possible_duplicate_name", message: `В ручном справочнике уже есть сотрудник с ФИО «${employee.fullName}». Карточки не объединены автоматически.` });
      }
      const syncError = errors.length ? errors.join("; ") : null;
      if (syncError) issues.push({ bitrix24Id: employee.bitrix24Id, code: "invalid_employee", message: `${employee.fullName || `ID ${employee.bitrix24Id}`}: ${syncError}.` });
      prepared.push({ ...employee, siteIds, syncError, active: employee.availabilityStatus === "dismissed" || employee.availabilityStatus === "deleted" ? 0 : 1 });
    }

    const upserts = prepared.map((employee) => {
      const existing = existingByBitrixId.get(employee.bitrix24Id);
      const safeEmployee = employee.syncError && existing
        ? { ...employee, fullName: existing.fullName, employmentType: existing.employmentType, department: existing.department, position: existing.position }
        : employee;
      const primarySiteId = employee.siteIds[0] ?? null;
      return db.prepare(`INSERT INTO employees
        (bitrix24_id, bitrix24_stage, availability_status, bitrix24_updated_at, last_synced_at, sync_error, sync_miss_count,
         full_name, employment_type, department, position, source, site_id, active)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'bitrix24', ?, ?)
        ON CONFLICT (bitrix24_id) DO UPDATE SET
          bitrix24_stage = EXCLUDED.bitrix24_stage,
          availability_status = EXCLUDED.availability_status,
          bitrix24_updated_at = EXCLUDED.bitrix24_updated_at,
          last_synced_at = EXCLUDED.last_synced_at,
          sync_error = EXCLUDED.sync_error,
          sync_miss_count = 0,
          full_name = EXCLUDED.full_name,
          employment_type = EXCLUDED.employment_type,
          department = EXCLUDED.department,
          position = EXCLUDED.position,
          source = 'bitrix24',
          site_id = CASE WHEN EXCLUDED.active = 0 THEN NULL ELSE COALESCE(EXCLUDED.site_id, employees.site_id) END,
          active = EXCLUDED.active`)
        .bind(employee.bitrix24Id, employee.stageName, employee.availabilityStatus, employee.sourceUpdatedAt, startedAt, employee.syncError,
          safeEmployee.fullName, safeEmployee.employmentType, safeEmployee.department, safeEmployee.position, primarySiteId, employee.active);
    });
    for (let offset = 0; offset < upserts.length; offset += 100) await db.batch(upserts.slice(offset, offset + 100));

    const refreshed = await db.prepare(`SELECT id, bitrix24_id AS bitrix24Id, full_name AS fullName, employment_type AS employmentType, department, position,
      bitrix24_stage AS bitrix24Stage, availability_status AS availabilityStatus, active, sync_miss_count AS syncMissCount, site_id AS siteId
      FROM employees WHERE source = 'bitrix24' AND bitrix24_id IS NOT NULL`).all<ExistingBitrixEmployee>();
    const refreshedByBitrixId = new Map(refreshed.results.map((employee) => [employee.bitrix24Id, employee]));
    const historyStatements = [];
    const assignmentStatements = [];
    const outOfScopeStatements = [];
    let added = 0;
    let updated = 0;
    let unavailable = 0;
    let archived = 0;
    let moved = 0;

    for (const employee of prepared) {
      const previous = existingByBitrixId.get(employee.bitrix24Id);
      const current = refreshedByBitrixId.get(employee.bitrix24Id);
      if (!current) continue;
      if (!previous) added += 1;
      else if (employeeProfileChanged(previous, employee) || previous.availabilityStatus !== employee.availabilityStatus || previous.active !== employee.active) updated += 1;
      if (employee.availabilityStatus !== "on_site" && employee.active) unavailable += 1;
      if (!employee.active && (!previous || previous.active)) archived += 1;
      if (!employee.syncError && (employeeProfileChanged(previous, employee) || !profileVersionEmployeeIds.has(current.id))) {
        const effectiveAt = employee.sourceUpdatedAt ?? startedAt;
        historyStatements.push(db.prepare("UPDATE employee_profile_versions SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(effectiveAt, current.id));
        historyStatements.push(db.prepare(`INSERT INTO employee_profile_versions
          (employee_id, full_name, employment_type, department, position, bitrix24_stage, valid_from, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'bitrix24')`)
          .bind(current.id, current.fullName, current.employmentType, current.department, current.position, employee.stageName, effectiveAt));
        profileVersionEmployeeIds.add(current.id);
      }
      if (!previous || previous.availabilityStatus !== employee.availabilityStatus) {
        historyStatements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(startedAt, current.id));
        historyStatements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')").bind(current.id, employee.availabilityStatus, startedAt));
      }
      if (employee.syncError) continue;
      if (!employee.active) {
        assignmentStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE WHERE employee_id = ? AND active = 1").bind(current.id));
        continue;
      }
      if (!employee.siteIds.length && ["transfer", "intershift", "vacation", "sick_leave"].includes(employee.availabilityStatus)) continue;
      if (employee.siteIds.length) {
        const placeholders = employee.siteIds.map(() => "?").join(", ");
        assignmentStatements.push(db.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE
          WHERE employee_id = ? AND active = 1 AND site_id NOT IN (${placeholders})`).bind(current.id, ...employee.siteIds));
        for (const siteId of employee.siteIds) {
          assignmentStatements.push(db.prepare(`UPDATE employee_project_assignments SET active = 1, end_date = NULL, source = 'bitrix24'
            WHERE id = (SELECT id FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 0 ORDER BY id DESC LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1)`)
            .bind(current.id, siteId, current.id, siteId));
          assignmentStatements.push(db.prepare(`INSERT INTO employee_project_assignments (employee_id, site_id, source, start_date)
            SELECT ?, ?, 'bitrix24', CURRENT_DATE WHERE NOT EXISTS
            (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1)`).bind(current.id, siteId, current.id, siteId));
        }
        if (previous && employee.siteIds.length && previous.siteId !== employee.siteIds[0]) moved += 1;
      }
    }
    for (const employee of existingResult.results as ExistingBitrixEmployee[]) {
      const source = sourceById.get(employee.bitrix24Id);
      if (!source || seen.has(employee.bitrix24Id)) continue;
      const nextStatus: EmployeeAvailabilityStatus = source.availabilityStatus === "dismissed" ? "dismissed" : "out_of_scope";
      outOfScopeStatements.push(db.prepare(`UPDATE employees SET bitrix24_stage = ?, availability_status = ?, bitrix24_updated_at = ?,
        last_synced_at = ?, sync_error = NULL, sync_miss_count = 0, site_id = NULL, active = 0 WHERE id = ?`)
        .bind(source.stageName, nextStatus, source.sourceUpdatedAt, startedAt, employee.id));
      assignmentStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE WHERE employee_id = ? AND active = 1").bind(employee.id));
      if (employee.availabilityStatus !== nextStatus) {
        historyStatements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(startedAt, employee.id));
        historyStatements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, ?, ?, 'bitrix24')").bind(employee.id, nextStatus, startedAt));
      }
      if (employee.active) archived += 1;
    }
    for (let offset = 0; offset < outOfScopeStatements.length; offset += 100) await db.batch(outOfScopeStatements.slice(offset, offset + 100));
    for (let offset = 0; offset < historyStatements.length; offset += 100) await db.batch(historyStatements.slice(offset, offset + 100));
    for (let offset = 0; offset < assignmentStatements.length; offset += 100) await db.batch(assignmentStatements.slice(offset, offset + 100));

    const missing = (existingResult.results as ExistingBitrixEmployee[]).filter((employee) => !sourceById.has(employee.bitrix24Id));
    if (missing.length) {
      const missingStatements = [];
      for (const employee of missing) {
        missingStatements.push(db.prepare("UPDATE employees SET sync_miss_count = sync_miss_count + 1, last_synced_at = ? WHERE id = ?").bind(startedAt, employee.id));
        if (employee.syncMissCount >= 1 && employee.availabilityStatus !== "deleted") {
          missingStatements.push(db.prepare("UPDATE employees SET active = 0, availability_status = 'deleted', bitrix24_stage = 'Удалён из Битрикс24', site_id = NULL WHERE id = ?").bind(employee.id));
          missingStatements.push(db.prepare("UPDATE employee_project_assignments SET active = 0, end_date = CURRENT_DATE WHERE employee_id = ? AND active = 1").bind(employee.id));
          missingStatements.push(db.prepare("UPDATE employee_availability_periods SET valid_to = ? WHERE employee_id = ? AND valid_to IS NULL").bind(startedAt, employee.id));
          missingStatements.push(db.prepare("INSERT INTO employee_availability_periods (employee_id, status, valid_from, source) VALUES (?, 'deleted', ?, 'bitrix24')").bind(employee.id, startedAt));
          archived += 1;
        }
      }
      for (let offset = 0; offset < missingStatements.length; offset += 100) await db.batch(missingStatements.slice(offset, offset + 100));
    }

    if (issues.length) {
      const issueStatements = issues.map((issue) => db.prepare("INSERT INTO employee_sync_issues (run_id, bitrix24_id, code, message) VALUES (?, ?, ?, ?)").bind(runId, issue.bitrix24Id, issue.code, issue.message));
      for (let offset = 0; offset < issueStatements.length; offset += 100) await db.batch(issueStatements.slice(offset, offset + 100));
    }
    const summary = { sourceReceived: sourceSnapshot.length, received: snapshot.length, excluded: sourceSnapshot.length - snapshot.length, added, updated, moved, unavailable, archived, issues: issues.length };
    await db.prepare("UPDATE employee_sync_runs SET status = 'success', completed_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?").bind(JSON.stringify(summary), runId).run();
    return { runId, ...summary, issueMessages: issues.slice(0, 10).map((issue) => issue.message) };
    });
  } catch (error) {
    await rootDb.prepare("UPDATE employee_sync_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_text = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message : "Неизвестная ошибка синхронизации", runId).run();
    throw error;
  }
}

export async function GET(request: Request) {
  try {
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await ensureDatabaseInitialized();
    const url = new URL(request.url);
    const requestedSiteId = asPositiveInteger(url.searchParams.get("siteId")) ?? 1;
    const siteId = authUser.role === "foreman" ? authUser.assignedSiteId ?? requestedSiteId : requestedSiteId;
    const workDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    if (!validDate(workDate)) throw new Error("Некорректная дата отчёта.");
    const rangeStart = url.searchParams.get("rangeStart") ?? workDate;
    const rangeEnd = url.searchParams.get("rangeEnd") ?? workDate;
    if (!validDate(rangeStart) || !validDate(rangeEnd) || rangeStart > rangeEnd) throw new Error("Некорректный диапазон дат отчёта.");
    const scope = url.searchParams.get("scope");
    if (scope === "entries") {
      const [entries, filledDates] = await env.DB.readBatch([
        placementEntriesStatement(siteId, workDate),
        filledDatesStatement(siteId, rangeStart, rangeEnd),
      ]);
      return Response.json({ entries: entries.results, filledDates: filledDates.results.map((row) => (row as { workDate: string }).workDate) });
    }
    if (scope === "workspace") {
      const [sites, placementEmployees, shifts, zones, mainWorkTypes, subworkTypes, masters, entries, filledDates] = await env.DB.readBatch([
        env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
        env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source,
          e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError,
          epa.site_id AS siteId, s.name AS siteName
          FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1 JOIN sites s ON s.id = epa.site_id AND s.active = 1
          WHERE e.active = 1 AND e.availability_status = 'on_site' AND e.sync_error IS NULL AND epa.site_id = ? ORDER BY e.full_name`).bind(siteId),
        env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
        env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
        env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
        env.DB.prepare("SELECT id, name FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
        env.DB.prepare("SELECT id, name FROM masters WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
        placementEntriesStatement(siteId, workDate),
        filledDatesStatement(siteId, rangeStart, rangeEnd),
      ]);
      return Response.json({
        sites: canViewAllProjects(authUser.role) ? sites.results : sites.results.filter((site) => (site as { id: number }).id === siteId),
        employees: placementEmployees.results,
        placementEmployees: placementEmployees.results,
        projectEmployees: placementEmployees.results,
        positionCatalog: [],
        employmentTypes: [],
        departments: [],
        positions: [],
        shifts: shifts.results,
        zones: zones.results,
        mainWorkTypes: mainWorkTypes.results,
        subworkTypes: subworkTypes.results,
        masters: masters.results,
        entries: entries.results,
        filledDates: filledDates.results.map((row) => (row as { workDate: string }).workDate),
        users: [],
      });
    }
    const [sites, employees, placementEmployees, projectEmployees, positionCatalog, employmentTypes, departments, positions, shifts, zones, mainWorkTypes, subworkTypes, masters, entries, filledDates, users, syncStatus, bitrix24ActionLimits] = await env.DB.readBatch([
      env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
      env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source,
        e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError, e.last_synced_at AS lastSyncedAt,
        MIN(epa.site_id) AS siteId, STRING_AGG(assigned_site.name, ', ' ORDER BY assigned_site.name) AS siteName
        FROM employees e
        LEFT JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1
        LEFT JOIN sites assigned_site ON assigned_site.id = epa.site_id AND assigned_site.active = 1
        WHERE e.active = 1 OR e.source = 'bitrix24'
        GROUP BY e.id, e.full_name, e.employment_type, e.department, e.position, e.source, e.bitrix24_stage, e.availability_status, e.sync_error, e.last_synced_at
        ORDER BY e.full_name`),
      env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source,
        e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError,
        epa.site_id AS siteId, s.name AS siteName
        FROM employees e JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.active = 1 JOIN sites s ON s.id = epa.site_id AND s.active = 1
        WHERE e.active = 1 AND e.availability_status = 'on_site' AND e.sync_error IS NULL AND epa.site_id = ? ORDER BY e.full_name`).bind(siteId),
      env.DB.prepare(`SELECT e.id, e.full_name AS fullName, e.employment_type AS employmentType, e.department, e.position, e.source,
        e.bitrix24_stage AS bitrix24Stage, e.availability_status AS availabilityStatus, e.sync_error AS syncError,
        epa.site_id AS siteId, s.name AS siteName
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
      placementEntriesStatement(siteId, workDate),
      filledDatesStatement(siteId, rangeStart, rangeEnd),
      env.DB.prepare("SELECT id, full_name AS fullName, email, CASE WHEN role = 'office' THEN 'superadmin' ELSE role END AS role, assigned_site_id AS assignedSiteId, CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END AS status FROM app_users WHERE active = 1 ORDER BY full_name"),
      env.DB.prepare("SELECT id, status, started_at AS startedAt, completed_at AS completedAt, summary, error_text AS errorText FROM employee_sync_runs ORDER BY id DESC LIMIT 1"),
      env.DB.prepare("SELECT action_key AS actionKey, last_started_at AS lastStartedAt FROM bitrix24_action_limits WHERE action_key IN ('inspect-bitrix24', 'sync-bitrix24')"),
    ]);
    return Response.json({
      sites: canViewAllProjects(authUser.role) ? sites.results : sites.results.filter((site) => (site as { id: number }).id === siteId),
      employees: canViewAllProjects(authUser.role) ? employees.results : placementEmployees.results,
      placementEmployees: placementEmployees.results,
      projectEmployees: projectEmployees.results,
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
      filledDates: filledDates.results.map((row) => (row as { workDate: string }).workDate),
      users: canViewAllProjects(authUser.role) ? users.results : [],
      syncStatus: syncStatus.results[0] ?? null,
      bitrix24Cooldowns: canManageBitrix24(authUser.role) ? mapBitrix24Cooldowns(bitrix24ActionLimits.results as Bitrix24ActionLimitRow[]) : undefined,
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
    await ensureDatabaseInitialized();
    const payload = (await request.json()) as EntryPayload & UserPayload & { entries?: EntryPayload[] };
    if (payload.action && !canRunAction(authUser.role, payload)) return forbidden();
    if (!payload.action) {
      const placementRows = payload.entries?.length ? payload.entries : [payload];
      if (placementRows.some((row) => !canManagePlacement(authUser, asPositiveInteger(row.siteId) ?? undefined, row.workDate))) return forbidden();
    }
    if (payload.action === "sync-bitrix24") {
      const cooldown = await reserveBitrix24Action(payload.action);
      return Response.json({ ...await synchronizeBitrixEmployees(), cooldown });
    }
    if (payload.action === "inspect-bitrix24") {
      const cooldown = await reserveBitrix24Action(payload.action);
      const sourceSnapshot = await fetchBitrixEmployeeSnapshot();
      const snapshot = selectBitrixEmployeesForImport(sourceSnapshot);
      const selectedIds = new Set(snapshot.map((employee) => employee.bitrix24Id));
      const excluded = sourceSnapshot.filter((employee) => !selectedIds.has(employee.bitrix24Id));
      const countValues = (values: string[]) => Object.entries(values.reduce<Record<string, number>>((counts, value) => {
        const key = value || "Не указано";
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {})).sort(([left], [right]) => left.localeCompare(right, "ru-RU"));
      return Response.json({
        sourceReceived: sourceSnapshot.length,
        received: snapshot.length,
        excluded: excluded.length,
        incomplete: snapshot.filter((employee) => !employee.fullName || !employee.employmentType || !employee.department || !employee.position).length,
        unknownStages: snapshot.filter((employee) => employee.availabilityStatus === "unknown").length,
        stages: countValues(snapshot.map((employee) => employee.stageName || employee.stageId)),
        projects: countValues(snapshot.flatMap((employee) => employee.projectKeys.length ? employee.projectKeys : ["Не указано"])),
        excludedStages: countValues(excluded.map((employee) => employee.stageName || employee.stageId)),
        cooldown,
      });
    }
    if (payload.action === "create-user") {
      const fullName = payload.fullName?.trim() ?? "";
      const email = payload.email?.trim().toLocaleLowerCase() ?? "";
      const role = isUserRole(payload.role) ? payload.role : null;
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
      await validateEmployeeDirectoryValues(employmentType, department, position, projectSiteId);
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
        env.DB.prepare("SELECT id FROM employees WHERE id = ? AND active = 1 AND source <> 'bitrix24'").bind(employeeId),
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
      await reconcilePositionCatalogOptions();
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
      await reconcilePositionCatalogOptions();
      return Response.json({ count: rows.length }, { status: 201 });
    }
    if (payload.action === "import-employees") {
      const rows = payload.employees ?? [];
      if (!rows.length || rows.length > 2000) throw new Error("В файле должно быть от 1 до 2000 сотрудников.");
      const [sitesResult, employeesResult] = await env.DB.batch([
        env.DB.prepare("SELECT id, code, name FROM sites WHERE active = 1"),
        env.DB.prepare("SELECT id, full_name AS fullName, source FROM employees WHERE active = 1"),
      ]);
      const sitesByKey = new Map<string, number>();
      for (const site of sitesResult.results as Array<{ id: number; code: string; name: string }>) {
        sitesByKey.set(site.code.trim().toLocaleLowerCase("ru-RU"), site.id);
        sitesByKey.set(site.name.trim().toLocaleLowerCase("ru-RU"), site.id);
      }
      const employeesByName = new Map((employeesResult.results as Array<{ id: number; fullName: string; source: string }>).map((employee) => [employee.fullName.trim().toLocaleLowerCase("ru-RU"), employee]));
      const importedNames = new Set<string>();
      const validatedRows = rows.map((row, index) => {
        const fullName = row.fullName?.trim() ?? "";
        const employmentType = row.employmentType?.trim() ?? "";
        const department = row.department?.trim() ?? "";
        const position = row.position?.trim() ?? "";
        const projectNames = (row.projectCode ?? "").split(",").map((name) => name.trim()).filter(Boolean);
        if (!fullName || !employmentType || !department || !position || !projectNames.length) throw new Error(`Строка ${index + 1}: заполните ФИО, тип, отдел, должность и проект.`);
        const normalizedName = fullName.toLocaleLowerCase("ru-RU");
        if (importedNames.has(normalizedName)) throw new Error(`Строка ${index + 1}: сотрудник «${fullName}» повторяется в файле.`);
        if (employeesByName.get(normalizedName)?.source === "bitrix24") throw new Error(`Строка ${index + 1}: сотрудник «${fullName}» управляется Битрикс24 и не может быть изменён импортом.`);
        importedNames.add(normalizedName);
        const unknownProjects = projectNames.filter((name) => !sitesByKey.has(name.toLocaleLowerCase("ru-RU")));
        if (unknownProjects.length) throw new Error(`Строка ${index + 1}: ${unknownProjects.length === 1 ? "проект" : "проекты"} «${unknownProjects.join("», «")}» не найдены.`);
        const siteIds = [...new Set(projectNames.map((name) => sitesByKey.get(name.toLocaleLowerCase("ru-RU"))!))];
        return { fullName, normalizedName, employmentType, department, position, siteIds };
      });
      const employeeStatements = validatedRows.map((row) => {
        const existingId = employeesByName.get(row.normalizedName)?.id;
        return existingId
          ? env.DB.prepare("UPDATE employees SET employment_type = ?, department = ?, position = ?, site_id = ?, source = 'excel' WHERE id = ?").bind(row.employmentType, row.department, row.position, row.siteIds[0], existingId)
          : env.DB.prepare("INSERT INTO employees (full_name, employment_type, department, position, source, site_id) VALUES (?, ?, ?, ?, 'excel', ?)").bind(row.fullName, row.employmentType, row.department, row.position, row.siteIds[0]);
      });
      for (let offset = 0; offset < employeeStatements.length; offset += 100) await env.DB.batch(employeeStatements.slice(offset, offset + 100));

      const refreshedEmployees = await env.DB.prepare("SELECT id, full_name AS fullName FROM employees WHERE active = 1").all<{ id: number; fullName: string }>();
      const refreshedByName = new Map(refreshedEmployees.results.map((employee) => [employee.fullName.trim().toLocaleLowerCase("ru-RU"), employee.id]));
      const assignmentStatements = validatedRows.flatMap((row) => {
        const employeeId = refreshedByName.get(row.normalizedName);
        if (!employeeId) throw new Error(`Не удалось найти сотрудника «${row.fullName}» после импорта.`);
        const placeholders = row.siteIds.map(() => "?").join(", ");
        return [
          env.DB.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = DATE('now') WHERE employee_id = ? AND active = 1 AND site_id NOT IN (${placeholders})`).bind(employeeId, ...row.siteIds),
          ...row.siteIds.flatMap((siteId) => [
            env.DB.prepare("UPDATE employee_project_assignments SET source = 'excel', end_date = NULL WHERE employee_id = ? AND site_id = ? AND active = 1").bind(employeeId, siteId),
            env.DB.prepare("INSERT INTO employee_project_assignments (employee_id, site_id, source) SELECT ?, ?, 'excel' WHERE NOT EXISTS (SELECT 1 FROM employee_project_assignments WHERE employee_id = ? AND site_id = ? AND active = 1)").bind(employeeId, siteId, employeeId, siteId),
          ]),
        ];
      });
      for (let offset = 0; offset < assignmentStatements.length; offset += 100) await env.DB.batch(assignmentStatements.slice(offset, offset + 100));
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
    if (payload.action === "save-directory-items") {
      const directory = directoryTable(payload.entity);
      const siteId = asPositiveInteger(payload.siteId);
      const rows = payload.directories ?? [];
      if (!directory || directory.global || directory.key === "shift" || !siteId) throw new Error("Укажите проект и доступный справочник.");
      if (!rows.length || rows.length > 500) throw new Error("Подготовьте от 1 до 500 строк справочника.");
      const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND active = 1").bind(siteId).first();
      if (!site) throw new Error("Выбранный проект не найден или уже закрыт.");
      const existing = await env.DB.prepare(`SELECT id, name FROM ${directory.table} WHERE site_id = ? AND active = 1`).bind(siteId).all<{ id: number; name: string }>();
      const existingById = new Map(existing.results.map((item) => [item.id, item]));
      const editedIds = rows.map((row) => asPositiveInteger(row.directoryId)).filter((id): id is number => Boolean(id));
      if (new Set(editedIds).size !== editedIds.length) throw new Error("Одна строка справочника добавлена в редактирование несколько раз.");
      const employeeById = new Map<number, string>();
      if (directory.key === "master") {
        const employees = await env.DB.prepare(`SELECT e.id, e.full_name AS fullName FROM employees e
          JOIN employee_project_assignments epa ON epa.employee_id = e.id AND epa.site_id = ? AND epa.active = 1
          WHERE e.active = 1`).bind(siteId).all<{ id: number; fullName: string }>();
        employees.results.forEach((employee) => employeeById.set(employee.id, employee.fullName));
      }
      const normalizeName = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
      const occupiedNames = new Set(existing.results.filter((item) => !editedIds.includes(item.id)).map((item) => normalizeName(item.name)));
      const prepared = rows.map((row, index) => {
        const directoryId = asPositiveInteger(row.directoryId);
        if (directoryId && !existingById.has(directoryId)) throw new Error(`Строка ${index + 1}: значение справочника не найдено.`);
        const employeeId = asPositiveInteger(row.employeeId);
        const name = directory.key === "master" && employeeId ? employeeById.get(employeeId) ?? "" : row.name?.trim() ?? "";
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
          (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot,
           employee_name_snapshot, employment_type_snapshot, department_snapshot, master_name_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
            data.employeeName, data.employmentType, data.department, data.masterName)));
      }
      return Response.json({ count: rows.length }, { status: 201 });
    }
    const data = await validatePayload(payload);
    const result = await env.DB.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot,
       employee_name_snapshot, employment_type_snapshot, department_snapshot, master_name_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
        data.employeeName, data.employmentType, data.department, data.masterName).run();
    return Response.json({ id: result.meta.last_row_id }, { status: 201 });
  } catch (error) {
    if (error instanceof Bitrix24CooldownError) {
      return Response.json({ error: error.message, cooldown: error.cooldown }, {
        status: 429,
        headers: { "Retry-After": String(error.cooldown.remainingSeconds) },
      });
    }
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить строку." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const authUser = await getAuthUser(request);
    if (!authUser) return unauthorized();
    await ensureDatabaseInitialized();
    const payload = (await request.json()) as EntryPayload & UserPayload & { entries?: EntryPayload[]; newEntries?: EntryPayload[] };
    const placementUpdates = Array.isArray(payload.entries) ? payload.entries : null;
    const placementCreates = Array.isArray(payload.newEntries) ? payload.newEntries : null;
    if (payload.action && !canRunAction(authUser.role, payload)) return forbidden();
    if (!payload.action) {
      const placementRows = placementUpdates || placementCreates
        ? [...(placementUpdates ?? []), ...(placementCreates ?? [])]
        : [payload];
      if (placementRows.some((entry) => !canManagePlacement(authUser, asPositiveInteger(entry.siteId) ?? undefined, entry.workDate))) return forbidden();
    }
    if (payload.action === "update-user") {
      const userId = asPositiveInteger(payload.userId);
      const fullName = payload.fullName?.trim() ?? "";
      const email = payload.email?.trim().toLocaleLowerCase() ?? "";
      const role = isUserRole(payload.role) ? payload.role : null;
      const assignedSiteId = role === "foreman" ? asPositiveInteger(payload.assignedSiteId) : null;
      if (!userId || !fullName || !/^\S+@\S+\.\S+$/.test(email) || !role || (role === "foreman" && !assignedSiteId)) throw new Error("Заполните ФИО, корректный email, роль и объект прораба.");
      const duplicate = await env.DB.prepare("SELECT id FROM app_users WHERE email = ? AND id <> ? AND active = 1").bind(email, userId).first();
      if (duplicate) throw new Error("Пользователь с таким email уже существует.");
      const currentUserRecord = await env.DB.prepare("SELECT role, password_hash AS passwordHash FROM app_users WHERE id = ? AND active = 1").bind(userId).first<{ role: string; passwordHash: string | null }>();
      if ((currentUserRecord?.role === "superadmin" || currentUserRecord?.role === "office") && role !== "superadmin") {
        const adminCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role IN ('superadmin', 'office') AND active = 1").first<{ count: number }>();
        if (Number(adminCount?.count ?? 0) <= 1) throw new Error("Нельзя убрать роль «Супер-админ» у последнего администратора.");
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
      await validateEmployeeDirectoryValues(employmentType, department, position, projectSiteId);
      const duplicate = await env.DB.prepare("SELECT id FROM employees WHERE full_name = ? AND id <> ? AND active = 1").bind(fullName, employeeId).first();
      if (duplicate) throw new Error("Рабочий с таким ФИО уже существует.");
      const result = await env.DB.prepare("UPDATE employees SET full_name = ?, employment_type = ?, department = ?, position = ?, site_id = ? WHERE id = ? AND active = 1 AND source <> 'bitrix24'").bind(fullName, employmentType, department, position, projectSiteId, employeeId).run();
      if (!result.meta.changes) throw new Error("Рабочий не найден или управляется Битрикс24.");
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
          env.DB.prepare("UPDATE employees SET employment_type = ?, department = ?, position = ? WHERE employment_type = ? AND department = ? AND position = ? AND active = 1 AND source <> 'bitrix24'").bind(employmentType, department, position, current.employmentType, current.department, current.position),
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
          env.DB.prepare(`UPDATE employees SET ${column} = ? WHERE ${column} = ? AND active = 1 AND source <> 'bitrix24'`).bind(name, current.name),
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
    if (placementCreates) {
      const updates = placementUpdates ?? [];
      if (!updates.length && !placementCreates.length) throw new Error("Нет строк для сохранения.");
      if (updates.length + placementCreates.length > 1000) throw new Error("За один раз можно сохранить не более 1000 строк.");
      const ids = updates.map((entry) => asPositiveInteger(entry.id));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Некорректный список строк для изменения.");
      const entryIds = ids as number[];
      const existing = entryIds.length
        ? await env.DB.prepare(`SELECT id, site_id AS siteId, work_date AS workDate, employee_id AS employeeId, master_id AS masterId, hours,
          position_snapshot AS positionSnapshot, employee_name_snapshot AS employeeNameSnapshot,
          employment_type_snapshot AS employmentTypeSnapshot, department_snapshot AS departmentSnapshot,
          master_name_snapshot AS masterNameSnapshot
          FROM placement_entries WHERE id = ANY(?) AND deleted_at IS NULL`).bind(entryIds).all<ExistingPlacementEntry>()
        : { results: [] as ExistingPlacementEntry[] };
      if (existing.results.length !== entryIds.length) throw new Error("Одна или несколько строк не найдены.");
      if (existing.results.some((entry) => !canManagePlacement(authUser, entry.siteId, entry.workDate))) return forbidden();
      const rows = await validateBulkPayloads([...updates, ...placementCreates], existing.results);
      const updateRows = rows.slice(0, updates.length);
      const createRows = rows.slice(updates.length);
      let updatedCount = 0;
      for (let offset = 0; offset < updateRows.length; offset += 100) {
        const results = await env.DB.batch(updateRows.slice(offset, offset + 100).map((data, index) => env.DB.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
          main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?,
          employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND deleted_at IS NULL`)
          .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
            data.employeeName, data.employmentType, data.department, data.masterName, entryIds[offset + index])));
        updatedCount += results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
      }
      for (let offset = 0; offset < createRows.length; offset += 100) {
        await env.DB.batch(createRows.slice(offset, offset + 100).map((data) => env.DB.prepare(`INSERT INTO placement_entries
          (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot,
           employee_name_snapshot, employment_type_snapshot, department_snapshot, master_name_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
            data.employeeName, data.employmentType, data.department, data.masterName)));
      }
      return Response.json({ ok: true, updatedCount, createdCount: createRows.length });
    }
    if (placementUpdates) {
      if (!placementUpdates.length) throw new Error("Нет строк для изменения.");
      if (placementUpdates.length > 1000) throw new Error("За один раз можно изменить не более 1000 строк.");
      const ids = placementUpdates.map((entry) => asPositiveInteger(entry.id));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Некорректный список строк для изменения.");
      const entryIds = ids as number[];
      const existing = await env.DB.prepare(`SELECT id, site_id AS siteId, work_date AS workDate, employee_id AS employeeId, master_id AS masterId, hours,
        position_snapshot AS positionSnapshot, employee_name_snapshot AS employeeNameSnapshot,
        employment_type_snapshot AS employmentTypeSnapshot, department_snapshot AS departmentSnapshot,
        master_name_snapshot AS masterNameSnapshot
        FROM placement_entries WHERE id = ANY(?) AND deleted_at IS NULL`).bind(entryIds).all<ExistingPlacementEntry>();
      if (existing.results.length !== entryIds.length) throw new Error("Одна или несколько строк не найдены.");
      if (existing.results.some((entry) => !canManagePlacement(authUser, entry.siteId, entry.workDate))) return forbidden();
      const rows = await validateBulkPayloads(placementUpdates, existing.results);
      let changed = 0;
      for (let offset = 0; offset < rows.length; offset += 100) {
        const results = await env.DB.batch(rows.slice(offset, offset + 100).map((data, index) => env.DB.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
          main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?,
          employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND deleted_at IS NULL`)
          .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
            data.employeeName, data.employmentType, data.department, data.masterName, entryIds[offset + index])));
        changed += results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
      }
      return Response.json({ ok: true, count: changed });
    }
    const id = asPositiveInteger(payload.id);
    if (!id) throw new Error("Не указана строка для изменения.");
    const data = await validatePayload(payload, id);
    await env.DB.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
      main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?,
      employee_name_snapshot = ?, employment_type_snapshot = ?, department_snapshot = ?, master_name_snapshot = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL`)
      .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position,
        data.employeeName, data.employmentType, data.department, data.masterName, id).run();
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
    await ensureDatabaseInitialized();
    const url = new URL(request.url);
    const entity = url.searchParams.get("entity");
    if (!canDeleteEntity(authUser.role, entity, url.searchParams.get("kind"))) return forbidden();
    if (!entity) {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await request.json() as { ids?: unknown[] }
        : null;
      const ids = [...new Set((body?.ids ?? [url.searchParams.get("id")]).map(asPositiveInteger).filter((id): id is number => id !== null))];
      if (!ids.length) throw new Error("Не указаны строки для удаления.");
      if (ids.length > 5_000) throw new Error("За один раз можно удалить не более 5000 строк.");
      if (authUser.role === "foreman") {
        const entries = await env.DB.prepare("SELECT site_id AS siteId, work_date AS workDate FROM placement_entries WHERE id = ANY(?) AND deleted_at IS NULL").bind(ids).all<{ siteId: number; workDate: string }>();
        if (entries.results.length !== ids.length || entries.results.some((entry) => !canManagePlacement(authUser, entry.siteId, entry.workDate))) return forbidden();
      }
      const result = await env.DB.prepare("UPDATE placement_entries SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ANY(?) AND deleted_at IS NULL").bind(ids).run();
      return Response.json({ ok: true, count: result.meta.changes });
    }
    if (entity === "employee") {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await request.json() as { ids?: unknown[] }
        : null;
      const ids = [...new Set((body?.ids ?? [url.searchParams.get("id")]).map(asPositiveInteger).filter((value): value is number => value !== null))];
      if (!ids.length) throw new Error("Выберите хотя бы одного сотрудника.");
      if (ids.length > 5_000) throw new Error("За один раз можно удалить не более 5000 сотрудников.");
      const managedByBitrix = await env.DB.prepare("SELECT COUNT(*) AS count FROM employees WHERE id = ANY(?) AND source = 'bitrix24'").bind(ids).first<{ count: number }>();
      if (Number(managedByBitrix?.count ?? 0) > 0) throw new Error("Сотрудников Битрикс24 нельзя удалить вручную. Их статус обновляется при актуализации.");
      const employeesResult = await env.DB.prepare("SELECT id, full_name AS fullName FROM employees WHERE id = ANY(?) AND active = 1").bind(ids).all<{ id: number; fullName: string }>();
      const employees = employeesResult.results as Array<{ id: number; fullName: string }>;
      if (employees.length !== ids.length) {
        const existingIds = new Set(employees.map((employee) => employee.id));
        const missingCount = ids.filter((id) => !existingIds.has(id)).length;
        throw new Error(`${missingCount === 1 ? "Один сотрудник уже удалён" : `Сотрудники уже удалены (${missingCount})`}. Таблица обновлена — выберите строки заново.`);
      }
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE employee_project_assignments SET active = 0, end_date = COALESCE(end_date, DATE('now')) WHERE employee_id = ANY(?) AND active = 1").bind(ids),
        env.DB.prepare("UPDATE masters SET active = 0 WHERE active = 1 AND name IN (SELECT full_name FROM employees WHERE id = ANY(?))").bind(ids),
        env.DB.prepare("UPDATE employees SET active = 0, site_id = NULL WHERE id = ANY(?) AND active = 1").bind(ids),
      ]);
      return Response.json({ ok: true, count: results[2].meta.changes });
    }
    const id = asPositiveInteger(url.searchParams.get("id"));
    if (!id) throw new Error("Не указана строка для удаления.");
    if (url.searchParams.get("entity") === "user") {
      if (id === authUser.id) throw new Error("Нельзя удалить собственную учётную запись.");
      const deletingUser = await env.DB.prepare("SELECT role FROM app_users WHERE id = ? AND active = 1").bind(id).first<{ role: string }>();
      if (deletingUser?.role === "superadmin" || deletingUser?.role === "office") {
        const adminCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE role IN ('superadmin', 'office') AND active = 1").first<{ count: number }>();
        if (Number(adminCount?.count ?? 0) <= 1) throw new Error("Нельзя удалить последнего администратора.");
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
    if (url.searchParams.get("entity") === "employee-assignment") {
      const siteId = asPositiveInteger(url.searchParams.get("siteId"));
      if (!siteId) throw new Error("Не указан проект сотрудника.");
      const result = await env.DB.prepare(`UPDATE employee_project_assignments SET active = 0, end_date = DATE('now')
        WHERE employee_id = ? AND site_id = ? AND active = 1
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND source <> 'bitrix24')`).bind(id, siteId, id).run();
      if (!result.meta.changes) throw new Error("Сотрудник не относится к проекту или управляется Битрикс24.");
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
      await reconcilePositionCatalogOptions();
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
    throw new Error("Неизвестный тип данных для удаления.");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось удалить строку." }, { status: 400 });
  }
}
