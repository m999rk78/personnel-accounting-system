import { defineConfig } from "drizzle-kit";
import { readFileSync } from "node:fs";

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return false;

  const certificate = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n")
    ?? (process.env.DATABASE_CA_CERT_FILE ? readFileSync(process.env.DATABASE_CA_CERT_FILE, "utf8") : undefined);

  if (mode === "verify-full" && !certificate) {
    throw new Error("DATABASE_CA_CERT or DATABASE_CA_CERT_FILE is required for verify-full SSL.");
  }

  return certificate ? { ca: certificate, rejectUnauthorized: true } : mode;
}

const dbCredentials = process.env.PGHOST
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE ?? "personnel",
      ssl: sslConfiguration(),
    }
  : {
      url: process.env.DATABASE_URL ?? "postgresql://personnel:personnel@localhost:5432/personnel",
    };

export default defineConfig({
  out: "./drizzle-postgres",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials,
});
