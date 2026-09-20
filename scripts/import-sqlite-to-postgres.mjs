import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import pg from "pg";

const { Client } = pg;

function describeError(error) {
  if (error && Array.isArray(error.errors) && error.errors.length) {
    return error.errors.map(describeError).join("\n");
  }
  if (error instanceof Error) {
    const code = "code" in error && error.code ? ` [${error.code}]` : "";
    return `${error.name}${code}: ${error.message || "неизвестная ошибка"}`;
  }
  return String(error);
}

const TABLES = [
  "sites",
  "app_users",
  "login_attempts",
  "user_invitations",
  "user_sessions",
  "employees",
  "employee_project_assignments",
  "personnel_options",
  "position_catalog",
  "shifts",
  "zones",
  "main_work_types",
  "subwork_types",
  "masters",
  "placement_entries",
];

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Недопустимый SQL-идентификатор: ${value}`);
  return `"${value}"`;
}

function findDefaultDatabase() {
  const root = resolve(".wrangler/state/v3/d1");
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite")
    .map((entry) => join(entry.parentPath, entry.name));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error("Найдено несколько локальных D1-баз. Передайте путь явно после --.");
  }
  return null;
}

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return undefined;
  const certificate = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n")
    ?? (process.env.DATABASE_CA_CERT_FILE ? readFileSync(process.env.DATABASE_CA_CERT_FILE, "utf8") : undefined);
  if (mode === "verify-full" && !certificate) {
    throw new Error("Для DATABASE_SSL=verify-full требуется DATABASE_CA_CERT.");
  }
  return certificate ? { ca: certificate, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && !process.env.PGHOST) {
    throw new Error("Не задана переменная DATABASE_URL или PGHOST.");
  }

  const sourcePath = resolve(process.argv[2] ?? findDefaultDatabase() ?? "");
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error("Локальная D1/SQLite-база не найдена. Передайте путь: npm run db:import-sqlite -- /path/to/database.sqlite");
  }
  if (basename(sourcePath) === "metadata.sqlite") throw new Error("Указан служебный metadata.sqlite, а не база приложения.");

  const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
  const client = new Client({
    ...(connectionString ? { connectionString } : {}),
    ssl: sslConfiguration(),
  });
  await client.connect();
  try {
    const existingTables = new Set(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
    );
    const targetState = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [TABLES],
    );
    const targetTables = new Set(targetState.rows.map((row) => row.table_name));
    const missing = TABLES.filter((table) => !targetTables.has(table));
    if (missing.length) {
      throw new Error(`В PostgreSQL не применены миграции. Отсутствуют таблицы: ${missing.join(", ")}`);
    }

    if (process.env.ALLOW_NONEMPTY_TARGET !== "true") {
      for (const table of TABLES) {
        const result = await client.query(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`);
        if (result.rowCount) {
          throw new Error(
            `Таблица ${table} в PostgreSQL уже содержит данные. Импорт остановлен, чтобы ничего не перезаписать.`,
          );
        }
      }
    }

    await client.query("BEGIN");
    const totals = [];
    for (const table of TABLES) {
      if (!existingTables.has(table)) continue;
      const sourceColumns = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((column) => String(column.name));
      const targetColumnsResult = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1
         ORDER BY ordinal_position`,
        [table],
      );
      const targetColumns = new Set(targetColumnsResult.rows.map((column) => column.column_name));
      const columns = sourceColumns.filter((column) => targetColumns.has(column));
      if (!columns.length) continue;

      const rows = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const insert = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`;
      for (const row of rows) await client.query(insert, columns.map((column) => row[column]));
      totals.push(`${table}: ${rows.length}`);
    }

    for (const table of TABLES) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdentifier(table)}), 1), EXISTS (SELECT 1 FROM ${quoteIdentifier(table)}))`,
        [table],
      );
    }
    await client.query("COMMIT");
    console.log(`Импорт завершён из ${sourcePath}`);
    console.log(totals.join("\n"));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    sqlite.close();
    await client.end();
  }
}

main().catch((error) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
