import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { serializeSpreadsheetText, parseSpreadsheetText } from "../app/spreadsheetClipboard.ts";
import { isTableSelectAllShortcut, isTableTextEntryTarget } from "../app/tableSelectAllShortcut.ts";
import { excelPreviewClipboardHeaders, excelPreviewClipboardRows } from "../app/excelPreviewClipboardRows.ts";
import { userRoleLabel } from "../app/userAccessModel.ts";
import { PERMISSION_ACTIONS, PERMISSION_ACTION_LABELS, PERMISSION_CATALOG, rolePermissionTemplate } from "../app/permissionModel.ts";

async function declaration(path, name) {
  const url = new URL(path, import.meta.url);
  const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(source).replace(/^export\s+/, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const hookCode = await declaration("../app/useNativeTableSelectAll.ts", "useNativeTableSelectAll");
const userCode = await declaration("../app/UserAccessCards.tsx", "userTableClipboardRows");
const permissionCode = await declaration("../app/PermissionMatrix.tsx", "permissionTableClipboardRows");
const userRows = new Function("userRoleLabel", `${userCode};return userTableClipboardRows;`)(userRoleLabel);
const permissionRows = new Function("PERMISSION_ACTIONS", `${permissionCode};return permissionTableClipboardRows;`)(PERMISSION_ACTIONS);
async function constant(path, name, dependencies = {}) {
  const url = new URL(path, import.meta.url);
  const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []).find(node => node.name.getText(source) === name);
  assert.ok(declaration?.initializer);
  const code = ts.transpileModule(`return (${declaration.initializer.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}
const userHeaders = await constant("../app/UserAccessCards.tsx", "USER_TABLE_CLIPBOARD_HEADERS");
const permissionHeaders = await constant("../app/PermissionMatrix.tsx", "PERMISSION_TABLE_CLIPBOARD_HEADERS", { PERMISSION_ACTIONS, PERMISSION_ACTION_LABELS });

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(kind = "div", parent = null, type = "text") { super(); this.kind = kind; this.parent = parent; this.type = type; this.checked = false; this.focusCount = 0; }
  closest(selector) {
    const matches = selector.split(",").some(value => value.trim() === this.kind || value.trim() === "input" && this.kind === "input");
    return matches ? this : this.parent?.closest(selector) ?? null;
  }
  contains(target) { for (let node = target; node; node = node.parent) if (node === this) return true; return false; }
  focus() { this.focusCount++; }
}
const originalElement = globalThis.Element, originalNode = globalThis.Node;
globalThis.Element = FakeElement; globalThis.Node = FakeNode;
test.after(() => { if (originalElement === undefined) delete globalThis.Element; else globalThis.Element = originalElement; if (originalNode === undefined) delete globalThis.Node; else globalThis.Node = originalNode; });

function harness(initialRows = [["Первый", "1"], ["Второй", "2"]]) {
  const slots = [], listeners = new Map(), root = new FakeElement();
  let cursor = 0, dirty = false, pending = [], cleanup = [];
  const options = { rows: initialRows, resetKey: "first", rootRef: { current: root } };
  const document = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); } };
  const deps = {
    useRef(value) { const index = cursor++; slots[index] ??= { current: value }; return slots[index]; },
    useMemo: callback => callback(), useCallback: callback => callback,
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; dirty = true; }]; },
    useEffect(callback) { pending.push(callback); }, useLayoutEffect(callback) { pending.push(callback); }, document, Node: FakeNode, Element: FakeElement,
    serializeSpreadsheetText, isTableSelectAllShortcut, isTableTextEntryTarget,
  };
  const hook = new Function(...Object.keys(deps), `${hookCode};return useNativeTableSelectAll;`)(...Object.values(deps));
  function render() {
    let result, count = 0;
    do { cursor = 0; dirty = false; pending = []; result = hook(options); assert.ok(count++ < 4); } while (dirty);
    cleanup.forEach(callback => callback?.()); cleanup = pending.map(callback => callback());
    return result;
  }
  function event(target = new FakeElement("td", root), fields = {}) {
    const writes = [];
    const result = { target, key: "a", code: "KeyA", ctrlKey: true, metaKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      clipboardData: { setData: (...args) => writes.push(args) }, writes, ...fields };
    result.nativeEvent = result; return result;
  }
  return { root, options, render, event, listeners };
}

test("native table Ctrl+A and Cmd+A select only its current data and copy a quoted TSV without changing checkboxes", () => {
  for (const key of [{ ctrlKey: true, metaKey: false, key: "ф" }, { ctrlKey: false, metaKey: true }]) {
    const env = harness([["Имя\tс табуляцией", "Две\nстроки"], ["Кавычки \"тут\"", 0]]);
    const checkbox = new FakeElement("input", env.root, "checkbox"); checkbox.checked = true;
    const select = env.event(checkbox, key);
    env.render().handlers.onKeyDownCapture(select);
    assert.equal(select.defaultPrevented, true); assert.equal(checkbox.checked, true);
    const current = env.render(); assert.equal(current.selected, true); assert.equal(current.className, "native-table-select-all");
    const copy = env.event(); current.handlers.onCopyCapture(copy);
    assert.equal(copy.defaultPrevented, true);
    assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [["Имя\tс табуляцией", "Две\nстроки"], ["Кавычки \"тут\"", "0"]]);
  }
});

test("native full selection includes one heading row; ordinary partial text copy is not replaced", () => {
  const env = harness([["Тестовый сотрудник", "visible@example.invalid", "Просмотр", "Активен"]]);
  env.options.headers = userHeaders;
  const partialCopy = env.event(); env.render().handlers.onCopyCapture(partialCopy);
  assert.equal(partialCopy.defaultPrevented, false); assert.deepEqual(partialCopy.writes, []);
  env.render().handlers.onKeyDownCapture(env.event());
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [userHeaders, ...env.options.rows]);
  assert.deepEqual(userHeaders, ["ФИО", "Email", "Роль", "Статус"]);
  env.options.headers = ["Новое название", ...userHeaders.slice(1)];
  assert.equal(env.render().selected, false);
  const staleCopy = env.event(); env.render().handlers.onCopyCapture(staleCopy); assert.deepEqual(staleCopy.writes, []);
  env.options.headers = userHeaders; assert.equal(env.render().selected, false);
});

test("a native table with headings and no data still selects and copies its headings only", () => {
  const env = harness([]); env.options.headers = permissionHeaders;
  env.render().handlers.onKeyDownCapture(env.event()); assert.equal(env.render().selected, true);
  const copy = env.event(); env.render().handlers.onCopyCapture(copy);
  assert.deepEqual(parseSpreadsheetText(copy.writes[0][1]), [permissionHeaders]);
  assert.deepEqual(permissionHeaders, ["Раздел системы", "Просмотр", "Добавление", "Редактирование", "Удаление"]);
});

test("native table select-all preserves editor, search and popup native selection", () => {
  for (const kind of ["input", "textarea", "select", "[contenteditable]:not([contenteditable='false'])", "[role='searchbox']", ".table-context-menu"]) {
    const env = harness(); const target = new FakeElement(kind, env.root);
    const select = env.event(target); env.render().handlers.onKeyDownCapture(select);
    assert.equal(select.defaultPrevented, false, kind);
    assert.equal(env.render().selected, false);
    const copy = env.event(target); env.render().handlers.onCopyCapture(copy); assert.deepEqual(copy.writes, [], kind);
  }
});

test("filter, order, period and enabled changes cannot leave or resurrect an old native selection", () => {
  const env = harness(); const original = env.options.rows;
  env.render().handlers.onKeyDownCapture(env.event()); assert.equal(env.render().selected, true);
  env.options.rows = [original[1]]; assert.equal(env.render().selected, false);
  const copy = env.event(); env.render().handlers.onCopyCapture(copy); assert.deepEqual(copy.writes, []);
  env.options.rows = original; assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event());
  env.options.resetKey = "other-period"; assert.equal(env.render().selected, false);
  env.options.resetKey = "first"; assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event());
  env.options.enabled = false; assert.equal(env.render().selected, false);
  env.options.enabled = true; assert.equal(env.render().selected, false);
});

test("Escape, focus leaving and outside pointer clear native select-all; empty tables do not select the whole page", () => {
  const env = harness();
  env.render().handlers.onKeyDownCapture(env.event());
  env.render().handlers.onKeyDownCapture(env.event(undefined, { key: "Escape", code: "Escape", ctrlKey: false }));
  assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event()); env.render();
  env.listeners.get("pointerdown")({ target: new FakeElement("main") }); assert.equal(env.render().selected, false);
  env.render().handlers.onKeyDownCapture(env.event()); env.render().handlers.onBlurCapture({ relatedTarget: new FakeElement("button") }); assert.equal(env.render().selected, false);
  env.options.rows = []; const empty = env.event(); env.render().handlers.onKeyDownCapture(empty);
  assert.equal(empty.defaultPrevented, true); assert.equal(env.render().selected, false);
  const plainCopy = env.event(); env.render().handlers.onCopyCapture(plainCopy); assert.equal(plainCopy.defaultPrevented, false);
});

test("user table projection includes visible identity, email, role and status without decorative or hidden data", () => {
  assert.deepEqual(userRows([{ id: 2, fullName: "Видимый сотрудник", email: "visible@example.invalid", role: "viewer", customRoleName: "Наблюдатель", status: "active", assignedSiteId: 7 }]), [["Видимый сотрудник", "visible@example.invalid", "Наблюдатель", "Активен"]]);
});

test("permission matrix projection uses actual allowed checked state, including unsupported and constrained actions", () => {
  const definition = PERMISSION_CATALOG.find(item => item.key === "workers_report");
  const permissions = rolePermissionTemplate("superadmin"); permissions.workers_report.create = false;
  const result = permissionRows([definition], permissions, false, (_resource, action) => ({ allowed: action !== "delete" }));
  assert.deepEqual(result[0], [`${definition.title}\n${definition.description}`, "Да", "Нет", "Да", "—"]);
  assert.deepEqual(permissionRows([definition], permissions, true)[0].slice(0, 1), [definition.title]);
  assert.deepEqual(permissionRows([], permissions, true), []);
});

test("every Excel preview projection copies displayed body values and excludes template metadata", () => {
  const generic = { headers: ["ФИО", "Значение"], rows: [["Тест", ""], ["Другое", "Сложное\nзначение"]], workbook: { kind: "table" } };
  assert.deepEqual(excelPreviewClipboardRows(generic), [[1, "Тест", "—"], [2, "Другое", "Сложное\nзначение"]]);
  assert.deepEqual(excelPreviewClipboardHeaders(generic), ["№", "ФИО", "Значение"]);
  const placement = { headers: ["Дата", "ФИО"], rows: [["2026-11-09", "Тест"]], workbook: { kind: "placement" } };
  assert.deepEqual(excelPreviewClipboardRows(placement), [[new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date("2026-11-09T00:00:00Z")), "Тест"]]);
  assert.deepEqual(excelPreviewClipboardHeaders(placement), ["Дата", "ФИО"]);
  assert.deepEqual(excelPreviewClipboardRows({ ...placement, workbook: { kind: "equipment-placement" } }), excelPreviewClipboardRows(placement));
  const worker = { employmentType: "ОПР", department: "Отдел", fullName: "Тест", position: "Монтажник", positionNote: "Примечание", dailyValues: [0, "В", 8], timesheetHours: 8, reportHours: 6, masters: "Мастер" };
  const personnel = excelPreviewClipboardRows({ workbook: { kind: "personnel-timesheet", dates: ["2026-11-01"], rows: [worker, { ...worker, employmentType: "ИТР" }] } });
  const personnelHeaders = excelPreviewClipboardHeaders({ workbook: { kind: "personnel-timesheet", dates: ["2026-11-01"], rows: [worker] } });
  assert.equal(personnelHeaders.length, personnel[0].length); assert.deepEqual(personnelHeaders.slice(0, 6), ["Тип", "Отдел", "Фамилия, имя, отчество", "Должность", "Примечание к должности", "1"]); assert.deepEqual(personnelHeaders.slice(-3), ["ЧАСЫ", "РАСТ", "Мастер"]);
  assert.equal(personnel[0].length, 39); assert.deepEqual(personnel[0].slice(5, 8), [0, "В", 8]); assert.deepEqual(personnel[0].slice(-3), [8, 2, "Мастер"]); assert.equal(personnel[1].at(-2), 0);
  const equipment = excelPreviewClipboardRows({ workbook: { kind: "equipment-timesheet", dates: ["2026-11-01"], rows: [{ equipmentName: "Кран // Тест // А001", dailyProductiveHours: [0, 6], productiveHours: 6, downtimeHours: 2, totalHours: 8, reportHours: 5 }] } });
  const equipmentHeaders = excelPreviewClipboardHeaders({ workbook: { kind: "equipment-timesheet", dates: ["2026-11-01"], rows: [] } });
  assert.equal(equipmentHeaders.length, equipment[0].length); assert.deepEqual(equipmentHeaders.slice(0, 4), ["Тип", "Уникальное наименование единицы", "ГРЗ", "1"]); assert.deepEqual(equipmentHeaders.slice(-3), ["ЧАСЫ", "ПРОСТОЙ", "РАСТ"]);
  assert.equal(equipment[0].length, 37); assert.deepEqual(equipment[0].slice(0, 5), ["Кран", "Кран // Тест // А001", "А001", "", 6]); assert.deepEqual(equipment[0].slice(-3), [6, 2, 3]);
  assert.deepEqual(excelPreviewClipboardRows(null), []);
  assert.deepEqual(excelPreviewClipboardHeaders(null), []);
});
