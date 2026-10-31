import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("role creation audit records its identity and the actor's named role, with built-in compatibility", async () => {
  process.env.NODE_ENV = "production";
  delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
  const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const boundaryUrl = url(`
    export let actor; export const inserts=[];
    export function setActor(user){actor=user;}
    export async function getAuthUser(){return actor;}
    export function getDatabase(){
      return { prepare(sql){
        if(!sql.includes('INSERT INTO audit_events')) throw new Error('Unexpected SQL');
        return { bind(...values){ return { async run(){inserts.push(values);} }; } };
      } };
    }
  `);
  let source = ts.transpileModule(await readFile(new URL("../app/auditLog.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  source = source.replace('"../db/client"', JSON.stringify(boundaryUrl)).replace('"./auth"', JSON.stringify(boundaryUrl));
  const boundary = await import(boundaryUrl), audit = await import(url(source));
  const request = () => new Request("http://localhost/api/roles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Контроль техники", permissions: {} }) });
  for (const actor of [{ id: 5, fullName: "Тест", role: "engineer", customRoleName: "ПТО" }, { id: 6, fullName: "Тест", role: "engineer" }]) {
    boundary.setActor(actor);
    const response = await audit.withAuditTrail(request(), async () => Response.json({ role: { id: 12 }, id: 12 }, { status: 201 }));
    assert.equal(response.status, 201);
    const values = boundary.inserts.at(-1);
    assert.equal(values[2], actor.customRoleName ?? actor.role);
    assert.deepEqual(values.slice(3, 7), ["access", "roles.create", "custom_role", "12"]);
    assert.equal(JSON.parse(values[11]).result.role.id, 12);
  }
  await audit.withAuditTrail(request(), async () => Response.json({ error: "Нет доступа" }, { status: 403 }));
  assert.equal(boundary.inserts.length, 2, "failed creation must not be recorded as successful");
});
