import { acceptInvitation, assertSameOrigin, invitationUser } from "../../../auth";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const user = await invitationUser(token);
  return user ? Response.json({ valid: true, user }) : Response.json({ valid: false, error: "Ссылка приглашения недействительна или уже истекла." }, { status: 404 });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as { token?: string; password?: string };
    const result = await acceptInvitation(body.token ?? "", body.password ?? "", request);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": result.cookie } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось принять приглашение." }, { status: 400 });
  }
}
