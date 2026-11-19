import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("PersonnelApp.tsx", await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, environment) {
  let result;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node; if (!result) ts.forEachChild(node, visit); };
  visit(source); assert.ok(result, name);
  const code = ts.transpileModule(`return (${result.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(environment), code)(...Object.values(environment));
}
function harness(name, response, { saving = false } = {}) {
  const calls = [], errors = [], redirects = [];
  const environment = {
    profileSaving: saving, currentPassword: "initial", newPassword: "replacement", repeatPassword: "replacement",
    beginAuthMutation() { calls.push("pause"); return () => calls.push("resume"); },
    setProfileSaving(value) { calls.push(value ? "saving" : "idle"); },
    setProfileError: value => errors.push(value), setProfileNotice() {}, setCurrentPassword() {}, setNewPassword() {}, setRepeatPassword() {},
    async fetch(url) { assert.equal(calls[0], "pause", "a renewal must be cancelled before the credential request starts"); calls.push(url); return typeof response === "function" ? response() : response; },
    window: { location: { replace: url => redirects.push(url) } },
  };
  return { run: handler(name, environment), calls, errors, redirects };
}

test("actual logout cancels status checks before revoking the cookie and always releases coordination", async () => {
  const ui = harness("logout", Response.json({ ok: true }));
  await ui.run();
  assert.deepEqual(ui.calls, ["pause", "saving", "/api/auth/logout", "resume", "idle"]);
  assert.deepEqual(ui.redirects, ["/login"]);
});

for (const [name, response] of [
  ["maintenance", Response.json({ maintenance: true }, { status: 503 })],
  ["network failure", () => { throw new TypeError("Synthetic offline"); }],
]) test(`actual logout preserves the workspace on ${name} and resumes future auth checks`, async () => {
  const ui = harness("logout", response);
  await ui.run();
  assert.deepEqual(ui.redirects, []);
  assert.ok(ui.errors.at(-1));
  assert.deepEqual(ui.calls.slice(-2), ["resume", "idle"]);
});

test("actual password change pauses renewal until the new cookie or failure has been received", async () => {
  for (const response of [Response.json({ ok: true }), Response.json({ error: "Synthetic failure" }, { status: 503 })]) {
    const ui = harness("changePassword", response);
    await ui.run({ preventDefault() {} });
    assert.deepEqual(ui.calls, ["pause", "saving", "/api/auth/password", "resume", "idle"]);
    assert.deepEqual(ui.redirects, []);
    if (!response.ok) assert.equal(ui.errors.at(-1), "Synthetic failure");
  }
});

test("busy logout does not create another auth mutation", async () => {
  const ui = harness("logout", Response.json({ ok: true }), { saving: true });
  await ui.run(); assert.deepEqual(ui.calls, []); assert.deepEqual(ui.redirects, []);
});
