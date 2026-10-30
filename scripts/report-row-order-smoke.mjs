// Isolated browser fixture: only an in-memory row-order endpoint, no work database.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { movePersonnelReportRows } from "../app/personnelReportRowOrder.ts";

let ids = ["2026-10-28/report-11-101", "2026-10-28/report-11-102", "2026-10-28/report-11-103", "2026-10-27/report-12-104", "2026-10-27/report-12-105"];
let saved = false;
const config = {
  configFile: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  build: { outDir: await mkdtemp(join(tmpdir(), "personnel-report-row-order-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/report-row-order.html", import.meta.url)) } },
  plugins: [react(), { name: "mock-row-order", configurePreviewServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith("/api/table-order")) return next();
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const move = JSON.parse(body);
        for (const id of move.displayedIds ?? []) if (!ids.includes(id)) ids.push(id);
        try { ids = movePersonnelReportRows(ids, move); saved = true; }
        catch (error) { response.statusCode = 400; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ error: error.message })); return; }
      }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ ids, canWrite: true, hasSavedOrder: saved }));
    });
  } }],
  preview: { host: "127.0.0.1", port: 3117, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
