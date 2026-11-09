import { getDatabase } from "../../../db/client";
import { assertSameOrigin, getAuthUser } from "../../auth";
import { MAX_EQUIPMENT_DRAFT_BYTES, EquipmentReportDraftBufferError } from "../../equipmentReportDraftBuffer";
import { assertEquipmentReportDraftBufferAccess, ensureEquipmentReportDraftBufferSchema, readEquipmentReportDraftBuffer, writeEquipmentReportDraftBuffer } from "../../equipmentReportDraftBufferStore";

function failureResponse(error: unknown) {
  if (error instanceof EquipmentReportDraftBufferError) return Response.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
  console.error("Equipment draft buffer failed", error);
  return Response.json({ error: "Не удалось сохранить черновик. Изменения остаются в браузере." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser(request);
    if (!user) return Response.json({ error: "Требуется авторизация." }, { status: 401 });
    const siteId = Number(new URL(request.url).searchParams.get("siteId"));
    assertEquipmentReportDraftBufferAccess(user, siteId);
    const db = getDatabase();
    await ensureEquipmentReportDraftBufferSchema(db);
    return Response.json(await readEquipmentReportDraftBuffer(db, user, siteId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failureResponse(error); }
}

export async function PUT(request: Request) {
  try {
    try { assertSameOrigin(request); } catch { return Response.json({ error: "Запрос с другого сайта отклонён." }, { status: 403 }); }
    const user = await getAuthUser(request);
    if (!user) return Response.json({ error: "Требуется авторизация." }, { status: 401 });
    let payload: unknown;
    try {
      if (Number(request.headers.get("content-length") ?? 0) > MAX_EQUIPMENT_DRAFT_BYTES) throw new EquipmentReportDraftBufferError("Черновик слишком большой для автосохранения.", 413, "DRAFT_BUFFER_TOO_LARGE");
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_EQUIPMENT_DRAFT_BYTES) throw new EquipmentReportDraftBufferError("Черновик слишком большой для автосохранения.", 413, "DRAFT_BUFFER_TOO_LARGE");
      payload = JSON.parse(raw);
    } catch (error) {
      if (error instanceof EquipmentReportDraftBufferError) throw error;
      throw new EquipmentReportDraftBufferError("Некорректные данные черновика.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new EquipmentReportDraftBufferError("Некорректные данные черновика.");
    const body = payload as Record<string, unknown>;
    const siteId = typeof body.siteId === "number" ? body.siteId : NaN;
    assertEquipmentReportDraftBufferAccess(user, siteId);
    const db = getDatabase();
    await ensureEquipmentReportDraftBufferSchema(db);
    return Response.json(await writeEquipmentReportDraftBuffer(db, user, siteId, body.revision, body.snapshot), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failureResponse(error); }
}
