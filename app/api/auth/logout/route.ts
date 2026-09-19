import { assertSameOrigin, clearSessionCookie, revokeSession } from "../../../auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await revokeSession(request);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(request) } });
  } catch {
    return Response.json({ error: "Не удалось завершить сеанс." }, { status: 400 });
  }
}
