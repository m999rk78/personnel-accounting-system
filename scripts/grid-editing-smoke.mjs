// Local browser regression fixture. No credentials, network API or database writes.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const config = {
  configFile: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  publicDir: false,
  build: {
    outDir: await mkdtemp(join(tmpdir(), "personnel-grid-editing-")),
    emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/grid-editing.html", import.meta.url)) },
  },
  plugins: [react()],
  preview: { host: "127.0.0.1", port: 3101, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
