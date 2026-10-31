import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const fileUrl = name => new URL(`../app/${name}.ts`, import.meta.url).href;
async function compile(name, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(`../app/${name}.tsx`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, replacement] of Object.entries({ react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"), "./permissionModel": fileUrl("permissionModel"), "./customRoles.css": dataUrl(""), ...replacements })) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  return dataUrl(code);
}
const matrixUrl = await compile("PermissionMatrix");
const { PermissionMatrix } = await import(matrixUrl);
let harnessId = 0;
async function componentHarness(name) {
  const reactUrl = dataUrl(`// isolated hook harness ${++harnessId}
    let states=[], cursor=0; export let effects=[];
    export function begin(){cursor=0;effects=[];}
    export function useState(initial){const key=cursor++;if(!(key in states))states[key]=typeof initial==='function'?initial():initial;return [states[key],next=>{states[key]=typeof next==='function'?next(states[key]):next;}];}
    export function useRef(initial){const key=cursor++;if(!(key in states))states[key]={current:initial};return states[key];}
    export function useEffect(effect){cursor++;effects.push(effect);}
    export function useMemo(create){cursor++;return create();}
  `);
  const contextUrl = dataUrl("export function useWorkspaceAccess(){return globalThis.customRoleUiAccess ?? null;}");
  const dialogUrl = await compile("RoleEditorDialog", { react: reactUrl, "./PermissionMatrix": matrixUrl });
  const { [name]: Component } = await import(name === "RoleEditorDialog" ? dialogUrl : await compile(name, {
    react: reactUrl, "./PermissionMatrix": matrixUrl, "./RoleEditorDialog": dialogUrl,
    "./TableAccessContext": contextUrl, "./roles": fileUrl("roles"), "./userAccessModel": fileUrl("userAccessModel"),
    "./CustomSelect": dataUrl("export function CustomSelect(){return null;}"),
    "./ProjectAccessPicker": dataUrl("export function ProjectAccessPicker(){return null;}"),
  }));
  const hooks = await import(reactUrl);
  return { render(props) { hooks.begin(); return Component(props); }, async load() { for (const effect of hooks.effects) effect(); await flush(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function allNodes(node) {
  if (Array.isArray(node)) return node.flatMap(allNodes);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...allNodes(node.props.children)];
}
const textOf = node => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");
const find = (tree, predicate) => { const node = allNodes(tree).find(predicate); assert.ok(node, "Expected rendered control"); return node; };
const button = (tree, text) => find(tree, node => node.type === "button" && textOf(node) === text);
const matrix = tree => find(tree, node => node.type === PermissionMatrix);
const role = { id: 31, name: "Контроль проекта", baseRole: "viewer", permissions: rolePermissionTemplate("viewer"), revision: 1 };

test("the shared permissions matrix names every checkbox and keeps unsupported/locked actions disabled", () => {
  const permissions = normalizePermissionSet({ workers_report: { create: true }, access_rights: { update: true } });
  const html = renderToStaticMarkup(createElement(PermissionMatrix, { label: "Права роли", value: permissions, onChange() {}, cellPolicy(resource, action) { return { locked: resource === "access_rights" && action === "update" }; } }));
  assert.match(html, /aria-label="Права роли"/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 56);
  assert.match(html, /aria-label="Добавление: Отчёт рабочих" checked=""/);
  assert.match(html, /aria-label="Просмотр: Отчёт рабочих" checked=""/);
  assert.match(html, /aria-label="Добавление: Журнал действий" disabled=""/);
  assert.match(html, /aria-label="Редактирование: Права доступа" disabled="" checked=""/);
});

test("role creation submits the chosen matrix once, blocks closing during save and retains input after a duplicate", async context => {
  const originalWindow = globalThis.window;
  let confirmations = 0, allowDiscard = false;
  globalThis.window = { confirm() { confirmations++; return allowDiscard; } };
  context.after(() => { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
  let resolveResponse, calls = 0, closed = 0;
  const requests = [], created = [];
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++; requests.push(JSON.parse(init.body));
    return new Promise(resolve => { resolveResponse = resolve; });
  });
  const harness = await componentHarness("RoleEditorDialog");
  const props = { onClose() { closed++; }, onCreated(value) { created.push(value); } };
  let tree = harness.render(props);
  assert.equal(button(tree, "Сохранить роль").props.disabled, true);
  const input = find(tree, node => node.type === "input");
  assert.equal(input.props.maxLength, 80); assert.equal(input.props.required, true);
  input.props.onChange({ target: { value: "Контроль проекта" } });
  tree = harness.render(props);
  matrix(tree).props.onChange("workers_report", "update", true);
  tree = harness.render(props);
  assert.equal(matrix(tree).props.value.workers_report.view, true);
  assert.equal(matrix(tree).props.value.workers_report.update, true);
  tree.props.onCancel({ preventDefault() {} });
  assert.equal(closed, 0); assert.equal(confirmations, 1);
  find(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  tree = harness.render(props);
  assert.equal(button(tree, "Сохраняем…").props.disabled, true);
  find(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  tree.props.onCancel({ preventDefault() {} });
  assert.equal(calls, 1); assert.equal(confirmations, 1); assert.equal(closed, 0);
  resolveResponse(Response.json({ error: "Роль с таким названием уже существует." }, { status: 409 }));
  await flush(); tree = harness.render(props);
  assert.match(textOf(find(tree, node => node.props.role === "alert")), /уже существует/);
  assert.equal(find(tree, node => node.type === "input").props.value, "Контроль проекта");
  assert.equal(matrix(tree).props.value.workers_report.update, true);
  assert.equal(button(tree, "Сохранить роль").props.disabled, false);
  find(tree, node => node.type === "input").props.onChange({ target: { value: "Новая роль" } });
  tree = harness.render(props);
  find(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  resolveResponse(Response.json({ role: { ...role, name: "Новая роль", baseRole: "engineer", permissions: requests[1].permissions } }, { status: 201 }));
  await flush();
  assert.equal(calls, 2); assert.equal(created.length, 1);
  assert.deepEqual(Object.keys(requests[1]).sort(), ["name", "permissions"]);
  assert.equal(created[0].permissions.workers_report.update, true);
  allowDiscard = true;
});

test("turning view off clears write permissions and role preview cannot submit a mutation", async context => {
  const harness = await componentHarness("RoleEditorDialog");
  let closed = 0, requests = 0;
  context.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  const props = { onClose() { closed++; }, onCreated() {} };
  let tree = harness.render(props);
  matrix(tree).props.onChange("workers_report", "create", true);
  tree = harness.render(props);
  matrix(tree).props.onChange("workers_report", "view", false);
  tree = harness.render(props);
  assert.deepEqual(matrix(tree).props.value.workers_report, { view: false, create: false, update: false, delete: false });
  const previewHarness = await componentHarness("RoleEditorDialog");
  const preview = previewHarness.render({ ...props, previewRole: role });
  assert.equal(matrix(preview).props.disabled, true);
  assert.equal(matrix(preview).props.onChange, undefined);
  assert.equal(allNodes(preview).some(node => node.type === "input"), false);
  find(preview, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  preview.props.onCancel({ preventDefault() {} });
  assert.equal(requests, 0); assert.equal(closed, 1);
});

test("Access Rights uses a custom role template and creating a role preserves unfinished user permissions", async context => {
  const template = normalizePermissionSet({ workers_report: { view: true } });
  const user = { id: 8, fullName: "Проверяемый пользователь", email: "qa@invalid.test", role: "engineer", customRoleId: 31, customRoleName: "Контроль проекта", roleTemplate: template,
    assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer"), customized: true };
  let mayManage = true;
  context.mock.method(globalThis, "fetch", async url => Response.json(String(url) === "/api/roles" ? { roles: [role], canManage: true } : { users: [user], sites: [], canManage: mayManage, currentUserId: 1 }));
  const harness = await componentHarness("AccessRightsView");
  const props = { onBack() {} };
  harness.render(props); await harness.load();
  let tree = harness.render(props);
  assert.ok(button(tree, "＋Добавить роль"));
  assert.match(textOf(tree), /Контроль проекта/);
  button(tree, "Шаблон роли").props.onClick(); tree = harness.render(props);
  assert.deepEqual(matrix(tree).props.value, template);
  button(tree, "＋Добавить роль").props.onClick(); tree = harness.render(props);
  const editor = find(tree, node => node.type?.name === "RoleEditorDialog");
  editor.props.onCreated({ ...role, id: 32, name: "Новая роль" }); tree = harness.render(props);
  assert.deepEqual(matrix(tree).props.value, template);
  assert.ok(button(tree, "Новая роль"));
  assert.match(textOf(find(tree, node => node.props.className === "message success inline-message")), /Роль «Новая роль» создана/);
  mayManage = false;
  const readonlyHarness = await componentHarness("AccessRightsView");
  readonlyHarness.render(props); await readonlyHarness.load();
  tree = readonlyHarness.render(props);
  assert.equal(allNodes(tree).some(node => node.type === "button" && textOf(node).includes("Добавить роль")), false);
  assert.equal(matrix(tree).props.disabled, true);
});

test("user role selection keeps custom identity, resets viewer project grants and can return to a builtin role", async context => {
  const workingRole = { ...role, id: 32, name: "Координатор", baseRole: "engineer" };
  context.mock.method(globalThis, "fetch", async () => Response.json({ roles: [role, workingRole] }));
  const harness = await componentHarness("UserAccessCards");
  const draft = { key: "existing", id: 8, fullName: "Проверяемый пользователь", email: "qa@invalid.test", role: "viewer", customRoleId: role.id, customRoleName: role.name,
    assignedSiteId: "7", projectAccess: { mode: "selected", siteIds: [7] }, canViewPendingReports: true };
  const props = { rows: [], drafts: [draft], sites: [{ id: 7, name: "Проект" }], selectedIds: [], saving: false,
    onPatchDraft(_key, changes) { Object.assign(draft, changes); }, onEdit() {}, onSelectionChange() {}, onCancelEditing() {}, onSave() {} };
  harness.render(props); await harness.load();
  const editor = () => { const tree = harness.render(props); const element = find(tree, node => node.type?.name === "UserEditorDialog"); return element.type(element.props); };
  let tree = editor();
  assert.equal(allNodes(tree).filter(node => node.props.role === "radio").some(node => node.props["aria-checked"]), false);
  let select = find(tree, node => node.type?.name === "CustomSelect");
  assert.equal(select.props.searchable, true); assert.equal(select.props.value, String(role.id));
  select.props.onChange(String(role.id)); tree = editor();
  assert.deepEqual(draft.projectAccess, { mode: "selected", siteIds: [7] });
  assert.equal(draft.canViewPendingReports, true, "reselecting the same role must not reset saved access");
  select = find(tree, node => node.type?.name === "CustomSelect");
  select.props.onChange(String(workingRole.id)); tree = editor();
  assert.equal(draft.role, "engineer"); assert.equal(draft.customRoleId, workingRole.id);
  assert.equal(draft.customRoleName, workingRole.name); assert.deepEqual(draft.projectAccess, { mode: "selected", siteIds: [7] });
  select = find(tree, node => node.type?.name === "CustomSelect");
  select.props.onChange(String(role.id)); tree = editor();
  assert.equal(draft.role, "viewer"); assert.equal(draft.customRoleId, role.id);
  assert.deepEqual(draft.projectAccess, { mode: "selected", siteIds: [] }); assert.equal(draft.canViewPendingReports, false);
  find(tree, node => node.props.role === "radio" && textOf(node).startsWith("ППросмотр")).props.onClick();
  assert.equal(draft.customRoleId, null); assert.equal(draft.customRoleName, null); assert.equal(draft.role, "viewer");
});

test("a failed role catalog keeps the current user role and builtin choices usable, and retry reloads choices", async context => {
  let fail = true, calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return fail ? Response.json({ error: "Каталог временно недоступен" }, { status: 503 }) : Response.json({ roles: [role] }); });
  const harness = await componentHarness("UserAccessCards");
  const draft = { key: "existing", id: 8, fullName: "Проверяемый пользователь", email: "qa@invalid.test", role: "viewer", customRoleId: role.id, customRoleName: role.name,
    assignedSiteId: "7", projectAccess: { mode: "selected", siteIds: [7] } };
  const props = { rows: [], drafts: [draft], sites: [{ id: 7, name: "Проект" }], selectedIds: [], saving: false,
    onPatchDraft() {}, onEdit() {}, onSelectionChange() {}, onCancelEditing() {}, onSave() {} };
  harness.render(props); await harness.load();
  const editor = () => { const tree = harness.render(props); const element = find(tree, node => node.type?.name === "UserEditorDialog"); return element.type(element.props); };
  let tree = editor();
  const select = find(tree, node => node.type?.name === "CustomSelect");
  assert.equal(select.props.value, String(role.id));
  assert.equal(select.props.options.find(option => option.value === String(role.id)).label, role.name);
  assert.equal(select.props.disabled, true);
  assert.equal(allNodes(tree).filter(node => node.props.role === "radio").every(node => !node.props.disabled), true);
  assert.match(textOf(find(tree, node => node.props.role === "alert")), /Каталог временно недоступен/);
  button(tree, "Повторить").props.onClick(); fail = false;
  harness.render(props); await harness.load(); tree = editor();
  assert.equal(calls, 2);
  assert.equal(find(tree, node => node.type?.name === "CustomSelect").props.disabled, false);
  assert.equal(draft.customRoleId, role.id);
});

for (const lateStatus of [200, 503]) test(`a late role catalog response (${lateStatus}) cannot erase a role created after that request started`, async context => {
  let catalogReads = 0, resolveCatalog;
  context.mock.method(globalThis, "fetch", async url => {
    if (String(url) !== "/api/roles") return Response.json({ users: [], sites: [], canManage: true, currentUserId: 1 });
    if (++catalogReads === 1) return Response.json({ roles: [], canManage: true });
    return new Promise(resolve => { resolveCatalog = resolve; });
  });
  const harness = await componentHarness("AccessRightsView");
  const props = { onBack() {} };
  harness.render(props); await harness.load();
  let tree = harness.render(props);
  button(tree, "Обновить").props.onClick();
  await flush(); tree = harness.render(props);
  assert.equal(button(tree, "＋Добавить роль").props.disabled, false, "the user request completed before the slower catalog request");
  button(tree, "＋Добавить роль").props.onClick(); tree = harness.render(props);
  find(tree, node => node.type?.name === "RoleEditorDialog").props.onCreated(role);
  tree = harness.render(props);
  assert.ok(button(tree, role.name));
  resolveCatalog(Response.json(lateStatus === 200 ? { roles: [], canManage: true } : { error: "Старая ошибка каталога" }, { status: lateStatus }));
  await flush(); tree = harness.render(props);
  assert.ok(button(tree, role.name));
  assert.ok(button(tree, "＋Добавить роль"));
  assert.doesNotMatch(textOf(tree), /Старая ошибка каталога/);
});
