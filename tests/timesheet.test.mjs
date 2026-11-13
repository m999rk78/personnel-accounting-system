import { readWorkspaceImplementation, readDataImplementation } from "./fixtures/read-implementation.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPersonnelTimesheetXlsx } from "../app/placementXlsx.ts";
import { buildPersonnelTimesheetRange, dateKeysInRange, monthKeysInRange, selectPersonnelTimesheetRange } from "../app/timesheetExportRange.ts";

test("exports the personnel timesheet with the template layout and month sheet name", async () => {
  const workbook = createPersonnelTimesheetXlsx("Усть-Луга ГПЗ", "Октябрь 2026 г.", ["2026-10-01", "2026-10-02"], [{
    employmentType: "ОПР",
    department: "МУТТ",
    fullName: "Иванов Иван",
    position: "Монтажник",
    positionNote: "",
    dailyValues: [8, "О"],
    dailyTimesheetHours: [8, 0],
    dailyReportHours: [8, 0],
    dailyMasters: ["Мастер", ""],
    timesheetHours: 8,
    reportHours: 8,
    masters: "Мастер",
  }], [8, 0], 8, 0);
  const contents = new TextDecoder().decode(await workbook.arrayBuffer());

  assert.match(contents, /sheet name="Октябрь"/);
  assert.match(contents, /pane xSplit="6" ySplit="3"/);
  assert.match(contents, /<t xml:space="preserve">Фамилия, имя, отчество<\/t>/);
  assert.match(contents, /<t xml:space="preserve">Примечание к должности<\/t>/);
  assert.match(contents, /<f>SUM\(G4:AK4\)<\/f><v>8<\/v>/);
  assert.match(contents, /autoFilter ref="B3:AN4"/);
  assert.match(contents, /Aptos Display/);
});

test("loads and combines personnel timesheet dates from different months", () => {
  assert.deepEqual(monthKeysInRange("2026-09-30", "2026-10-02"), ["2026-09", "2026-10"]);
  const employee = { id: 7, fullName: "Иванов Иван", employmentType: "ОПР", department: "УСР", position: "Монтажник" };
  const result = buildPersonnelTimesheetRange([
    {
      employees: [employee],
      entries: [{ employeeId: 7, workDate: "2026-09-30", hours: 8, masters: "Мастер 1", zones: "А" }],
      marks: [],
    },
    {
      employees: [employee],
      entries: [{ employeeId: 7, workDate: "2026-10-01", hours: 8, masters: "Мастер 2", zones: "Б" }],
      marks: [{ employeeId: 7, workDate: "2026-10-01", hours: 6, code: null, note: "", updatedBy: "Инженер" }],
    },
  ], "2026-09-30", "2026-10-01");

  assert.deepEqual(result.dates, ["2026-09-30", "2026-10-01"]);
  assert.deepEqual(result.rows[0].dailyValues, [8, 6]);
  assert.equal(result.rows[0].timesheetHours, 14);
  assert.equal(result.rows[0].reportHours, 16);
  assert.equal(result.rows[0].masters, "Мастер 1, Мастер 2");
  assert.deepEqual(result.dayTotals, [8, 6]);
  assert.equal(result.totalDifference, -2);
});

test("export ranges reject calendar overflow and preserve leap days and the inclusive 366-day limit", () => {
  for (const value of ["2026-02-30", "2026-02-29", "2026-04-31", "0000-01-01", "2026-1-01"]) {
    assert.throws(() => dateKeysInRange(value, value), /Проверьте даты/);
    assert.throws(() => monthKeysInRange(value, value), /Проверьте даты/);
  }
  assert.deepEqual(dateKeysInRange("2028-02-28", "2028-03-01"), ["2028-02-28", "2028-02-29", "2028-03-01"]);
  assert.equal(dateKeysInRange("2025-01-31", "2026-01-31").length, 366);
  assert.equal(monthKeysInRange("2025-01-31", "2026-01-31").length, 13);
  assert.throws(() => dateKeysInRange("2025-01-31", "2026-02-01"), /366 дней/);
  assert.deepEqual(monthKeysInRange("9999-12-01", "9999-12-31"), ["9999-12"], "The final supported month must not advance into an invalid loop");
});

test("a short export includes assignments and facts within its dates without unrelated monthly history", () => {
  const employee = (id, extra = {}) => ({ id, fullName: `Сотрудник ${id}`, employmentType: "ОПР", department: "УСР", position: "Монтажник", ...extra });
  const history = { periods: [], unknownDates: ["2026-11-30"], reason: "history" };
  const november = {
    employees: [
      employee(1, { reportDates: ["2026-11-05"], roster: history }),
      employee(2, { reportDates: [], roster: { periods: [{ startDate: "2026-11-10", endDate: "2026-11-30" }], unknownDates: [], reason: "assignment" } }),
      employee(3, { reportDates: [], roster: { periods: [{ startDate: "2026-11-30", endDate: "2026-12-01" }], unknownDates: [], reason: "assignment" } }),
      employee(4, { reportDates: ["2026-11-30"], roster: history }),
      employee(5, { reportDates: [], roster: history }),
      employee(6, { employmentType: "ИТР", reportDates: ["2026-11-30"], roster: history }),
      employee(7, { reportDates: [], roster: { ...history, reason: "assignment" } }),
    ],
    entries: [
      { employeeId: 1, workDate: "2026-11-05", hours: 8, masters: "Мастер", zones: "А", reportTracked: true },
      { employeeId: 4, workDate: "2026-11-30", hours: 6, masters: "Мастер", zones: "А", reportTracked: true },
    ],
    marks: [{ employeeId: 5, workDate: "2026-11-30", hours: null, code: "УВ", note: "", updatedBy: "Инженер" }],
  };
  const december = {
    employees: [employee(3, { position: "Бригадир", reportDates: [], roster: { periods: [{ startDate: "2026-12-01", endDate: "2027-01-01" }], unknownDates: [], reason: "assignment" } })],
    entries: [], marks: [],
  };
  const result = buildPersonnelTimesheetRange([november, december], "2026-11-30", "2026-12-01", [7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(result.rows.map(row => row.fullName), ["Сотрудник 7", "Сотрудник 6", "Сотрудник 5", "Сотрудник 4", "Сотрудник 3"]);
  assert.equal(result.rows.find(row => row.fullName === "Сотрудник 3").position, "Бригадир");
  assert.deepEqual(result.rows.find(row => row.fullName === "Сотрудник 6").dailyValues, ["", ""], "A published non-OPR fact retains membership without manufacturing report hours");
  assert.deepEqual(result.rows.find(row => row.fullName === "Сотрудник 5").dailyValues, ["УВ", ""]);
  assert.deepEqual(result.dayTotals, [6, 0]);
  assert.equal(result.totalHours, 6);
  assert.equal(november.employees.length, 7, "Export filtering does not mutate the monthly payload");
  const decemberOnly = selectPersonnelTimesheetRange(result.dates, result.rows, result.dayTotals, "2026-12-01", "2026-12-01");
  assert.deepEqual(decemberOnly.rows.map(row => row.fullName), ["Сотрудник 3"], "Narrowing the preview follows the same roster dates as a new export");
  assert.deepEqual(decemberOnly.dayTotals, [0]);
  assert.equal(decemberOnly.totalHours, 0);
});

test("limits a personnel timesheet export to the selected dates and recalculates totals", () => {
  const result = selectPersonnelTimesheetRange(
    ["2026-10-01", "2026-10-02", "2026-10-03"],
    [{
      employmentType: "ОПР",
      department: "УСР",
      fullName: "Иванов Иван",
      position: "Монтажник",
      positionNote: "",
      dailyValues: [8, "О", 4],
      dailyTimesheetHours: [8, 0, 4],
      dailyReportHours: [8, 2, 0],
      dailyMasters: ["Мастер 1", "Мастер 1", "Мастер 2"],
      timesheetHours: 12,
      reportHours: 10,
      masters: "Мастер 1, Мастер 2",
    }],
    [8, 2, 4],
    "2026-10-02",
    "2026-10-03",
  );

  assert.deepEqual(result.dates, ["2026-10-02", "2026-10-03"]);
  assert.deepEqual(result.rows[0].dailyValues, ["О", 4]);
  assert.equal(result.rows[0].timesheetHours, 4);
  assert.equal(result.rows[0].reportHours, 2);
  assert.equal(result.rows[0].masters, "Мастер 1, Мастер 2");
  assert.deepEqual(result.dayTotals, [2, 4]);
  assert.equal(result.totalHours, 4);
  assert.equal(result.totalDifference, 2);
});

test("uses daily report hours only for OPR employees", () => {
  const result = buildPersonnelTimesheetRange([{
    employees: [
      { id: 1, fullName: "Рабочий ОПР", employmentType: "ОПР", department: "УСР", position: "Монтажник" },
      { id: 2, fullName: "Инженер ИТР", employmentType: "ИТР", department: "ПТО", position: "Инженер" },
    ],
    entries: [
      { employeeId: 1, workDate: "2026-09-01", hours: 8, masters: "Мастер", zones: "А" },
      { employeeId: 2, workDate: "2026-09-01", hours: 10, masters: "Ошибочная старая строка", zones: "Б" },
    ],
    marks: [{ employeeId: 2, workDate: "2026-09-01", hours: 7, code: null, note: "", updatedBy: "Инженер" }],
  }], "2026-09-01", "2026-09-01");

  const opr = result.rows.find((row) => row.fullName === "Рабочий ОПР");
  const engineer = result.rows.find((row) => row.fullName === "Инженер ИТР");
  assert.deepEqual(opr?.dailyValues, [8]);
  assert.equal(opr?.reportHours, 8);
  assert.deepEqual(engineer?.dailyValues, [7]);
  assert.deepEqual(engineer?.dailyReportHours, [0]);
  assert.equal(engineer?.reportHours, 0);
});

test("keeps approved OPR hours after a date transfer and a later change of employee type", () => {
  const employee = { id: 7, fullName: "Архивный сотрудник", employmentType: "ИТР", department: "ПТО", position: "Инженер" };
  const oldMonth = { employees: [], entries: [], marks: [] };
  const newMonth = {
    employees: [employee],
    entries: [{ employeeId: 7, workDate: "2027-01-01", hours: 8, masters: "Исходный мастер", zones: "А", reportTracked: true }],
    marks: [],
  };
  const exported = buildPersonnelTimesheetRange([oldMonth, newMonth], "2026-12-31", "2027-01-01");
  assert.deepEqual(exported.rows[0].dailyValues, ["", 8]);
  assert.deepEqual(exported.rows[0].dailyReportHours, [0, 8]);
  assert.deepEqual(exported.dayTotals, [0, 8]);
  assert.equal(exported.rows[0].masters, "Исходный мастер");
  assert.equal(exported.rows[0].employmentType, "ИТР");
  assert.equal(exported.totalHours, 8);
  const corrected = buildPersonnelTimesheetRange([oldMonth, { ...newMonth,
    marks: [{ employeeId: 7, workDate: "2027-01-01", hours: null, code: "В", note: "Ручная отметка", updatedBy: "Инженер" }],
  }], "2026-12-31", "2027-01-01");
  assert.deepEqual(corrected.rows[0].dailyValues, ["", "В"]);
  assert.deepEqual(corrected.rows[0].dailyReportHours, [0, 8]);
  assert.equal(corrected.totalHours, 0);
  assert.equal(newMonth.entries[0].hours, 8);
});

test("mixed OPR and ITR days keep the same discrepancy in range previews and XLSX formulas", async () => {
  const employee = { id: 7, fullName: "Сотрудник со сменой типа", employmentType: "ИТР", department: "ПТО", position: "Инженер" };
  const result = buildPersonnelTimesheetRange([{
    month: "2026-11", employees: [employee],
    entries: [{ employeeId: 7, workDate: "2026-11-04", hours: 8, masters: "Мастер", zones: "А", reportTracked: true }],
    marks: [
      { employeeId: 7, workDate: "2026-11-04", hours: 4, code: null, note: "", updatedBy: "Инженер" },
      { employeeId: 7, workDate: "2026-11-05", hours: 7, code: null, note: "", updatedBy: "Инженер" },
    ],
  }], "2026-11-04", "2026-11-05");
  assert.deepEqual(result.rows[0].dailyReportTracked, [true, false]);
  assert.equal(result.totalHours, 11);
  assert.equal(result.totalDifference, -4, "ITR manual work must neither hide an older OPR correction nor add a new discrepancy");
  const firstDay = selectPersonnelTimesheetRange(result.dates, result.rows, result.dayTotals, "2026-11-04", "2026-11-04");
  assert.deepEqual(firstDay.rows[0].dailyReportTracked, [true]);
  assert.equal(firstDay.totalDifference, -4);
  const secondDay = selectPersonnelTimesheetRange(result.dates, result.rows, result.dayTotals, "2026-11-05", "2026-11-05");
  assert.deepEqual(secondDay.rows[0].dailyReportTracked, [false]);
  assert.equal(secondDay.totalDifference, 0);
  const workbook = createPersonnelTimesheetXlsx("Проект", "Ноябрь 2026 г.", result.dates, result.rows, result.dayTotals, result.totalHours, result.totalDifference);
  const contents = new TextDecoder().decode(await workbook.arrayBuffer());
  assert.match(contents, /<c r="AM4"[^>]*><f>SUM\(G4\)-8<\/f><v>-4<\/v><\/c>/, "The editable Excel formula uses only the OPR day and agrees with its cached value");
  assert.doesNotMatch(contents, /<c r="AM4"[^>]*><f>IF\(B4=/, "The final row label cannot suppress historical OPR comparison");
});

test("multi-month discrepancies use each month's employee type before the final row label", () => {
  const employee = { id: 7, fullName: "Сотрудник со сменой типа", department: "ПТО", position: "Инженер" };
  const mark = (workDate, hours) => ({ employeeId: 7, workDate, hours, code: null, note: "", updatedBy: "Инженер" });
  const result = buildPersonnelTimesheetRange([
    { month: "2026-10", employees: [{ ...employee, employmentType: "ОПР" }], entries: [], marks: [mark("2026-10-31", 4)] },
    { month: "2026-11", employees: [{ ...employee, employmentType: "ИТР" }], entries: [], marks: [mark("2026-11-01", 7)] },
  ], "2026-10-31", "2026-11-01");
  assert.equal(result.rows[0].employmentType, "ИТР");
  assert.deepEqual(result.rows[0].dailyReportTracked, [true, false]);
  assert.equal(result.totalDifference, 4, "An OPR manual day without a report still needs reconciliation");
});

test("a later OPR profile does not compare a saved ITR report day against missing OPR hours", () => {
  const result = buildPersonnelTimesheetRange([{
    month: "2026-11",
    employees: [{ id: 7, fullName: "Сотрудник со сменой типа", employmentType: "ОПР", department: "УСР", position: "Монтажник",
      reportDates: ["2026-11-04", "2026-11-05"], reportTrackedByDate: { "2026-11-04": false, "2026-11-05": true } }],
    entries: [{ employeeId: 7, workDate: "2026-11-05", hours: 8, masters: "Мастер", zones: "А", reportTracked: true }],
    marks: [{ employeeId: 7, workDate: "2026-11-04", hours: 7, code: null, note: "", updatedBy: "Инженер" }],
  }], "2026-11-04", "2026-11-05");
  assert.deepEqual(result.rows[0].dailyValues, [7, 8]);
  assert.deepEqual(result.rows[0].dailyReportTracked, [false, true]);
  assert.deepEqual(result.rows[0].dailyReportHours, [0, 8]);
  assert.equal(result.totalHours, 15);
  assert.equal(result.totalDifference, 0);
  assert.equal(selectPersonnelTimesheetRange(result.dates, result.rows, result.dayTotals, "2026-11-04", "2026-11-04").totalDifference, 0);
});

test("builds the monthly timesheet from saved daily reports with document scrolling", async () => {
  const api = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const pageStyles = await readFile(new URL("../app/tablePageScroll.css", import.meta.url), "utf8");
  const clipboard = await readFile(new URL("../app/useTimesheetClipboard.ts", import.meta.url), "utf8");
  const columnFilter = await readFile(new URL("../app/TimesheetColumnFilter.tsx", import.meta.url), "utf8");
  const filterController = await readFile(new URL("../app/useTimesheetFilters.tsx", import.meta.url), "utf8");
  const nativeFilters = await readFile(new URL("../app/GridEnterpriseFilters.tsx", import.meta.url), "utf8");
  const xlsx = await readFile(new URL("../app/placementXlsx.ts", import.meta.url), "utf8");
  const app = await readWorkspaceImplementation();
  const migration = await readFile(new URL("../drizzle-postgres/0007_timesheet_marks.sql", import.meta.url), "utf8");
  const cleanupMigration = await readFile(new URL("../drizzle-postgres/0008_position_catalog_cleanup.sql", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const startup = await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
  const migrationRunner = await readFile(new URL("../scripts/apply-postgres-migrations.mjs", import.meta.url), "utf8");
  const yandexPostgres = await readFile(new URL("../scripts/yandex-postgres.mjs", import.meta.url), "utf8");

  assert.match(api, /getAuthUser\(request\)/);
  assert.match(api, /!hasPermission\(authUser\.permissions, "workers_timesheet", "view"\)/);
  assert.match(api, /Нет доступа к табелю рабочих/);
  assert.match(api, /!canAccessProject\(authUser, requestedSiteId\)/);
  assert.match(api, /pe\.work_date >= \? AND pe\.work_date < \?/);
  assert.match(api, /const workMonth = payload\.workDate\.slice\(0, 7\)/);
  assert.match(api, /const monthEndDate = nextMonthStart\(workMonth\)/);
  assert.match(api, /pe\.site_id = \? AND pe\.work_date >= \? AND pe\.work_date < \? AND pe\.deleted_at IS NULL/);
  assert.match(api, /FROM timesheet_marks\s+WHERE site_id = \? AND work_date >= \? AND work_date < \?/);
  assert.doesNotMatch(api, /pe\.site_id = \? AND pe\.work_date = \?/);
  assert.doesNotMatch(api, /tm\.site_id = \? AND tm\.work_date = \?/);
  assert.match(api, /SUM\(pe\.hours\)::int AS hours/);
  assert.match(api, /GROUP BY pe\.employee_id, pe\.work_date/);
  assert.match(api, /pe\.deleted_at IS NULL/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS timesheet_marks/);
  assert.match(api, /isPersonnelTimesheetCode/);
  assert.match(api, /assertSameOrigin\(request\)/);
  assert.match(api, /!canAccessProject\(authUser, requestedSiteId\)/);
  assert.match(api, /ON CONFLICT \(site_id, employee_id, work_date\) DO UPDATE/);
  assert.match(api, /hours BETWEEN 1 AND 10/);
  assert.match(api, /marks: marksResult\.results/);
  assert.doesNotMatch(api, /availability_status = 'on_site'/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "timesheet_marks"/);
  assert.match(migration, /ALTER COLUMN "work_date" TYPE date/);
  assert.match(migration, /timesheet_hours_range/);
  assert.match(migration, /timesheet_value_required/);
  assert.match(migration, /idx_timesheet_marks_unique_day/);

  assert.match(cleanupMigration, /UPDATE "position_catalog"/);
  assert.match(cleanupMigration, /SET "active" = 0/);
  assert.doesNotMatch(cleanupMigration, /UPDATE "employees"/);
  assert.match(cleanupMigration, /'ОПР', 'УСР', 'Стропальщик'/);

  assert.match(dockerfile, /CMD \["node", "scripts\/start-production\.mjs"\]/);
  assert.match(dockerfile, /node_modules\/drizzle-orm/);
  assert.match(startup, /apply-postgres-migrations\.mjs/);
  assert.match(startup, /server\.js/);
  assert.match(migrationRunner, /pg_advisory_lock/);
  assert.match(migrationRunner, /pg_advisory_unlock/);
  assert.match(yandexPostgres, /rc1b-p176vla5mhlldu1a\.mdb\.yandexcloud\.net/);
  assert.match(yandexPostgres, /cloud-system-yums-personnel/);

  assert.match(view, /Табель учёта рабочего времени/);
  assert.match(view, /import \{ TimesheetMonthPicker \}/);
  assert.match(view, /personnel-timesheet-summary timesheet-top-summary/);
  assert.match(view, /<NativeTimesheetPageScroll viewportRef=\{clipboardShellRef\} rowCount=\{visibleEmployees\.length\}/);
  assert.doesNotMatch(view, /syncTimesheetHeaderScroll|resetTimesheetHeaderScroll/);
  assert.match(pageStyles, /\.table-page-scroll-frame[^}]*position:sticky/);
  assert.match(pageStyles, /\[data-table-page-viewport\][^}]*overflow-y:hidden/);
  assert.match(view, /Итого по дням/);
  assert.match(view, /timesheet-fill-row[\s\S]*colSpan=\{columnResize\.columnCount\}/);
  assert.match(view, /timesheet-summary-label[\s\S]*colSpan=\{columnResize\.stickyCount\}/);
  assert.match(styles, /timesheet-grid-shell-reconciled \.timesheet-table[^{]*\{ height:100%/);
  assert.match(styles, /timesheet-table tbody \.timesheet-fill-row \{ height:100%/);
  assert.match(view, /Вернуть значение из отчёта/);
  assert.match(view, /TimesheetFilterableHeading/);
  assert.match(view, /label="Тип"/);
  assert.match(view, /label="Сотрудник"/);
  assert.match(view, /label="Должность"/);
  assert.match(view, /useTimesheetFilters\(/);
  assert.match(view, /const visibleEmployees = filters\.rows/);
  assert.match(view, /TimesheetFiltersProvider value=\{filters\.context\}/);
  assert.match(view, /\{filters\.controller\}/);
  assert.match(view, /columnId=\{workDate\}/);
  assert.match(view, /value: "manual"/);
  assert.match(view, /value: "mismatch"/);
  assert.match(view, /resetKey: `\$\{siteId\}:\$\{month\}`/);
  assert.match(view, /timesheet-header-filter-reset/);
  assert.match(view, /const mismatch = isMismatch\(employee, entry, mark\)/);
  assert.match(view, /const expectedManualMark = isExpectedManualMark\(employee, entry, mark\)/);
  assert.match(view, /expectedManualMark \? "manual-expected" : ""/);
  assert.match(view, /mismatch \? "mismatch" : ""/);
  assert.doesNotMatch(view, /Сверка с ежедневными отчётами/);
  assert.doesNotMatch(view, /По мастерам/);
  assert.doesNotMatch(view, /По зонам/);
  assert.match(view, /Табельные коды/);
  assert.doesNotMatch(view, /timesheet-filter-panel/);
  assert.doesNotMatch(view, /timesheet-search/);
  assert.doesNotMatch(view, /timesheet-overview-expanded/);
  assert.match(view, /Вернуть значение из отчёта/);
  assert.match(view, /TIMESHEET_CODES/);
  assert.match(view, /openInlineEditor/);
  assert.match(view, /timesheet-cell-inline-editor/);
  assert.match(view, /aria-invalid=\{Boolean\(inlineEditor\.error\)\}/);
  assert.match(view, /onBlur=\{\(event\) =>/);
  assert.match(view, /saveInlineEditor\(undefined, event\.currentTarget\.value, false\)/);
  assert.match(view, /saveInlineEditor\(movement\[event\.key\], event\.currentTarget\.value\)/);
  assert.match(view, /if \(returnFocus\) inlineGridFocusPending\.current = true/);
  assert.match(view, /if \(inlineEditor \|\| !inlineGridFocusPending\.current\) return/);
  assert.match(view, /PERSONNEL_TIMESHEET_OPTIONS/);
  assert.match(view, /timesheet-cell-dropdown/);
  assert.match(view, /personnel-timesheet-cell-dropdown/);
  assert.match(view, /editor\?\.employeeId === employeeId && editor\.workDate === workDate/);
  assert.match(view, /aria-expanded=\{editor\?\.employeeId === employee\.id && editor\.workDate === workDate\}/);
  assert.match(view, /isActiveCell && <button/);
  assert.match(view, /Выбрать значение из списка/);
  assert.match(view, /onType: \(rowIndex, columnIndex, _anchor, value\)/);
  assert.match(view, /openInlineEditor\(employee\.id, dateForDay\(month, day\), rowIndex, columnIndex, value\)/);
  assert.match(view, /TimesheetMarkList/);
  assert.match(view, /custom-select-options timesheet-mark-options/);
  assert.match(view, /custom-select-option/);
  assert.match(view, /Недопустимое значение/);
  assert.match(view, /normalizedValue === ""/);
  assert.match(view, /Изменение не сохранено: допустимы часы 1–10 или табельный код/);
  assert.match(view, /closeEditorAndRestoreGridFocus/);
  assert.match(view, /clipboardShellRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(view, /personnel-timesheet-summary/);
  assert.match(view, /openTimesheetExportPreview/);
  assert.match(view, /openExcelExportPreview/);
  assert.match(view, /kind: "personnel-timesheet"/);
  assert.match(view, /excelFileName\("Табель персонала", \[payload\?\.siteName, month\]\)/);
  assert.match(view, /<ExcelActionsMenu actions=\{\[\s*\{ label: "Экспорт в Excel", onSelect: openTimesheetExportPreview, disabled: exportBlocked \|\| visibleEmployees\.length === 0 \}/);
  assert.match(view, /TimesheetMonthPicker/);
  const monthPicker = await readFile(new URL("../app/TimesheetMonthPicker.tsx", import.meta.url), "utf8");
  assert.match(monthPicker, /Выбрать месяц, сейчас/);
  assert.match(monthPicker, /TimesheetCellPopover/);
  assert.match(monthPicker, /timesheet-month-popover/);
  assert.match(monthPicker, /Выбор месяца табеля/);
  assert.doesNotMatch(view, /type="month"/);
  assert.match(view, /canDelete:/);
  assert.match(view, /marksByCell\.has/);
  assert.match(view, /onDelete: pasteTimesheetCells/);
  assert.match(clipboard, /event\.key !== "Delete" && event\.key !== "Backspace"/);
  assert.match(clipboard, /ArrowLeft/);
  assert.match(clipboard, /ArrowRight/);
  assert.match(clipboard, /ArrowUp/);
  assert.match(clipboard, /ArrowDown/);
  assert.match(clipboard, /event\.shiftKey/);
  assert.match(clipboard, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.match(clipboard, /scrollCellIntoVisibleArea/);
  assert.match(clipboard, /lastHeaderCell/);
  assert.match(clipboard, /footerCell/);
  assert.match(clipboard, /shell\.scrollBy\(\{ top: verticalOffset, left: horizontalOffset \}\)/);
  assert.match(clipboard, /event\.key === "Enter" \|\| event\.key === "F2"/);
  assert.match(clipboard, /onActivate\(current\.rowIndex, current\.columnIndex, anchor\)/);
  assert.match(clipboard, /event\.key\.length === 1/);
  assert.match(clipboard, /onType\(current\.rowIndex, current\.columnIndex, anchor, event\.key\)/);
  assert.match(view, /onActivate: \(rowIndex, columnIndex\)/);
  assert.match(view, /Стрелки перемещают выбранную ячейку/);
  assert.match(clipboard, /Удалено ручных значений/);
  assert.match(clipboard, /value: ""/);
  assert.match(clipboard, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(clipboard, /undoStack/);
  assert.match(clipboard, /rememberUndo/);
  assert.match(view, /getUndoNote/);

  assert.match(columnFilter, /timesheet-header-filter/);
  assert.match(columnFilter, /TimesheetFiltersContext/);
  assert.match(columnFilter, /Фильтр и сортировка/);
  assert.match(columnFilter, /filters\?\.open\(columnId, event\.currentTarget, wasOpen\)/);
  assert.match(columnFilter, /timesheet-sort-indicator/);
  assert.doesNotMatch(columnFilter, /timesheet-filter-popover|createPortal/);
  assert.doesNotMatch(columnFilter, /<select/);
  assert.match(filterController, /AgGridReact/);
  assert.match(filterController, /enterpriseFilterParams/);
  assert.match(filterController, /forEachNodeAfterFilterAndSort/);
  assert.match(filterController, /getFilterModel\(\)/);
  assert.match(filterController, /applyColumnState/);
  assert.match(filterController, /enableFilterHandlers/);
  assert.match(filterController, /showColumnFilter\(columnId\)/);
  assert.match(nativeFilters, /agSetColumnFilter/);
  assert.match(nativeFilters, /agNumberColumnFilter/);
  assert.match(nativeFilters, /agTextColumnFilter/);

  assert.match(xlsx, /export function createPersonnelTimesheetXlsx/);
  assert.match(xlsx, /Фамилия, имя, отчество/);
  assert.match(xlsx, /Примечание к должности/);
  assert.match(xlsx, /"РАСТ"/);
  assert.match(xlsx, /"Проверка"/);
  assert.match(xlsx, /Часы по табелю/);
  assert.match(xlsx, /autoFilter ref="B3:\$\{masterLetter\}\$\{Math\.max\(3, lastDataRow\)\}"/);
  assert.doesNotMatch(xlsx, /formulaStringCell/);
  assert.match(xlsx, /dayColumnCount = Math\.max\(31, dates\.length\)/);
  assert.match(xlsx, /SUM\(\$\{firstDayLetter\}\$\{rowNumber\}:\$\{lastDayLetter\}\$\{rowNumber\}\)/);
  assert.doesNotMatch(xlsx, /const weekdayCells/);
  assert.match(xlsx, /sort\(\(left, right\) => cellXmlColumnIndex\(left\) - cellXmlColumnIndex\(right\)\)/);
  assert.match(xlsx, /workbookFiles\(worksheet, undefined, timesheetSheetName\(dates\), "Справочники", timesheetStylesXml\)/);

  assert.match(app, /view === "timesheet"/);
  assert.match(app, /<TimesheetView/);
  assert.match(app, /mayViewWorkersReport \|\| mayViewWorkersTimesheet/);
  assert.match(app, /mayViewWorkersTimesheet && view === "timesheet"/);
  assert.match(app, /mayViewEquipmentTimesheet && view === "equipmentTimesheet"/);
  assert.match(app, /personnel-navigation/);
  assert.match(app, />Персонал</);
  assert.match(app, /aria-label="Отчёт персонала"/);
  assert.match(app, /aria-label="Табель персонала"/);
  assert.match(app, /aria-label="Табель техники"/);
  const workspaceAccess = await readFile(new URL("../app/workspaceAccess.ts", import.meta.url), "utf8");
  assert.match(workspaceAccess, /timesheet: "workers_timesheet", equipmentTimesheet: "equipment_timesheet"/);
  assert.match(workspaceAccess, /hasPermission\(permissions, resource, "view"\)/);
});

test("allows future personnel planning and retains timesheet queries for compatible report clients", async () => {
  const timesheetApi = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");
  const dataApi = await readDataImplementation();
  const timesheetView = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(timesheetApi, /Будущие дни пока нельзя заполнять/);
  assert.doesNotMatch(timesheetView, /workDate > today\) return/);
  assert.match(timesheetView, /<TimesheetMonthPicker value=\{month\} current=\{currentMonth\}/);
  assert.match(timesheetView, /aria-label="Следующий месяц"/);

  assert.match(dataApi, /function reportTimesheetMarksStatement\(siteId: number, workDate: string\)/);
  assert.match(dataApi, /timesheetMarks: timesheetMarks\.results/);
});
