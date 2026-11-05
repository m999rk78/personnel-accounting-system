

export function unauthorized() {
  return Response.json({ error: "Требуется вход в систему." }, { status: 401 });
}

export function forbidden() {
  return Response.json({ error: "У вас нет прав для этого действия." }, { status: 403 });
}

export function approvalRequired() {
  return Response.json({ error: "Новые строки отчёта сохраняются в черновике и попадают в табель после проверки инженером. Обновите страницу отчёта.", code: "APPROVAL_REQUIRED" }, { status: 409 });
}

export class PlacementRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function placementErrorResponse(error: unknown, fallback: string) {
  if (error instanceof PlacementRequestError) {
    return Response.json({ error: error.message, code: error.code, ...error.details }, { status: error.status });
  }
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 400 });
}
