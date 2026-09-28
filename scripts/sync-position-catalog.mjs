import { readFile } from "node:fs/promises";
import pg from "pg";

const args = process.argv.slice(2);
const catalogPath = args.find((argument) => argument !== "--apply");
const apply = args.includes("--apply");
if (!catalogPath) throw new Error("Передайте путь к JSON-файлу со строками employmentType, department и position.");

const normalize = (value) => String(value ?? "").trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const key = (row) => [row.employmentType, row.department, row.position].map(normalize).join("\u0000");
const label = (row) => `${row.employmentType} | ${row.department} | ${row.position}`;
const sourceRows = JSON.parse(await readFile(catalogPath, "utf8"));
if (!Array.isArray(sourceRows) || !sourceRows.length || sourceRows.length > 2000) throw new Error("Каталог должен содержать от 1 до 2000 строк.");

const expectedRows = sourceRows.map((row, index) => {
  const prepared = {
    employmentType: String(row.employmentType ?? "").trim(),
    department: String(row.department ?? "").trim(),
    position: String(row.position ?? "").trim(),
  };
  if (!prepared.employmentType || !prepared.department || !prepared.position) throw new Error(`Строка ${index + 1}: заполните тип, отдел и должность.`);
  return prepared;
});
const expectedByKey = new Map();
for (const row of expectedRows) {
  const rowKey = key(row);
  if (expectedByKey.has(rowKey)) throw new Error(`Строка «${label(row)}» повторяется в каталоге.`);
  expectedByKey.set(rowKey, row);
}

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return undefined;
  const certificate = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n");
  if (mode === "verify-full" && !certificate) throw new Error("Для DATABASE_SSL=verify-full требуется DATABASE_CA_CERT.");
  return certificate ? { ca: certificate, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

const pool = new pg.Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "personnel",
  }),
  ssl: sslConfiguration(),
  max: 1,
});
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('personnel-position-catalog-sync'))");
  const connection = await client.query("SELECT current_database() AS database, current_user AS username");
  if (connection.rows[0].database !== "personnel" || connection.rows[0].username !== "personnel") {
    throw new Error(`Ожидались база и пользователь personnel, получены ${connection.rows[0].database}/${connection.rows[0].username}.`);
  }
  const catalogResult = await client.query(`SELECT id, employment_type AS "employmentType", department, position
    FROM position_catalog WHERE active = 1 ORDER BY id FOR UPDATE`);
  const actualGroups = new Map();
  for (const row of catalogResult.rows) {
    const rowKey = key(row);
    actualGroups.set(rowKey, [...(actualGroups.get(rowKey) ?? []), row]);
  }

  const missing = [];
  const extras = [];
  for (const [rowKey, expected] of expectedByKey) {
    const candidates = actualGroups.get(rowKey) ?? [];
    if (!candidates.length) {
      missing.push(expected);
      continue;
    }
    const exact = candidates.find((candidate) => candidate.employmentType === expected.employmentType && candidate.department === expected.department && candidate.position === expected.position);
    const kept = exact ?? candidates[0];
    extras.push(...candidates.filter((candidate) => candidate.id !== kept.id));
    actualGroups.delete(rowKey);
  }
  for (const candidates of actualGroups.values()) extras.push(...candidates);

  const blocked = [];
  for (const row of extras) {
    const usage = await client.query(`SELECT COUNT(*)::int AS count FROM employees
      WHERE active = 1 AND employment_type = $1 AND department = $2 AND position = $3`,
      [row.employmentType, row.department, row.position]);
    if (usage.rows[0].count) blocked.push({ ...row, activeEmployees: usage.rows[0].count });
  }

  if (apply && blocked.length) {
    throw new Error(`Синхронизация остановлена: ${blocked.length} лишних должностей используются активными сотрудниками: ${blocked.slice(0, 5).map(label).join("; ")}.`);
  }
  if (apply) {
    for (const row of missing) {
      await client.query(`INSERT INTO position_catalog (employment_type, department, position)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [row.employmentType, row.department, row.position]);
    }
    if (extras.length) await client.query("DELETE FROM position_catalog WHERE id = ANY($1::int[])", [extras.map((row) => row.id)]);
    await client.query("UPDATE personnel_options SET active = 0 WHERE kind = 'employmentType' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND employment_type = personnel_options.name)");
    await client.query("UPDATE personnel_options SET active = 0 WHERE kind = 'department' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND department = personnel_options.name)");
    await client.query("UPDATE personnel_options SET active = 0 WHERE kind = 'position' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND position = personnel_options.name)");
    await client.query("INSERT INTO personnel_options (kind, name) SELECT DISTINCT 'employmentType', employment_type FROM position_catalog WHERE employment_type <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'employmentType' AND name = position_catalog.employment_type AND active = 1)");
    await client.query("INSERT INTO personnel_options (kind, name) SELECT DISTINCT 'department', department FROM position_catalog WHERE department <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'department' AND name = position_catalog.department AND active = 1)");
    await client.query("INSERT INTO personnel_options (kind, name) SELECT DISTINCT 'position', position FROM position_catalog WHERE position <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'position' AND name = position_catalog.position AND active = 1)");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }

  console.log(JSON.stringify({
    ok: true,
    mode: apply ? "applied" : "dry-run",
    expectedRows: expectedRows.length,
    currentRows: catalogResult.rows.length,
    missingCount: missing.length,
    extraCount: extras.length,
    blockedCount: blocked.length,
    missing: missing.map(label),
    extra: extras.map(label),
    blocked: blocked.map((row) => ({ value: label(row), activeEmployees: row.activeEmployees })),
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
