import { env } from "cloudflare:workers";
import { assertSameOrigin, createSession, ensureAuthSchema, getAuthUser, hashPassword, loginAttemptKey, verifyPassword } from "../../../auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await ensureAuthSchema();
    const authUser = await getAuthUser(request);
    if (!authUser) return Response.json({ error: "Требуется вход в систему." }, { status: 401 });

    const body = await request.json() as { currentPassword?: string; newPassword?: string };
    const attemptKey = await loginAttemptKey(request, `password-change:${authUser.email}`);
    await env.DB.prepare("DELETE FROM login_attempts WHERE created_at <= DATETIME('now', '-15 minutes')").run();
    const attempts = await env.DB.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE attempt_key = ? AND created_at > DATETIME('now', '-15 minutes')").bind(attemptKey).first<{ count: number }>();
    if (Number(attempts?.count ?? 0) >= 5) return Response.json({ error: "Слишком много попыток. Повторите через 15 минут." }, { status: 429 });

    const credentials = await env.DB.prepare("SELECT password_hash AS passwordHash, password_salt AS passwordSalt, password_iterations AS passwordIterations FROM app_users WHERE id = ? AND active = 1")
      .bind(authUser.id).first<{ passwordHash: string | null; passwordSalt: string | null; passwordIterations: number | null }>();
    const currentPasswordValid = credentials?.passwordHash && credentials.passwordSalt && credentials.passwordIterations
      ? await verifyPassword(body.currentPassword ?? "", credentials.passwordHash, credentials.passwordSalt, credentials.passwordIterations)
      : false;
    if (!currentPasswordValid) {
      await env.DB.prepare("INSERT INTO login_attempts (attempt_key) VALUES (?)").bind(attemptKey).run();
      return Response.json({ error: "Текущий пароль указан неверно." }, { status: 400 });
    }

    if ((body.currentPassword ?? "") === (body.newPassword ?? "")) return Response.json({ error: "Новый пароль должен отличаться от текущего." }, { status: 400 });
    const password = await hashPassword(body.newPassword ?? "");
    await env.DB.batch([
      env.DB.prepare("UPDATE app_users SET password_hash = ?, password_salt = ?, password_iterations = ?, activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP) WHERE id = ?")
        .bind(password.hash, password.salt, password.iterations, authUser.id),
      env.DB.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").bind(authUser.id),
      env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(attemptKey),
    ]);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": await createSession(authUser.id, request) } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось изменить пароль." }, { status: 400 });
  }
}
