import { fetchBitrixEmployeeSnapshot, selectBitrixEmployeesForImport } from "../app/bitrix24Sync.ts";

function countBy(values) {
  return Object.entries(values.reduce((counts, value) => {
    const key = value || "Не указано";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right, "ru-RU"));
}

function groupedCounts(employees, keyForEmployee, valuesForEmployee) {
  return Object.fromEntries(
    [...new Set(employees.map(keyForEmployee))]
      .sort((left, right) => left.localeCompare(right, "ru-RU"))
      .map((key) => [
        key,
        countBy(employees.filter((employee) => keyForEmployee(employee) === key).flatMap(valuesForEmployee)),
      ]),
  );
}

const sourceEmployees = await fetchBitrixEmployeeSnapshot();
const employees = selectBitrixEmployeesForImport(sourceEmployees);
const selectedIds = new Set(employees.map((employee) => employee.bitrix24Id));
const excludedEmployees = sourceEmployees.filter((employee) => !selectedIds.has(employee.bitrix24Id));
const incomplete = employees.filter((employee) =>
  !employee.fullName || !employee.employmentType || !employee.department || !employee.position,
).length;

console.log(JSON.stringify({
  ok: true,
  sourceReceived: sourceEmployees.length,
  received: employees.length,
  excluded: excludedEmployees.length,
  incomplete,
  availability: countBy(employees.map((employee) => employee.availabilityStatus)),
  stages: countBy(employees.map((employee) => `${employee.stageName || "Без названия"} [${employee.stageId || "без ID"}]`)),
  projects: countBy(employees.flatMap((employee) => employee.projectKeys.length ? employee.projectKeys : ["Не указано"])),
  projectsByStage: groupedCounts(
    employees,
    (employee) => employee.stageName || employee.stageId || "Не указано",
    (employee) => employee.projectKeys.length ? employee.projectKeys : ["Не указано"],
  ),
  excludedStages: countBy(excludedEmployees.map((employee) => employee.stageName || employee.stageId)),
}, null, 2));
