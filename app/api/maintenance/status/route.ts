/** The production gateway answers this endpoint even while the application is stopped. */
export async function GET() {
  const maintenance = /^(true|1|on)$/i.test(process.env.MAINTENANCE_MODE ?? "");
  return Response.json({ maintenance, phase: maintenance ? "maintenance" : "ready", retryAfterSeconds: 5 }, {
    headers: { "Cache-Control": "no-store" },
  });
}
