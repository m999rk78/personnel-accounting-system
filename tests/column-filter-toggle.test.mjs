import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import ts from "typescript";
import { columnFilterToggleHandlers, columnFilterVisibility } from "../app/columnFilterToggle.ts";

async function declaration(path, name) {
  const file = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `${name} exists`);
  return node.getText(file).replace(/^export\s+/, "");
}
const implementation = ts.transpileModule([
  await declaration("../app/useColumnFilterToggle.ts", "useColumnFilterToggle"),
  await declaration("../app/SpreadsheetFilterHeader.tsx", "SpreadsheetFilterHeader"),
  await declaration("../app/AgDataGrids.tsx", "PinnableInnerHeader"),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" } }).outputText;

/** Real shared hook and both real header components, with AG's event boundary. */
function harness(kind) {
  const hooks = new Map(), events = new Map(), queued = [], calls = [], columns = new Map(), buttons = new Map(), pinButtons = new Map();
  let cursor = 0, slots, popup = null, contextOpen = false, destroyed = false;
  const model = { fullName: { filterType: "set", values: ["Сотрудник"] } };
  const same = (left, right) => left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const memo = (calculate, dependencies) => {
    const index = cursor++;
    if (!same(slots[index]?.dependencies, dependencies)) slots[index] = { value: calculate(), dependencies };
    return slots[index].value;
  };
  const useState = initial => { const state = slots, index = cursor++; state[index] ??= { value: typeof initial === "function" ? initial() : initial }; return [state[index].value, next => { state[index].value = typeof next === "function" ? next(state[index].value) : next; }]; };
  const useRef = initial => { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; };
  const useEffect = (effect, dependencies) => {
    const index = cursor++;
    if (!same(slots[index]?.dependencies, dependencies)) { slots[index]?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; }
  };
  const emit = event => { for (const listener of events.get(event.type) ?? []) listener(event); };
  const queue = (column, visible, key = "columnFilter") => queued.push({ type: "columnMenuVisibleChanged", key, visible, column });
  const api = {
    isDestroyed: () => destroyed,
    addEventListener(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); },
    removeEventListener(name, listener) { events.get(name)?.delete(listener); },
    hideColumnFilter() { calls.push("hideFilter"); if (popup) queue(columns.get(popup.id), false); popup = null; },
    hidePopupMenu() { calls.push("hideMenu"); contextOpen = false; },
    // The former API path defers to a RAF and does not use the custom button.
    showColumnFilter() { throw new Error("Use the native header showFilter(button), not deferred API opening"); },
    setColumnsPinned([column], pinned) { column.pinned = pinned; emit({ type: "columnPinned" }); },
  };
  const useSyncExternalStore = (subscribe, getSnapshot) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { cleanup: subscribe(() => {}) };
    return getSnapshot();
  };
  const environment = { createElement, useState, useRef, useEffect, useLayoutEffect: useEffect, useMemo: memo, useSyncExternalStore, columnFilterToggleHandlers, columnFilterVisibility, closed: () => null, ColumnFilterIcon: () => null, GridIcon: () => null };
  const components = new Function(...Object.keys(environment), `${implementation}; return {SpreadsheetFilterHeader,PinnableInnerHeader};`)(...Object.values(environment));
  function render(id = "fullName") {
    if (!columns.has(id)) columns.set(id, { getColId: () => id, pinned: null, getPinned() { return this.pinned; }, isFilterActive: () => true,
      isMenuVisible() { throw new Error("Generic menu visibility must not control the filter button"); } });
    if (!buttons.has(id)) buttons.set(id, { id, isConnected: true });
    if (!hooks.has(id)) hooks.set(id, []);
    slots = hooks.get(id); cursor = 0;
    const view = components[kind]({ api, column: columns.get(id), displayName: id, showFilter(button) {
      calls.push(`show:${id}`); popup = { id, anchor: button }; queue(columns.get(id), true);
    } });
    const find = node => {
      if (!node || typeof node !== "object") return null;
      if (node.type === "button" && node.props.className?.includes("ag-column-pin")) pinButtons.set(id, node.props);
      if (node.type === "button" && node.props.className?.includes("ag-column-filter")) return node;
      return [node.props?.children].flat().map(find).find(Boolean);
    };
    return find(view).props;
  }
  const flush = () => { for (const event of queued.splice(0)) emit(event); };
  const click = (id = "fullName", detail = 1) => {
    const props = render(id), target = buttons.get(id);
    const event = { button: 0, currentTarget: target, detail, stopPropagation() {}, preventDefault() {} };
    props.onMouseDownCapture(event);
    // Real AG PopupService's document bubble listener runs before click.
    if (popup && popup.anchor !== target) api.hideColumnFilter();
    flush();
    const refreshed = render(id); // Supplies a new native showFilter callback.
    assert.equal(refreshed.onClickCapture, props.onClickCapture, "AG's intervening header refresh must retain the gesture handler");
    refreshed.onClickCapture(event); flush();
    return render(id);
  };
  return { api, calls, model, render, click, flush, get popup() { return popup; }, get contextOpen() { return contextOpen; },
    event: emit,
    keyboard(id = "fullName", key = "Enter") { const props = render(id), event = { key, currentTarget: buttons.get(id), detail: 0, stopPropagation() {} }; props.onKeyDownCapture(event); props.onClickCapture(event); flush(); return render(id); },
    assistive(id = "fullName") { render(id).onClickCapture({ currentTarget: buttons.get(id), stopPropagation() {} }); flush(); return render(id); },
    outside() { api.hideColumnFilter(); flush(); },
    context(id = "fullName") { render(id); contextOpen = true; emit({ type: "columnMenuVisibleChanged", key: "columnMenu", column: columns.get(id), visible: true }); },
    pin(id = "fullName") { render(id); pinButtons.get(id).onClick({ stopPropagation() {} }); return columns.get(id).pinned; },
    unmount(id) { hooks.get(id)?.forEach(slot => slot.cleanup?.()); hooks.delete(id); },
    destroy() { emit({ type: "gridPreDestroyed" }); destroyed = true; },
    listeners: events,
  };
}

test("the pinnable header keeps its independent pin control", () => {
  const ui = harness("PinnableInnerHeader");
  assert.equal(ui.pin(), "left"); assert.equal(ui.pin(), null);
  assert.equal(ui.popup, null); assert.deepEqual(ui.calls, []);
  ui.destroy();
});

for (const kind of ["SpreadsheetFilterHeader", "PinnableInnerHeader"]) {
  test(`${kind}: same-button mouse gestures open, close and reopen exactly once, including a detail-zero paired click`, () => {
    const ui = harness(kind); ui.render();
    assert.equal(ui.click()["aria-expanded"], true); assert.equal(ui.popup.id, "fullName");
    assert.equal(columnFilterVisibility(ui.api).getAnchor("fullName"), ui.popup.anchor, "popup placement receives the actual custom toggle button");
    // A filter search/model refresh must not turn an open popup into a new one.
    ui.event({ type: "filterChanged" });
    assert.equal(ui.click()["aria-expanded"], false); assert.equal(ui.popup, null);
    assert.equal(ui.click("fullName", 0)["aria-expanded"], true);
    assert.equal(ui.calls.filter(call => call === "show:fullName").length, 2);
    assert.deepEqual(ui.model, { fullName: { filterType: "set", values: ["Сотрудник"] } });
    ui.destroy();
    assert.equal(columnFilterVisibility(ui.api).getAnchor("fullName"), null);
  });

  test(`${kind}: keyboard, assistive/touch fallback, outside close and switching columns preserve ownership`, () => {
    const ui = harness(kind); ui.render();
    assert.equal(ui.keyboard()["aria-expanded"], true);
    assert.equal(ui.keyboard("fullName", " ")["aria-expanded"], false);
    assert.equal(ui.assistive()["aria-expanded"], true);
    assert.equal(ui.click("workDate")["aria-expanded"], true);
    assert.equal(ui.popup.id, "workDate"); assert.equal(ui.render("fullName")["aria-expanded"], false);
    ui.outside(); assert.equal(ui.render("workDate")["aria-expanded"], false);
    assert.equal(ui.click("fullName")["aria-expanded"], true);
    ui.destroy();
  });

  test(`${kind}: ordinary context menus do not count as filters, and remounts retain actual filter state`, () => {
    const ui = harness(kind); ui.context();
    assert.equal(ui.render()["aria-expanded"], false);
    assert.equal(ui.click()["aria-expanded"], true); assert.equal(ui.contextOpen, false);
    ui.unmount("fullName"); assert.equal(ui.render()["aria-expanded"], true);
    ui.unmount("fullName"); ui.outside();
    assert.equal(ui.render()["aria-expanded"], false, "outside closure is tracked even while a header is virtualized");
    assert.equal(ui.listeners.get("columnMenuVisibleChanged").size, 1, "one ownership tracker per grid");
    ui.destroy(); assert.equal(ui.listeners.get("columnMenuVisibleChanged").size, 0);
  });
}
