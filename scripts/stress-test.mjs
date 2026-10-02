import process from "node:process";
import pg from "pg";

const { Client, Pool } = pg;

const DEFAULTS = Object.freeze({
  employees: 100_000,
  personnelEntries: 300_000,
  equipmentUnits: 25_000,
  equipmentEntries: 150_000,
  auditEvents: 100_000,
});

function integerArgument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw.replaceAll("_", ""));
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000_000) {
    throw new Error(`Параметр --${name} должен быть целым числом от 1 до 5000000.`);
  }
  return value;
}

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return undefined;
  return { rejectUnauthorized: mode === "verify-full" };
}

function connectionConfiguration() {
  if (!process.env.DATABASE_URL) throw new Error("Для стресс-теста требуется DATABASE_URL.");
  const url = new URL(process.env.DATABASE_URL);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (!localHosts.has(url.hostname) && !process.argv.includes("--allow-remote")) {
    throw new Error(`Стресс-тест разрешён только для локальной БД. Получен хост ${url.hostname}.`);
  }
  return { connectionString: process.env.DATABASE_URL, ssl: sslConfiguration() };
}

const counts = {
  employees: integerArgument("employees", DEFAULTS.employees),
  personnelEntries: integerArgument("personnel-entries", DEFAULTS.personnelEntries),
  equipmentUnits: integerArgument("equipment-units", DEFAULTS.equipmentUnits),
  equipmentEntries: integerArgument("equipment-entries", DEFAULTS.equipmentEntries),
  auditEvents: integerArgument("audit-events", DEFAULTS.auditEvents),
};

const schemaName = `stress_test_${Date.now()}_${process.pid}`;
if (!/^stress_test_\d+_\d+$/.test(schemaName)) throw new Error("Некорректное имя временной схемы.");
const quotedSchema = `"${schemaName}"`;
const databaseConfiguration = connectionConfiguration();
const client = new Client(databaseConfiguration);
let connected = false;

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function formatBytes(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function timedQuery(name, sql, parameters = [], { attempts = 3, includePayload = false } = {}) {
  let best = Number.POSITIVE_INFINITY;
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const start = process.hrtime.bigint();
    latest = await client.query(sql, parameters);
    best = Math.min(best, elapsedMs(start));
  }
  const payloadBytes = includePayload ? Buffer.byteLength(JSON.stringify(latest.rows)) : 0;
  return {
    name,
    milliseconds: Math.round(best * 10) / 10,
    rows: latest.rowCount ?? latest.rows.length,
    payload: includePayload ? formatBytes(payloadBytes) : "—",
    payloadBytes,
  };
}

async function createFixture() {
  await client.query(`CREATE SCHEMA ${quotedSchema}`);
  await client.query(`SET search_path TO ${quotedSchema}, public`);
  await client.query(`
    CREATE TABLE sites (id integer PRIMARY KEY, name text NOT NULL);
    CREATE TABLE employees (
      id bigint PRIMARY KEY,
      full_name text NOT NULL,
      employment_type text NOT NULL,
      department text NOT NULL,
      position text NOT NULL,
      active integer NOT NULL DEFAULT 1
    );
    CREATE TABLE employee_project_assignments (
      employee_id bigint NOT NULL,
      site_id integer NOT NULL,
      active integer NOT NULL DEFAULT 1
    );
    CREATE TABLE placement_entries (
      id bigint PRIMARY KEY,
      site_id integer NOT NULL,
      work_date date NOT NULL,
      employee_id bigint NOT NULL,
      employee_name_snapshot text NOT NULL,
      employment_type_snapshot text NOT NULL,
      department_snapshot text NOT NULL,
      hours integer NOT NULL,
      deleted_at timestamptz
    );
    CREATE TABLE timesheet_marks (
      id bigint PRIMARY KEY,
      site_id integer NOT NULL,
      employee_id bigint NOT NULL,
      work_date date NOT NULL,
      hours integer,
      code text
    );
    CREATE TABLE equipment_units (
      id bigint PRIMARY KEY,
      organization text NOT NULL,
      equipment_type text NOT NULL,
      model text NOT NULL,
      registration_number text NOT NULL,
      active integer NOT NULL DEFAULT 1
    );
    CREATE TABLE equipment_project_assignments (
      equipment_id bigint NOT NULL,
      site_id integer NOT NULL,
      active integer NOT NULL DEFAULT 1
    );
    CREATE TABLE equipment_entries (
      id bigint PRIMARY KEY,
      site_id integer NOT NULL,
      work_date date NOT NULL,
      equipment_id bigint NOT NULL,
      hours integer NOT NULL,
      deleted_at timestamptz
    );
    CREATE TABLE equipment_timesheet_marks (
      id bigint PRIMARY KEY,
      site_id integer NOT NULL,
      equipment_id bigint NOT NULL,
      work_date date NOT NULL,
      productive_hours integer NOT NULL,
      downtime_hours integer NOT NULL
    );
    CREATE TABLE audit_events (
      id bigint PRIMARY KEY,
      actor_name text NOT NULL,
      category text NOT NULL,
      site_id integer,
      summary text NOT NULL,
      created_at timestamptz NOT NULL
    );
  `);

  await client.query("INSERT INTO sites VALUES (1, 'Нагрузочный проект'), (2, 'Другой проект')");
  await client.query(`INSERT INTO employees (id, full_name, employment_type, department, position)
    SELECT value,
      'Сотрудник ' || lpad(value::text, 7, '0'),
      CASE WHEN value % 5 = 0 THEN 'АУП' ELSE 'ОПР' END,
      'Отдел ' || (value % 40),
      'Должность ' || (value % 120)
    FROM generate_series(1, $1) AS value`, [counts.employees]);
  await client.query(`INSERT INTO employee_project_assignments (employee_id, site_id)
    SELECT value, 1 FROM generate_series(1, $1) AS value`, [counts.employees]);
  await client.query(`INSERT INTO placement_entries
      (id, site_id, work_date, employee_id, employee_name_snapshot, employment_type_snapshot, department_snapshot, hours)
    SELECT value, 1, DATE '2026-01-01' + ((value - 1) % 365)::integer,
      ((value - 1) % $1) + 1,
      'Сотрудник ' || lpad((((value - 1) % $1) + 1)::text, 7, '0'),
      CASE WHEN value % 5 = 0 THEN 'АУП' ELSE 'ОПР' END,
      'Отдел ' || (value % 40),
      (value % 10) + 1
    FROM generate_series(1, $2) AS value`, [counts.employees, counts.personnelEntries]);
  const timesheetCount = Math.min(counts.personnelEntries, counts.employees * 3);
  await client.query(`INSERT INTO timesheet_marks (id, site_id, employee_id, work_date, hours, code)
    SELECT value, 1, ((value - 1) % $1) + 1,
      DATE '2026-09-01' + ((value - 1) % 30)::integer,
      CASE WHEN value % 9 = 0 THEN NULL ELSE (value % 10) + 1 END,
      CASE WHEN value % 9 = 0 THEN 'В' ELSE NULL END
    FROM generate_series(1, $2) AS value`, [counts.employees, timesheetCount]);

  await client.query(`INSERT INTO equipment_units (id, organization, equipment_type, model, registration_number)
    SELECT value, 'Организация ' || (value % 20), 'Тип ' || (value % 40),
      'Модель ' || value, 'Номер ' || value
    FROM generate_series(1, $1) AS value`, [counts.equipmentUnits]);
  await client.query(`INSERT INTO equipment_project_assignments (equipment_id, site_id)
    SELECT value, 1 FROM generate_series(1, $1) AS value`, [counts.equipmentUnits]);
  await client.query(`INSERT INTO equipment_entries (id, site_id, work_date, equipment_id, hours)
    SELECT value, 1, DATE '2026-01-01' + ((value - 1) % 365)::integer,
      ((value - 1) % $1) + 1, (value % 10) + 1
    FROM generate_series(1, $2) AS value`, [counts.equipmentUnits, counts.equipmentEntries]);
  const equipmentMarkCount = Math.min(counts.equipmentEntries, counts.equipmentUnits * 3);
  await client.query(`INSERT INTO equipment_timesheet_marks
      (id, site_id, equipment_id, work_date, productive_hours, downtime_hours)
    SELECT value, 1, ((value - 1) % $1) + 1,
      DATE '2026-09-01' + ((value - 1) % 30)::integer,
      CASE WHEN value % 20 = 0 THEN 0 ELSE (value % 10) + 1 END,
      CASE WHEN value % 20 = 0 THEN 8 ELSE 0 END
    FROM generate_series(1, $2) AS value`, [counts.equipmentUnits, equipmentMarkCount]);
  await client.query(`INSERT INTO audit_events (id, actor_name, category, site_id, summary, created_at)
    SELECT value, 'Пользователь ' || (value % 50),
      CASE WHEN value % 2 = 0 THEN 'reports' ELSE 'timesheets' END,
      1, 'Тестовое событие ' || value,
      TIMESTAMPTZ '2026-10-02 12:00:00+03' - (value || ' seconds')::interval
    FROM generate_series(1, $1) AS value`, [counts.auditEvents]);
}

async function createCurrentIndexes() {
  await client.query(`
    CREATE UNIQUE INDEX idx_employee_assignment_active
      ON employee_project_assignments (employee_id, site_id) WHERE active = 1;
    CREATE INDEX idx_employee_assignment_site ON employee_project_assignments (site_id, active);
    CREATE INDEX idx_entries_site_date ON placement_entries (site_id, work_date);
    CREATE INDEX idx_entries_active_site_date ON placement_entries (site_id, work_date) WHERE deleted_at IS NULL;
    CREATE INDEX idx_entries_employee_date ON placement_entries (employee_id, work_date);
    CREATE UNIQUE INDEX idx_timesheet_unique_day ON timesheet_marks (site_id, employee_id, work_date);
    CREATE INDEX idx_timesheet_month ON timesheet_marks (site_id, work_date);
    CREATE INDEX idx_equipment_units_site_active_fixture ON equipment_units (active);
    CREATE INDEX idx_equipment_assignment_site ON equipment_project_assignments (site_id, active);
    CREATE INDEX idx_equipment_entries_site_date ON equipment_entries (site_id, work_date);
    CREATE INDEX idx_equipment_entries_unit_date ON equipment_entries (equipment_id, work_date);
    CREATE UNIQUE INDEX idx_equipment_timesheet_unique_day
      ON equipment_timesheet_marks (site_id, equipment_id, work_date);
    CREATE INDEX idx_equipment_timesheet_month ON equipment_timesheet_marks (site_id, work_date);
    CREATE INDEX idx_audit_created ON audit_events (created_at DESC, id DESC);
    CREATE INDEX idx_audit_category ON audit_events (category, created_at DESC);
  `);
  await client.query("ANALYZE");
}

async function benchmark(label) {
  const results = [];
  results.push(await timedQuery(`${label}: отчёт рабочих за день`, `
    SELECT pe.id, pe.employee_id, pe.employee_name_snapshot, pe.hours
    FROM placement_entries pe
    WHERE pe.site_id = 1 AND pe.work_date = DATE '2026-09-15' AND pe.deleted_at IS NULL
    ORDER BY pe.employee_name_snapshot, pe.id`, [], { includePayload: true }));
  results.push(await timedQuery(`${label}: сотрудники проекта`, `
    SELECT e.id, e.full_name, e.employment_type, e.department, e.position
    FROM employees e
    WHERE e.active = 1 AND EXISTS (
      SELECT 1 FROM employee_project_assignments assignment
      WHERE assignment.employee_id = e.id AND assignment.site_id = 1 AND assignment.active = 1
    )
    ORDER BY CASE WHEN upper(trim(e.employment_type)) = 'ОПР' THEN 1 ELSE 0 END, e.full_name, e.id`, [], { includePayload: true }));
  results.push(await timedQuery(`${label}: табель рабочих за месяц`, `
    SELECT employee_id, work_date, SUM(hours)::integer AS hours
    FROM placement_entries
    WHERE site_id = 1 AND work_date >= DATE '2026-09-01' AND work_date < DATE '2026-10-01'
      AND deleted_at IS NULL AND upper(trim(employment_type_snapshot)) = 'ОПР'
    GROUP BY employee_id, work_date
    ORDER BY work_date, employee_id`));
  results.push(await timedQuery(`${label}: отметки табеля рабочих`, `
    SELECT employee_id, work_date, hours, code FROM timesheet_marks
    WHERE site_id = 1 AND work_date >= DATE '2026-09-01' AND work_date < DATE '2026-10-01'
    ORDER BY work_date, employee_id`, [], { includePayload: true }));
  results.push(await timedQuery(`${label}: реестр техники`, `
    SELECT eu.id, eu.organization, eu.equipment_type, eu.model, eu.registration_number
    FROM equipment_units eu
    JOIN equipment_project_assignments assignment ON assignment.equipment_id = eu.id
    WHERE eu.active = 1 AND assignment.site_id = 1 AND assignment.active = 1
    ORDER BY eu.equipment_type, eu.model, eu.registration_number, eu.id`, [], { includePayload: true }));
  results.push(await timedQuery(`${label}: табель техники за месяц`, `
    SELECT equipment_id, work_date, productive_hours, downtime_hours
    FROM equipment_timesheet_marks
    WHERE site_id = 1 AND work_date >= DATE '2026-09-01' AND work_date < DATE '2026-10-01'
    ORDER BY work_date, equipment_id`, [], { includePayload: true }));
  results.push(await timedQuery(`${label}: журнал действий`, `
    SELECT id, actor_name, category, summary, created_at
    FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 200`, [], { includePayload: true }));
  results.push(await timedQuery(`${label}: страница сотрудников (200)`, `
    SELECT id, full_name, employment_type, department, position
    FROM employees WHERE active = 1 ORDER BY full_name, id LIMIT 200`, [], { includePayload: true }));
  return results;
}

async function createScaleIndexes() {
  await client.query(`
    CREATE INDEX idx_employees_active_name_stress
      ON employees (full_name, id) WHERE active = 1;
    CREATE INDEX idx_employee_assignments_site_employee_active_stress
      ON employee_project_assignments (site_id, employee_id) WHERE active = 1;
    CREATE INDEX idx_placement_entries_opr_site_date_stress
      ON placement_entries (site_id, work_date, employee_id)
      WHERE deleted_at IS NULL AND upper(trim(employment_type_snapshot)) = 'ОПР';
    CREATE INDEX idx_equipment_units_active_sort_stress
      ON equipment_units (equipment_type, model, registration_number, id) WHERE active = 1;
    CREATE INDEX idx_equipment_assignments_site_equipment_active_stress
      ON equipment_project_assignments (site_id, equipment_id) WHERE active = 1;
  `);
  await client.query("ANALYZE");
}

async function concurrentReadBenchmark() {
  const pool = new Pool({ ...databaseConfiguration, max: 10, connectionTimeoutMillis: 10_000 });
  const statements = [
    `SELECT id, employee_id, hours FROM ${quotedSchema}.placement_entries
      WHERE site_id = 1 AND work_date = DATE '2026-09-15' AND deleted_at IS NULL ORDER BY id`,
    `SELECT employee_id, work_date, SUM(hours)::integer AS hours FROM ${quotedSchema}.placement_entries
      WHERE site_id = 1 AND work_date >= DATE '2026-09-01' AND work_date < DATE '2026-10-01'
        AND deleted_at IS NULL AND upper(trim(employment_type_snapshot)) = 'ОПР'
      GROUP BY employee_id, work_date`,
    `SELECT equipment_id, work_date, productive_hours, downtime_hours FROM ${quotedSchema}.equipment_timesheet_marks
      WHERE site_id = 1 AND work_date >= DATE '2026-09-01' AND work_date < DATE '2026-10-01'`,
    `SELECT id, actor_name, category, summary, created_at FROM ${quotedSchema}.audit_events
      ORDER BY created_at DESC, id DESC LIMIT 200`,
  ];
  try {
    const measurements = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const started = process.hrtime.bigint();
      const result = await pool.query(statements[index % statements.length]);
      return { milliseconds: elapsedMs(started), rows: result.rowCount ?? result.rows.length };
    }));
    measurements.sort((left, right) => left.milliseconds - right.milliseconds);
    const percentile = (share) => measurements[Math.min(measurements.length - 1, Math.floor(measurements.length * share))].milliseconds;
    return {
      requests: measurements.length,
      pool: 10,
      p50: Math.round(percentile(0.5) * 10) / 10,
      p95: Math.round(percentile(0.95) * 10) / 10,
      max: Math.round(measurements.at(-1).milliseconds * 10) / 10,
      rows: measurements.reduce((sum, item) => sum + item.rows, 0),
    };
  } finally {
    await pool.end();
  }
}

function assess(results) {
  const operational = results.filter((result) => !result.name.includes("сотрудники проекта") && !result.name.includes("реестр техники"));
  const slow = operational.filter((result) => result.milliseconds > 1_000);
  return { passed: slow.length === 0, slow };
}

async function main() {
  await client.connect();
  connected = true;
  const target = (await client.query(`SELECT current_database() AS database, current_user AS username,
    inet_server_addr()::text AS server_address`)).rows[0];
  if (target.database !== "personnel") {
    throw new Error(`Ожидалась локальная БД personnel, получена ${target.database}.`);
  }
  console.log(`Локальная БД проверена: ${target.database}, ${target.server_address ?? "local socket"}.`);
  console.log(`Временная схема: ${schemaName}. Производственные таблицы не изменяются.`);
  console.log("Объём синтетических данных:", counts);

  const fixtureStart = process.hrtime.bigint();
  await createFixture();
  await createCurrentIndexes();
  console.log(`Данные подготовлены за ${Math.round(elapsedMs(fixtureStart))} мс.`);

  const currentResults = await benchmark("Текущие индексы");
  await createScaleIndexes();
  const optimizedResults = await benchmark("Масштабные индексы");
  console.table([...currentResults, ...optimizedResults].map((result) => ({
    name: result.name,
    milliseconds: result.milliseconds,
    rows: result.rows,
    payload: result.payload,
  })));
  const concurrentResult = await concurrentReadBenchmark();
  console.log("40 параллельных запросов чтения:", concurrentResult);
  const largePayloads = optimizedResults.filter((result) => result.payloadBytes > 10 * 1024 * 1024);
  if (largePayloads.length) {
    console.warn(`Внимание: ответы больше 10 МБ требуют серверной пагинации: ${largePayloads.map((item) => `${item.name} — ${item.payload}`).join(", ")}.`);
  }

  const memory = process.memoryUsage();
  const projectedPersonnelCells = counts.employees * 35;
  const projectedEquipmentCells = counts.equipmentUnits * 38;
  console.log(`Оценка обычной HTML-таблицы: ${projectedPersonnelCells.toLocaleString("ru-RU")} ячеек табеля рабочих и ${projectedEquipmentCells.toLocaleString("ru-RU")} ячеек табеля техники.`);
  console.log(`Пиковая память процесса теста: RSS ${formatBytes(memory.rss)}, heap ${formatBytes(memory.heapUsed)}.`);

  const assessment = assess(optimizedResults);
  if (concurrentResult.p95 > 2_000) {
    assessment.passed = false;
    assessment.slow.push({ name: "40 параллельных запросов (p95)", milliseconds: concurrentResult.p95 });
  }
  if (!assessment.passed) {
    console.error("Порог 1000 мс превышен:", assessment.slow.map((item) => `${item.name}: ${item.milliseconds} мс`).join(", "));
    process.exitCode = 2;
  }
}

try {
  await main();
} finally {
  if (connected) {
    if (/^stress_test_\d+_\d+$/.test(schemaName)) {
      await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch((error) => {
        console.error(`Не удалось удалить временную схему ${schemaName}:`, error);
        process.exitCode = 3;
      });
      if (process.exitCode !== 3) console.log(`Временная схема ${schemaName} удалена.`);
    }
    await client.end();
    connected = false;
  }
}
