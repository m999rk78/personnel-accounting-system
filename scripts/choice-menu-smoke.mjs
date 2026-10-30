// Isolated fixture for long labels, viewport edges and variable-height filter rows.
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
    outDir: await mkdtemp(join(tmpdir(), "personnel-choice-menus-")),
    emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/choice-menus.html", import.meta.url)) },
  },
  plugins: [react()],
  preview: { host: "127.0.0.1", port: 3104, strictPort: true },
};
await build(config);
(await preview(config)).printUrls();
