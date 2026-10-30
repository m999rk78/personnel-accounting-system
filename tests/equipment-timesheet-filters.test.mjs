import assert from "node:assert/strict";
import test from "node:test";
import { equipmentTimesheetDayPresets, equipmentTimesheetFilterValue, matchesEquipmentTimesheetDayPreset } from "../app/equipmentTimesheetFilters.ts";

const day = (overrides = {}) => ({ productive: 0, downtime: 0, mismatch: false, ...overrides });

test("equipment day filters distinguish an empty day, manual zero, work and downtime values", () => {
  assert.equal(equipmentTimesheetFilterValue(undefined), null);
  assert.equal(equipmentTimesheetFilterValue(day()), null);
  assert.equal(equipmentTimesheetFilterValue(day({ mark: { note: "Явный ноль" } })), 0);
  assert.equal(equipmentTimesheetFilterValue(day({ productive: 8 })), 8);
  assert.equal(equipmentTimesheetFilterValue(day({ downtime: 2 })), "П 2");
  assert.equal(equipmentTimesheetFilterValue(day({ productive: 8, downtime: 2 })), "8/2", "mixed work/downtime must not collapse to a work-only number");
});

test("native state presets preserve manual and mismatch filtering when displayed hours are identical", () => {
  const cells = [
    undefined,
    day({ productive: 8 }),
    day({ productive: 8, mark: { id: 1 } }),
    day({ productive: 8, mark: { id: 2 }, mismatch: true }),
    day({ downtime: 8 }),
    day({ mark: { id: 3 } }),
  ];
  assert.deepEqual(cells.slice(1, 4).map(equipmentTimesheetFilterValue), [8, 8, 8]);
  const selected = preset => cells.flatMap((cell, index) => matchesEquipmentTimesheetDayPreset(preset, cell) ? [index] : []);
  assert.deepEqual(selected("filled"), [1, 2, 3, 4, 5]);
  assert.deepEqual(selected("empty"), [0]);
  assert.deepEqual(selected("productive"), [1, 2, 3]);
  assert.deepEqual(selected("downtime"), [4]);
  assert.deepEqual(selected("manual"), [2, 3, 5]);
  assert.deepEqual(selected("mismatch"), [3]);
  assert.deepEqual(selected("unknown"), []);
  const states = cells.map(cell => equipmentTimesheetDayPresets.filter(preset => matchesEquipmentTimesheetDayPreset(preset.value, cell)).map(preset => preset.value));
  assert.deepEqual(states[3], ["filled", "productive", "manual", "mismatch"]);
  assert.deepEqual(states[5], ["filled", "manual"], "a saved zero is a filled manual entry, not an empty day");
});

test("state presets allow OR selection without changing cell values or report metadata", () => {
  const cells = [day({ productive: 8 }), day({ downtime: 4 }), day({ mark: { note: "Исправлено" } }), day({ productive: 6, mark: {}, mismatch: true })];
  const original = structuredClone(cells);
  const selectedStates = new Set(["downtime", "manual"]);
  const matches = cells.filter(cell => equipmentTimesheetDayPresets.some(preset => selectedStates.has(preset.value) && matchesEquipmentTimesheetDayPreset(preset.value, cell)));
  assert.deepEqual(matches, cells.slice(1));
  assert.deepEqual(cells, original);
});
