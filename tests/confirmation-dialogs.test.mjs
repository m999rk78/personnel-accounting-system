import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = await readFile(new URL("../app/useConfirmationDialog.tsx", import.meta.url), "utf8");
async function harness() {
  const hooksUrl = dataUrl(`// unique module ${Math.random()}
    let state=null;const pending={current:null};let cleanup;
    export function useState(){return [state,next=>{state=next;}]}
    export function useRef(){return pending}
    export function useCallback(callback){return callback}
    export function useId(){return 'test-id'}
    export function useEffect(effect){cleanup=effect()}
    export function unmount(){cleanup?.()}
  `);
  let compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, replacement] of Object.entries({ react: hooksUrl, "react-dom": import.meta.resolve("react-dom"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"), "./confirmationDialog.css": dataUrl("") })) compiled = compiled.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  const { useConfirmationDialog } = await import(dataUrl(compiled));
  return { render: useConfirmationDialog, unmount: (await import(hooksUrl)).unmount };
}
const question = { title: "Перейти?", description: "Изменения будут отменены." };

for (const accepted of [false, true]) test(`custom confirmation settles once with ${accepted}, rejects duplicate requests and can reopen`, async () => {
  const ui = await harness();
  const first = ui.render().confirm(question);
  assert.equal(await ui.render().confirm(question), false, "Do not queue actions against stale workspace state");
  const dialog = ui.render().dialog;
  assert.deepEqual(dialog.props.options, question);
  dialog.props.onAnswer(accepted);
  dialog.props.onAnswer(!accepted);
  assert.equal(await first, accepted);
  assert.equal(ui.render().dialog, null);
  const second = ui.render().confirm(question);
  ui.render().dialog.props.onAnswer(false);
  assert.equal(await second, false);
});

test("unmount cancels a pending confirmation rather than executing a detached action", async () => {
  const ui = await harness();
  const answer = ui.render().confirm(question);
  ui.unmount();
  assert.equal(await answer, false);
});

test("application confirmations never call browser confirm/alert/prompt", async () => {
  const root = new URL("../app/", import.meta.url);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const contents = await readFile(`${entry.parentPath}/${entry.name}`, "utf8");
    assert.doesNotMatch(contents, /\b(?:window|globalThis)\.(?:confirm|alert|prompt)\s*\(/, entry.name);
  }
  for (const name of ["RoleEditorDialog", "WorkTypesDirectory", "PersonnelReportWorkspace", "EquipmentReportWorkspace"]) {
    const contents = await readFile(new URL(`${name}.tsx`, root), "utf8");
    assert.match(contents, /addEventListener\("beforeunload", preventLoss\)/, "Keep browser-mandated tab close/reload protection");
  }
});
