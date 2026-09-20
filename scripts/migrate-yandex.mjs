import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";

const CA_URL = "https://storage.yandexcloud.net/cloud-certs/CA.pem";
const CA_PATH = resolve(".certificates/yandex-cloud-ca.pem");

function usage() {
  console.log("Использование: npm run db:migrate-yandex -- <FQDN PostgreSQL-хоста>");
}

async function ensureCertificate() {
  if (existsSync(CA_PATH)) return;
  console.log("Скачиваю корневой сертификат Яндекс Облака...");
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error(`Не удалось скачать сертификат: HTTP ${response.status}`);
  const certificate = await response.text();
  if (!certificate.includes("BEGIN CERTIFICATE")) throw new Error("Получен некорректный сертификат.");
  mkdirSync(dirname(CA_PATH), { recursive: true });
  writeFileSync(CA_PATH, certificate, { mode: 0o600 });
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("Команду нужно запустить в обычном интерактивном терминале.");
  }

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
      if (character === "\u0003") {
        finish();
        reject(new Error("Операция отменена."));
      } else if (character === "\r" || character === "\n") {
        finish();
        resolveSecret(secret);
      } else if (character === "\u007f" || character === "\b") {
        secret = secret.slice(0, -1);
      } else if (character >= " ") {
        secret += character;
      }
    };

    process.stdin.on("data", onData);
  });
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Команда завершилась с кодом ${result.status}.`);
}

async function main() {
  const host = process.argv[2];
  if (!host || host === "--help" || host === "-h") {
    usage();
    process.exitCode = host ? 0 : 1;
    return;
  }
  if (!/^[a-z0-9.-]+\.mdb\.yandexcloud\.net$/i.test(host)) {
    throw new Error("Указан некорректный FQDN хоста Яндекс Managed PostgreSQL.");
  }

  await ensureCertificate();
  const password = await readSecret("Пароль пользователя personnel: ");
  if (!password) throw new Error("Пароль не введён.");

  const environment = {
    ...process.env,
    DATABASE_URL: "",
    PGHOST: host,
    PGPORT: "6432",
    PGDATABASE: "personnel",
    PGUSER: "personnel",
    PGPASSWORD: password,
    DATABASE_SSL: "verify-full",
    DATABASE_CA_CERT_FILE: CA_PATH,
  };

  console.log("\n1/2 Применяю структуру базы данных...");
  run(process.execPath, [resolve("scripts/apply-postgres-migrations.mjs")], environment);

  console.log("\n2/2 Переношу данные из локальной базы...");
  run(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", resolve("scripts/import-sqlite-to-postgres.mjs")],
    environment,
  );

  console.log("\nГотово: структура и данные перенесены в Яндекс Managed PostgreSQL.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
