import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const outputPath = resolve(process.argv[2] ?? `backups/personnel-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
const connectionUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (!connectionUrl || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(connectionUrl.hostname)) {
  throw new Error("Резервная копия разрешена только при подключении к локальной базе через DATABASE_URL.");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

try {
  const connection = await pool.query("SELECT current_database() AS database, inet_server_addr()::text AS server_address");
  const target = connection.rows[0];
  if (target.database !== "personnel") throw new Error(`Ожидалась база personnel, получена ${target.database}.`);
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
