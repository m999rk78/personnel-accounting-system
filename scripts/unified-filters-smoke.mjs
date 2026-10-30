// Synthetic browser fixture only: no environment files, database or real API.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 3119);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Укажите корректный порт стенда.");
const config = {
  configFile: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  build: {
    outDir: await mkdtemp(join(tmpdir(), "unified-filters-smoke-")),
    emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/unified-filters.html", import.meta.url)) },
  },
  plugins: [react()],
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
