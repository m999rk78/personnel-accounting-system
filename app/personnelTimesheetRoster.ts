import { calendarMonthDays, shiftCalendarDate, shiftCalendarMonth } from "./reportDateCalendar.ts";

type Period = { startDate: string; endDate: string };
export type PersonnelTimesheetAssignment = { startDate: string | null; endDate: string | null; active: boolean };
type Exit = { workDate: string; code: string };

export type PersonnelTimesheetRoster = {
  included: boolean;
  periods: Period[];
  outsideDates: string[];
  unknownDates: string[];
  conflictDates: string[];
  warnings: string[];
  reason: "assignment" | "history" | "excluded";
};

type RosterInput = {
  month: string;
  currentMonth: string;
  employeeActive?: boolean;
  assignments: readonly PersonnelTimesheetAssignment[];
  reportDates: readonly string[];
  markDates: readonly string[];
  exits: readonly Exit[];
};

function covers(periods: readonly Period[], date: string) {
  return periods.some(period => period.startDate <= date && date < period.endDate);
}

function mergePeriods(periods: Period[]) {
  const merged: Period[] = [];
  for (const period of periods.sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const last = merged.at(-1);
    if (!last || period.startDate > last.endDate) merged.push({ ...period });
    else if (period.endDate > last.endDate) last.endDate = period.endDate;
  }
  return merged;
}

/** Inputs describe one employee on one project. Period ends are exclusive. */
export function resolvePersonnelTimesheetRoster(input: RosterInput): PersonnelTimesheetRoster {
  const { month, currentMonth, assignments, reportDates, markDates, exits } = input;
  const monthStart = `${month}-01`;
  const monthEnd = shiftCalendarMonth(monthStart, 1);
  if (!monthEnd) throw new RangeError("Некорректный месяц табеля.");

  const belongsToMonth = (date: string) => monthStart <= date && date < monthEnd;
  const exitDates = [...new Set(exits.filter(exit => (exit.code === "УВ" || exit.code === "ПЕ") && exit.workDate < monthEnd)
    .map(exit => exit.workDate))].sort();
  const exitDateSet = new Set(exitDates);
  const reportDays = new Set(reportDates.filter(belongsToMonth));
  const factDays = new Set([...reportDays, ...markDates.filter(belongsToMonth), ...exitDates.filter(belongsToMonth)]);
  const closingDays = new Set(assignments.map(assignment => assignment.endDate));
  const assignmentPeriods: Period[] = [];
  const uncertainPeriods: Period[] = [];
  const assignmentBoundaryDays = new Set<string>();
  let missingStart = false;
  let missingEnd = false;
  let hasAssignmentWithoutPeriod = false;

  for (const assignment of assignments) {
    const startDate = assignment.startDate && assignment.startDate > monthStart ? assignment.startDate : monthStart;
    const exitDate = exitDates.find(date => !assignment.startDate || date >= assignment.startDate);
    // A transfer or dismissal mark is valid on its own day. Only a later
    // dated assignment can restore participation after that day.
    const exitEnd = exitDate ? shiftCalendarDate(exitDate, 1) : null;
    let endDate = assignment.endDate && assignment.endDate < monthEnd ? assignment.endDate : monthEnd;
    if (exitEnd && exitEnd < endDate) endDate = exitEnd;
    // Removal can be the only dated evidence for legacy membership or for an
    // assignment opened and closed on the same day. Retain its monthly row.
    const closedOn = assignment.endDate;
    if (closedOn && belongsToMonth(closedOn) && (!exitDate || belongsToMonth(exitDate))
      && (!assignment.startDate || assignment.startDate === closedOn)) {
      hasAssignmentWithoutPeriod = true;
      if (!assignment.startDate) missingStart = true;
      if (startDate >= endDate && (!exitDate || closedOn <= exitDate)) assignmentBoundaryDays.add(closedOn);
    }
    if (startDate >= endDate) continue;

    const period = { startDate, endDate };
    if (!assignment.startDate) missingStart = true;
    if (assignment.startDate && !assignment.endDate && !assignment.active) missingEnd = true;
    const datedAssignment = Boolean(assignment.startDate && (assignment.endDate || assignment.active));
    const undatedCurrentAssignment = !assignment.startDate && !assignment.endDate && assignment.active && month >= currentMonth;
    if (datedAssignment) assignmentPeriods.push(period);
    else {
      uncertainPeriods.push(period);
      if (undatedCurrentAssignment) hasAssignmentWithoutPeriod = true;
    }
  }

  const periods = mergePeriods(assignmentPeriods);
  const outsideDates: string[] = [];
  const unknownDates: string[] = [];
  const conflictDates: string[] = [];
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = calendarMonthDays(year, monthNumber);
  const firstExit = exitDates[0];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    if (covers(periods, date)) continue;
    const unknown = assignmentBoundaryDays.has(date) || covers(uncertainPeriods, date) || (!assignments.length && (!firstExit || date <= firstExit));
    if (factDays.has(date)) {
      const closingMark = closingDays.has(date) && exitDateSet.has(date) && !reportDays.has(date);
      if (!unknown && !closingMark) conflictDates.push(date);
    } else if (unknown) unknownDates.push(date);
    else outsideDates.push(date);
  }

  // An archived directory card must not recreate a blank row from an old
  // assignment. Its saved reports/marks still retain the historical row and
  // the recorded assignment periods, independently of the current status.
  const hasAssignment = input.employeeActive !== false && (periods.length > 0 || hasAssignmentWithoutPeriod);
  const included = hasAssignment || factDays.size > 0;
  const warnings: string[] = [];
  if (included && !assignments.length) warnings.push("Период назначения не указан");
  if (included && missingStart) warnings.push("Не указана дата назначения");
  if (included && missingEnd) warnings.push("Не указана дата окончания назначения");
  if (conflictDates.length) warnings.push("Есть отчёты или отметки вне периода назначения на объект");
  const reason = hasAssignment ? "assignment" : factDays.size > 0 ? "history" : "excluded";
  return { included, periods, outsideDates, unknownDates, conflictDates, warnings, reason };
}
