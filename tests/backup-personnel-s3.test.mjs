import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

test("S3 backup unit tests: guarded targets, private files, verified upload and failure cleanup", { timeout: 30_000 }, async () => {
  const result = await execFileAsync("python3", ["-B", "tests/test_backup_personnel_s3.py"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    timeout: 25_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(result.stderr, /\bOK\b/, result.stdout || result.stderr);
});
