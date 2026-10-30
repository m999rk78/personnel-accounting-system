import assert from "node:assert/strict";
import test from "node:test";
import { attachSelectionRowDrag } from "../app/selectionRowDrag.ts";

// Node 22 does not match a boolean `true` when removing capture listeners.
// Normalise to the equivalent DOM options object while keeping native Events
// and dispatchEvent, including default prevention and propagation semantics.
class DomTarget extends EventTarget {
  listeners = [];

  addEventListener(type, listener, options) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    this.listeners.push({ type, listener, capture });
    return super.addEventListener(type, listener, typeof options === "boolean" ? { capture: options } : options);
  }

  removeEventListener(type, listener, options) {
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    this.listeners = this.listeners.filter(item => item.type !== type || item.listener !== listener || item.capture !== capture);
    return super.removeEventListener(type, listener, typeof options === "boolean" ? { capture: options } : options);
  }
}

function fixture({ selected = true, allowed = true, checkboxExists = true } = {}) {
  const checkbox = new DomTarget();
  checkbox.title = "";
  const classes = new Set(["native-checkbox"]);
  checkbox.classList = {
    toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); },
  };
  checkbox.removeAttribute = name => { if (name === "title") checkbox.title = ""; };
  const cell = new DomTarget();
  cell.querySelector = selector => selector === ".ag-selection-checkbox" && checkboxExists ? checkbox : null;
  const node = new DomTarget();
  node.isSelected = () => selected;
  const api = new DomTarget();
  api.isDestroyed = () => false;
  const registered = [];
  const cleanup = attachSelectionRowDrag({ eGridCell: cell, node, api, registerRowDragger: (...args) => registered.push(args), canDrag: () => allowed });
  return {
    checkbox, cell, node, api, registered, cleanup,
    setSelected(value) { selected = value; node.dispatchEvent(new Event("rowSelected")); },
    setAllowed(value) { allowed = value; },
    enterDrag(draggedNode = node) { api.dispatchEvent(Object.assign(new Event("rowDragEnter"), { node: draggedNode })); },
  };
}

function dispatch(target, type) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test("selected and permitted checkbox remains clickable and is registered with a drag threshold", () => {
  const target = fixture();
  assert.equal(target.registered.length, 1);
  assert.deepEqual(target.registered[0], [target.checkbox, 5, undefined, true]);
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), true);
  assert.match(target.checkbox.title, /Перетащите/);
  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    const event = dispatch(target.checkbox, type);
    assert.equal(event.cancelBubble, false);
    assert.equal(event.defaultPrevented, false);
  }
  const click = dispatch(target.cell, "click");
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.cancelBubble, false);
  target.cleanup();
});

test("unselected or disabled rows stop drag initiation without cancelling checkbox selection", () => {
  for (const state of [{ selected: false }, { allowed: false }, { selected: false, allowed: false }]) {
    const target = fixture(state);
    assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), false);
    for (const type of ["pointerdown", "mousedown", "touchstart"]) {
      const event = dispatch(target.checkbox, type);
      assert.equal(event.cancelBubble, true);
      assert.equal(event.defaultPrevented, false, "selection's native default must remain enabled");
    }
    assert.equal(dispatch(target.cell, "click").defaultPrevented, false);
    target.cleanup();
  }
});

test("selection changes and changed permissions are checked when a gesture starts", () => {
  const target = fixture({ selected: false });
  target.setSelected(true);
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), true);
  assert.equal(dispatch(target.checkbox, "pointerdown").cancelBubble, false);
  target.setAllowed(false);
  const disabled = dispatch(target.checkbox, "pointerdown");
  assert.equal(disabled.cancelBubble, true);
  assert.equal(disabled.defaultPrevented, false);
  target.setSelected(false);
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), false);
  target.cleanup();
});

test("a selected checkbox stops being a drag handle if the row is no longer selectable", () => {
  const target = fixture();
  target.node.selectable = false;
  target.node.dispatchEvent(new Event("selectableChanged"));
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), false);
  assert.equal(dispatch(target.checkbox, "pointerdown").cancelBubble, true);
  assert.equal(dispatch(target.cell, "click").defaultPrevented, false);
  target.node.selectable = true;
  target.node.dispatchEvent(new Event("selectableChanged"));
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), true);
  target.cleanup();
});

test("a completed drag suppresses its trailing checkbox click exactly once", () => {
  const target = fixture();
  let nativeSelectionClicks = 0;
  target.cell.addEventListener("click", () => { nativeSelectionClicks += 1; });
  dispatch(target.checkbox, "pointerdown");
  target.enterDrag();
  const trailing = dispatch(target.cell, "click");
  assert.equal(trailing.defaultPrevented, true);
  assert.equal(trailing.cancelBubble, true);
  assert.equal(nativeSelectionClicks, 0);
  const nextClick = dispatch(target.cell, "click");
  assert.equal(nextClick.defaultPrevented, false);
  assert.equal(nativeSelectionClicks, 1);
  target.cleanup();
});

test("dragging an unrelated row does not consume this checkbox's next click", () => {
  const target = fixture();
  target.enterDrag(new DomTarget());
  const click = dispatch(target.cell, "click");
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.cancelBubble, false);
  target.cleanup();
});

test("a later ordinary gesture is not suppressed if the previous drag produced no click", () => {
  const target = fixture();
  dispatch(target.checkbox, "pointerdown");
  target.enterDrag();
  dispatch(target.checkbox, "pointerdown");
  assert.equal(dispatch(target.cell, "click").defaultPrevented, false);
  target.cleanup();
});

test("keyboard or assistive clicks after a drag remain native and clear stale pointer-click suppression", () => {
  const target = fixture();
  let nativeSelectionClicks = 0;
  target.cell.addEventListener("click", () => { nativeSelectionClicks += 1; });
  dispatch(target.checkbox, "pointerdown");
  target.enterDrag();
  const keyboardClick = Object.assign(new Event("click", { bubbles: true, cancelable: true }), { detail: 0 });
  target.cell.dispatchEvent(keyboardClick);
  assert.equal(keyboardClick.defaultPrevented, false);
  assert.equal(keyboardClick.cancelBubble, false);
  assert.equal(nativeSelectionClicks, 1);
  const nextPointerClick = Object.assign(new Event("click", { bubbles: true, cancelable: true }), { detail: 1 });
  target.cell.dispatchEvent(nextPointerClick);
  assert.equal(nextPointerClick.defaultPrevented, false);
  assert.equal(nextPointerClick.cancelBubble, false);
  assert.equal(nativeSelectionClicks, 2);
  target.cleanup();
});

test("cleanup removes listeners and drag styling without damaging the native checkbox", () => {
  const target = fixture();
  assert.equal(target.checkbox.listeners.length, 3);
  assert.equal(target.cell.listeners.length, 1);
  assert.equal(target.node.listeners.length, 2);
  assert.equal(target.api.listeners.length, 1);
  target.cleanup();
  for (const element of [target.checkbox, target.cell, target.node, target.api]) assert.equal(element.listeners.length, 0);
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), false);
  assert.equal(target.checkbox.classList.contains("native-checkbox"), true);
  assert.equal(target.checkbox.title, "");
  target.setSelected(false);
  assert.equal(dispatch(target.checkbox, "pointerdown").cancelBubble, false);
  target.setSelected(true);
  assert.equal(target.checkbox.classList.contains("table-selection-drag-ready"), false);
  target.enterDrag();
  assert.equal(dispatch(target.cell, "click").defaultPrevented, false);
});

test("cells without a native selection checkbox are a safe no-op", () => {
  const target = fixture({ checkboxExists: false });
  assert.equal(target.cleanup, undefined);
  assert.deepEqual(target.registered, []);
  for (const element of [target.checkbox, target.cell, target.node, target.api]) assert.equal(element.listeners.length, 0);
});
