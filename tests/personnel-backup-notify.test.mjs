import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

test("Backup notifications: scoped recipients, TLS, daily freshness, deduplication and failure recovery", { timeout: 30_000 }, async () => {
  const result = await execFileAsync("python3", ["-B", "tests/test_personnel_backup_notify.py"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(result.stderr, /\bOK\b/, result.stdout || result.stderr);
});
