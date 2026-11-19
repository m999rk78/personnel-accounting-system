import { getDatabase } from "../../../../db/client";
import { ensureAuthSchema, getAuthUser, refreshAuthSession } from "../../../auth";

const env = { get DB() { return getDatabase(); } };

export async function GET(request: Request) {
  await ensureAuthSchema();
  let user = await getAuthUser(request);
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (user) {
    const cookie = await refreshAuthSession(request, user.id);
    // A concurrent logout/password change must never revive the old session.
    if (cookie) headers.set("Set-Cookie", cookie);
    else user = null;
  }
  const configured = await env.DB.prepare("SELECT id FROM app_users WHERE active = 1 AND password_hash IS NOT NULL LIMIT 1").first();
  return Response.json({ authenticated: Boolean(user), bootstrapRequired: !configured, user }, { headers });
}
