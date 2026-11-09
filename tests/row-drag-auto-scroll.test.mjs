import assert from "node:assert/strict";
import test from "node:test";
import { createRowDragAutoScroll, rowDragPoint, rowDragScrollSpeed, startRowDragAutoScroll } from "../app/rowDragAutoScroll.ts";

const area = { left: 100, right: 900, top: 100, bottom: 700, contentTop: 188, contentBottom: 653 };

function fixture(initialTop = 1400) {
  const frames = new Map(); let sequence = 0; let time = 0;
  const viewport = { scrollTop: initialTop, scrollHeight: 5000, clientHeight: 600 };
  const runtime = { requestFrame(callback) { frames.set(++sequence, callback); return sequence; }, cancelFrame(id) { frames.delete(id); } };
  let bounds = area;
  const controller = createRowDragAutoScroll({ viewport, bounds: () => bounds, runtime });
  return { controller, viewport, frames, runtime, removeBounds() { bounds = null; }, step(count = 1, interval = 16) {
    for (let index = 0; index < count; index++) {
      time += interval;
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(time);
    }
  } };
}

test("upper/lower row-drag zones span the columns, body edges and sticky heading/footer", () => {
  for (const clientX of [105, 450, 895]) {
    assert.ok(rowDragScrollSpeed({ clientX, clientY: 240 }, area) < 0, "start well below the sticky heading");
    assert.ok(rowDragScrollSpeed({ clientX, clientY: 140 }, area) < 0, "the whole heading remains an upper scroll area");
    assert.ok(rowDragScrollSpeed({ clientX, clientY: 610 }, area) > 0);
    assert.ok(rowDragScrollSpeed({ clientX, clientY: 680 }, area) > 0, "footer remains a lower scroll area");
    assert.equal(rowDragScrollSpeed({ clientX, clientY: 420 }, area), 0);
  }
  assert.ok(rowDragScrollSpeed({ clientX: 200, clientY: 160 }, area) < rowDragScrollSpeed({ clientX: 200, clientY: 265 }, area), "approaching the edge increases speed");
});

test("leaving the table stops scrolling, with a small allowance for overshooting its edge", () => {
  assert.ok(rowDragScrollSpeed({ clientX: 200, clientY: 80 }, area) < 0);
  for (const point of [{ clientX: 30, clientY: 150 }, { clientX: 950, clientY: 650 }, { clientX: 200, clientY: 30 }, { clientX: 200, clientY: 760 }, { clientX: NaN, clientY: 150 }]) {
    assert.equal(rowDragScrollSpeed(point, area), 0);
  }
  const small = { ...area, bottom: 360, contentBottom: 313 };
  assert.equal(rowDragScrollSpeed({ clientX: 200, clientY: 250 }, small), 0, "small viewports retain a neutral middle");
});

test("reports extend AG Grid's zone without stacking two scroll loops on its original edge", () => {
  const grid = { ...area, existingEdge: 20 };
  assert.equal(rowDragScrollSpeed({ clientX: 200, clientY: 195 }, grid), 0);
  assert.equal(rowDragScrollSpeed({ clientX: 200, clientY: 645 }, grid), 0);
  assert.ok(rowDragScrollSpeed({ clientX: 200, clientY: 240 }, grid) < 0);
  assert.ok(rowDragScrollSpeed({ clientX: 200, clientY: 140 }, grid) < 0, "keep scrolling over the grid heading after rowDragLeave");
  assert.ok(rowDragScrollSpeed({ clientX: 200, clientY: 195 }, area) < 0, "native timesheets use the complete enlarged area");
});

test("a stationary held row keeps scrolling and can reverse direction without another gesture", () => {
  const f = fixture();
  f.controller.update({ clientX: 200, clientY: 240 });
  f.step(60);
  assert.ok(f.viewport.scrollTop < 1250);
  assert.equal(f.frames.size, 1);
  const before = f.viewport.scrollTop;
  f.controller.update({ clientX: 800, clientY: 610 });
  f.step(60);
  assert.ok(f.viewport.scrollTop > before + 150);
  f.controller.stop();
  assert.equal(f.frames.size, 0);
  f.controller.update({ clientX: 200, clientY: 240 }); f.step(30);
  assert.equal(f.frames.size, 0, "drop/cancel cannot revive an old gesture");
});

test("centre/outside positions and an unmounted table end the frame loop", () => {
  for (const point of [{ clientX: 200, clientY: 420 }, { clientX: 20, clientY: 200 }]) {
    const f = fixture();
    f.controller.update({ clientX: 200, clientY: 240 }); f.step(2);
    const before = f.viewport.scrollTop;
    f.controller.update(point); f.step(20);
    assert.equal(f.viewport.scrollTop, before); assert.equal(f.frames.size, 0);
  }
  const f = fixture();
  f.controller.update({ clientX: 200, clientY: 240 }); f.removeBounds(); f.step(3);
  assert.equal(f.viewport.scrollTop, 1400); assert.equal(f.frames.size, 0);
});

test("scrolling is clamped at both ends and does not jump after a delayed frame", () => {
  const up = fixture(5); up.controller.update({ clientX: 200, clientY: 140 }); up.step(30);
  assert.equal(up.viewport.scrollTop, 0); assert.equal(up.frames.size, 0);
  const down = fixture(4395); down.controller.update({ clientX: 200, clientY: 680 }); down.step(30);
  assert.equal(down.viewport.scrollTop, 4400); assert.equal(down.frames.size, 0);
  const delayed = fixture(); delayed.controller.update({ clientX: 200, clientY: 140 }); delayed.step();
  const before = delayed.viewport.scrollTop; delayed.step(1, 10000);
  assert.ok(before - delayed.viewport.scrollTop <= 24);
  delayed.controller.stop();
});

test("leaving the document pauses a held gesture until it re-enters", () => {
  const f = fixture(); f.controller.update({ clientX: 200, clientY: 140 }); f.step(3);
  const before = f.viewport.scrollTop; f.controller.pause(); f.step(20);
  assert.equal(f.viewport.scrollTop, before); assert.equal(f.frames.size, 0);
  f.controller.update({ clientX: 200, clientY: 140 }); f.step(3);
  assert.ok(f.viewport.scrollTop < before);
  f.controller.stop();
});

class DomTarget extends EventTarget {
  listeners = new Set();
  addEventListener(type, callback, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners.add(callback);
    super.addEventListener(type, callback, { capture });
  }
  removeEventListener(type, callback, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    super.removeEventListener(type, callback, { capture });
    this.listeners.delete(callback);
  }
}

test("native heading dragover is accepted and drop/Escape/blur remove all document listeners", () => {
  for (const finish of ["drop", "dragend", "Escape", "blur"]) {
    const f = fixture();
    const completionTasks = [];
    const view = Object.assign(new DomTarget(), { innerWidth: 1000, innerHeight: 800, requestAnimationFrame: f.runtime.requestFrame, cancelAnimationFrame: f.runtime.cancelFrame,
      setTimeout(callback) { completionTasks.push(callback); return completionTasks.length; } });
    const document = Object.assign(new DomTarget(), { defaultView: view });
    const root = Object.assign(f.viewport, { ownerDocument: document, isConnected: true, contains: () => true, getBoundingClientRect: () => area,
      querySelector: name => name === "thead" ? { offsetHeight: 88 } : name === "tfoot" ? { offsetHeight: 47 } : null });
    let finished = 0;
    const gesture = startRowDragAutoScroll(root, { clientX: 200, clientY: 420 }, "native", () => finished++);
    const event = Object.assign(new Event("dragover", { cancelable: true }), { clientX: 200, clientY: 140 });
    document.dispatchEvent(event); f.step(5);
    assert.equal(event.defaultPrevented, true); assert.ok(root.scrollTop < 1400);
    document.dispatchEvent(new Event("mouseup"));
    assert.ok(document.listeners.size > 0, "native mouseup must not invalidate the upcoming HTML5 drop");
    if (finish === "blur") view.dispatchEvent(new Event("blur"));
    else document.dispatchEvent(Object.assign(new Event(finish === "Escape" ? "keydown" : finish), { key: "Escape" }));
    assert.equal(document.listeners.size, 0); assert.equal(view.listeners.size, 0); assert.equal(f.frames.size, 0);
    assert.equal(finished, 0, "the target row still has its snapshot during drop dispatch");
    completionTasks.splice(0).forEach(callback => callback()); assert.equal(finished, 1);
    gesture.stop();
    completionTasks.splice(0).forEach(callback => callback()); assert.equal(finished, 1, "cleanup is idempotent");
  }
});

test("mouse and touch gestures share client coordinates without depending on global DOM classes", () => {
  assert.deepEqual(rowDragPoint({ clientX: 25, clientY: 80 }), { clientX: 25, clientY: 80 });
  assert.deepEqual(rowDragPoint({ touches: [{ clientX: 50, clientY: 90 }], changedTouches: [] }), { clientX: 50, clientY: 90 });
  assert.equal(rowDragPoint({ touches: [], changedTouches: [] }), null);
});

test("AG Grid's scrolling viewport includes its pinned heading and stops on pointer release", () => {
  const f = fixture();
  const view = Object.assign(new DomTarget(), { innerWidth: 1000, innerHeight: 800, requestAnimationFrame: f.runtime.requestFrame, cancelAnimationFrame: f.runtime.cancelFrame });
  const document = Object.assign(new DomTarget(), { defaultView: view });
  const viewport = Object.assign(f.viewport, { isConnected: true, matches: selector => selector === ".ag-grid-viewport", getBoundingClientRect: () => area });
  const root = { ownerDocument: document, isConnected: true, getBoundingClientRect: () => area,
    querySelector(selector) {
      if (selector === ".ag-grid-viewport, .ag-body-viewport") return viewport;
      if (selector === ".ag-grid-pinned-top-rows") return { offsetHeight: 41 };
      return null;
    } };
  startRowDragAutoScroll(root, { clientX: 200, clientY: 210 }, "grid"); f.step(10);
  assert.ok(viewport.scrollTop < 1400, "the enlarged area starts below the actual sticky heading");
  document.dispatchEvent(new Event("mouseup"));
  assert.equal(f.frames.size, 0); assert.equal(document.listeners.size, 0); assert.equal(view.listeners.size, 0);
});
