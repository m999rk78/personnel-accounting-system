import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMaintenanceAssets, maintenanceAssetsRoot, serveMaintenanceAsset } from "../scripts/maintenance-assets.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "personnel-maintenance-assets-"));
  const sourceRoot = join(root, "build", "_next", "static");
  const archiveRoot = maintenanceAssetsRoot(join(root, "shared", "maintenance.json"));
  await mkdir(join(sourceRoot, "chunks"), { recursive: true });
  try { await run({ root, sourceRoot, archiveRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function httpArchive(archiveRoot, run) {
  const server = createServer((request, response) => {
    if (!serveMaintenanceAsset(request, response, { archiveRoot })) { response.writeHead(404); response.end("not found"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
}

test("an old lazy chunk survives a new build and retains its public immutable URL", async () => fixture(async ({ sourceRoot, archiveRoot }) => {
  await writeFile(join(sourceRoot, "chunks", "old-Ab12cd34.js"), "export const old = true;");
  assert.deepEqual(archiveMaintenanceAssets({ sourceRoot, archiveRoot }), { copied: 1, reused: 0, skipped: 0 });
  await rm(join(sourceRoot, "chunks", "old-Ab12cd34.js"));
  await writeFile(join(sourceRoot, "chunks", "new-Ef56gh78.js"), "export const next = true;");
  assert.equal(archiveMaintenanceAssets({ sourceRoot, archiveRoot }).copied, 1);
  await httpArchive(archiveRoot, async origin => {
    const old = await fetch(`${origin}/_next/static/chunks/old-Ab12cd34.js`);
    assert.equal(old.status, 200);
    assert.equal(await old.text(), "export const old = true;");
    assert.equal(old.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(old.headers.get("cache-control"), /immutable/);
    assert.equal(old.headers.get("x-content-type-options"), "nosniff");
    const head = await fetch(`${origin}/_next/static/chunks/new-Ef56gh78.js`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
  });
}));

test("archive reuses equal immutable bytes and refuses to overwrite a conflicting hash", async () => fixture(async ({ sourceRoot, archiveRoot }) => {
  const path = join(sourceRoot, "chunks", "same-Ab12cd34.js");
  await writeFile(path, "original"); archiveMaintenanceAssets({ sourceRoot, archiveRoot });
  assert.equal(archiveMaintenanceAssets({ sourceRoot, archiveRoot }).reused, 1);
  await writeFile(path, "changed");
  assert.throws(() => archiveMaintenanceAssets({ sourceRoot, archiveRoot }), /collision/);
  assert.equal(await readFile(join(archiveRoot, "chunks", "same-Ab12cd34.js"), "utf8"), "original");
}));

test("HTML, environment files, source maps and source symlinks never enter the public archive", async () => fixture(async ({ root, sourceRoot, archiveRoot }) => {
  await writeFile(join(root, "outside.js"), "sensitive server implementation");
  await writeFile(join(sourceRoot, "index.html"), "private html");
  await writeFile(join(sourceRoot, ".env"), "secret=value");
  await writeFile(join(sourceRoot, "chunks", "chunk.js.map"), "source-map");
  await symlink(join(root, "outside.js"), join(sourceRoot, "chunks", "linked.js"));
  await symlink(root, join(sourceRoot, "linked-directory"));
  assert.deepEqual(archiveMaintenanceAssets({ sourceRoot, archiveRoot }), { copied: 0, reused: 0, skipped: 5 });
  await httpArchive(archiveRoot, async origin => {
    for (const path of ["index.html", ".env", "chunks/chunk.js.map", "chunks/linked.js", "linked-directory/outside.js"]) {
      assert.equal((await fetch(`${origin}/_next/static/${path}`)).status, 404);
    }
  });
}));

test("archive serving rejects traversal, encoded separators, malformed encoding and writable methods", async () => fixture(async ({ sourceRoot, archiveRoot }) => {
  await writeFile(join(sourceRoot, "chunks", "ok-Ab12cd34.js"), "public"); archiveMaintenanceAssets({ sourceRoot, archiveRoot });
  const response = { headersSent: false, writeHead() { throw new Error("Unsafe path was served"); } };
  for (const path of [
    "/_next/static/../server.js", "/_next/static/%2e%2e/server.js", "/_next/static/%252e%252e/server.js",
    "/_next/static/chunks%2fok-Ab12cd34.js", "/_next/static/chunks%5cok-Ab12cd34.js",
    "/_next/static/chunks\\ok-Ab12cd34.js", "/_next/static/%00.js", "/_next/static/%zz.js",
    "/_next/static//chunks/ok-Ab12cd34.js", "/other/chunks/ok-Ab12cd34.js", "/_next/staticity/chunks/ok-Ab12cd34.js",
  ]) assert.equal(serveMaintenanceAsset({ method: "GET", url: path }, response, { archiveRoot }), false, path);
  assert.equal(serveMaintenanceAsset({ method: "POST", url: "/_next/static/chunks/ok-Ab12cd34.js" }, response, { archiveRoot }), false);
}));

test("neither a symlinked archive directory nor a symlinked leaf can escape the cache root", async () => fixture(async ({ root, sourceRoot, archiveRoot }) => {
  await writeFile(join(root, "private.js"), "never public");
  await mkdir(archiveRoot, { recursive: true });
  await symlink(root, join(archiveRoot, "escape"));
  await symlink(join(root, "private.js"), join(archiveRoot, "leaf.js"));
  await httpArchive(archiveRoot, async origin => {
    assert.equal((await fetch(`${origin}/_next/static/escape/private.js`)).status, 404);
    assert.equal((await fetch(`${origin}/_next/static/leaf.js`)).status, 404);
  });
  await writeFile(join(sourceRoot, "leaf.js"), "public chunk");
  assert.throws(() => archiveMaintenanceAssets({ sourceRoot, archiveRoot }), /regular public|link/);
  assert.equal(await readFile(join(root, "private.js"), "utf8"), "never public");
}));

test("CSS, fonts and build-scoped manifests retain their paths and correct MIME", async () => fixture(async ({ sourceRoot, archiveRoot }) => {
  for (const [directory, file, bytes] of [["css", "index.Ab12cd34.css", "body{}"], ["fonts", "font-Ab12cd34.woff2", "font"], ["build-uuid", "_buildManifest.js", "self.manifest={}"]]) {
    await mkdir(join(sourceRoot, directory), { recursive: true });
    await writeFile(join(sourceRoot, directory, file), bytes);
  }
  archiveMaintenanceAssets({ sourceRoot, archiveRoot });
  await httpArchive(archiveRoot, async origin => {
    assert.match((await fetch(`${origin}/_next/static/css/index.Ab12cd34.css`)).headers.get("content-type"), /text\/css/);
    assert.equal((await fetch(`${origin}/_next/static/fonts/font-Ab12cd34.woff2`)).headers.get("content-type"), "font/woff2");
    assert.equal((await fetch(`${origin}/_next/static/build-uuid/_buildManifest.js`)).status, 200);
  });
}));
