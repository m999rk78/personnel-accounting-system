import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps daily personnel reports limited to OPR employees", async () => {
  const [api, app, timesheetApi] = await Promise.all([
    source("app/api/data/route.ts"),
    source("app/PersonnelApp.tsx"),
    source("app/api/timesheet/route.ts"),
  ]);

  assert.match(api, /function isOprEmploymentType\(value: string\)/);
  assert.match(api, /function reportEmployeesStatement\(siteId: number\)[\s\S]*epa\.site_id = \?[\s\S]*UPPER\(TRIM\(e\.employment_type\)\) = 'ОПР'/);
  assert.match(api, /В отчёт рабочих можно добавлять только сотрудников с типом ОПР/);
  assert.match(api, /Строка \$\{index \+ 1\}: в отчёт рабочих можно добавлять только сотрудников с типом ОПР/);
  assert.match(api, /UPPER\(TRIM\(COALESCE\(NULLIF\(pe\.employment_type_snapshot, ''\), e\.employment_type\)\)\) = 'ОПР'/);
  assert.match(api, /UPPER\(TRIM\(entry\.employment_type_snapshot\)\) = 'ОПР'/);

  assert.match(app, /new Map\(data\.reportEmployees\.map\(\(employee\) => \[employee\.id, employee\]\)\)/);
  assert.match(app, /employees=\{data\?\.reportEmployees \?\? \[\]\}/);
  assert.match(app, /employees: data\.reportEmployees/);
  assert.match(app, /data\.reportEmployees\.find\(\(item\) => normalize\(item\.fullName\) === normalize\(name\)\)/);

  assert.match(timesheetApi, /UPPER\(TRIM\(pe\.employment_type_snapshot\)\) = 'ОПР'/);
  assert.match(timesheetApi, /EXISTS \(SELECT 1 FROM employee_project_assignments epa[\s\S]*epa\.active = 1/);
  assert.match(timesheetApi, /OR EXISTS \([\s\S]*FROM placement_entries pe[\s\S]*pe\.work_date >= \? AND pe\.work_date < \?/);
  assert.match(timesheetApi, /OR EXISTS \([\s\S]*FROM timesheet_marks tm[\s\S]*tm\.work_date >= \? AND tm\.work_date < \?/);
});

test("keeps project assignment history instead of rewriting past assignments", async () => {
  const [api, app, grid] = await Promise.all([
    source("app/api/data/route.ts"),
    source("app/PersonnelApp.tsx"),
    source("app/AgDataGrids.tsx"),
  ]);

  assert.match(api, /payload\.action === "create-employee"[\s\S]*projectSiteId \? "on_site" : "unassigned"/);
  assert.match(api, /payload\.action === "update-employee"[\s\S]*end_date = COALESCE\(end_date, CURRENT_DATE\)/);
  assert.match(api, /INSERT INTO employee_project_assignments \(employee_id, site_id, source, start_date\) VALUES \(\?, \?, 'manual', CURRENT_DATE\)/);
  assert.doesNotMatch(api, /UPDATE employee_project_assignments SET active = 1, end_date = NULL/);
  assert.match(api, /employee\.availabilityStatus !== "on_site" \|\| !employee\.siteIds\.length[\s\S]*active = 0, end_date = COALESCE/);
  assert.match(app, /projectSiteId: draft\.projectSiteId \? Number\(draft\.projectSiteId\) : null/);
  assert.match(app, /label: "Без объекта"/);
  assert.match(grid, /row\.employee\?\.siteName \?\? "Без объекта"/);
});
