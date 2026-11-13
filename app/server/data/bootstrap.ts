import { ensureAuthSchema } from "../../auth";
import { ensureProjectMastersSchema } from "../../projectMasters";
import { env } from "./context";
import { reconcilePositionCatalogOptions } from "./catalogs";

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
    sort_order INTEGER NOT NULL DEFAULT 0,
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
  `CREATE TABLE IF NOT EXISTS bitrix24_employee_check_states (
    employee_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by_user_id INTEGER,
    CONSTRAINT bitrix24_employee_check_status_valid CHECK (status IN ('mismatch', 'missing_in_bitrix', 'dismissed_in_bitrix', 'blacklisted_in_bitrix'))
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
    main_work_type_id INTEGER REFERENCES main_work_types(id),
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
    responsible_user_id INTEGER,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by_user_id INTEGER,
    updated_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS placement_report_days (
    site_id INTEGER NOT NULL,
    work_date DATE NOT NULL,
    submitted_by INTEGER,
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (site_id, work_date)
  )`,
  `CREATE TABLE IF NOT EXISTS placement_report_contributions (
    site_id INTEGER NOT NULL,
    work_date DATE NOT NULL,
    foreman_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    submitted_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (site_id, work_date, foreman_id)
  )`,
  `CREATE TABLE IF NOT EXISTS timesheet_marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    hours INTEGER CHECK (hours BETWEEN 1 AND 10),
    code TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((hours IS NOT NULL AND code IS NULL) OR (hours IS NULL AND code IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_site_date ON placement_entries(site_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_active_site_date ON placement_entries(site_id, work_date) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_entries_employee_date ON placement_entries(employee_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_opr_site_date_employee ON placement_entries(site_id, work_date, employee_id)
    WHERE deleted_at IS NULL AND upper(trim(employment_type_snapshot)) = 'ОПР'`,
  `CREATE INDEX IF NOT EXISTS idx_report_contributions_site_date_status ON placement_report_contributions(site_id, work_date, status)`,
  `CREATE INDEX IF NOT EXISTS idx_report_contributions_foreman_date ON placement_report_contributions(foreman_id, work_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheet_marks_unique_day ON timesheet_marks(site_id, employee_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_timesheet_marks_month ON timesheet_marks(site_id, work_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_project_assignment_active ON employee_project_assignments(employee_id, site_id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_employee_project_assignment_site ON employee_project_assignments(site_id, active)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_project_assignment_site_employee_active ON employee_project_assignments(site_id, employee_id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_employees_active_name ON employees(full_name, id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_employee_profile_versions_period ON employee_profile_versions(employee_id, valid_from, valid_to)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_availability_periods_period ON employee_availability_periods(employee_id, valid_from, valid_to)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_sync_issues_run ON employee_sync_issues(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bitrix24_employee_check_status ON bitrix24_employee_check_states(status, acknowledged_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_personnel_options_kind_name ON personnel_options(kind, name) WHERE active = 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_position_catalog_values ON position_catalog(employment_type, department, position) WHERE active = 1`,
];

async function initializeDatabase() {
  const db = env.DB;
  await ensureAuthSchema();
  await db.batch(TABLE_STATEMENTS.map((statement) => db.prepare(statement)));
  await db.prepare("ALTER TABLE subwork_types ADD COLUMN IF NOT EXISTS main_work_type_id INTEGER REFERENCES main_work_types(id)").run();
  await ensureProjectMastersSchema(db);
  await db.prepare(`INSERT INTO placement_report_days (site_id, work_date, submitted_at)
    SELECT site_id, work_date, MIN(created_at) FROM placement_entries WHERE deleted_at IS NULL GROUP BY site_id, work_date
    ON CONFLICT (site_id, work_date) DO NOTHING`).all();
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
  if (!employeeColumnNames.has("sort_order")) {
    await db.prepare("ALTER TABLE employees ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0").run();
  }
  await db.prepare(`WITH maximum AS (
      SELECT COALESCE(MAX(sort_order), 0) AS value FROM employees WHERE sort_order > 0
    ), unranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY full_name, id) AS position FROM employees WHERE sort_order <= 0
    )
    UPDATE employees SET sort_order = maximum.value + unranked.position
    FROM maximum, unranked WHERE employees.id = unranked.id`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_employees_active_sort_order ON employees(sort_order, id) WHERE active = 1").run();
  const placementColumns = await db.prepare("PRAGMA table_info(placement_entries)").all<{ name: string }>();
  const placementColumnNames = new Set(placementColumns.results.map((column) => column.name));
  for (const column of ["employee_name_snapshot", "employment_type_snapshot", "department_snapshot", "master_name_snapshot"]) {
    if (!placementColumnNames.has(column)) await db.prepare(`ALTER TABLE placement_entries ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`).run();
  }
  if (!placementColumnNames.has("responsible_user_id")) await db.prepare("ALTER TABLE placement_entries ADD COLUMN responsible_user_id INTEGER").run();
  if (!placementColumnNames.has("revision")) await db.prepare("ALTER TABLE placement_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1").run();
  if (!placementColumnNames.has("created_by_user_id")) await db.prepare("ALTER TABLE placement_entries ADD COLUMN created_by_user_id INTEGER").run();
  if (!placementColumnNames.has("updated_by_user_id")) await db.prepare("ALTER TABLE placement_entries ADD COLUMN updated_by_user_id INTEGER").run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_responsible_site_date
    ON placement_entries(responsible_user_id, site_id, work_date)
    WHERE responsible_user_id IS NOT NULL AND deleted_at IS NULL`).run();
  await db.prepare(`UPDATE placement_entries AS entry
    SET responsible_user_id = report.submitted_by
    FROM placement_report_days AS report
    JOIN app_users AS submitter ON submitter.id = report.submitted_by AND submitter.role = 'foreman'
    WHERE entry.site_id = report.site_id AND entry.work_date = report.work_date AND entry.responsible_user_id IS NULL`).run();
  await db.prepare(`INSERT INTO placement_report_contributions
      (site_id, work_date, foreman_id, status, revision, submitted_at, updated_at)
    SELECT report.site_id, report.work_date, report.submitted_by, 'submitted', 1, report.submitted_at, report.submitted_at
    FROM placement_report_days AS report
    JOIN app_users AS submitter ON submitter.id = report.submitted_by AND submitter.role = 'foreman'
    ON CONFLICT (site_id, work_date, foreman_id) DO NOTHING`).all();
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
      db.prepare(`DELETE FROM employees
        WHERE active = 0
          AND bitrix24_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM placement_entries WHERE employee_id = employees.id)
          AND NOT EXISTS (SELECT 1 FROM timesheet_marks WHERE employee_id = employees.id)
          AND NOT EXISTS (SELECT 1 FROM employee_project_assignments WHERE employee_id = employees.id)
          AND NOT EXISTS (SELECT 1 FROM masters WHERE employee_id = employees.id)`),
    ]);
  }
  const syncPositionCatalog = () => db.prepare("INSERT OR IGNORE INTO position_catalog (employment_type, department, position) SELECT DISTINCT employment_type, department, position FROM employees WHERE active = 1 AND employment_type <> '' AND department <> '' AND position <> ''").run();
  const syncEmployeeAssignments = () => db.prepare("INSERT OR IGNORE INTO employee_project_assignments (employee_id, site_id, source) SELECT id, site_id, source FROM employees WHERE active = 1 AND site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_project_assignments history WHERE history.employee_id = employees.id)").run();
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
    await db.prepare("UPDATE employees SET site_id = 1 WHERE site_id IS NULL AND source <> 'bitrix24' AND NOT EXISTS (SELECT 1 FROM employee_project_assignments history WHERE history.employee_id = employees.id)").run();
    await repairNumericPersonnelValues();
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
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position, sort_order) VALUES (1, ?, 'ОПР', 'УСР', ?, 1)").bind("Иванов Сергей Петрович", "Монтажник технологических трубопроводов"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position, sort_order) VALUES (2, ?, 'ОПР', 'УСР', ?, 2)").bind("Абдуллаев Рустам Каримович", "Электрогазосварщик"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position, sort_order) VALUES (3, ?, 'ОПР', 'МУВСП', ?, 3)").bind("Петров Алексей Николаевич", "Стропальщик"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position, sort_order) VALUES (4, ?, 'ОПР', 'МУТТ', ?, 4)").bind("Саидов Джамшед Махмудович", "Монтажник металлоконструкций"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position, sort_order) VALUES (5, ?, 'ИТР', 'УСР', ?, 5)").bind("Ким Андрей Викторович", "Мастер строительно-монтажных работ"),
    db.prepare("INSERT INTO employees (id, full_name, employment_type, department, position, sort_order) VALUES (6, ?, 'ОПР', 'УОВ', ?, 6)").bind("Смирнов Николай Олегович", "Подсобный рабочий"),
    db.prepare("INSERT INTO shifts (id, site_id, name) VALUES (1, 1, 'день'), (2, 1, 'ночь'), (4, 2, 'день'), (5, 2, 'ночь')"),
    db.prepare("INSERT INTO zones (id, site_id, name) VALUES (1, 1, 'G4-C1810BX0'), (2, 1, 'G3-B1110BX0'), (3, 1, 'G1-B6710RX0'), (4, 1, 'отсутствует'), (5, 2, 'Секция A'), (6, 2, 'Секция B')"),
    db.prepare("INSERT INTO main_work_types (id, site_id, name) VALUES (1, 1, 'Трубопроводы /// Монтаж'), (2, 1, 'Трубопроводы /// Сварка'), (3, 1, 'Металлоконструкции /// Эстакады'), (4, 1, 'Вспомогательные и прочие работы'), (5, 2, 'Монтаж оборудования'), (6, 2, 'Подготовительные работы')"),
    db.prepare("INSERT INTO subwork_types (id, site_id, main_work_type_id, name) VALUES (1, 1, 4, 'Вспомогательные или прочие работы'), (2, 1, 4, 'Погрузо-разгрузка, сортировка, склад'), (3, 1, 2, 'Подготовка к сварочным работам'), (4, 1, 1, 'Подкрасочные работы'), (5, 2, 6, 'Сортировка материала'), (6, 2, 5, 'Дополнительные работы')"),
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

export function ensureDatabaseInitialized() {
  const globals = globalThis as DataGlobals;
  if (!globals.personnelDatabaseInitializationPromise) {
    const initializationTask = process.env.NODE_ENV === "production" && process.env.DATABASE_RUNTIME_BOOTSTRAP !== "true"
      ? Promise.resolve()
      : initializeDatabase();
    globals.personnelDatabaseInitializationPromise = initializationTask.catch((error) => {
      delete globals.personnelDatabaseInitializationPromise;
      throw error;
    });
  }
  return globals.personnelDatabaseInitializationPromise;
}
