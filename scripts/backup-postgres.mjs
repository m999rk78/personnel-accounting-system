import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const args = process.argv.slice(2);
const allowRemote = args.includes("--allow-remote");
const outputArgument = args.find((argument) => argument !== "--allow-remote");
const outputPath = resolve(outputArgument ?? `backups/personnel-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
const connectionUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const host = connectionUrl?.hostname ?? process.env.PGHOST ?? "";
const isLocal = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
if (!host) throw new Error("Не задан DATABASE_URL или PGHOST.");
if (!isLocal && !allowRemote) throw new Error("Для резервного копирования удалённой базы передайте --allow-remote.");

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return undefined;
  const certificate = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n")
    ?? (process.env.DATABASE_CA_CERT_FILE ? readFile(process.env.DATABASE_CA_CERT_FILE, "utf8") : undefined);
  return Promise.resolve(certificate).then((value) => value ? { ca: value, rejectUnauthorized: true } : { rejectUnauthorized: false });
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

const ssl = await sslConfiguration();
const pool = new pg.Pool({
  ...(connectionUrl ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "personnel",
  }),
  ssl,
  max: 1,
});

try {
  const connection = await pool.query("SELECT current_database() AS database, current_user AS username, inet_server_addr()::text AS server_address");
  const target = connection.rows[0];
  if (target.database !== "personnel" || target.username !== "personnel") {
    throw new Error(`Ожидались база и пользователь personnel, получены ${target.database}/${target.username}.`);
  }
  const tableResult = await pool.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const tables = [];
  for (const { table_name: tableName } of tableResult.rows) {
    const columns = await pool.query(`SELECT column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [tableName]);
    const rows = await pool.query(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY 1`);
    tables.push({ name: tableName, columns: columns.rows, rows: rows.rows });
  }
  const sequences = await pool.query("SELECT sequencename AS name, last_value AS value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename");
  const backup = {
    format: "personnel-postgres-json-v1",
    createdAt: new Date().toISOString(),
    database: target.database,
    serverAddress: target.server_address,
    tables,
    sequences: sequences.rows,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(backup, null, 2), { encoding: "utf8", mode: 0o600 });
  const verified = JSON.parse(await readFile(outputPath, "utf8"));
  if (verified.format !== backup.format || verified.tables.length !== tables.length) throw new Error("Не удалось проверить созданную резервную копию.");
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    tableCount: tables.length,
    rowCount: tables.reduce((sum, table) => sum + table.rows.length, 0),
  }, null, 2));
} finally {
  await pool.end();
}
