import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceLocation, workspaceUrl } from "../app/appRoutes.ts";
import { isStatisticsPersonnel, reportRowMatchesSource } from "../app/reportSourceFilter.ts";

test("statistics source links preserve day, zone, unassigned zone and all-time filters on reload", () => {
  for (const view of ["placement", "equipment"]) {
    for (const source of [{ from: "2026-11-03", to: "2026-11-03" }, { from: "2026-11-01", to: "2026-11-18", zoneId: 9 }, { zoneId: null }, {}]) {
      const url = new URL(workspaceUrl(view, "all", "2026-11-03", "2026-11", null, null, source), "http://localhost");
      assert.deepEqual(parseWorkspaceLocation(url.pathname, url.search, "2026-11-18").reportSource, source);
    }
  }
  assert.equal(parseWorkspaceLocation("/timesheets/workers", "?source=statistics&zoneId=9", "2026-11-18").reportSource, undefined);
  assert.ok(!workspaceUrl("employees", "all", "2026-11-18", "2026-11", null, null, { zoneId: 9 }).includes("source="));
});

test("invalid source dates and zone identities never produce partial report scopes", () => {
  for (const query of ["from=2026-11-31&to=2026-12-01", "from=2026-11-03", "from=2026-11-18&to=2026-11-01", "zoneId=", "zoneId=-1", "zoneId=1.5", "zoneId=9007199254740992", "zoneId=NaN"]) {
    assert.equal(parseWorkspaceLocation("/reports/workers", `?source=statistics&${query}`, "2026-11-18").reportSource, undefined, query);
  }
});

test("report source scope includes both date boundaries and matches saved and editable zones", () => {
  const source = { from: "2026-11-02", to: "2026-11-03", zoneId: 9 };
  const row = { workDate: "2026-11-02", entry: { zoneId: 9 } };
  assert.equal(reportRowMatchesSource(row, source), true);
  assert.equal(reportRowMatchesSource({ ...row, workDate: "2026-11-03" }, source), true);
  for (const workDate of ["2026-11-01", "2026-11-04"]) assert.equal(reportRowMatchesSource({ ...row, workDate }, source), false);
  assert.equal(reportRowMatchesSource({ ...row, draft: { zoneId: "10" } }, source), false);
  assert.equal(reportRowMatchesSource({ ...row, draft: { zoneId: "9" } }, source), true);
  assert.equal(reportRowMatchesSource({ ...row, entry: { zoneId: null } }, { zoneId: null }), true);
  assert.equal(reportRowMatchesSource({ ...row, entry: { zoneId: 0 } }, { zoneId: null }), true);
  assert.equal(reportRowMatchesSource({ ...row, draft: { zoneId: "" } }, { zoneId: null }), true);
  assert.equal(reportRowMatchesSource(row, undefined), true);
});

test("personnel source reports use the same OPR scope as statistics", () => {
  for (const value of ["ОПР", " опр "]) assert.equal(isStatisticsPersonnel(value), true);
  for (const value of ["ИТР", "АУП", "", undefined]) assert.equal(isStatisticsPersonnel(value), false);
});
