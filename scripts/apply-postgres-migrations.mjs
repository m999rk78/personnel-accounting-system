import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

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

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return undefined;
  const certificate = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n")
    ?? (process.env.DATABASE_CA_CERT_FILE ? readFileSync(process.env.DATABASE_CA_CERT_FILE, "utf8") : undefined);
  if (mode === "verify-full" && !certificate) {
    throw new Error("Для DATABASE_SSL=verify-full требуется сертификат Яндекс Облака.");
  }
  return certificate ? { ca: certificate, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    throw new Error("Не задана переменная DATABASE_URL или PGHOST.");
  }

  const poolConfig = {
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    ssl: sslConfiguration(),
    max: 1,
    connectionTimeoutMillis: 15_000,
  };
  const lockPool = new Pool(poolConfig);
  const pool = new Pool(poolConfig);
  const lockClient = await lockPool.connect();

  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext('personnel-schema-migrations'))");
    const connection = await pool.query(
      "SELECT current_database() AS database, current_user AS username, inet_server_addr()::text AS server_address",
    );
    const target = connection.rows[0];
    if (target.database !== "personnel") {
      throw new Error(`Ожидалась база personnel, но подключение установлено к ${target.database}. Миграция остановлена.`);
    }
    if (target.username !== "personnel") {
      throw new Error(`Ожидался пользователь personnel, но подключение выполнено как ${target.username}. Миграция остановлена.`);
    }

    console.log(`Подключение проверено: база ${target.database}, пользователь ${target.username}.`);
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle-postgres") });
    console.log("Миграции PostgreSQL успешно применены.");
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('personnel-schema-migrations'))").catch(() => undefined);
    lockClient.release();
    await pool.end();
    await lockPool.end();
  }
}

main().catch((error) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
