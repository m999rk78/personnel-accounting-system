import { env } from "cloudflare:workers";
import { assertSameOrigin, createSession, ensureAuthSchema, loginAttemptKey, verifyPassword } from "../../../auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await ensureAuthSchema();
    const body = await request.json() as { email?: string; password?: string };
    const email = body.email?.trim().toLocaleLowerCase() ?? "";
    const attemptKey = await loginAttemptKey(request, email);
    await env.DB.prepare("DELETE FROM login_attempts WHERE created_at <= DATETIME('now', '-15 minutes')").run();
    const attempts = await env.DB.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE attempt_key = ? AND created_at > DATETIME('now', '-15 minutes')").bind(attemptKey).first<{ count: number }>();
    if (Number(attempts?.count ?? 0) >= 5) return Response.json({ error: "Слишком много попыток. Повторите вход через 15 минут." }, { status: 429 });
    const user = await env.DB.prepare(`SELECT id, password_hash AS passwordHash, password_salt AS passwordSalt, password_iterations AS passwordIterations
      FROM app_users WHERE email = ? AND active = 1`).bind(email).first<{ id: number; passwordHash: string | null; passwordSalt: string | null; passwordIterations: number | null }>();
    const valid = user?.passwordHash && user.passwordSalt && user.passwordIterations
      ? await verifyPassword(body.password ?? "", user.passwordHash, user.passwordSalt, user.passwordIterations)
      : false;
    if (!user || !valid) {
      await env.DB.prepare("INSERT INTO login_attempts (attempt_key) VALUES (?)").bind(attemptKey).run();
      return Response.json({ error: "Неверный email или пароль." }, { status: 401 });
    }
    await env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(attemptKey).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": await createSession(user.id, request) } });
  } catch {
    return Response.json({ error: "Не удалось выполнить вход." }, { status: 400 });
  }
}
