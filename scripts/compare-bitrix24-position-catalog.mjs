import { readFile } from "node:fs/promises";

import { fetchBitrixEmployeeSnapshot, normalizeBitrixText, selectBitrixEmployeesForImport } from "../app/bitrix24Sync.ts";

function normalizedKey(employee) {
  return [employee.employmentType, employee.department, employee.position]
    .map(normalizeBitrixText)
    .join("\u0000");
}

function countBy(values) {
  return Object.entries(values.reduce((counts, value) => {
    const key = value || "Не указано";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {})).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru-RU"));
}

const catalogPath = process.argv[2];
if (!catalogPath) throw new Error("Передайте путь к JSON-каталогу должностей.");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
if (!Array.isArray(catalog)) throw new Error("Каталог должностей должен быть массивом.");

const catalogKeys = new Set(catalog.map(normalizedKey));
const catalogTypes = new Set(catalog.map((row) => normalizeBitrixText(row.employmentType)));
const catalogDepartments = new Set(catalog.map((row) => normalizeBitrixText(row.department)));
const catalogPositions = new Set(catalog.map((row) => normalizeBitrixText(row.position)));
const sourceEmployees = await fetchBitrixEmployeeSnapshot();
const employees = selectBitrixEmployeesForImport(sourceEmployees);

const results = employees.map((employee) => {
  const incomplete = !employee.fullName || !employee.employmentType || !employee.department || !employee.position;
  const matched = !incomplete && catalogKeys.has(normalizedKey(employee));
  const reasons = [];
  if (incomplete) reasons.push("неполная карточка");
  if (employee.employmentType && !catalogTypes.has(normalizeBitrixText(employee.employmentType))) reasons.push("тип отсутствует в Excel");
  if (employee.department && !catalogDepartments.has(normalizeBitrixText(employee.department))) reasons.push("отдел отсутствует в Excel");
  if (employee.position && !catalogPositions.has(normalizeBitrixText(employee.position))) reasons.push("должность отсутствует в Excel");
  if (!incomplete && !matched && reasons.length === 0) reasons.push("сочетание полей отсутствует в Excel");
  return { employee, incomplete, matched, reasons };
});

const stages = [...new Set(results.map(({ employee }) => employee.stageName || employee.stageId))]
  .sort((left, right) => left.localeCompare(right, "ru-RU"));
const mismatches = results.filter((result) => !result.matched);

console.log(JSON.stringify({
  ok: true,
  mode: "read-only-comparison",
  sourceReceived: sourceEmployees.length,
  selectedEmployees: employees.length,
  catalogRows: catalog.length,
  uniqueCatalogRows: catalogKeys.size,
  matchedEmployees: results.filter((result) => result.matched).length,
  mismatchedEmployees: mismatches.length,
  incompleteEmployees: results.filter((result) => result.incomplete).length,
  byStage: Object.fromEntries(stages.map((stage) => {
    const stageRows = results.filter(({ employee }) => (employee.stageName || employee.stageId) === stage);
    return [stage, {
      total: stageRows.length,
      matched: stageRows.filter((row) => row.matched).length,
      mismatched: stageRows.filter((row) => !row.matched).length,
    }];
  })),
  mismatchReasons: countBy(mismatches.flatMap((result) => result.reasons)),
  mismatchCombinations: countBy(mismatches.map(({ employee }) =>
    `${employee.employmentType || "—"} | ${employee.department || "—"} | ${employee.position || "—"}`)).slice(0, 50),
}, null, 2));
