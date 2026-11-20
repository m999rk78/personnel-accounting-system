import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { formatTimesheetHours } from "../app/timesheetFormatting.ts";

const path = "../app/StatisticsChart.tsx";
const source = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let optionsExpression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "options") optionsExpression = node.initializer.getText(source);
  if (!optionsExpression) ts.forEachChild(node, visit);
}
visit(source);
assert.ok(optionsExpression);

function optionsFor(row, series, byDay = false) {
  const calls = [];
  const datum = { ...row, category: byDay ? row.workDate : String(row.zoneId), label: byDay ? "20.11.2026" : row.zone, source: row };
  const environment = {
    container: { current: {} }, data: [datum], series, byDay, maxHours: row.total,
    labels: new Map([[datum.category, datum.label]]), fontFamily: "Inter", labelRotation: 0, barWidth: 32,
    activeDatum: { current: null }, formatTimesheetHours,
    chartTooltip: (...args) => { calls.push(args); return "tooltip"; },
  };
  const compiled = ts.transpileModule(`return (${optionsExpression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const options = new Function(...Object.keys(environment), compiled)(...Object.values(environment));
  return { options, calls, datum };
}

const personnel = [
  { key: "welders", name: "Сварщики", color: "#285fc2" },
  { key: "installers", name: "Монтажники", color: "#bf4946" },
  { key: "other", name: "Прочие сотрудники", color: "#6b7280" },
];
const hours = { welders: 12.5, installers: 8, other: 0, productive: 0, downtime: 0, total: 20.5 };

test("chart highlight uses the same exact hit test as each bar tooltip", () => {
  const { options } = optionsFor({ zoneId: 1, zone: "Зона А", ...hours }, personnel);
  assert.deepEqual(options.highlight, { range: "tooltip", mode: "single" });
  assert.equal(options.tooltip.range, "exact");
  assert.equal(options.tooltip.mode, "single");
  for (const series of options.series) {
    assert.equal(series.nodeClickRange, "exact");
    assert.equal(series.tooltip.range, "exact");
  }
});

for (const byDay of [false, true]) {
  test(`personnel ${byDay ? "day" : "zone"} tooltip carries report headcounts and the distinct total`, () => {
    const row = { ...(byDay ? { workDate: "2026-11-20" } : { zoneId: 1, zone: "<Зона А>" }), ...hours,
      personnelCounts: { welders: 2, installers: 2, other: 0, total: 3 } };
    const { options, datum, calls } = optionsFor(row, personnel, byDay);
    assert.equal(options.series[0].tooltip.renderer({ datum }), "tooltip");
    const [category, seriesId, label, values] = calls[0];
    assert.equal(category, datum.category);
    assert.equal(seriesId, "welders");
    assert.equal(label, datum.label);
    assert.deepEqual(values.map(value => value.people), [2, 2, 0, 3]);
    assert.deepEqual(values.map(value => value.value), ["12,5 ч", "8 ч", "0 ч", "20,5 ч"]);
    assert.equal(values.at(-1).label, byDay ? "Всего за день" : "Всего по зоне");
    assert.equal(values.at(-1).total, true);
  });
}

test("legacy personnel and equipment tooltips retain hours without inventing employee counts", () => {
  for (const series of [personnel, [{ key: "productive", name: "Работа", color: "#26734d" }, { key: "downtime", name: "Простой", color: "#a56a15" }]]) {
    const { options, datum, calls } = optionsFor({ zoneId: 1, zone: "Зона А", ...hours }, series);
    options.series[0].tooltip.renderer({ datum });
    assert.equal(calls[0][3].some(value => value.people !== undefined), false);
    assert.equal(calls[0][3].at(-1).value, "20,5 ч");
  }
});
