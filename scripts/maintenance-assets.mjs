import { constants, closeSync, createReadStream, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const PREFIX = "/_next/static/";
const MIME = new Map([
  [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".avif", "image/avif"], [".svg", "image/svg+xml"], [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
]);

export const maintenanceAssetsRoot = stateFile => resolve(dirname(stateFile), "static");

function safeParts(path) {
  const parts = path.split("/");
  return parts.length && parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== "." && part !== "..") ? parts : null;
}

function contained(root, path) {
  const difference = relative(root, path);
  return difference !== "" && !difference.startsWith(`..${sep}`) && difference !== ".." && !difference.startsWith(sep);
}

function directoryRoot(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Static asset root must be a directory, not a link.");
  return realpathSync(path);
}

function ensureParents(root, parts) {
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(root, realpathSync(directory))) throw new Error("Unsafe archive directory.");
  }
  return directory;
}

function openPublicFile(root, parts) {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("Only regular public asset files are allowed.");
  }
  if (!contained(root, realpathSync(path))) throw new Error("Asset path escapes its root.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!fstatSync(fd).isFile()) { closeSync(fd); throw new Error("Asset is not a regular file."); }
  return fd;
}

/** Archive only the immutable public build subtree. Existing assets are never removed or overwritten. */
export function archiveMaintenanceAssets({ sourceRoot, archiveRoot }) {
  const source = directoryRoot(resolve(sourceRoot));
  const archive = directoryRoot(resolve(archiveRoot), true);
  if (source === archive || contained(source, archive)) throw new Error("Asset archive must be outside the current build subtree.");
  const result = { copied: 0, reused: 0, skipped: 0 };
  const visit = (directory, ancestors = []) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const parts = [...ancestors, entry.name];
      if (!safeParts(parts.join("/")) || entry.isSymbolicLink()) { result.skipped++; continue; }
      if (entry.isDirectory()) { visit(join(directory, entry.name), parts); continue; }
      if (!entry.isFile() || !MIME.has(extname(entry.name).toLowerCase())) { result.skipped++; continue; }
      const sourceFd = openPublicFile(source, parts);
      let bytes;
      try { bytes = readFileSync(sourceFd); } finally { closeSync(sourceFd); }
      const parent = ensureParents(archive, parts.slice(0, -1));
      const destination = join(parent, entry.name);
      try {
        const existingFd = openPublicFile(archive, parts);
        let existing;
        try { existing = readFileSync(existingFd); } finally { closeSync(existingFd); }
        if (!existing.equals(bytes)) throw new Error("Immutable asset path collision; the previous file was preserved.");
        result.reused++;
        continue;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      // A temporary file is not an allowed public asset URL. Hard-link creation
      // publishes the complete bytes atomically and cannot replace an old hash.
      const temporary = join(parent, `.${entry.name}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        try { linkSync(temporary, destination); result.copied++; }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const existingFd = openPublicFile(archive, parts);
          try { if (!readFileSync(existingFd).equals(bytes)) throw new Error("Immutable asset path collision; the previous file was preserved."); }
          finally { closeSync(existingFd); }
          result.reused++;
        }
      } finally {
        try { unlinkSync(temporary); }
        catch { /* Unpublished temporary files are never served; do not mask an archive error during cleanup. */ }
      }
    }
  };
  visit(source);
  return result;
}

/** Serve public immutable GET/HEAD even during maintenance; never admit UI/API writes. */
export function serveMaintenanceAsset(request, response, { archiveRoot }) {
  if (!["GET", "HEAD"].includes(request.method) || response.headersSent) return false;
  const rawPath = (request.url ?? "").split(/[?#]/, 1)[0];
  if (!rawPath.startsWith(PREFIX) || rawPath.length > 4096 || /%2f|%5c/i.test(rawPath)) return false;
  let path;
  try { path = decodeURIComponent(rawPath.slice(PREFIX.length)); } catch { return false; }
  if (/[\\%]/.test(path)) return false;
  const parts = safeParts(path);
  const mime = MIME.get(extname(path).toLowerCase());
  if (!parts || !mime) return false;
  let fd;
  try {
    const root = directoryRoot(resolve(archiveRoot));
    fd = openPublicFile(root, parts);
    const stat = fstatSync(fd);
    response.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") { closeSync(fd); response.end(); }
    else {
      const stream = createReadStream(null, { fd, autoClose: true });
      stream.once("error", () => response.destroy());
      response.once("close", () => stream.destroy());
      stream.pipe(response);
    }
    return true;
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Descriptor may already belong to a stream. */ } }
    return false;
  }
}
