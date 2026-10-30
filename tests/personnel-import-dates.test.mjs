import assert from "node:assert/strict";
import test from "node:test";
import { parsePersonnelImportDate as parse } from "../app/personnelImportDates.ts";

test("native Excel dates preserve each day of the October 26–28 import", () => {
  assert.deepEqual([46321, "46322", 46323].map(value => parse(value)), ["2026-10-26", "2026-10-27", "2026-10-28"]);
  assert.equal(parse("46323.99999"), "2026-10-28");
  assert.equal(parse("4.6323e4"), "2026-10-28");
});

test("1900 and 1904 workbook epochs use their actual serial rules", () => {
  assert.equal(parse(1), "1900-01-01");
  assert.equal(parse(59), "1900-02-28");
  assert.equal(parse(61), "1900-03-01");
  assert.throws(() => parse(60), /29\.02\.1900/);
  assert.throws(() => parse(60.75), /29\.02\.1900/);
  assert.equal(parse(0, { date1904: true }), "1904-01-01");
  assert.equal(parse(44861, { date1904: true }), "2026-10-28");
});

test("ISO timestamps retain the workbook's calendar day across timezone boundaries", () => {
  assert.equal(parse("2026-10-26"), "2026-10-26");
  assert.equal(parse("2026-10-26T00:30:00+14:00"), "2026-10-26");
  assert.equal(parse("2026-10-28T23:30:00-12:00"), "2026-10-28");
  assert.equal(parse("2026-10-27T12:00:00.123Z"), "2026-10-27");
  assert.equal(parse("2026-10-28 09:15"), "2026-10-28");
});

test("Russian and slash dates always use day-month-year with strict calendar validation", () => {
  assert.equal(parse("26.10.2026"), "2026-10-26");
  assert.equal(parse("27/10/2026"), "2026-10-27");
  assert.equal(parse("3/4/2026"), "2026-04-03");
  assert.equal(parse("29.02.2000"), "2000-02-29");
  assert.equal(parse("2024-02-29"), "2024-02-29");
  for (const value of ["31.02.2026", "2026-02-29", "29/02/1900", "29.02.2100", "31.04.2026", "10/28/2026", "2026-00-15", "2026-10-00"]) assert.throws(() => parse(value), /календарная дата/, value);
});

test("missing, malformed and out-of-range dates fail instead of falling back to today", () => {
  for (const value of ["", "   "]) assert.throws(() => parse(value), /Не заполнена дата/);
  for (const value of ["2026/10/28", "28-10-2026", "28.10.26", "сегодня", "2026-10-28oops", "2026-10-28T25:00", "2026-10-28T12:60", "2026-10-28T12:00:60"]) assert.throws(() => parse(value), /дат|время/, value);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e100, 2958466]) assert.throws(() => parse(value), /дат|календар/, String(value));
});
