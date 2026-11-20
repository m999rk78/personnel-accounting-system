import assert from "node:assert/strict";
import test from "node:test";
import { connectTimesheetResizePointer } from "../app/timesheetColumnResizePointer.ts";

class Events {
  listeners = new Map();
  addEventListener(name, callback, options = false) {
    const key = `${name}:${typeof options === "boolean" ? options : Boolean(options.capture)}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(callback);
  }
  removeEventListener(name, callback, options = false) {
    this.listeners.get(`${name}:${typeof options === "boolean" ? options : Boolean(options.capture)}`)?.delete(callback);
  }
  emit(name, event, capture = false) { for (const callback of [...this.listeners.get(`${name}:${capture}`) ?? []]) callback(event); }
  get count() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
const box = (left, right, top = 20, bottom = 100) => ({ left, right, top, bottom, width: right - left, height: bottom - top });
const classes = (...initial) => {
  const values = new Set(initial);
  return { contains: value => values.has(value), add: value => values.add(value), remove: value => values.delete(value) };
};

function harness(bounds = box(0, 400, 0, 600)) {
  const root = new Events(), view = new Events(), handles = [], starts = [];
  let dragging = false;
  root.ownerDocument = { defaultView: view };
  root.classList = classes("unrelated-table-class");
  root.getBoundingClientRect = () => bounds;
  root.querySelectorAll = () => handles;
  const add = (id, rect, { sticky = false, pin, visible = true, edge = "right" } = {}) => {
    const attrs = new Map();
    const cell = {
      rect, visible, dataset: pin === undefined ? {} : { timesheetPin: pin }, classList: classes(...sticky ? ["timesheet-sticky"] : []),
      getBoundingClientRect() { return this.rect; },
      getClientRects() { return this.visible ? [this.rect] : []; },
    };
    const handle = {
      dataset: { columnId: id, resizeEdge: edge, resizeOwner: id }, cell,
      closest: selector => selector === "th" ? cell : null,
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: name => attrs.delete(name),
      hasAttribute: name => attrs.has(name),
    };
    handles.push(handle);
    return handle;
  };
  const connection = connectTimesheetResizePointer(root, {
    isDragging: () => dragging,
    start: (id, event, handle) => starts.push({ id, event, handle }),
  });
  const fire = (name, x, y = 50, overrides = {}) => {
    const event = {
      target: root, button: 0, isPrimary: true, clientX: x, clientY: y, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides,
    };
    root.emit(name, event, true);
    return event;
  };
  const highlighted = () => handles.filter(handle => handle.hasAttribute("data-resize-hover")).map(handle => handle.dataset.columnId);
  return { root, view, starts, handles, add, connection, fire, highlighted,
    set dragging(value) { dragging = value; },
  };
}

test("the visible divider and both nearby sides resize the same owner even when the next header wins native hit testing", () => {
  const ui = harness(), first = ui.add("first", box(0, 100)), second = ui.add("second", box(100, 200));
  for (const x of [97, 98, 100, 102, 103]) {
    ui.fire("pointermove", x, 50, { target: x >= 100 ? second.cell : first.cell });
    assert.deepEqual(ui.highlighted(), ["first"], `divider at100: ${x} belongs to its preceding column`);
    const event = ui.fire("pointerdown", x, 50, { target: second.cell });
    assert.equal(ui.starts.at(-1).id, "first");
    assert.equal(ui.starts.at(-1).handle, first);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true, "Resize must not also select the neighbouring header");
  }
  const before = ui.starts.length;
  for (const x of [95, 96.9, 103.1, 105, 112]) {
    ui.fire("pointermove", x);
    const event = ui.fire("pointerdown", x);
    assert.deepEqual(ui.highlighted(), []);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, false);
  }
  assert.equal(ui.starts.length, before);
});

test("only one divider is highlighted and moving between header children does not clear it", () => {
  const ui = harness(), first = ui.add("first", box(0, 100));
  ui.add("second", box(100, 200));
  ui.fire("pointermove", 100);
  ui.fire("pointerleave", 100, 50, { target: first.cell });
  assert.deepEqual(ui.highlighted(), ["first"]);
  ui.fire("pointermove", 200);
  assert.deepEqual(ui.highlighted(), ["second"]);
  assert.equal(ui.root.classList.contains("timesheet-column-edge-hover"), true);
  ui.fire("pointerleave", 401);
  assert.deepEqual(ui.highlighted(), []);
  assert.equal(ui.root.classList.contains("timesheet-column-edge-hover"), false);
  assert.equal(ui.root.classList.contains("unrelated-table-class"), true);
});

test("pinned headers cover scrolled-away day dividers and own a shared boundary", () => {
  const ui = harness();
  ui.add("covered-day", box(40, 80));
  ui.add("shared-day", box(60, 100));
  ui.add("metadata", box(0, 100), { sticky: true });
  ui.add("visible-day", box(100, 140));
  ui.fire("pointermove", 80);
  assert.deepEqual(ui.highlighted(), [], "A hidden day cannot steal input inside pinned metadata");
  ui.fire("pointerdown", 100);
  assert.equal(ui.starts.at(-1).id, "metadata");
  ui.fire("pointermove", 140);
  assert.deepEqual(ui.highlighted(), ["visible-day"]);
});

test("right pins hide center dividers behind them without blocking visible center columns", () => {
  const ui = harness();
  ui.add("metadata", box(0, 100), { sticky: true });
  ui.add("visible-day", box(100, 240));
  ui.add("covered-day", box(240, 340));
  ui.add("right-total", box(300, 400), { sticky: true, pin: "right" });
  ui.fire("pointermove", 240);
  assert.deepEqual(ui.highlighted(), ["visible-day"], "A right pin must not be mistaken for the left frozen region");
  ui.fire("pointermove", 340);
  assert.deepEqual(ui.highlighted(), [], "The center divider is covered by the right-pinned total");
  ui.fire("pointerdown", 400);
  assert.equal(ui.starts.at(-1).id, "right-total");
});

test("a right-pinned owner wins a shared boundary and both nearby sides remain usable", () => {
  const ui = harness();
  const covered = ui.add("covered-day", box(240, 350));
  const pinned = ui.add("pinned-day", box(300, 350), { sticky: true, pin: "right" });
  ui.add("right-total", box(350, 400), { sticky: true, pin: "right" });
  for (const x of [347, 350, 353]) {
    ui.fire("pointermove", x, 50, { target: covered.cell });
    assert.deepEqual(ui.highlighted(), ["pinned-day"]);
    ui.fire("pointerdown", x, 50, { target: covered.cell });
    assert.equal(ui.starts.at(-1).handle, pinned);
  }
});

test("explicit none overrides a legacy sticky class after unpinning", () => {
  const ui = harness();
  ui.add("former-metadata", box(0, 100), { sticky: true, pin: "none" });
  ui.add("visible-day", box(40, 80));
  ui.fire("pointermove", 80);
  assert.deepEqual(ui.highlighted(), ["visible-day"]);
});

test("root borders work, but hidden cells and out-of-viewport boundaries do not intercept input", () => {
  const ui = harness(box(20, 420, 0, 600));
  ui.add("off-left", box(-40, 10));
  ui.add("hidden", box(20, 100), { visible: false });
  ui.add("zero-height", box(20, 120, 40, 40));
  ui.add("zero-width", box(150, 150));
  ui.add("last", box(320, 420));
  ui.add("off-right", box(425, 460));
  for (const x of [10, 100, 120, 150, 421, 460]) {
    ui.fire("pointermove", x);
    assert.deepEqual(ui.highlighted(), [], `No resize at inaccessible edge ${x}`);
  }
  ui.fire("pointerdown", 420);
  assert.equal(ui.starts.at(-1).id, "last", "The root's outer border remains part of the final divider");
});

test("the day divider belongs to its own header row rather than the flat month group or body rows", () => {
  const ui = harness();
  ui.add("day-1", box(60, 100, 60, 100));
  for (const y of [19, 30, 101, 200]) {
    ui.fire("pointermove", 100, y);
    assert.deepEqual(ui.highlighted(), []);
  }
  ui.fire("pointermove", 100, 80);
  assert.deepEqual(ui.highlighted(), ["day-1"]);
});

test("refresh and native scroll/resize events use live geometry for a stationary pointer", () => {
  const ui = harness(), handle = ui.add("first", box(0, 100));
  ui.fire("pointermove", 100);
  handle.cell.rect = box(0, 120);
  ui.connection.refresh();
  assert.deepEqual(ui.highlighted(), []);
  handle.cell.rect = box(0, 100);
  ui.root.emit("scroll", {});
  assert.deepEqual(ui.highlighted(), ["first"]);
  ui.root.classList.remove("timesheet-column-edge-hover");
  ui.connection.refresh();
  assert.equal(ui.root.classList.contains("timesheet-column-edge-hover"), true, "A shell className render cannot remove the current resize cursor");
  handle.cell.rect = box(0, 80);
  ui.view.emit("scroll", {});
  assert.deepEqual(ui.highlighted(), []);
  handle.cell.rect = box(0, 100);
  ui.view.emit("resize", {});
  assert.deepEqual(ui.highlighted(), ["first"]);
});

test("dragging keeps its indicator while recording the eventual pointer position for finish refresh", () => {
  const ui = harness();
  ui.add("first", box(0, 100)); ui.add("second", box(100, 200));
  ui.fire("pointermove", 100);
  ui.dragging = true;
  ui.fire("pointermove", 200);
  ui.connection.refresh();
  assert.deepEqual(ui.highlighted(), ["first"], "Geometry changes must not transfer an active drag to another divider");
  ui.dragging = false;
  ui.connection.refresh();
  assert.deepEqual(ui.highlighted(), ["second"], "Finishing uses the latest pointer rather than the drag's starting point");
  ui.dragging = true;
  ui.fire("pointermove", 430);
  assert.deepEqual(ui.highlighted(), ["second"]);
  ui.dragging = false;
  ui.connection.refresh();
  assert.deepEqual(ui.highlighted(), []);
  ui.fire("pointermove", 100);
  ui.dragging = true;
  ui.fire("pointerleave", 430);
  assert.deepEqual(ui.highlighted(), ["first"]);
  ui.dragging = false;
  ui.connection.refresh();
  assert.deepEqual(ui.highlighted(), []);
});

test("secondary buttons, extra touch pointers and another active drag cannot start a new resize", () => {
  const ui = harness(); ui.add("first", box(0, 100));
  ui.fire("pointerdown", 100, 50, { button: 2 });
  ui.fire("pointerdown", 100, 50, { isPrimary: false });
  ui.dragging = true;
  ui.fire("pointerdown", 100);
  assert.equal(ui.starts.length, 0);
});

test("disposing removes all event listeners and owned hover state", () => {
  const ui = harness(); ui.add("first", box(0, 100));
  ui.fire("pointermove", 100);
  assert.ok(ui.root.count > 0 && ui.view.count > 0);
  ui.connection.dispose(); ui.connection.dispose();
  assert.equal(ui.root.count, 0); assert.equal(ui.view.count, 0);
  assert.deepEqual(ui.highlighted(), []);
  assert.equal(ui.root.classList.contains("timesheet-column-edge-hover"), false);
  assert.equal(ui.root.classList.contains("unrelated-table-class"), true);
  ui.fire("pointermove", 100); ui.fire("pointerdown", 100); ui.connection.refresh();
  assert.deepEqual(ui.highlighted(), []); assert.equal(ui.starts.length, 0);
});
