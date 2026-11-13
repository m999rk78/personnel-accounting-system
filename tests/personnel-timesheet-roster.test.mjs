import assert from "node:assert/strict";
import test from "node:test";
import { resolvePersonnelTimesheetRoster } from "../app/personnelTimesheetRoster.ts";

const assignment = (startDate, endDate = null, active = true) => ({ startDate, endDate, active });
const period = (startDate, endDate) => ({ startDate, endDate });
const exit = (workDate, code = "УВ") => ({ workDate, code });
const roster = overrides => resolvePersonnelTimesheetRoster({
  month: "2026-11", currentMonth: "2026-11", assignments: [], reportDates: [], markDates: [], exits: [], ...overrides,
});

test("25 terminal marks leave all 50 rows in November and only 25 in December", () => {
  const employees = Array.from({ length: 50 }, (_, index) => ({
    assignments: [assignment("2026-10-01")],
    exits: index < 25 ? [exit("2026-11-20", index % 2 ? "ПЕ" : "УВ")] : [],
  }));
  const november = employees.map(employee => roster(employee));
  const december = employees.map(employee => roster({ ...employee, month: "2026-12" }));
  assert.equal(november.filter(row => row.included).length, 50);
  assert.equal(december.filter(row => row.included).length, 25);
  assert.deepEqual(november[0].periods, [period("2026-11-01", "2026-11-21")]);
  assert.equal(november[0].outsideDates[0], "2026-11-21");
  assert.deepEqual(november[0].conflictDates, []);
});

test("a dated assignment opens the row before its first report, from its start date only", () => {
  const row = roster({ assignments: [assignment("2026-11-12")] });
  assert.equal(row.included, true);
  assert.equal(row.reason, "assignment");
  assert.deepEqual(row.periods, [period("2026-11-12", "2026-12-01")]);
  assert.equal(row.outsideDates.length, 11);
  assert.equal(row.outsideDates.at(-1), "2026-11-11");
  assert.deepEqual(row.unknownDates, []);
  assert.equal(roster({ assignments: [assignment("2026-12-01")] }).included, false);
});

test("a return after the exit restores the period and keeps the gap outside", () => {
  const row = roster({
    assignments: [assignment("2026-11-20"), assignment("2026-11-03")],
    exits: [exit("2026-11-27", "ПЕ"), exit("2026-11-10")],
  });
  assert.deepEqual(row.periods, [period("2026-11-03", "2026-11-11"), period("2026-11-20", "2026-11-28")]);
  assert.equal(row.outsideDates.includes("2026-11-19"), true);
  assert.equal(row.outsideDates.includes("2026-11-20"), false);
  assert.equal(row.outsideDates.includes("2026-11-28"), true);
  assert.deepEqual(row.conflictDates, []);
});

test("reassignment on the exit date does not carry the employee beyond that day", () => {
  const employee = { assignments: [assignment("2026-10-01"), assignment("2026-11-20")], exits: [exit("2026-11-20")] };
  assert.deepEqual(roster(employee).periods, [period("2026-11-01", "2026-11-21")]);
  assert.equal(roster({ ...employee, month: "2026-12" }).included, false);
  assert.equal(roster({ ...employee, month: "2026-12", assignments: [...employee.assignments, assignment("2026-11-21")] }).included, true);
  assert.deepEqual(roster({ assignments: [assignment("2026-11-03")], exits: [exit("2026-10-18")] }).periods, [period("2026-11-03", "2026-12-01")]);
});

test("a dated closed assignment remains visible in history after its active flag is cleared", () => {
  const employee = { assignments: [assignment("2026-10-01", "2026-11-12", false)] };
  const closed = roster({ ...employee, exits: [exit("2026-11-12")], markDates: ["2026-11-12"] });
  assert.equal(closed.included, true);
  assert.deepEqual(closed.periods, [period("2026-11-01", "2026-11-12")]);
  assert.equal(closed.outsideDates[0], "2026-11-13");
  assert.deepEqual(closed.conflictDates, [], "The closing-day УВ is a valid record");
  assert.deepEqual(roster({ ...employee, reportDates: ["2026-11-12"], exits: [exit("2026-11-12")] }).conflictDates, ["2026-11-12"], "Work hours on the exclusive end date conflict");
  assert.equal(roster({ ...employee, month: "2026-12" }).included, false);
});

test("archived cards require facts from the selected month while closed assignments still cover their recorded days", () => {
  const assignments = [assignment("2026-10-19", "2026-11-02", false)];
  const archived = { employeeActive: false, assignments };
  const historicalPeriod = [period("2026-11-01", "2026-11-02")];
  const blank = roster({ ...archived, reportDates: ["2026-10-31"], markDates: ["2026-12-01"] });
  assert.equal(blank.included, false);
  assert.equal(blank.reason, "excluded");

  for (const facts of [{ reportDates: ["2026-11-01"] }, { markDates: ["2026-11-01"] }]) {
    const history = roster({ ...archived, ...facts });
    assert.equal(history.included, true);
    assert.equal(history.reason, "history");
    assert.deepEqual(history.periods, historicalPeriod);
    assert.equal(history.outsideDates[0], "2026-11-02");
    assert.deepEqual(history.conflictDates, []);
  }

  const formerProjectMember = roster({ employeeActive: true, assignments });
  assert.equal(formerProjectMember.included, true);
  assert.equal(formerProjectMember.reason, "assignment");
  assert.deepEqual(formerProjectMember.periods, historicalPeriod);
});

test("legacy open assignments support this month, while old months require facts and leave unrecorded dates unknown", () => {
  const employee = { assignments: [assignment(null)] };
  for (const month of ["2026-11", "2026-12"]) {
    const row = roster({ ...employee, month });
    assert.equal(row.reason, "assignment");
    assert.deepEqual(row.warnings, ["Не указана дата назначения"]);
    assert.deepEqual(row.outsideDates, []);
    assert.deepEqual(row.periods, [], "A missing start date must not become an invented first-of-month appointment");
    assert.equal(row.unknownDates[0], `${month}-01`);
  }
  assert.equal(roster({ ...employee, month: "2026-10" }).included, false);
  const history = roster({ ...employee, month: "2026-10", reportDates: ["2026-10-06"] });
  assert.equal(history.reason, "history");
  assert.equal(history.unknownDates.length, 30);
  assert.equal(history.unknownDates.includes("2026-10-06"), false);
  assert.deepEqual(history.periods, []);
  assert.deepEqual(history.outsideDates, []);
  assert.equal(roster({ ...employee, exits: [exit("2026-10-18")] }).included, false, "An undated assignment cannot prove return after the earlier exit");
});

test("closed undated and history-only rows retain unknown days before a known boundary", () => {
  const closed = roster({ assignments: [assignment(null, "2026-11-05", false)], markDates: ["2026-11-03"] });
  assert.equal(closed.reason, "assignment");
  assert.deepEqual(closed.periods, []);
  assert.deepEqual(closed.unknownDates, ["2026-11-01", "2026-11-02", "2026-11-04"]);
  assert.equal(closed.outsideDates[0], "2026-11-05");
  const history = roster({ reportDates: ["2026-11-01"], exits: [exit("2026-11-05")] });
  assert.equal(history.reason, "history");
  assert.deepEqual(history.unknownDates, ["2026-11-02", "2026-11-03", "2026-11-04"]);
  assert.equal(history.outsideDates[0], "2026-11-06");
  assert.deepEqual(history.conflictDates, []);
  assert.deepEqual(history.warnings, ["Период назначения не указан"]);
});

test("an undated project removal keeps its closing month editable without inferring earlier months", () => {
  const former = { assignments: [assignment(null, "2026-11-13", false)] };
  const closingMonth = roster({ ...former, currentMonth: "2026-12" });
  assert.equal(closingMonth.included, true);
  assert.equal(closingMonth.reason, "assignment");
  assert.deepEqual(closingMonth.periods, []);
  assert.equal(closingMonth.unknownDates.at(-1), "2026-11-12");
  assert.equal(roster({ ...former, month: "2026-10" }).included, false);
  assert.equal(roster({ ...former, month: "2026-12" }).included, false);
  assert.equal(roster({ ...former, employeeActive: false }).included, false);
  assert.equal(roster({ ...former, exits: [exit("2026-10-31", "ПЕ")] }).included, false);
});

test("a same-day or first-day project removal supplies a monthly row without a work period", () => {
  for (const [start, closedOn] of [["2026-11-13", "2026-11-13"], [null, "2026-11-01"]]) {
    const former = { assignments: [assignment(start, closedOn, false)] };
    const row = roster(former);
    assert.equal(row.included, true);
    assert.equal(row.reason, "assignment");
    assert.deepEqual(row.periods, []);
    assert.deepEqual(row.unknownDates, [closedOn], "Retain a boundary date for export without inferring a work period");
    assert.equal(roster({ ...former, month: "2026-12" }).included, false);
  }
  assert.equal(roster({ assignments: [assignment("2026-11-13", "2026-11-12", false)] }).included, false);
});

test("an inactive assignment without an end date needs a fact and warns about uncertain later days", () => {
  const employee = { assignments: [assignment("2026-11-12", null, false)] };
  assert.equal(roster(employee).included, false);
  const row = roster({ ...employee, reportDates: ["2026-11-14"] });
  assert.equal(row.reason, "history");
  assert.equal(row.outsideDates.at(-1), "2026-11-11");
  assert.equal(row.unknownDates[0], "2026-11-12");
  assert.equal(row.unknownDates.includes("2026-11-14"), false);
  assert.deepEqual(row.warnings, ["Не указана дата окончания назначения"]);
});

test("reports and manual marks outside an assignment remain facts but do not restore an expired period", () => {
  const employee = { assignments: [assignment("2026-10-01")], exits: [exit("2026-11-10")] };
  const november = roster({ ...employee, reportDates: ["2026-11-08", "2026-11-11"], markDates: ["2026-11-20"] });
  assert.deepEqual(november.periods, [period("2026-11-01", "2026-11-11")]);
  assert.deepEqual(november.conflictDates, ["2026-11-11", "2026-11-20"]);
  assert.ok(november.warnings.some(warning => warning.includes("вне периода назначения")));
  assert.equal(november.outsideDates.includes("2026-11-11"), false);
  assert.equal(november.outsideDates.includes("2026-11-12"), true);
  const december = roster({ ...employee, month: "2026-12", reportDates: ["2026-12-04"] });
  assert.equal(december.reason, "history");
  assert.deepEqual(december.periods, []);
  assert.deepEqual(december.conflictDates, ["2026-12-04"]);
  assert.equal(roster({ ...employee, month: "2027-01" }).included, false);
});

test("removing or replacing the terminal mark restores carryover without changing assignments", () => {
  const employee = { month: "2026-12", assignments: [assignment("2026-10-01")], markDates: ["2026-11-20"] };
  assert.equal(roster({ ...employee, exits: [exit("2026-11-20")] }).reason, "excluded");
  assert.equal(roster(employee).reason, "assignment");
  assert.equal(roster({ ...employee, exits: [exit("2026-11-20", "В")] }).reason, "assignment");
});

test("month boundaries handle leap days and the year change without future facts affecting older months", () => {
  const assignments = [assignment("2024-01-10")];
  assert.deepEqual(roster({ month: "2024-02", assignments, exits: [exit("2024-02-28")] }).outsideDates, ["2024-02-29"]);
  assert.deepEqual(roster({ month: "2024-02", assignments, exits: [exit("2024-02-29")] }).periods, [period("2024-02-01", "2024-03-01")]);
  const employee = { assignments: [assignment("2026-10-01")], exits: [exit("2026-12-31")] };
  assert.deepEqual(roster(employee).periods, [period("2026-11-01", "2026-12-01")]);
  assert.deepEqual(roster({ ...employee, month: "2026-12" }).periods, [period("2026-12-01", "2027-01-01")]);
  assert.equal(roster({ ...employee, month: "2027-01" }).included, false);
  assert.equal(roster({ reportDates: ["2026-10-31"], markDates: ["2026-12-01"], exits: [exit("2026-12-01")] }).included, false);
});
