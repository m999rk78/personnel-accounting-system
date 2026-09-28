import pg from "pg";

import { fetchBitrixEmployeeSnapshot, normalizeBitrixText, selectBitrixEmployeesForImport } from "../app/bitrix24Sync.ts";

function parseProjectOverrides() {
  const raw = process.env.BITRIX24_PROJECT_MAP?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BITRIX24_PROJECT_MAP должен быть JSON-объектом.");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [normalizeBitrixText(key), String(value)]),
  );
}

function countBy(values) {
  return Object.entries(values.reduce((counts, value) => {
    const key = value || "Не указано";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right, "ru-RU"));
}

function sslConfiguration() {
  const mode = process.env.DATABASE_SSL ?? "disable";
  if (mode === "disable") return undefined;
  const certificate = process.env.DATABASE_CA_CERT?.replaceAll("\\n", "\n");
  return certificate ? { ca: certificate, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

const pool = new pg.Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE ?? "personnel",
      }),
  ssl: sslConfiguration(),
  max: 1,
});

try {
  const sourceEmployees = await fetchBitrixEmployeeSnapshot();
  const employees = selectBitrixEmployeesForImport(sourceEmployees);
  const selectedIds = new Set(employees.map((employee) => employee.bitrix24Id));
  const excludedEmployees = sourceEmployees.filter((employee) => !selectedIds.has(employee.bitrix24Id));
  const [sitesResult, positionsResult, manualEmployeesResult, existingBitrixResult] = await Promise.all([
    pool.query("SELECT id, name, code FROM sites WHERE active = 1 ORDER BY id"),
    pool.query("SELECT employment_type, department, position FROM position_catalog WHERE active = 1"),
    pool.query("SELECT full_name FROM employees WHERE source <> 'bitrix24' AND active = 1"),
    pool.query("SELECT COUNT(*)::int AS count FROM employees WHERE source = 'bitrix24'"),
  ]);

  const siteByKey = new Map();
  for (const site of sitesResult.rows) {
    siteByKey.set(normalizeBitrixText(site.name), site);
    siteByKey.set(normalizeBitrixText(site.code), site);
  }
  const positionKeys = new Set(positionsResult.rows.map((row) =>
    [row.employment_type, row.department, row.position].map(normalizeBitrixText).join("\u0000")));
  const manualNames = new Set(manualEmployeesResult.rows.map((row) => normalizeBitrixText(row.full_name)));
  const overrides = parseProjectOverrides();

  const unknownProjects = [];
  const unknownOnSiteProjects = [];
  const plannedSites = [];
  const issueCodes = [];
  let readyOnSite = 0;
  let blockedOnSite = 0;
  let possibleManualDuplicates = 0;

  for (const employee of employees) {
    const issues = [];
    if (!employee.fullName || !employee.employmentType || !employee.department || !employee.position) {
      issues.push("incomplete_profile");
    }
    const positionKey = [employee.employmentType, employee.department, employee.position]
      .map(normalizeBitrixText).join("\u0000");
    if (employee.employmentType && employee.department && employee.position && !positionKeys.has(positionKey)) {
      issues.push("position_not_in_catalog");
    }

    const matchedSites = [];
    for (const project of employee.projectKeys) {
      const target = overrides[normalizeBitrixText(project)] ?? project;
      const site = siteByKey.get(normalizeBitrixText(target));
      if (site) {
        matchedSites.push(site);
        plannedSites.push(site.name);
      } else {
        unknownProjects.push(project);
        if (employee.availabilityStatus === "on_site") unknownOnSiteProjects.push(project);
        issues.push("project_not_found");
      }
    }
    if (employee.availabilityStatus === "on_site" && matchedSites.length === 0) {
      issues.push("on_site_without_project");
    }
    if (employee.availabilityStatus === "unknown") issues.push("unknown_stage");
    if (manualNames.has(normalizeBitrixText(employee.fullName))) possibleManualDuplicates += 1;

    if (employee.availabilityStatus === "on_site") {
      if (issues.length === 0) readyOnSite += 1;
      else blockedOnSite += 1;
    }
    issueCodes.push(...new Set(issues));
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "read-only-preview",
    syncEnabled: process.env.BITRIX24_SYNC_ENABLED === "true",
    sourceReceived: sourceEmployees.length,
    received: employees.length,
    excluded: excludedEmployees.length,
    selectedStages: countBy(employees.map((employee) => employee.stageName || employee.stageId)),
    excludedStages: countBy(excludedEmployees.map((employee) => employee.stageName || employee.stageId)),
    existingBitrixRows: existingBitrixResult.rows[0]?.count ?? 0,
    localSites: sitesResult.rows.map(({ name, code }) => ({ name, code })),
    availability: countBy(employees.map((employee) => employee.availabilityStatus)),
    readyOnSite,
    blockedOnSite,
    plannedOnSiteAssignments: countBy(plannedSites),
    unknownOnSiteProjects: countBy(unknownOnSiteProjects),
    unknownProjectsAllStages: countBy(unknownProjects),
    issues: countBy(issueCodes),
    possibleManualDuplicates,
  }, null, 2));
} finally {
  await pool.end();
}
