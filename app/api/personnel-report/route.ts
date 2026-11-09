import { getDatabase } from "../../../db/client";
import { withAuditTrail } from "../../auditLog";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { deletePersonnelReportApprovedRows, ensurePersonnelReportSchema, listPersonnelReports, mutatePersonnelReport, mutatePersonnelReportDate, mutatePersonnelReportEntry, mutatePersonnelReportEntryDate, validatePersonnelReportSubmissions } from "../../personnelReportStore";
import type { PersonnelReportRequest } from "../../personnelReportTypes";
import { PersonnelReportError } from "../../personnelReportWorkflow";

function errorResponse(error: unknown) {
  if (error instanceof PersonnelReportError) return Response.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
  console.error("Personnel report request failed", error);
  return Response.json({ error: "Не удалось выполнить действие с отчётом персонала." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) return Response.json({ error: "Требуется авторизация." }, { status: 401 });
    const url = new URL(request.url);
    const siteId = Number(url.searchParams.get("siteId"));
    if (!Number.isInteger(siteId) || siteId < 1) throw new PersonnelReportError("Укажите проект.");
    const all = url.searchParams.get("all") === "true";
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit" }).format(new Date());
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const from = all ? null : url.searchParams.get("from") ?? `${month}-01`;
    const to = all ? null : url.searchParams.get("to") ?? `${month}-${lastDay}`;
    const db = getDatabase();
    await ensurePersonnelReportSchema(db);
    return Response.json(await listPersonnelReports(db, user, siteId, from, to));
  } catch (error) { return errorResponse(error); }
}

async function handlePOST(request: Request) {
  try {
    try { assertSameOrigin(request); } catch { return Response.json({ error: "Запрос с другого сайта отклонён." }, { status: 403 }); }
    const user = await getAuthUser(request);
    if (!user) return Response.json({ error: "Требуется авторизация." }, { status: 401 });
    const auditRequest = request.clone();
    let payload: PersonnelReportRequest;
    try {
      const maxBytes = 8 * 1024 * 1024;
      if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new PersonnelReportError("Отчёт слишком большой. Сохраните строки по частям.", 413, "REPORT_TOO_LARGE");
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new PersonnelReportError("Отчёт слишком большой. Сохраните строки по частям.", 413, "REPORT_TOO_LARGE");
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      payload = value as PersonnelReportRequest;
    } catch (error) {
      if (error instanceof PersonnelReportError) throw error;
      throw new PersonnelReportError("Некорректные данные отчёта.");
    }
    const db = getDatabase();
    await ensurePersonnelReportSchema(db);
    // Validation is read-only: do not create audit records for every preview.
    if (payload.action === "validate-submissions") return Response.json(await validatePersonnelReportSubmissions(db, user, payload));
    return await withAuditTrail(auditRequest, async () => {
      if (payload.action === "delete-approved-rows") return Response.json(await deletePersonnelReportApprovedRows(db, user, payload));
      if (payload.action === "change-date") return Response.json({ report: await mutatePersonnelReportDate(db, user, payload) });
      if (payload.action === "change-entry-date") return Response.json({ entry: await mutatePersonnelReportEntryDate(db, user, payload) });
      if (payload.action === "save-approved-entry") return Response.json({ entry: await mutatePersonnelReportEntry(db, user, payload) });
      const report = await mutatePersonnelReport(db, user, payload);
      return Response.json({ report });
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) { return handlePOST(request); }
