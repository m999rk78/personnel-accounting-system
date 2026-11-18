import assert from "node:assert/strict";
import test from "node:test";
import { formatStatisticsDate, parseStatisticsDate, statisticsPeriodQuery, statisticsPresetRange, validateStatisticsRange } from "../app/statisticsPeriod.ts";

test("statistics presets use Monday and the current project date, with complete previous months", () => {
  assert.deepEqual(statisticsPresetRange("week", "2026-11-01"), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(statisticsPresetRange("week", "2026-11-02"), { from: "2026-11-02", to: "2026-11-02" });
  assert.deepEqual(statisticsPresetRange("week", "2026-01-01"), { from: "2025-12-29", to: "2026-01-01" });
  assert.deepEqual(statisticsPresetRange("month", "2026-11-17"), { from: "2026-11-01", to: "2026-11-17" });
  assert.deepEqual(statisticsPresetRange("previousMonth", "2026-01-01"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(statisticsPresetRange("previousMonth", "2024-03-05"), { from: "2024-02-01", to: "2024-02-29" });
});

test("custom dates are displayed in Russian format and accept typing and pasting", () => {
  assert.equal(formatStatisticsDate("2024-02-09"), "09.02.2024");
  for (const value of ["09.02.2024", "9.2.2024", "09022024", " 2024-02-09 "]) assert.equal(parseStatisticsDate(value), "2024-02-09");
  for (const value of ["", "02", "29.02.2026", "31.04.2026", "2026-04-31", "01.01.0000"]) assert.equal(parseStatisticsDate(value), null);
});

test("custom dates validate ordering and the inclusive server limit", () => {
  assert.deepEqual(validateStatisticsRange({ from: "01.01.2024", to: "31.12.2024" }), { range: { from: "2024-01-01", to: "2024-12-31" } });
  assert.match(validateStatisticsRange({ from: "01.01.2024", to: "01.01.2025" }).error, /366 дней/);
  assert.match(validateStatisticsRange({ from: "02.01.2025", to: "01.01.2025" }).error, /не раньше/);
  assert.match(validateStatisticsRange({ from: "", to: "01.01.2025" }).error, /формате/);
  assert.deepEqual(statisticsPeriodQuery({ preset: "all" }), { period: "all" });
  assert.deepEqual(statisticsPeriodQuery({ preset: "custom", range: { from: "2025-01-01", to: "2025-02-01" } }), { from: "2025-01-01", to: "2025-02-01" });
});
