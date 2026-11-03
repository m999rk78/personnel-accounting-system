type DepartmentRow = { employmentType: string; department: string; timesheetOrder?: number | null };

// Department sequence from the supplied November 2026 timesheet, sheet «Табель ЮМС».
// Types are part of the key: for example, АУП/ОК and ИТР/ОК are separate groups.
export const personnelTimesheetDepartments = [
  ["АУП", "Дирекция"],
  ["АУП", "УП"],
  ["АУП", "ОК"],
  ["ИТР", "ПТО"],
  ["ИТР", "ЛНК"],
  ["ИТР", "МУ"],
  ["ИТР", "ОГС"],
  ["ИТР", "ОК"],
  ["ИТР", "МУТТ"],
  ["ИТР", "МУСК"],
  ["ИТР", "СИГ"],
  ["ИТР", "ОГЭ"],
  ["ИТР", "ЭМУ"],
  ["ВСП", "АХО"],
  ["ВСП", "МТО"],
  ["МЕХ", "ОГМ"],
  ["ИТР", "ОТПБ"],
  ["ОПР", "МУСК"],
  ["ОПР", "МУТТ"],
  ["ОПР", "МУВСП"],
  ["ОПР", "МУСЛП"],
] as const;

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleUpperCase("ru-RU").replaceAll("Ё", "Е");
const departmentKey = (row: DepartmentRow) => `${normalize(row.employmentType)}\u0000${normalize(row.department)}`;
const departmentRanks = new Map(personnelTimesheetDepartments.map(([employmentType, department], index) => [departmentKey({ employmentType, department }), index]));

export function personnelTimesheetReferenceKey(employee: DepartmentRow & { fullName: string }) {
  return `${departmentKey(employee)}\u0000${normalize(employee.fullName)}`;
}

const employeeRank = (row: DepartmentRow) => typeof row.timesheetOrder === "number" && Number.isSafeInteger(row.timesheetOrder) && row.timesheetOrder >= 0 ? row.timesheetOrder : Infinity;

/** Reference employees come first in each department; new employees retain their incoming order. */
export function orderPersonnelTimesheetEmployees<T extends DepartmentRow>(employees: readonly T[]): T[] {
  const ranks = new Map(departmentRanks);
  for (const employee of employees) {
    const key = departmentKey(employee);
    if (!ranks.has(key)) ranks.set(key, ranks.size);
  }
  return employees.map((employee, index) => ({ employee, index, rank: ranks.get(departmentKey(employee))!, employeeRank: employeeRank(employee) }))
    .sort((left, right) => left.rank - right.rank || (left.employeeRank === right.employeeRank ? 0 : left.employeeRank < right.employeeRank ? -1 : 1) || left.index - right.index)
    .map(({ employee }) => employee);
}
