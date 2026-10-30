/** Stream large authenticated catalogs without making the event loop gzip them synchronously. */
export function compressJsonResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  const vary = headers.get("Vary")?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
  if (!vary.some(value => value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
  headers.set("Vary", vary.join(", "));
  const encodings = (request.headers.get("Accept-Encoding") ?? "").split(",").map(value => {
    const [name, ...parameters] = value.trim().toLowerCase().split(";");
    const quality = parameters.find(parameter => parameter.trim().startsWith("q="))?.trim().slice(2);
    return { name, quality: quality === undefined ? 1 : Number(quality) };
  });
  const gzip = encodings.find(encoding => encoding.name === "gzip") ?? encodings.find(encoding => encoding.name === "*");
  const compress = Boolean(response.ok && response.body && gzip && gzip.quality > 0
    && !headers.has("Content-Encoding") && headers.get("Content-Type")?.includes("application/json"));
  if (!compress) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  headers.delete("Content-Length");
  headers.set("Content-Encoding", "gzip");
  return new Response(response.body!.pipeThrough(new CompressionStream("gzip")), { status: response.status, statusText: response.statusText, headers });
}
