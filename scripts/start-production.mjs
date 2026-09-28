import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

function runNode(script) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(script)], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${script} завершился с кодом ${code ?? "нет"}${signal ? ` (${signal})` : ""}.`));
    });
  });
}

await runNode("scripts/apply-postgres-migrations.mjs");

const server = spawn(process.execPath, [resolve("server.js")], {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
