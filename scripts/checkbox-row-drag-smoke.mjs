// Local-only browser QA: synthetic rows and an in-memory ordering endpoint.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moveRowBlock } from "../app/tableRowOrder.ts";

const orders = new Map();
const mutations = [];
const scopes = new Set(["fixture-generic", "directory-zone", "equipment", "project-personnel", "project-equipment", "directory-work-types"]);
let delayMs = 0;
function availableIds(scope, siteId) {
  return scope === "directory-work-types"
    ? ["parent-1", "parent-2", "parent-3", "child-11", "child-12", "child-13", "child-14", "child-15"]
    : Array.from({ length: 6 }, (_, index) => (siteId - 1) * 100 + index + 1);
}
function json(response, value, status = 200) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}
async function bodyOf(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const config = {
  configFile: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  build: {
    outDir: await mkdtemp(join(tmpdir(), "checkbox-row-drag-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/checkbox-row-drag.html", import.meta.url)) },
  },
  plugins: [react(), {
    name: "isolated-checkbox-row-order",
    configurePreviewServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__smoke/")) return next();
        try {
          if (url.pathname === "/__smoke/status") return json(response, { orders: Object.fromEntries(orders), mutations, delayMs });
          if (url.pathname === "/__smoke/reset" && request.method === "POST") {
            orders.clear(); mutations.length = 0;
            return json(response, { reset: true });
          }
          if (url.pathname === "/__smoke/policy" && request.method === "POST") {
            const body = await bodyOf(request);
            delayMs = body.slow ? 1500 : 0;
            return json(response, { delayMs });
          }
          if (url.pathname !== "/api/table-order") return json(response, { error: "Этот API не подключён к изолированному стенду." }, 404);
          const body = request.method === "POST" ? await bodyOf(request) : {};
          const scope = body.scope ?? url.searchParams.get("scope");
          const siteId = Number(body.siteId ?? url.searchParams.get("siteId"));
          if (!scopes.has(scope) || ![1, 2].includes(siteId)) return json(response, { error: "Неизвестный тестовый проект или таблица." }, 400);
          const key = `${scope}:${siteId}`;
          const previous = orders.get(key);
          let ids = previous?.ids ?? availableIds(scope, siteId);
          if (request.method === "POST") {
            if (!Array.isArray(body.movingIds) || !body.movingIds.length || body.movingIds.some(id => !ids.includes(id))) throw new Error("Выберите существующие тестовые строки.");
            if (!["start", "end", "before", "after"].includes(body.placement)) throw new Error("Некорректный способ переноса.");
            if (["before", "after"].includes(body.placement) && !ids.includes(body.targetId)) throw new Error("Строка назначения отсутствует в этом тестовом проекте.");
            if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
            ids = moveRowBlock(ids, body);
            orders.set(key, { ids, hasSavedOrder: true });
            mutations.push({ scope, siteId, movingIds: body.movingIds, targetId: body.targetId, placement: body.placement });
          }
          return json(response, { ids, canWrite: true, hasSavedOrder: orders.get(key)?.hasSavedOrder ?? false });
        } catch (error) { return json(response, { error: error.message }, 400); }
      });
    },
  }],
  preview: { host: "127.0.0.1", port: 3121, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
