// Component-only QA server. No environment files, API, database or browser driver.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let port = 3152;
let buildOnly = false;
for (const argument of process.argv.slice(2)) {
  if (argument === "--build-only") buildOnly = true;
  else if (/^\d+$/.test(argument)) port = Number(argument);
  else throw new Error(`Неизвестный аргумент стенда: ${argument}`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const config = {
  configFile: false,
  envDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: await mkdtemp(join(tmpdir(), "report-filter-search-smoke-")),
    emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/report-filter-search.html", import.meta.url)) },
  },
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
if (!buildOnly) {
  const server = await preview(config);
  server.printUrls();
  console.log(`Отчёты: http://127.0.0.1:${port}/report-filter-search.html`);
}
