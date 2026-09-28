import { getDatabase } from "../../../../db/client";
import { assertSameOrigin, createSession, ensureAuthSchema, hashPassword } from "../../../auth";

const env = { get DB() { return getDatabase(); } };

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await ensureAuthSchema();
    const configured = await env.DB.prepare("SELECT id FROM app_users WHERE active = 1 AND password_hash IS NOT NULL LIMIT 1").first();
    if (configured) return Response.json({ error: "Первый администратор уже создан." }, { status: 409 });
    const body = await request.json() as { fullName?: string; email?: string; password?: string };
    const fullName = body.fullName?.trim() ?? "";
    const email = body.email?.trim().toLocaleLowerCase() ?? "";
    if (!fullName || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Укажите ФИО и корректный email.");
    const password = await hashPassword(body.password ?? "");
    const existing = await env.DB.prepare("SELECT id FROM app_users WHERE email = ? LIMIT 1").bind(email).first<{ id: number }>();
    let userId: number;
    if (existing) {
      userId = existing.id;
      await env.DB.prepare("UPDATE app_users SET full_name = ?, role = 'superadmin', assigned_site_id = NULL, active = 1, password_hash = ?, password_salt = ?, password_iterations = ?, activated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(fullName, password.hash, password.salt, password.iterations, userId).run();
    } else {
      const result = await env.DB.prepare("INSERT INTO app_users (full_name, email, role, password_hash, password_salt, password_iterations, activated_at) VALUES (?, ?, 'superadmin', ?, ?, ?, CURRENT_TIMESTAMP)")
        .bind(fullName, email, password.hash, password.salt, password.iterations).run();
      userId = Number(result.meta.last_row_id);
    }
    const cookie = await createSession(userId, request);
    return Response.json({ ok: true }, { status: 201, headers: { "Set-Cookie": cookie } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось создать администратора." }, { status: 400 });
  }
}
