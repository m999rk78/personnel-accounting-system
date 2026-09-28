import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";

const CA_URL = "https://storage.yandexcloud.net/cloud-certs/CA.pem";
const CA_PATH = resolve(".certificates/yandex-cloud-ca.pem");
const PERSONNEL_DATABASE_HOST = "rc1b-p176vla5mhlldu1a.mdb.yandexcloud.net";
const ALLOWED_TASKS = new Set(["migrate", "backup", "sync-positions"]);

function usage() {
  console.log("Использование: npm run db:yandex -- <FQDN> <migrate|backup|sync-positions> [аргументы]");
}

async function ensureCertificate() {
  if (existsSync(CA_PATH)) return;
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error(`Не удалось скачать сертификат Яндекс Облака: HTTP ${response.status}`);
  const certificate = await response.text();
  if (!certificate.includes("BEGIN CERTIFICATE")) throw new Error("Получен некорректный сертификат Яндекс Облака.");
  mkdirSync(dirname(CA_PATH), { recursive: true });
  writeFileSync(CA_PATH, certificate, { mode: 0o600 });
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Задайте PGPASSWORD или YC_POSTGRES_PASSWORD_SECRET_ID.");
  return new Promise((resolveSecret, reject) => {
    let secret = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (character) => {
      if (character === "\u0003") { finish(); reject(new Error("Операция отменена.")); }
      else if (character === "\r" || character === "\n") { finish(); resolveSecret(secret); }
      else if (character === "\u007f" || character === "\b") secret = secret.slice(0, -1);
      else if (character >= " ") secret += character;
    };
    process.stdin.on("data", onData);
  });
}

async function password() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  const secretId = process.env.YC_POSTGRES_PASSWORD_SECRET_ID;
  if (secretId) {
    const yc = process.env.YC_CLI_PATH ?? "yc";
    return execFileSync(yc, ["lockbox", "payload", "get", secretId, "--key", process.env.YC_POSTGRES_PASSWORD_SECRET_KEY ?? "postgresql_password"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  }
  return readSecret("Пароль пользователя personnel: ");
}

function run(script, args, environment) {
  const result = spawnSync(process.execPath, [resolve(script), ...args], { cwd: process.cwd(), env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Команда завершилась с кодом ${result.status}.`);
}

async function main() {
  const [host, task, ...taskArgs] = process.argv.slice(2);
  if (!host || !task || !ALLOWED_TASKS.has(task)) { usage(); process.exitCode = 1; return; }
  if (host !== PERSONNEL_DATABASE_HOST) {
    throw new Error("Команда разрешена только для PostgreSQL системы учета персонала в облаке cloud-system-yums-personnel.");
  }
  await ensureCertificate();
  const databasePassword = await password();
  if (!databasePassword) throw new Error("Пароль PostgreSQL не получен.");
  const certificate = readFileSync(CA_PATH, "utf8");
  const environment = {
    ...process.env,
    DATABASE_URL: "",
    PGHOST: host,
    PGPORT: "6432",
    PGDATABASE: "personnel",
    PGUSER: "personnel",
    PGPASSWORD: databasePassword,
    DATABASE_SSL: "verify-full",
    DATABASE_CA_CERT: certificate,
    DATABASE_CA_CERT_FILE: CA_PATH,
  };
  if (task === "migrate") run("scripts/apply-postgres-migrations.mjs", taskArgs, environment);
  if (task === "backup") run("scripts/backup-postgres.mjs", [...taskArgs, "--allow-remote"], environment);
  if (task === "sync-positions") run("scripts/sync-position-catalog.mjs", taskArgs, environment);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
