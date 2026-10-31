// Synthetic UI only: no .env files, database, accounts or invitations.
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const portFlag = process.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 3111;
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Некорректный порт стенда.");
const outDir = await mkdtemp(join(tmpdir(), "user-roles-smoke-"));
const config = {
  configFile: false, envDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  plugins: [react()],
  build: { outDir, emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/user-roles.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
if (process.argv.includes("--build-only")) {
  await rm(outDir, { recursive: true, force: true });
} else {
  const server = await preview(config); server.printUrls();
  const close = async () => { await new Promise(resolve => server.httpServer.close(resolve)); await rm(outDir, { recursive: true, force: true }); process.exit(0); };
  process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
}
