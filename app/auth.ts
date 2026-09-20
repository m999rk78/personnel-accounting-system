import { getDatabase } from "../db/client";

export type AuthUser = {
  id: number;
  fullName: string;
  email: string;
  role: "foreman" | "office";
  assignedSiteId: number | null;
};

const SESSION_COOKIE = "personnel_session";
const PASSWORD_ITERATIONS = 600_000;
const SESSION_DAYS = 30;
const INVITATION_HOURS = 72;
const encoder = new TextEncoder();

function database() {
  return getDatabase();
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function ensureAuthSchema() {
  const db = database();
  await db.prepare(`CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    assigned_site_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  )`).run();
  const columns = await db.prepare("PRAGMA table_info(app_users)").all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  if (!names.has("password_hash")) await db.prepare("ALTER TABLE app_users ADD COLUMN password_hash TEXT").run();
  if (!names.has("password_salt")) await db.prepare("ALTER TABLE app_users ADD COLUMN password_salt TEXT").run();
  if (!names.has("password_iterations")) await db.prepare("ALTER TABLE app_users ADD COLUMN password_iterations INTEGER").run();
  if (!names.has("invited_at")) await db.prepare("ALTER TABLE app_users ADD COLUMN invited_at TEXT").run();
  if (!names.has("activated_at")) await db.prepare("ALTER TABLE app_users ADD COLUMN activated_at TEXT").run();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS user_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_user_invitations_user ON user_invitations(user_id, used_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, revoked_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_login_attempts_key_time ON login_attempts(attempt_key, created_at)"),
  ]);
}

export async function loginAttemptKey(request: Request, email: string) {
  const address = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  return sha256(`${email}\u0000${address}`);
}

export function validatePassword(password: string) {
  if (password.length < 10) throw new Error("Пароль должен содержать не менее 10 символов.");
  if (password.length > 128) throw new Error("Пароль не должен быть длиннее 128 символов.");
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS }, material, 256);
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt), iterations: PASSWORD_ITERATIONS };
}

export async function verifyPassword(password: string, hash: string, salt: string, iterations: number) {
  if (!password || !hash || !salt || !iterations) return false;
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(salt), iterations }, material, 256);
  return safeEqual(bytesToBase64(new Uint8Array(bits)), hash);
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

export async function getAuthUser(request: Request): Promise<AuthUser | null> {
  await ensureAuthSchema();
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const user = await database().prepare(`SELECT u.id, u.full_name AS fullName, u.email, u.role, u.assigned_site_id AS assignedSiteId
    FROM user_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP AND u.active = 1`)
    .bind(tokenHash).first<AuthUser>();
  return user ?? null;
}

export async function createSession(userId: number, request: Request) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  await database().prepare("INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATETIME('now', ?))")
    .bind(userId, tokenHash, `+${SESSION_DAYS} days`).run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export async function revokeSession(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await database().prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256(token)).run();
}

export function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function createInvitation(userId: number, request: Request) {
  await ensureAuthSchema();
  const token = randomToken();
  const tokenHash = await sha256(token);
  await database().batch([
    database().prepare("UPDATE user_invitations SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").bind(userId),
    database().prepare("INSERT INTO user_invitations (user_id, token_hash, expires_at) VALUES (?, ?, DATETIME('now', ?))").bind(userId, tokenHash, `+${INVITATION_HOURS} hours`),
    database().prepare("UPDATE app_users SET invited_at = CURRENT_TIMESTAMP WHERE id = ?").bind(userId),
  ]);
  const configuredOrigin = process.env.PUBLIC_APP_ORIGIN?.trim();
  const applicationOrigin = configuredOrigin ? new URL(configuredOrigin).origin : new URL(request.url).origin;
  return `${applicationOrigin}/invite?token=${encodeURIComponent(token)}`;
}

export async function invitationUser(token: string) {
  await ensureAuthSchema();
  if (!token) return null;
  return database().prepare(`SELECT u.id, u.full_name AS fullName, u.email
    FROM user_invitations i JOIN app_users u ON u.id = i.user_id
    WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP AND u.active = 1`)
    .bind(await sha256(token)).first<{ id: number; fullName: string; email: string }>();
}

export async function acceptInvitation(token: string, password: string, request: Request) {
  const invitedUser = await invitationUser(token);
  if (!invitedUser) throw new Error("Ссылка приглашения недействительна или уже истекла.");
  const passwordData = await hashPassword(password);
  const tokenHash = await sha256(token);
  await database().batch([
    database().prepare("UPDATE app_users SET password_hash = ?, password_salt = ?, password_iterations = ?, activated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(passwordData.hash, passwordData.salt, passwordData.iterations, invitedUser.id),
    database().prepare("UPDATE user_invitations SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL").bind(tokenHash),
    database().prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").bind(invitedUser.id),
  ]);
  return { user: invitedUser, cookie: await createSession(invitedUser.id, request) };
}

export async function sendInvitationEmail(input: { to: string; fullName: string; invitationUrl: string; userId: number }) {
  const provider = process.env.MAIL_PROVIDER?.trim().toLocaleLowerCase() ?? "";
  const from = process.env.MAIL_FROM ?? "";
  if (!provider || !from) return { sent: false, reason: "email-not-configured" as const };
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const subject = "Приглашение в систему учёта персонала";
  const text = `Здравствуйте, ${input.fullName}!\n\nВас пригласили в систему учёта персонала.\nСоздайте пароль и войдите: ${input.invitationUrl}\n\nСсылка действует ${INVITATION_HOURS} часа.`;
  const html = `<p>Здравствуйте, ${escape(input.fullName)}!</p><p>Вас пригласили в систему учёта персонала.</p><p><a href="${escape(input.invitationUrl)}">Создать пароль и войти</a></p><p>Ссылка действует ${INVITATION_HOURS} часа.</p>`;
  try {
    let response: Response;
    if (provider === "yandex-postbox") {
      const tokenResponse = await fetch("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!tokenResponse.ok) throw new Error(`Cloud metadata returned ${tokenResponse.status}`);
      const tokenPayload = await tokenResponse.json() as { access_token?: string };
      if (!tokenPayload.access_token) throw new Error("Cloud metadata did not return an IAM token");
      response = await fetch("https://postbox.cloud.yandex.net/v2/email/outbound-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-YaCloud-SubjectToken": tokenPayload.access_token },
        body: JSON.stringify({
          FromEmailAddress: from,
          Destination: { ToAddresses: [input.to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: text, Charset: "UTF-8" },
                Html: { Data: html, Charset: "UTF-8" },
              },
            },
          },
        }),
      });
    } else if (provider === "resend") {
      const apiKey = process.env.RESEND_API_KEY ?? "";
      if (!apiKey) return { sent: false, reason: "email-not-configured" as const };
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `personnel-invite-${input.userId}` },
        body: JSON.stringify({ from, to: [input.to], subject, html, text }),
      });
    } else {
      return { sent: false, reason: "email-not-configured" as const };
    }
    if (!response.ok) console.error("Invitation email provider error", { provider, status: response.status });
    return response.ok ? { sent: true as const } : { sent: false as const, reason: "email-provider-error" as const };
  } catch (error) {
    console.error("Invitation email delivery failed", { provider, error: error instanceof Error ? error.message : "Unknown error" });
    return { sent: false as const, reason: "email-provider-error" as const };
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const allowedOrigins = new Set([new URL(request.url).origin]);
  for (const configuredOrigin of (process.env.APP_ORIGIN ?? "").split(/[,;\s]+/)) {
    const value = configuredOrigin.trim();
    if (value) allowedOrigins.add(new URL(value).origin);
  }
  let requestOrigin: string;
  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    throw new Error("Запрос с другого сайта отклонён.");
  }
  if (!allowedOrigins.has(requestOrigin)) throw new Error("Запрос с другого сайта отклонён.");
}
