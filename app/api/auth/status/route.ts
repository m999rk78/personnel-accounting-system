import { env } from "cloudflare:workers";
import { ensureAuthSchema, getAuthUser } from "../../../auth";

export async function GET(request: Request) {
  await ensureAuthSchema();
  const user = await getAuthUser(request);
  const configured = await env.DB.prepare("SELECT id FROM app_users WHERE active = 1 AND password_hash IS NOT NULL LIMIT 1").first();
  return Response.json({ authenticated: Boolean(user), bootstrapRequired: !configured, user });
}
