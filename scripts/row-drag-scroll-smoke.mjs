// Local browser QA only: synthetic rows and order state kept in this process.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveRowBlock } from "../app/tableRowOrder.ts";

const ids = Array.from({ length: 120 }, (_, index) => index + 1);
const scopes = new Set(["fixture-personnel-timesheet", "fixture-equipment-timesheet", "fixture-personnel-report", "fixture-equipment-report"]);
const orders = new Map();
const mutations = [];
const send = (response, payload, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
};
const config = {
  configFile: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  plugins: [react(), {
    name: "row-drag-scroll-memory-api",
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
        try {
          if (url.pathname === "/__smoke/status") return send(response, { orders: Object.fromEntries(orders), mutations });
          if (url.pathname === "/__smoke/reset" && request.method === "POST") {
            orders.clear(); mutations.length = 0;
            return send(response, { reset: true });
          }
          if (url.pathname !== "/api/table-order") return send(response, { error: "Only the isolated table order API is available." }, 404);
          if (!["GET", "POST"].includes(request.method)) return send(response, { error: "Unsupported method." }, 405);
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const body = raw ? JSON.parse(raw) : {};
          const scope = body.scope ?? url.searchParams.get("scope");
          const siteId = Number(body.siteId ?? url.searchParams.get("siteId"));
          if (!scopes.has(scope) || siteId !== 1) return send(response, { error: "Unknown synthetic fixture scope." }, 400);
          let ordered = orders.get(scope) ?? ids;
          if (request.method === "POST") {
            if (!Array.isArray(body.movingIds) || !body.movingIds.length || body.movingIds.some(id => !ids.includes(id))) throw new Error("Unknown synthetic rows.");
            if (!["start", "end", "before", "after"].includes(body.placement)) throw new Error("Unknown placement.");
            if (["before", "after"].includes(body.placement) && !ids.includes(body.targetId)) throw new Error("Unknown synthetic target.");
            ordered = moveRowBlock(ordered, body);
            orders.set(scope, ordered);
            mutations.push({ scope, movingIds: body.movingIds, targetId: body.targetId, placement: body.placement });
          }
          return send(response, { ids: ordered, canWrite: true, hasSavedOrder: orders.has(scope) });
        } catch (error) { return send(response, { error: error.message }, 400); }
      });
    },
  }],
  build: {
    outDir: await mkdtemp(join(tmpdir(), "row-drag-scroll-")),
    emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/row-drag-scroll.html", import.meta.url)) },
  },
  preview: { host: "127.0.0.1", port: 3156, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
