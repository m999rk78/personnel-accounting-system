import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement, Fragment } from "react";
import ts from "typescript";
import { boundedTimesheetWidth, readTimesheetColumnWidths, timesheetColumnLayout, timesheetResizeReferenceWidth, timesheetSizingColumns } from "../app/timesheetColumnSizing.ts";
import { applyTimesheetColumnPins, canPinTimesheetColumn, getTimesheetColumnPin, readTimesheetColumnPins } from "../app/timesheetColumnPinning.ts";

// Execute the real resize hook and its rendered handlers. Only React's lifecycle,
// layout painting and browser storage are replaced; business data is absent.
const source = ts.createSourceFile("useTimesheetColumnResize.tsx", await readFile(new URL("../app/useTimesheetColumnResize.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const implementation = ts.transpileModule(source.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(source).replace(/^export\s+/, "")).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement", jsxFragmentFactory: "Fragment" },
}).outputText;

function harness(kind, { enabled = false, storage = new Map(), clientWidth = 800 } = {}) {
  const slots = [], frames = new Map(), writes = [], painted = new Map(), bodyClasses = new Set(), captures = new Set(), attributes = new Map(), effects = [], connectors = [], observers = new Set();
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  let cursor = 0, nextFrame = 0;
  const initialWidth = timesheetColumnLayout(timesheetSizingColumns(kind, 30), {}, 800).totalWidth;
  const contentWidth = () => parseFloat(painted.get("--timesheet-columns-width") ?? initialWidth);
  const table = { style: { setProperty: (name, value) => painted.set(name, value) }, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, right: contentWidth(), width: contentWidth(), top: 0, bottom: 400, height: 400 }),
  };
  let scrollLeft = 120;
  const viewport = {
    clientWidth,
    get scrollWidth() { return contentWidth(); },
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(value) { scrollLeft = Math.max(0, Math.min(value, this.scrollWidth - this.clientWidth)); },
    querySelector: () => table,
    getBoundingClientRect: () => ({ left: 0, right: viewport.clientWidth, width: viewport.clientWidth, top: 0, bottom: 400, height: 400 }),
  };
  const root = { current: viewport };
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const useRef = initial => { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; };
  const changed = (previous, next) => !previous || !next || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  const memo = (callback, dependencies) => {
    const index = cursor++;
    if (!slots[index] || changed(slots[index].dependencies, dependencies)) slots[index] = { value: callback(), dependencies };
    return slots[index].value;
  };
  const useLayoutEffect = (effect, dependencies) => {
    const index = cursor++;
    if (!slots[index] || changed(slots[index].dependencies, dependencies)) {
      const previous = slots[index];
      slots[index] = { dependencies };
      effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); slots[index].cleanup = cleanup; return cleanup; });
    }
  };
  const environment = {
    createElement, Fragment, useState, useRef, useMemo: memo, useCallback: (callback, dependencies) => memo(() => callback, dependencies), useLayoutEffect,
    connectTimesheetResizePointer: (root, options) => {
      const connection = { root, options, refreshes: 0, disposed: false };
      connectors.push(connection);
      return { refresh: () => connection.refreshes++, dispose: () => { connection.disposed = true; } };
    },
    boundedTimesheetWidth, readTimesheetColumnWidths, timesheetColumnLayout, timesheetResizeReferenceWidth, timesheetSizingColumns,
    applyTimesheetColumnPins, canPinTimesheetColumn, getTimesheetColumnPin, readTimesheetColumnPins,
    // The render helpers have separate React tests; these callbacks do not
    // participate in the hook's actual pin state or geometry calculation.
    arrangeTimesheetCells: children => children, arrangeTimesheetFooter: children => children, arrangeTimesheetHeaders: first => first,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); writes.push({ key, widths: JSON.parse(value) }); },
      removeItem: key => storage.delete(key),
    },
    document: { body: { classList: { add: name => bodyClasses.add(name), remove: name => bodyClasses.delete(name) } }, addEventListener() {}, removeEventListener() {} },
    window: { matchMedia: () => media, addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.add(this); } observe() {} disconnect() { observers.delete(this); } },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const hook = new Function(...Object.keys(environment), `${implementation}\nreturn useTimesheetColumnResize;`)(...Object.values(environment));
  const render = () => { cursor = 0; return hook(root, { kind, dayCount: 30, enabled }); };
  const target = {
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id), focus() {},
    closest: selector => selector === "th" ? { getBoundingClientRect: () => ({ left: 100, right: 200, width: 100, top: 0, bottom: 88, height: 88 }) } : null,
    getBoundingClientRect: () => ({ left: 196, right: 200, width: 4, top: 0, bottom: 88, height: 88 }),
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    getAttribute: name => attributes.get(name) ?? null,
  };
  const event = (overrides = {}) => ({ button: 0, pointerId: 3, clientX: 200, currentTarget: target, shiftKey: false,
    prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides });
  const leaves = element => !element ? [] : element.type === Fragment
    ? [element.props.children].flat(Infinity).flatMap(leaves) : [element];
  const grip = (id, view = render()) => leaves(view.handle(id, id))[0];
  const mountEffects = () => effects.splice(0).map(effect => effect()).filter(Boolean);
  const settle = () => {
    let view = render();
    for (let count = 0; effects.length && count < 10; count++) { mountEffects(); view = render(); }
    assert.equal(effects.length, 0, "The real hook's layout effects settle without a render loop");
    return view;
  };
  return { render, event, leaves, grip, writes, painted, bodyClasses, captures, attributes, target, viewport, connectors, storage, settle,
    resize: (width, showPosition = true) => { viewport.clientWidth = width; media.matches = showPosition; [...observers].forEach(observer => observer.callback()); },
    mountEffects,
    flush: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
  };
}

for (const kind of ["workers", "equipment"]) {
  test(`${kind}: narrowing the viewport releases effective pins, cancels an active resize, and restores preferences on widening`, () => {
    const totals = timesheetSizingColumns(kind, 30).slice(-3).map(column => column.id);
    const pins = Object.fromEntries([
      ...Array.from({ length: 15 }, (_, index) => [`day-${index + 1}`, "left"]),
      ...totals.map(id => [id, "right"]),
    ]);
    const pinKey = `resource-report.timesheet-column-pins.${kind}.v1`;
    const saved = JSON.stringify(pins);
    const ui = harness(kind, { enabled: true, clientWidth: 2000, storage: new Map([[pinKey, saved]]) });
    let view = ui.settle();
    const originalOrder = [...view.columnIds];
    assert.equal(view.pinning.getPin("day-15"), "left");
    assert.equal(view.pinning.getPin(totals.at(-1)), "right");
    const handle = ui.grip("day-1", view);
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 220 }));
    ui.flush();
    assert.equal(ui.captures.size, 1);

    for (const width of [800, 500]) {
      ui.resize(width, false);
      view = ui.settle();
      ui.flush();
      assert.equal(ui.captures.size, 0, "Viewport changes cancel capture before changing the column arrangement");
      assert.equal(ui.bodyClasses.size, 0);
      assert.equal(view.pinning.getPin("day-15"), null);
      assert.equal(view.pinning.canPin("day-15", "left"), false);
      const frozenWidth = parseFloat(view.tableStyle["--timesheet-left-sticky-width"]) + parseFloat(view.tableStyle["--timesheet-right-sticky-width"]);
      assert.ok(frozenWidth <= width - Math.min(120, Math.floor(width / 4)));
      assert.equal(ui.storage.get(pinKey), saved);
      assert.equal(ui.writes.length, 0, "Temporary release and cancelled resizing do not overwrite either saved preference");
    }
    ui.resize(2000, true);
    view = ui.settle();
    assert.deepEqual(view.columnIds, originalOrder);
    assert.equal(view.pinning.getPin("day-15"), "left");
    assert.equal(view.pinning.getPin(totals.at(-1)), "right");
    assert.equal(view.tableStyle["--timesheet-width-day-1"], "48px");
    assert.equal(ui.storage.get(pinKey), saved);
  });

  test(`${kind}: each visible column renders exactly one right-edge separator owned by itself`, () => {
    const ui = harness(kind), view = ui.render();
    const handles = view.columnIds.flatMap(id => ui.leaves(view.handle(id, id)));
    assert.equal(handles.length, view.columnIds.length, "An adjacent header must not add a second proxy for the same divider");
    assert.deepEqual(handles.map(handle => handle.props["data-column-id"]), view.columnIds);
    for (const handle of handles) {
      assert.equal(handle.type, "button");
      assert.equal(handle.props.role, "separator");
      assert.equal(handle.props["data-resize-edge"], "right");
      assert.equal(handle.props["data-resize-owner"], handle.props["data-column-id"]);
      assert.equal(handle.props.tabIndex, 0);
      assert.doesNotMatch(handle.props.className, /handle-left/);
    }
    assert.equal(view.handle("unknown", "Unknown"), null);
  });

  test(`${kind}: the right separator changes only its own width and persists on release`, () => {
    const ui = harness(kind), id = kind === "workers" ? "department" : "organization";
    const before = ui.render().tableStyle;
    const handle = ui.grip(id);
    handle.props.onPointerDown(ui.event());
    assert.equal(ui.captures.has(3), true);
    assert.equal(ui.bodyClasses.has("timesheet-column-resizing"), true);
    handle.props.onPointerMove(ui.event({ clientX: 240 })); ui.flush();
    assert.equal(ui.writes.length, 0, "Live dragging does not write browser preferences on every move");
    handle.props.onPointerUp(ui.event({ clientX: 240 }));
    const next = ui.render().tableStyle;
    assert.equal(ui.viewport.scrollLeft, 120, "Resizing an ordinary column does not jump horizontal scroll to the end");
    assert.equal(parseFloat(next[`--timesheet-width-${id}`]) - parseFloat(before[`--timesheet-width-${id}`]), 40);
    for (const column of timesheetSizingColumns(kind, 30).filter(column => column.id !== id)) {
      assert.equal(next[`--timesheet-width-${column.id}`], before[`--timesheet-width-${column.id}`]);
    }
    assert.deepEqual(ui.writes.at(-1), { key: `resource-report.timesheet-column-widths.${kind}.v1`, widths: { [id]: parseFloat(next[`--timesheet-width-${id}`]) } });
    assert.equal(ui.captures.size, 0); assert.equal(ui.bodyClasses.size, 0);
  });

  test(`${kind}: cancellation restores the previous width and keyboard/reset still use the same separator`, () => {
    const ui = harness(kind), id = kind === "workers" ? "timesheet" : "productive";
    const before = ui.render().tableStyle[`--timesheet-width-${id}`], handle = ui.grip(id);
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 260 })); ui.flush();
    handle.props.onPointerCancel(ui.event());
    assert.equal(ui.render().tableStyle[`--timesheet-width-${id}`], before);
    assert.equal(ui.writes.length, 0); assert.equal(ui.captures.size, 0);
    ui.grip(id).props.onKeyDown(ui.event({ key: "ArrowRight" }));
    assert.equal(parseFloat(ui.render().tableStyle[`--timesheet-width-${id}`]), parseFloat(before) + 8);
    ui.grip(id).props.onDoubleClick(ui.event());
    assert.equal(ui.render().tableStyle[`--timesheet-width-${id}`], before);
    assert.equal(ui.writes.length, 2, "Keyboard and double-click changes are committed once each");
  });

  test(`${kind}: a pointer must be on the actual header edge before resize can capture it`, () => {
    const ui = harness(kind), handle = ui.grip(kind === "workers" ? "employmentType" : "equipment");
    for (const clientX of [180, 185, 190, 194, 196, 204, 206, 220]) {
      const event = ui.event({ clientX });
      handle.props.onPointerDown(event);
      assert.equal(ui.captures.size, 0, `${clientX}: header text/filter space is not a resize hotspot`);
      assert.equal(ui.bodyClasses.size, 0);
      assert.equal(event.prevented, false, "Ordinary header interaction remains available");
    }
    handle.props.onPointerDown(ui.event({ clientX: 198 }));
    assert.equal(ui.captures.has(3), true, "A two-pixel deviation from the divider is accepted");
    handle.props.onPointerCancel(ui.event());
  });

  test(`${kind}: delegated native pointer capture can start resizing from either side of a real divider`, () => {
    const ui = harness(kind, { enabled: true }), id = kind === "workers" ? "employmentType" : "equipment";
    const view = ui.render(), handle = ui.grip(id, view);
    const cleanups = ui.mountEffects();
    assert.equal(ui.connectors.length, 1);
    const connection = ui.connectors[0];
    assert.equal(connection.root, ui.viewport);
    assert.equal(connection.options.isDragging(), false);
    assert.ok(connection.refreshes > 0, "Painting the column plan refreshes the root's measured divider positions");
    const before = parseFloat(ui.render().tableStyle[`--timesheet-width-${id}`]);
    for (const clientX of [197, 203]) {
      const event = ui.event({ clientX, currentTarget: ui.viewport, target: { tagName: "SPAN", textContent: "Neighbouring header" } });
      connection.options.start(id, event, ui.target);
      assert.equal(connection.options.isDragging(), true, "The start callback uses the resolved owning handle, not event.currentTarget");
      assert.equal(ui.captures.has(3), true);
      handle.props.onPointerMove(ui.event({ clientX: clientX + 10 })); ui.flush();
      assert.equal(parseFloat(ui.painted.get(`--timesheet-width-${id}`)), before + 10);
      handle.props.onPointerCancel(ui.event());
      assert.equal(connection.options.isDragging(), false);
      assert.equal(ui.render().tableStyle[`--timesheet-width-${id}`], `${before}px`);
    }
    assert.equal(ui.writes.length, 0);
    cleanups.forEach(cleanup => cleanup());
    assert.equal(connection.disposed, true, "Unmount removes the native root pointer listeners");
  });

  test(`${kind}: pointer focus does not leave a keyboard highlight behind; keyboard input and blur clear the marker`, () => {
    const ui = harness(kind), handle = ui.grip(kind === "workers" ? "department" : "organization");
    handle.props.onPointerDown(ui.event());
    assert.equal(ui.target.getAttribute("data-resize-input"), "pointer");
    handle.props.onPointerUp(ui.event());
    handle.props.onKeyDown(ui.event({ key: "ArrowRight" }));
    assert.equal(ui.target.getAttribute("data-resize-input"), null, "A real keyboard action regains its visible focus line");
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerUp(ui.event());
    handle.props.onBlur(ui.event());
    assert.equal(ui.target.getAttribute("data-resize-input"), null, "Tabbing away and back cannot retain stale pointer modality");
  });

  test(`${kind}: growing the last column extends the table and follows its right edge without double-counting scroll`, () => {
    const ui = harness(kind), id = kind === "workers" ? "difference" : "total", handle = ui.grip(id);
    const baseline = ui.render().tableStyle;
    const initialWidth = parseFloat(baseline[`--timesheet-width-${id}`]);
    const tableWidth = parseFloat(baseline["--timesheet-columns-width"]);
    ui.viewport.scrollLeft = ui.viewport.scrollWidth - ui.viewport.clientWidth;
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 240 })); ui.flush();
    assert.equal(parseFloat(ui.painted.get(`--timesheet-width-${id}`)), initialWidth + 40);
    assert.equal(parseFloat(ui.painted.get("--timesheet-columns-width")), tableWidth + 40);
    assert.equal(ui.viewport.scrollLeft, ui.viewport.scrollWidth - ui.viewport.clientWidth, "The new right edge remains reachable while dragging");
    handle.props.onPointerMove(ui.event({ clientX: 241 })); ui.flush();
    assert.equal(parseFloat(ui.painted.get(`--timesheet-width-${id}`)), initialWidth + 41,
      "A further one-pixel pointer move does not add the scrolling surplus again");
    assert.equal(ui.viewport.scrollLeft, ui.viewport.scrollWidth - ui.viewport.clientWidth);
    handle.props.onPointerUp(ui.event({ clientX: 241 }));
    for (const column of timesheetSizingColumns(kind, 30).filter(column => column.id !== id)) {
      assert.equal(ui.render().tableStyle[`--timesheet-width-${column.id}`], baseline[`--timesheet-width-${column.id}`]);
    }
    assert.equal(ui.writes.at(-1).widths[id], initialWidth + 41);
  });

  test(`${kind}: cancelling a last-column resize restores both the width and the original horizontal position`, () => {
    const ui = harness(kind), id = kind === "workers" ? "difference" : "total", handle = ui.grip(id);
    const baseline = ui.render().tableStyle;
    ui.viewport.scrollLeft = 75;
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 240 })); ui.flush();
    assert.notEqual(ui.viewport.scrollLeft, 75, "Live growth reveals the right edge");
    handle.props.onPointerCancel(ui.event());
    assert.equal(ui.render().tableStyle[`--timesheet-width-${id}`], baseline[`--timesheet-width-${id}`]);
    assert.equal(ui.viewport.scrollLeft, 75, "Cancellation restores where the user was before dragging");
    assert.equal(ui.writes.length, 0);
  });

  test(`${kind}: releasing before the queued paint still reveals and saves the final column`, () => {
    const ui = harness(kind), id = kind === "workers" ? "difference" : "total", handle = ui.grip(id);
    const initialWidth = parseFloat(ui.render().tableStyle[`--timesheet-width-${id}`]);
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 230 }));
    handle.props.onPointerUp(ui.event({ clientX: 230 }));
    assert.equal(parseFloat(ui.painted.get(`--timesheet-width-${id}`)), initialWidth + 30);
    assert.equal(ui.viewport.scrollLeft, ui.viewport.scrollWidth - ui.viewport.clientWidth);
    assert.equal(ui.writes.at(-1).widths[id], initialWidth + 30);
    ui.flush();
    assert.equal(ui.viewport.scrollLeft, ui.viewport.scrollWidth - ui.viewport.clientWidth,
      "A canceled stale animation frame cannot move the newly exposed border back");
  });

  test(`${kind}: saved pins restore real column order and both side offsets without replacing saved widths`, () => {
    const identity = kind === "workers" ? "fullName" : "equipment";
    const total = kind === "workers" ? "reports" : "downtime";
    const pinKey = `resource-report.timesheet-column-pins.${kind}.v1`;
    const widthKey = `resource-report.timesheet-column-widths.${kind}.v1`;
    const storage = new Map([
      [pinKey, JSON.stringify({ [identity]: null, "day-6": "left", [total]: "right" })],
      [widthKey, JSON.stringify({ "day-6": 72, [total]: 160 })],
    ]);
    const ui = harness(kind, { enabled: true, storage }), view = ui.settle();
    assert.equal(view.pinning.getPin(identity), null);
    assert.equal(view.pinning.getPin("day-6"), "left");
    assert.equal(view.pinning.getPin(total), "right");
    assert.ok(view.columnIds.indexOf("day-6") < view.columnIds.indexOf(identity), "Pinned date moves before the unpinned identity column");
    assert.equal(view.columnIds.at(-1), total);
    assert.equal(view.tableStyle[`--timesheet-width-${total}`], "160px");
    assert.equal(view.tableStyle[`--timesheet-right-${total}`], "0px");
    assert.equal(ui.painted.get(`--timesheet-right-${total}`), "0px", "The current plan is painted, not only returned by React");
    assert.equal(ui.painted.get("--timesheet-width-day-6"), "72px");
    assert.ok(parseFloat(ui.painted.get("--timesheet-left-day-6")) > 0);
    assert.equal(ui.writes.length, 0, "Restoring preferences does not overwrite browser storage");
  });

  test(`${kind}: pinning commits an active resize and reset restores default pins while retaining widths`, () => {
    const total = kind === "workers" ? "reports" : "downtime";
    const pinKey = `resource-report.timesheet-column-pins.${kind}.v1`;
    const widthKey = `resource-report.timesheet-column-widths.${kind}.v1`;
    const ui = harness(kind, { enabled: true });
    let view = ui.settle();
    const before = parseFloat(view.tableStyle[`--timesheet-width-${total}`]);
    const handle = ui.grip(total, view);
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 220 })); ui.flush();
    view.pinning.setPin(total, "right");
    view = ui.settle();
    assert.equal(ui.captures.size, 0);
    assert.equal(ui.bodyClasses.has("timesheet-column-resizing"), false);
    assert.equal(view.pinning.getPin(total), "right");
    assert.equal(view.columnIds.at(-1), total);
    assert.equal(JSON.parse(ui.storage.get(widthKey))[total], before + 20, "A pin action cannot lose the active resize");
    assert.deepEqual(JSON.parse(ui.storage.get(pinKey)), { [total]: "right" });
    const reloaded = harness(kind, { enabled: true, storage: ui.storage }).settle();
    assert.equal(reloaded.pinning.getPin(total), "right");
    assert.equal(reloaded.tableStyle[`--timesheet-width-${total}`], `${before + 20}px`);
    view.pinning.resetPins();
    view = ui.settle();
    assert.deepEqual(view.columnIds, timesheetSizingColumns(kind, 30).map(column => column.id));
    assert.equal(view.pinning.getPin(total), null);
    assert.equal(view.pinning.getPin("number"), "left");
    assert.equal(ui.storage.has(pinKey), false);
    assert.equal(JSON.parse(ui.storage.get(widthKey))[total], before + 20);
    assert.equal(view.tableStyle[`--timesheet-width-${total}`], `${before + 20}px`);
  });

  test(`${kind}: resize uses the current pin geometry and pin actions reject unknown or overfull columns`, () => {
    const ui = harness(kind, { enabled: true, clientWidth: kind === "workers" ? 500 : 430 });
    let view = ui.settle();
    assert.equal(view.pinning.canPin("day-6", "left"), false);
    const writes = ui.writes.length;
    view.pinning.setPin("day-6", "left");
    view.pinning.setPin("missing", "right");
    view = ui.settle();
    assert.equal(view.pinning.getPin("day-6"), null);
    assert.equal(ui.writes.length, writes, "A rejected action cannot persist a layout that hides all scrolling days");
    const identity = kind === "workers" ? "fullName" : "equipment";
    view.pinning.setPin(identity, null);
    view = ui.settle();
    assert.equal(view.pinning.canPin("day-6", "left"), true, "Unpinning metadata frees room for the selected date");
    view.pinning.setPin("day-6", "left");
    view = ui.settle();
    const before = parseFloat(view.tableStyle["--timesheet-width-day-6"]);
    const handle = ui.grip("day-6", view);
    handle.props.onPointerDown(ui.event());
    handle.props.onPointerMove(ui.event({ clientX: 214 }));
    handle.props.onPointerUp(ui.event({ clientX: 214 }));
    view = ui.settle();
    assert.equal(view.pinning.getPin("day-6"), "left");
    assert.equal(parseFloat(view.tableStyle["--timesheet-width-day-6"]), before + 14);
    assert.equal(parseFloat(ui.painted.get("--timesheet-width-day-6")), before + 14);
    assert.ok(view.columnIds.indexOf("day-6") < view.columnIds.indexOf(identity));
  });
}
