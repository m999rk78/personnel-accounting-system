import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createEquipmentTimesheetXlsx } from "../app/placementXlsx.ts";
import { equipmentUnavailableReason, isEquipmentUnavailable } from "../app/equipmentAvailability.ts";
import { buildEquipmentCarryoverDrafts } from "../app/equipmentCarryover.ts";
import { buildEquipmentTimesheetRange, selectEquipmentTimesheetRange } from "../app/timesheetExportRange.ts";

test("loads and combines equipment timesheet dates from different months", () => {
  const unit = { id: 3, organization: "РХИ", equipmentType: "Кран", brand: "SANY", model: "", registrationNumber: "001" };
  const result = buildEquipmentTimesheetRange([
    {
      units: [unit],
      entries: [{ ...unit, equipmentId: 3, workDate: "2026-09-30", hours: 10, subworkTypeName: "Работа" }],
      marks: [],
    },
    {
      units: [unit],
      entries: [{ ...unit, equipmentId: 3, workDate: "2026-10-01", hours: 4, subworkTypeName: "Простой" }],
      marks: [{ equipmentId: 3, workDate: "2026-10-01", productiveHours: 6, downtimeHours: 2, note: "", updatedBy: "Инженер" }],
    },
  ], "2026-09-30", "2026-10-01");

  assert.deepEqual(result.dates, ["2026-09-30", "2026-10-01"]);
  assert.deepEqual(result.rows[0].dailyValues, [10, "6 / П 2"]);
  assert.equal(result.productiveTotal, 16);
  assert.equal(result.downtimeTotal, 2);
  assert.equal(result.totalHours, 18);
  assert.deepEqual(result.dayTotals, [10, 8]);
});

test("limits an equipment timesheet export to the selected dates and recalculates totals", () => {
  const result = selectEquipmentTimesheetRange(
    ["2026-10-01", "2026-10-02", "2026-10-03"],
    [{
      equipmentName: "Кран 50 т",
      organization: "РХИ",
      dailyValues: [10, "П 2", "6 / П 1"],
      dailyProductiveHours: [10, 0, 6],
      dailyDowntimeHours: [0, 2, 1],
      productiveHours: 16,
      downtimeHours: 3,
      totalHours: 19,
    }],
    [10, 2, 7],
    "2026-10-02",
    "2026-10-03",
  );

  assert.deepEqual(result.dates, ["2026-10-02", "2026-10-03"]);
  assert.deepEqual(result.rows[0].dailyValues, ["П 2", "6 / П 1"]);
  assert.equal(result.productiveTotal, 6);
  assert.equal(result.downtimeTotal, 3);
  assert.equal(result.totalHours, 9);
  assert.deepEqual(result.dayTotals, [2, 7]);
});

test("blocks equipment only when the timesheet contains downtime without productive work", () => {
  assert.equal(isEquipmentUnavailable({ productiveHours: 0, downtimeHours: 8, note: "Плановое ТО" }), true);
  assert.equal(isEquipmentUnavailable({ productiveHours: 6, downtimeHours: 2, note: "" }), false);
  assert.equal(isEquipmentUnavailable({ productiveHours: 8, downtimeHours: 0, note: "" }), false);
  assert.equal(equipmentUnavailableReason({ productiveHours: 0, downtimeHours: 8, note: "Плановое ТО" }), "Плановое ТО");
  assert.equal(equipmentUnavailableReason({ productiveHours: 0, downtimeHours: 4, note: "" }), "запланирован простой 4 ч.");
});

test("carries the foreman's previous equipment rows without duplicates or stale project assignments", () => {
  const entry = (id, equipmentId, overrides = {}) => ({
    id,
    workDate: "2026-09-30",
    equipmentId,
    shiftId: 1,
    zoneId: 2,
    mainWorkTypeId: 3,
    subworkTypeId: 4,
    hours: 8,
    note: "проверить",
    ...overrides,
  });
  const drafts = buildEquipmentCarryoverDrafts({
    reportSubmitted: false,
    workDate: "2026-10-01",
    units: [{ id: 10 }, { id: 20 }],
    entries: [entry(100, 20, { workDate: "2026-10-01" })],
    shifts: [{ id: 1, name: "День" }],
    zones: [{ id: 2, name: "Зона" }],
    mainWorkTypes: [{ id: 3, name: "Работа" }],
    subworkTypes: [],
  }, [entry(1, 10), entry(2, 20), entry(3, 30)]);

  assert.deepEqual(drafts, [{
    key: "previous-equipment-10-1",
    carriedFromPreviousDay: true,
    equipmentId: "10",
    shiftId: "1",
    zoneId: "2",
    mainWorkTypeId: "3",
    subworkTypeId: "",
    hours: "8",
    note: "проверить",
  }]);
});

test("exports the equipment timesheet as a formatted monthly workbook", async () => {
  const workbook = createEquipmentTimesheetXlsx(
    "Усть-Луга ГПЗ",
    "Сентябрь 2026 г.",
    ["2026-09-01", "2026-09-02"],
    [{ equipmentName: "Экскаватор // CAT 320 // А123ВС // ООО Техника", organization: "ООО Техника", equipmentType: "Экскаватор", registrationNumber: "А123ВС", dailyValues: [8, "П 2"], dailyProductiveHours: [8, 0], dailyDowntimeHours: [0, 2], dailyReportHours: [8, 2], productiveHours: 8, downtimeHours: 2, reportHours: 10, totalHours: 10 }],
    [8, 2],
    8,
    2,
    10,
  );
  const contents = new TextDecoder().decode(await workbook.arrayBuffer());

  assert.match(contents, /sheet name="Сентябрь"/);
  assert.match(contents, /pane xSplit="4" ySplit="5"/);
  assert.match(contents, /orientation="landscape"/);
  assert.match(contents, /<t xml:space="preserve">Уникальное наименование единицы<\/t>/);
  assert.match(contents, /<t xml:space="preserve">ГРЗ<\/t>/);
  assert.match(contents, /<t xml:space="preserve">ЧАСЫ<\/t>/);
  assert.match(contents, /<t xml:space="preserve">ПРОСТОЙ<\/t>/);
  assert.match(contents, /<t xml:space="preserve">РАСТ<\/t>/);
  assert.match(contents, /<f>SUM\(E6:AI6\)<\/f><v>8<\/v>/);
  assert.match(contents, /<c r="AK6" s="11"><v>2<\/v><\/c>/);
  assert.match(contents, /<f>AJ6\+AK6-10<\/f><v>0<\/v>/);
  assert.match(contents, /autoFilter ref="B5:AL6"/);
  assert.match(contents, /Усть-Луга ГПЗ — Сентябрь 2026 г\./);
});

test("builds equipment accounting from a shared registry and daily entries", async () => {
  const api = await readFile(new URL("../app/api/equipment/route.ts", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const parser = await readFile(new URL("../app/placementXlsx.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle-postgres/0009_equipment_accounting.sql", import.meta.url), "utf8");
  const assignmentMigration = await readFile(new URL("../drizzle-postgres/0010_equipment_project_assignments.sql", import.meta.url), "utf8");
  const timesheetMigration = await readFile(new URL("../drizzle-postgres/0011_equipment_timesheet_marks.sql", import.meta.url), "utf8");
  const grids = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(api, /getAuthUser\(request\)/);
  assert.match(api, /viewMode === "timesheet"[\s\S]*"equipment_timesheet"/);
  assert.match(api, /canEditTimesheet: hasPermission\(authUser\.permissions, "equipment_timesheet", "create"\)/);
  assert.match(api, /authUser\.role === "foreman"/);
  assert.doesNotMatch(api, /workDate\s*(?:===|!==|>=|<=|>|<)\s*todayInMoscow\(\)/);
  assert.match(api, /validateReferenceIds/);
  assert.match(api, /hours > 10/);
  assert.match(api, /payload\.action === "import-units"/);
  assert.match(api, /payload\.action === "import-entries"/);
  assert.match(api, /hasPermission\(authUser\.permissions, "equipment_report", "create"\)/);
  assert.match(api, /SELECT DISTINCT work_date AS "workDate"/);
  assert.match(api, /INSERT INTO equipment_entries/);
  assert.match(api, /equipment_project_assignments/);
  assert.match(api, /SET active = 1, assigned_at = CURRENT_TIMESTAMP, ended_at = NULL/);
  assert.doesNotMatch(api, /assigned_at = CASE/);
  assert.match(api, /setEquipmentProjectAssignment/);
  assert.match(api, /projectSiteId/);
  assert.match(api, /assignedSiteName/);
  assert.match(api, /scope === "global"/);
  assert.match(api, /scope === "assignments"/);
  assert.match(api, /payload\.action === "assign-unit-project"/);
  assert.match(api, /payload\.action === "remove-unit-project"/);
  assert.match(api, /ee\.deleted_at IS NULL/);
  assert.match(api, /equipment_timesheet_marks/);
  assert.match(api, /payload\.action === "save-timesheet-mark"/);
  assert.doesNotMatch(api, /Будущие дни пока нельзя заполнять/);
  assert.match(api, /dailyTimesheetMarks/);
  assert.match(api, /equipmentPlanConflictMessage/);
  assert.match(api, /etm\.productive_hours = 0 AND etm\.downtime_hours > 0/);
  assert.match(api, /productiveHours \+ downtimeHours > 20/);
  assert.match(api, /Сумма работы и простоя не должна превышать 20 часов/);
  assert.match(api, /canEditTimesheet/);

  assert.match(view, /section === "month"/);
  assert.match(view, /section === "month" \? "timesheet" : section/);
  assert.match(view, /&view=\$\{viewMode\}/);
  assert.match(view, /section === "registry"/);
  assert.match(view, /mode: EquipmentSection/);
  assert.match(view, /EquipmentDailyAgGrid/);
  assert.match(view, /EquipmentRegistryAgGrid/);
  assert.match(view, /ProjectEquipmentAgGrid/);
  assert.match(view, /Добавить технику в проект/);
  assert.match(view, /Убрать из проекта/);
  assert.match(view, /sites={payload\?\.sites \?\? \[\]}/);
  assert.match(view, /assignedSiteName/);
  assert.match(view, /Редактируется:/);
  assert.match(view, /Удалить технику/);
  assert.match(view, /Сохранить изменения/);
  assert.match(view, /normalize\(entry\.subworkTypeName\)\.includes\("простой"\)/);
  assert.match(view, /equipment-timesheet-summary timesheet-top-summary/);
  assert.match(view, /section === "month" \? "timesheet-page"/);
  assert.match(view, /className="timesheet-export-button"/);
  assert.match(view, /className="equipment-total"><small>Всего<\/small><strong>\{monthSummary\.total\} ч\.<\/strong>/);
  assert.match(view, /timesheet-fill-row[\s\S]*colSpan=\{monthDays\.length \+ 6\}/);
  assert.match(view, /TimesheetFilterableHeading/);
  assert.match(view, /label="Техника"/);
  assert.match(view, /label="Организация"/);
  assert.match(view, /monthDayFilters/);
  assert.doesNotMatch(view, /timesheet-filter-panel/);
  assert.doesNotMatch(view, /timesheet-search/);
  assert.match(view, /EquipmentMonthPicker/);
  assert.match(view, /current=\{today\.slice\(0, 7\)\}/);
  assert.doesNotMatch(view, /disabled=\{month >= today\.slice\(0, 7\)\}/);
  assert.match(view, /date > today \? "future" : ""/);
  assert.match(view, /timesheet-month-popover/);
  assert.match(view, /Выбор месяца табеля/);
  assert.doesNotMatch(view, /type="month"/);
  assert.doesNotMatch(view, /Данные формируются из ежедневных отчётов техники/);
  assert.match(view, /parseEquipmentRegistryXlsx/);
  assert.match(view, /parseEquipmentEntriesXlsx/);
  assert.match(view, /EquipmentReportDateNavigation/);
  assert.match(view, /Сбросить фильтры/);
  assert.match(view, /Есть простой/);
  assert.match(view, /timesheet-header-filter-reset/);
  assert.match(view, /openTimesheetEditor/);
  assert.match(view, /saveTimesheetMark/);
  assert.match(view, /EquipmentTimesheetMarkList/);
  assert.match(view, /EQUIPMENT_MARK_OPTIONS/);
  assert.match(view, /timesheet-cell-inline-editor/);
  assert.match(view, /void saveTimesheetInlineValue\(\)/);
  assert.match(view, /openTimesheetInlineEditor/);
  assert.match(view, /onType: \(rowIndex, columnIndex, _anchor, value\)/);
  assert.match(view, /isActiveCell && <button/);
  assert.match(view, /timesheet-cell-dropdown/);
  assert.match(view, /custom-select-options timesheet-mark-options equipment-mark-options/);
  assert.doesNotMatch(view, /Работа, простой и комментарий…/);
  assert.match(view, /!value\?\.downtime && value\?\.mark \? "0" : null/);
  assert.match(view, /equipment-timesheet-cell-dropdown/);
  assert.match(view, /timesheetEditor\?\.equipmentId === equipmentId && timesheetEditor\.workDate === editorWorkDate/);
  assert.match(view, /aria-expanded=\{timesheetEditor\?\.equipmentId === row\.unit\.id && timesheetEditor\.workDate === date\}/);
  assert.match(view, /\^П\\s\*\(\\d\{1,2\}\)\$/);
  assert.match(view, /«П 2» для простоя/);
  assert.match(view, /formatEquipmentHours/);
  assert.match(view, /Стрелки перемещают выбранную ячейку/);
  assert.match(view, /Ручная правка/);
  assert.match(view, /canDelete:/);
  assert.match(view, /timesheetMarksByCell\.has/);
  assert.match(view, /onDelete: pasteEquipmentTimesheetCells/);
  assert.match(view, /rememberEquipmentTimesheetUndo/);
  assert.match(view, /getUndoNote/);
  assert.match(view, /Из отчёта/);
  assert.match(view, /Всего за сутки/);
  assert.match(view, /productiveHours \+ downtimeHours <= 20/);
  assert.match(view, /Экспорт в Excel/);
  assert.match(view, /Импорт из Excel/);
  assert.match(view, /createTableXlsx/);
  assert.match(view, /openTimesheetExportPreview/);
  assert.match(view, /kind: "equipment-timesheet"/);
  assert.match(view, /Табель_техники_/);
  assert.match(view, /equipment-timesheet-page-actions/);
  assert.match(styles, /equipment-timesheet-summary \{ grid-template-columns:minmax\(184px,1\.2fr\) repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /equipment-machine-column \{ width:288px; min-width:288px; max-width:288px; left:44px/);
  assert.match(styles, /equipment-organization-column \{ width:170px; min-width:170px; max-width:170px; left:332px/);
  assert.match(styles, /equipment-month-table \.timesheet-total-column \{ width:72px; min-width:72px; max-width:72px/);
  assert.match(styles, /equipment-month-table \.timesheet-summary-label \{ width:502px!important/);
  assert.match(styles, /equipment-month-table \.future \{ background:#fafafa; color:#c2c2c7/);
  assert.match(styles, /equipment-month-table thead th\.future \{ background:#fafafa; color:#c2c2c7/);
  assert.match(styles, /tbody td\.today:not\(\.weekend\):not\(\.filled\)[^{]*\{ background:#fff/);
  assert.match(parser, /function columnLetter/);
  assert.doesNotMatch(view, /<div className="equipment-overview">/);
  assert.doesNotMatch(view, /Назначить на проект/);
  assert.doesNotMatch(view, /equipment-assignment-grid/);
  assert.match(grids, /export function EquipmentDailyAgGrid/);
  assert.match(grids, /export function EquipmentRegistryAgGrid/);
  assert.match(grids, /export function ProjectEquipmentAgGrid/);
  assert.match(grids, /В проекте пока нет техники/);
  assert.match(grids, /headerName: "Проект"/);
  assert.match(grids, /projectSiteId/);
  assert.match(grids, /selectAll: "filtered"/);
  assert.match(grids, /onFilterChanged/);
  assert.match(grids, /function EquipmentCombobox/);
  assert.match(grids, /Недоступна по табелю/);
  assert.match(grids, /equipment-plan-blocked/);
  assert.match(grids, /Начните вводить название техники/);
  assert.match(grids, /onSpreadsheetPaste={pasteIntoRow}/);

  assert.match(parser, /export async function parseEquipmentRegistryXlsx/);
  assert.match(parser, /export function createEquipmentTimesheetXlsx/);
  assert.match(parser, /orientation="landscape"/);
  assert.match(parser, /pane xSplit="4" ySplit="5"/);
  assert.match(parser, /"Уникальное наименование единицы"/);
  assert.match(parser, /workbookFiles\(worksheet, undefined, timesheetSheetName\(dates\), "Справочники", timesheetStylesXml\)/);
  assert.match(parser, /export async function parseEquipmentEntriesXlsx/);
  assert.match(parser, /ГРЗ \/ Инв\. №/);
  assert.match(parser, /projectName/);
  assert.match(parser, /xl\/worksheets\/sheet\$\{sheetNumber\}\.xml/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "equipment_units"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "equipment_entries"/);
  assert.match(migration, /equipment_entry_hours_range/);
  assert.match(migration, /idx_equipment_units_site_identity/);
  assert.match(assignmentMigration, /CREATE TABLE IF NOT EXISTS "equipment_project_assignments"/);
  assert.match(assignmentMigration, /SELECT "id", "site_id", 1/);
  assert.match(timesheetMigration, /CREATE TABLE IF NOT EXISTS "equipment_timesheet_marks"/);
  assert.match(timesheetMigration, /equipment_timesheet_daily_hours_limit/);
  assert.match(timesheetMigration, /<= 20/);

  assert.match(app, /view === "equipment"/);
  assert.match(app, /view === "equipmentTimesheet"/);
  assert.match(app, /view === "equipmentRegistry"/);
  assert.match(app, /view === "projectEquipment"/);
  assert.match(app, /Техника проекта/);
  assert.match(app, /<EquipmentAccountingView/);
  assert.match(app, /aria-label="Техника"/);
  assert.match(app, />Табели</);
});

test("separates the daily equipment report into foreman contributions", async () => {
  const api = await readFile(new URL("../app/api/equipment/route.ts", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
  const grids = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle-postgres/0013_equipment_foreman_report_contributions.sql", import.meta.url), "utf8");

  assert.match(schema, /export const equipmentReportContributions = pgTable\("equipment_report_contributions"/);
  assert.match(schema, /equipmentEntries[\s\S]*responsibleUserId: integer\("responsible_user_id"\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "equipment_report_contributions"/);
  assert.match(api, /const siteId = authUser\.role === "foreman" \? authUser\.assignedSiteId! : requestedSiteId/);
  assert.match(api, /canCreateDaily: hasPermission\(authUser\.permissions, "equipment_report", "create"\)/);
  assert.match(api, /canUpdateDaily: hasPermission\(authUser\.permissions, "equipment_report", "update"\)/);
  assert.match(api, /canDeleteDaily: hasPermission\(authUser\.permissions, "equipment_report", "delete"\)/);
  assert.match(api, /hasPermission\(authUser\.permissions, "equipment_report", entryId \? "update" : "create"\)/);
  assert.match(api, /payload\.action === "delete-entry"[\s\S]*hasPermission\(authUser\.permissions, "equipment_report", "delete"\)/);
  assert.doesNotMatch(api, /Прораб[^\n]*(?:сегодняшн|только сегодня)/i);
  assert.match(api, /responsibleUserId = authUser\.role === "foreman" && section === "daily" \? authUser\.id : null/);
  assert.match(api, /ee\.responsible_user_id = \?/);
  assert.match(api, /Прораб может изменять только собственные строки отчёта назначенного проекта/);
  assert.match(api, /Прораб может удалять только собственные строки отчёта назначенного проекта/);
  assert.match(api, /payload\.action === "submit-daily-report"/);
  assert.match(api, /INSERT INTO equipment_report_contributions[\s\S]*RETURNING revision/);
  assert.match(api, /INSERT INTO equipment_report_days[\s\S]*RETURNING site_id/);
  assert.match(api, /equipmentForemanProgressStatement/);
  assert.match(api, /equipment-hours:\$\{key\}/);
  assert.match(api, /За сутки можно указать не более 20 ч/);
  assert.match(view, /Сдали прорабы:/);
  assert.match(view, /Сохранить мою часть/);
  assert.match(view, /Если всё как вчера, сразу сохраните свою часть/);
  assert.match(view, /for \(const draft of entryDrafts\) await post\(\{ action: "save-entry", workDate, \.\.\.draft \}\)/);
  assert.match(view, /Принять отчёт за день/);
  assert.match(view, /if \(!payload \|\| \(entry \? !payload\.canUpdateDaily : !payload\.canCreateDaily\)\) return/);
  assert.match(view, /entryDrafts\.length === 0 && selectedEntryIds\.length === 0 && <div className="employee-footer-base">/);
  assert.match(view, /payload\?\.canCreateDaily && <button[^>]+onClick=\{\(\) => openEntry\(\)\}/);
  assert.match(view, /onClick=\{\(\) => \{ const selected = dailyEntries\.filter/);
  assert.match(view, /disabled=\{saving \|\| !payload\?\.canUpdateDaily\} title=\{payload\?\.canUpdateDaily \? undefined : "Нет права редактирования"\}>Редактировать/);
  assert.match(view, /onClick=\{\(\) => void deleteSelectedEntries\(\)\} disabled=\{saving \|\| !payload\?\.canDeleteDaily\} title=\{payload\?\.canDeleteDaily \? undefined : "Нет права удаления"\}/);
  assert.match(view, /payload\.currentUserRole !== "foreman" \|\| !payload\.canCreateDaily\) return/);
  assert.match(view, /workDate !== today \|\| payload\?\.workDate !== workDate[\s\S]*scope=carryover/);
  assert.match(view, /equipmentCarryoverMode = section === "daily" && workDate === today[\s\S]*payload\.currentUserRole === "foreman" && payload\.canCreateDaily/);
  assert.match(view, /unitDrafts\.length === 0 && selectedUnitIds\.length === 0 && <div className="employee-footer-base">/);
  assert.match(view, /projectUnitDrafts\.length === 0 && selectedProjectUnitIds\.length === 0 && <div className="employee-footer-base">/);
  assert.match(grids, /headerName: "Ответственный прораб"/);
});
