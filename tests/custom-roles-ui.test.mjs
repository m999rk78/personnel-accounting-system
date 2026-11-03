import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const confirmationUrl = dataUrl("export function useConfirmationDialog(){return {confirm:options=>Promise.resolve(globalThis.customRoleUiConfirm?.(options) ?? false),dialog:null};}");
const fileUrl = name => new URL(`../app/${name}.ts`, import.meta.url).href;
async function compile(name, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(`../app/${name}.tsx`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, replacement] of Object.entries({ react: import.meta.resolve("react"), "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"), "./permissionModel": fileUrl("permissionModel"), "./customRoles.css": dataUrl(""), "./usersRights.css": dataUrl(""), "./useConfirmationDialog": confirmationUrl, ...replacements })) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
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
    export function useLayoutEffect(effect){cursor++;effects.push(effect);}
    export function useMemo(create){cursor++;return create();}
  `);
  const contextUrl = dataUrl("export function useWorkspaceAccess(){return globalThis.customRoleUiAccess ?? null;}");
  const dialogUrl = await compile("RoleEditorDialog", { react: reactUrl, "./PermissionMatrix": matrixUrl });
  const catalogUrl = await compile("RoleCatalog", { react: reactUrl, "./roles": fileUrl("roles") });
  const { [name]: Component } = await import(name === "RoleEditorDialog" ? dialogUrl : await compile(name, {
    react: reactUrl, "./PermissionMatrix": matrixUrl, "./RoleEditorDialog": dialogUrl, "./RoleCatalog": catalogUrl,
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
const catalog = tree => find(tree, node => node.type?.name === "RoleCatalog");
const role = { id: 31, name: "Контроль проекта", baseRole: "viewer", permissions: rolePermissionTemplate("viewer"), revision: 1 };

test("unified settings expose only permitted tabs and keep roles out of the users list", async () => {
  const { UsersRightsNavigation } = await import(await compile("UsersRightsNavigation"));
  for (const [canViewUsers, canViewRoles] of [[true, false], [false, true], [true, true]]) {
    const html = renderToStaticMarkup(createElement(UsersRightsNavigation, { active: canViewUsers ? "users" : "roles", canViewUsers, canViewRoles, onSelect() {}, onBack() {} }));
    assert.equal(html.includes('id="users-rights-tab-users"'), canViewUsers);
    assert.equal(html.includes('id="users-rights-tab-roles"'), canViewRoles);
    assert.match(html, /role="tablist"/);
  }
  const harness = await componentHarness("UserAccessCards");
  const user = { id: 8, fullName: "Иванов Иван", email: "private@invalid.test", role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, status: "active" };
  const props = { layout: "list", rows: [user], drafts: [], sites: [], selectedIds: [], readOnly: true, canUpdate: false, canDelete: false, onEdit() {}, onSelectionChange() {}, onPatchDraft() {}, onCancelEditing() {}, onSave() {}, saving: false };
  let tree = harness.render(props);
  assert.equal(allNodes(tree).some(node => node.type === "th" && textOf(node) === "ФИО"), true);
  assert.equal(allNodes(tree).some(node => node.type === "input" && node.props.type === "checkbox"), false);
  assert.equal(textOf(tree).includes(user.email), true, "The list shows email to distinguish users with similar names");
  assert.equal(textOf(tree).includes("Активен"), true, "Account status remains readable without opening the profile");
  find(tree, node => node.props["aria-label"] === `Открыть пользователя ${user.fullName}`).props.onClick();
  tree = harness.render(props);
  const details = find(tree, node => node.type?.name === "UserDetailsDialog");
  assert.equal(details.props.user.email, user.email);
  assert.equal(details.props.onEdit, undefined);
  assert.equal(details.props.onEditRole, undefined);
  assert.equal(details.props.onOpenPermissions, undefined);
});

test("delegated rights managers retain user permission editing without system user access", async () => {
  const source = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("PersonnelApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let route;
  const visit = node => {
    if (ts.isJsxExpression(node) && node.expression?.getText(ast).startsWith('view === "accessRights"')) route = node.expression;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(route, "Expected the actual access-rights route");
  const compiled = ts.transpileModule(`function render(){return (${route.getText(ast)});}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const AccessRightsView = () => null, RolesSettingsView = () => null;
  const onDirtyChange = () => {}, onBusyChange = () => {}, navigated = [];
  const render = (usersAllowed, rightsAllowed) => new Function("React", "view", "may", "AccessRightsView", "RolesSettingsView", "onAccessRightsDirty", "onChildNavigationBusy", "navigateTo", "adminDataLoaded", `${compiled}\nreturn render();`)(
    { createElement }, "accessRights", resource => resource === "system_users" ? usersAllowed : rightsAllowed,
    AccessRightsView, RolesSettingsView, onDirtyChange, onBusyChange, view => navigated.push(view), { current: {} },
  );
  const fallback = find(render(false, true), node => node.type === AccessRightsView);
  assert.equal(fallback.props.onDirtyChange, onDirtyChange, "Unsaved individual rights still guard navigation");
  assert.equal(fallback.props.onBusyChange, onBusyChange, "Saving individual rights still blocks navigation");
  fallback.props.onBack();
  assert.deepEqual(navigated, ["settings"]);
  assert.equal(allNodes(render(false, true)).some(node => node.type === RolesSettingsView), false);
  assert.equal(find(render(true, true), node => node.type === RolesSettingsView).props.onDirtyChange, onDirtyChange);
  assert.equal(render(false, false), false, "The fallback must still require access_rights.view");
});

test("inline roles editor protects superadmin, confirms switching, and keeps unsaved revisions after conflicts", async context => {
  let allowDiscard = false;
  context.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/roles");
    if (!init?.method) return Response.json({ roles: [role], canManage: true });
    assert.equal(init.method, "PATCH");
    const payload = JSON.parse(init.body);
    assert.equal(payload.roleId, role.id); assert.equal(payload.revision, 1);
    assert.equal(payload.permissions.workers_report.update, true);
    return Response.json({ error: "Роль уже изменена другим пользователем." }, { status: 409 });
  });
  const previousConfirm = globalThis.customRoleUiConfirm;
  globalThis.customRoleUiConfirm = () => allowDiscard;
  context.after(() => { if (previousConfirm === undefined) delete globalThis.customRoleUiConfirm; else globalThis.customRoleUiConfirm = previousConfirm; });
  const harness = await componentHarness("RolesSettingsView");
  const props = {};
  harness.render(props); await harness.load();
  let tree = harness.render(props);
  assert.equal(matrix(tree).props.disabled, true);
  assert.equal(allNodes(tree).some(node => node.type === "button" && textOf(node) === "Удалить роль"), false);
  await find(tree, node => node.type === "button" && node.props.className?.includes("roles-sidebar-item") && textOf(node).includes(role.name)).props.onClick();
  tree = harness.render(props);
  const nameInput = () => find(tree, node => node.type === "input" && node.props.maxLength === 80);
  nameInput().props.onChange({ target: { value: "Изменённая роль" } });
  tree = harness.render(props);
  matrix(tree).props.onChange("workers_report", "update", true);
  tree = harness.render(props);
  const root = () => find(tree, node => node.type === "button" && node.props.className?.includes("roles-sidebar-item") && textOf(node).includes("Супер-админ"));
  await root().props.onClick();
  tree = harness.render(props);
  assert.equal(nameInput().props.value, "Изменённая роль");
  const save = button(tree, "Сохранить изменения");
  assert.equal(save.props.disabled, false);
  find(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  await flush(); tree = harness.render(props);
  assert.match(textOf(find(tree, node => node.props.role === "alert")), /уже изменена/);
  assert.equal(nameInput().props.value, "Изменённая роль");
  assert.equal(matrix(tree).props.value.workers_report.update, true);
  allowDiscard = true;
  await root().props.onClick(); await flush(); tree = harness.render(props);
  assert.equal(matrix(tree).props.disabled, true);
});

test("inline roles editor cannot mutate without server permission and failed in-use deletion retains the role", async context => {
  let canManage = false, writes = 0;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    if (!init?.method) return Response.json({ roles: [role], canManage });
    writes++;
    assert.equal(init.method, "DELETE");
    return Response.json({ error: "Сначала назначьте пользователям другую роль." }, { status: 409 });
  });
  const readonly = await componentHarness("RolesSettingsView");
  readonly.render({}); await readonly.load();
  let tree = readonly.render({});
  await find(tree, node => node.type === "button" && node.props.className?.includes("roles-sidebar-item") && textOf(node).includes(role.name)).props.onClick();
  tree = readonly.render({});
  assert.equal(matrix(tree).props.disabled, true);
  assert.equal(allNodes(tree).some(node => node.type === "button" && /Создать роль|Удалить роль|Сохранить изменения/.test(textOf(node))), false);
  assert.equal(writes, 0);
  canManage = true;
  const previousConfirm = globalThis.customRoleUiConfirm;
  globalThis.customRoleUiConfirm = () => true;
  context.after(() => { if (previousConfirm === undefined) delete globalThis.customRoleUiConfirm; else globalThis.customRoleUiConfirm = previousConfirm; });
  const editable = await componentHarness("RolesSettingsView");
  editable.render({}); await editable.load(); tree = editable.render({});
  await find(tree, node => node.type === "button" && node.props.className?.includes("roles-sidebar-item") && textOf(node).includes(role.name)).props.onClick();
  tree = editable.render({}); await button(tree, "Удалить роль").props.onClick(); await flush(); tree = editable.render({});
  assert.equal(writes, 1);
  assert.match(textOf(find(tree, node => node.props.role === "alert")), /другую роль/);
  assert.equal(find(tree, node => node.type === "input" && node.props.maxLength === 80).props.value, role.name);
});

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
  const originalConfirm = globalThis.customRoleUiConfirm;
  let confirmations = 0, allowDiscard = false;
  globalThis.customRoleUiConfirm = options => { confirmations++; assert.equal(options.confirmLabel, "Закрыть без сохранения"); return allowDiscard; };
  context.after(() => { if (originalConfirm === undefined) delete globalThis.customRoleUiConfirm; else globalThis.customRoleUiConfirm = originalConfirm; });
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
  assert.ok(catalog(tree).props.roles.some(role => role.name === "Новая роль"));
  assert.match(textOf(find(tree, node => node.props.className === "message success inline-message")), /Роль «Новая роль» создана/);
  mayManage = false;
  const readonlyHarness = await componentHarness("AccessRightsView");
  readonlyHarness.render(props); await readonlyHarness.load();
  tree = readonlyHarness.render(props);
  assert.equal(allNodes(tree).some(node => node.type === "button" && textOf(node).includes("Добавить роль")), false);
  assert.equal(matrix(tree).props.disabled, true);
});

test("profile permissions load only the requested user and refresh clears the dirty state", async context => {
  const user = { id: 8, fullName: "Проверяемый пользователь", email: "qa@invalid.test", role: "engineer", assignedSiteId: null, projectAccess: { mode: "all", siteIds: [] }, permissions: rolePermissionTemplate("engineer"), customized: false };
  context.mock.method(globalThis, "fetch", async url => { assert.equal(url, "/api/access-rights"); return Response.json({ users: [user], sites: [], canManage: true, currentUserId: 1 }); });
  const previousConfirm = globalThis.customRoleUiConfirm;
  globalThis.customRoleUiConfirm = () => true;
  context.after(() => { if (previousConfirm === undefined) delete globalThis.customRoleUiConfirm; else globalThis.customRoleUiConfirm = previousConfirm; });
  const harness = await componentHarness("AccessRightsView");
  const props = { embedded: true, initialUserId: 8, onBack() {} };
  harness.render(props); await harness.load();
  let tree = harness.render(props);
  assert.deepEqual(matrix(tree).props.value, normalizePermissionSet(user.permissions));
  assert.equal(button(tree, "Сохранить доступ").props.disabled, true);
  matrix(tree).props.onChange("workers_report", "delete", false);
  tree = harness.render(props);
  assert.equal(button(tree, "Сохранить доступ").props.disabled, false);
  await button(tree, "Обновить").props.onClick(); await flush(); tree = harness.render(props);
  assert.equal(matrix(tree).props.value.workers_report.delete, true);
  assert.equal(button(tree, "Сохранить доступ").props.disabled, true);
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
  find(tree, node => node.type?.name === "CustomSelect").props.onChange("__superadmin__");
  assert.equal(draft.customRoleId, null); assert.equal(draft.customRoleName, null); assert.equal(draft.role, "superadmin");
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
  assert.equal(select.props.disabled, false);
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
  assert.ok(catalog(tree).props.roles.some(item => item.name === role.name));
  resolveCatalog(Response.json(lateStatus === 200 ? { roles: [], canManage: true } : { error: "Старая ошибка каталога" }, { status: lateStatus }));
  await flush(); tree = harness.render(props);
  assert.ok(catalog(tree).props.roles.some(item => item.name === role.name));
  assert.ok(button(tree, "＋Добавить роль"));
  assert.doesNotMatch(textOf(tree), /Старая ошибка каталога/);
});
