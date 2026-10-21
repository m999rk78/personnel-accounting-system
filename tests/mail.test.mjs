import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import nodemailer from "nodemailer";

function mailTransport() {
  // Build MIME locally: never send test invitations or use production credentials.
  return nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

test("mail library builds UTF-8 invitations with the expected SMTP envelope", async () => {
  const info = await mailTransport().sendMail({
    from: "no-reply@example.invalid",
    to: "recipient@example.invalid",
    subject: "Приглашение в систему учёта персонала",
    text: "Здравствуйте! Создайте пароль и войдите: https://example.invalid/invite/test",
    html: '<p>Здравствуйте!</p><a href="https://example.invalid/invite/test">Войти</a>',
  });
  assert.deepEqual(info.envelope, {
    from: "no-reply@example.invalid",
    to: ["recipient@example.invalid"],
  });
  const message = info.message.toString();
  assert.match(message, /multipart\/alternative/);
  assert.match(message, /text\/plain; charset=utf-8/);
  assert.match(message, /text\/html; charset=utf-8/);
  assert.match(message, /Subject: =\?UTF-8\?/i);
  assert.match(message, /https:\/\/example\.invalid\/invite\/test/);
});

test("mail rendering refuses filesystem and remote URL content", async () => {
  await assert.rejects(mailTransport().sendMail({
    from: "from@example.invalid", to: "to@example.invalid",
    raw: { path: "/test-must-not-read-a-local-file" },
  }), /file access rejected/i);
  await assert.rejects(mailTransport().sendMail({
    from: "from@example.invalid", to: "to@example.invalid",
    raw: { href: "https://example.invalid/test-must-not-fetch" },
  }), /url access rejected/i);
});

test("production mail keeps Postbox TLS, bounded waits and content access restrictions", async () => {
  const source = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");
  assert.match(source, /host: "postbox\.cloud\.yandex\.net"/);
  assert.match(source, /port: 465/);
  assert.match(source, /secure: true/);
  assert.match(source, /connectionTimeout: 10_000/);
  assert.match(source, /greetingTimeout: 10_000/);
  assert.match(source, /socketTimeout: 20_000/);
  assert.match(source, /disableFileAccess: true/);
  assert.match(source, /disableUrlAccess: true/);
  assert.equal((source.match(/signal: AbortSignal\.timeout\(20_000\)/g) ?? []).length, 2);
});
