import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const serverUrl = new URL("../dist/server/index.js", import.meta.url);
  const { default: handler } = await import(serverUrl.href);
  return handler(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
  );
}

test("server-renders the protected personnel accounting workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ru">/i);
  assert.match(html, /<title>Расстановка \| Учёт персонала<\/title>/i);
  assert.match(html, /Учёт персонала/);
  assert.match(html, /Проверяем доступ/);
  assert.match(html, /class="auth-loading"/i);
  assert.doesNotMatch(html, /type="date"/);
  assert.doesNotMatch(html, /compact-pagination/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);

  const app = await readFile(
    new URL("../app/PersonnelApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(app, /Отчет персонала/);
  assert.match(app, /PlacementAgGrid/);
  assert.match(app, /Общее количество часов ОПР/);
  assert.match(app, /aria-label="Дата отчёта"/);

  const grid = await readFile(
    new URL("../app/AgDataGrids.tsx", import.meta.url),
    "utf8",
  );
  assert.match(grid, /AgGridReact/);
  assert.match(grid, /headerName: "Вид подработ"/);
  assert.match(grid, /headerName: "Должность"/);
  assert.match(grid, /pinned: "right"/);
  assert.doesNotMatch(grid, /AllCommunityModule/);
  assert.match(grid, /ClientSideRowModelModule/);
  assert.match(grid, /export function DirectoryAgGrid/);
  assert.match(grid, /selectEmployee/);
  assert.match(grid, /headerName: "ФИО"/);
  assert.match(grid, /headerName: "Тип"/);
  assert.match(grid, /headerName: "Отдел"/);
});

test("protects access with invitations, password hashing, and server sessions", async () => {
  const auth = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");
  const login = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  const invitation = await readFile(new URL("../app/invite/page.tsx", import.meta.url), "utf8");
  const password = await readFile(new URL("../app/api/auth/password/route.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");

  assert.match(auth, /PBKDF2/);
  assert.match(auth, /PASSWORD_ITERATIONS = 600_000/);
  assert.match(auth, /HttpOnly; SameSite=Lax/);
  assert.match(auth, /CREATE TABLE IF NOT EXISTS user_invitations/);
  assert.match(auth, /CREATE TABLE IF NOT EXISTS user_sessions/);
  assert.match(auth, /https:\/\/api\.resend\.com\/emails/);
  assert.match(auth, /https:\/\/postbox\.cloud\.yandex\.net\/v2\/email\/outbound-emails/);
  assert.match(auth, /computeMetadata\/v1\/instance\/service-accounts\/default\/token/);
  assert.match(auth, /process\.env\.PUBLIC_APP_ORIGIN/);
  assert.match(api, /getAuthUser\(request\)/);
  assert.match(api, /createInvitation\(userId, request\)/);
  assert.match(api, /sendInvitationEmail/);
  assert.match(login, /Создание администратора/);
  assert.match(invitation, /Создать пароль и войти/);
  assert.match(password, /verifyPassword/);
  assert.match(password, /UPDATE user_sessions SET revoked_at/);
  assert.match(app, /Открыть профиль пользователя/);
  assert.match(app, /Изменить пароль/);
});

test("keeps business validation in the data API", async () => {
  const api = await readFile(
    new URL("../app/api/data/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(api, /hours < 1 \|\| hours > 10/);
  assert.match(api, /used \+ hours > 10/);
  assert.match(api, /employee\.position/);
  assert.match(api, /INSERT INTO placement_entries/);
  assert.match(api, /payload\.action === "create-user"/);
  assert.match(api, /payload\.action === "update-user"/);
  assert.match(api, /payload\.action === "create-employee"/);
  assert.match(api, /payload\.action === "update-employee"/);
  assert.match(api, /payload\.action === "create-site"/);
  assert.match(api, /payload\.action === "create-directory"/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS personnel_options/);
  assert.match(api, /idx_personnel_options_kind_name/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS position_catalog/);
  assert.match(api, /payload\.action === "import-employees"/);
  assert.match(api, /projectCode \?\? ""\)\.split\(","\)/);
  assert.match(api, /UPDATE employee_project_assignments SET active = 0, end_date = DATE\('now'\)/);
  assert.match(api, /INSERT INTO employee_project_assignments \(employee_id, site_id, source\) SELECT \?, \?, 'excel' WHERE NOT EXISTS/);
  assert.match(api, /payload\.action === "import-positions"/);
  assert.match(api, /UPDATE app_users SET active = 0/);
  assert.match(api, /UPDATE employees SET active = 0, site_id = NULL WHERE id = ANY\(\?\) AND active = 1/);
  assert.match(api, /DELETE FROM position_catalog WHERE id = \?/);
  assert.match(api, /repairNumericPersonnelValues/);
  assert.match(api, /ensureStandardShifts/);
  assert.match(api, /syncMasterEmployees/);
  assert.match(api, /Мастер строительно-монтажных работ/);
  assert.match(api, /name IN \('день', 'ночь'\)/);
  assert.match(api, /Смены фиксированы для всех проектов: день и ночь/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS employee_project_assignments/);
  assert.match(api, /payload\.action === "assign-employee-project"/);
  assert.match(api, /Выберите мастера из сотрудников текущего проекта/);
  assert.match(api, /JOIN employee_project_assignments epa/);
  assert.match(api, /entity"\) === "employee-assignment"/);
  assert.match(api, /placementEmployees: placementEmployees\.results/);
  assert.match(api, /SELECT DISTINCT 'employmentType', employment_type FROM position_catalog/);
  assert.match(api, /SELECT DISTINCT 'department', department FROM position_catalog/);
  assert.match(api, /validateEmployeeDirectoryValues/);
  assert.match(api, /position_catalog WHERE employment_type = \? AND department = \? AND position = \? AND active = 1/);
  assert.match(api, /Сочетание типа, отдела и должности отсутствует в справочнике должностей/);

  const app = await readFile(
    new URL("../app/PersonnelApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(app, /Общие настройки/);
  assert.match(app, /Настройки проекта/);
  assert.match(app, /Виды работ/);
  assert.match(app, /ProjectEmployeeAgGrid/);
  assert.match(app, /DirectoryAgGrid/);
  assert.match(app, /Сотрудники проекта/);
  assert.match(app, /downloadProjectEmployeeTemplate/);
  assert.match(app, /downloadProjectDirectoryTemplate/);
  assert.match(app, /importProjectEmployees/);
  assert.match(app, /importProjectDirectory/);
  assert.doesNotMatch(app, /project-settings-summary/);
});

test("loads daily reports without reloading all reference data", async () => {
  const api = await readFile(
    new URL("../app/api/data/route.ts", import.meta.url),
    "utf8",
  );
  const app = await readFile(
    new URL("../app/PersonnelApp.tsx", import.meta.url),
    "utf8",
  );
  const auth = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");
  const database = await readFile(new URL("../db/client.ts", import.meta.url), "utf8");

  assert.match(api, /scope === "entries"/);
  assert.match(api, /scope === "workspace"/);
  assert.match(api, /personnelDatabaseInitializationPromise/);
  assert.match(api, /DATABASE_RUNTIME_BOOTSTRAP/);
  assert.match(app, /scope=entries/);
  assert.match(app, /scope=workspace/);
  assert.match(app, /const loadEntries = useCallback/);
  assert.match(auth, /personnelAuthSchemaPromise/);
  assert.match(auth, /DATABASE_RUNTIME_BOOTSTRAP/);
  assert.doesNotMatch(database, /client\.query\("SELECT 1"\)/);
  assert.match(database, /types\.setTypeParser\(1082, \(value\) => value\)/);
  assert.match(database, /async readBatch/);
  assert.match(api, /env\.DB\.readBatch/);
  assert.match(api, /id = ANY\(\?\)/);
  assert.match(app, /JSON\.stringify\(\{ ids: pendingDeletes \}\)/);
});

test("fills the quick date bar and shifts it five days at a time", async () => {
  const api = await readFile(
    new URL("../app/api/data/route.ts", import.meta.url),
    "utf8",
  );
  const app = await readFile(
    new URL("../app/PersonnelApp.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(app, /function recentDateKeys\(endDate: string, count = 14\)/);
  assert.match(app, /<ReportDateNavigation dates=\{recentDates\}/);
  assert.match(app, /filledDates\.has\(date\)/);
  assert.match(app, /className="calendar-popover"/);
  assert.match(app, /onRangeChange\(moveDate\(rangeEnd, -5\)\)/);
  assert.match(app, /onRangeChange\(moveDate\(rangeEnd, 5\)\)/);
  assert.match(app, /setRangeMotion\("older"\)/);
  assert.match(app, /setRangeMotion\("newer"\)/);
  assert.doesNotMatch(app, /className="archive-date"/);
  assert.match(app, /rangeStart=\$\{recentDates\[0\]\}&rangeEnd=\$\{reportRangeEnd\}/);
  assert.match(api, /function filledDatesStatement/);
  assert.match(api, /SELECT DISTINCT work_date AS "workDate"/);
  assert.match(api, /deleted_at IS NULL/);
  assert.match(styles, /\.quick-date\.filled/);
  assert.match(styles, /background:#ddefe2/);
  assert.match(styles, /box-shadow:inset 0 0 0 2px #78b489/);
  assert.match(styles, /\.report-date-bar/);
  assert.match(styles, /@keyframes quick-dates-from-left/);
  assert.match(styles, /@keyframes quick-dates-from-right/);
});

test("uses the shared accessible select instead of native dropdowns", async () => {
  const select = await readFile(new URL("../app/CustomSelect.tsx", import.meta.url), "utf8");
  const grids = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const filters = await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(select, /createPortal/);
  assert.match(select, /role="listbox"/);
  assert.match(select, /role="option"/);
  assert.match(select, /aria-selected=\{selected\}/);
  assert.match(select, /event\.key === "ArrowDown"/);
  assert.doesNotMatch(grids, /<select\b/);
  assert.doesNotMatch(filters, /<select\b/);
  assert.match(styles, /\.custom-select-menu/);
  assert.match(styles, /\.custom-select-option\.selected/);
});

test("keeps the employee grid compact without duplicated filter controls", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../package.json", import.meta.url), "utf8");

  assert.match(grid, /className="employee-performance-frame"/);
  assert.match(grid, /field: "fullName", headerName: "ФИО"/);
  assert.match(grid, /field: "employmentType", headerName: "Тип"/);
  assert.match(grid, /field: "department", headerName: "Отдел"/);
  assert.match(grid, /field: "position", headerName: "Должность"/);
  assert.match(grid, /field: "siteName", headerName: "Проект"/);
  assert.match(grid, /rowSelection=\{\{ mode: "multiRow"/);
  assert.match(grid, /onSelectionChanged=/);
  assert.match(grid, /if \(!row \|\| row\.kind === "entry"\) return null/);
  assert.doesNotMatch(grid, /headerName: "Сотрудник"/);
  assert.doesNotMatch(grid, /headerName: "Кадровые данные"/);
  assert.doesNotMatch(grid, /headerName: "Назначение"/);
  assert.doesNotMatch(grid, /quickFilterText=/);
  assert.doesNotMatch(grid, /floatingFilterComponent:/);
  assert.doesNotMatch(grid, /floatingFiltersHeight=/);
  assert.doesNotMatch(grid, /groupHeaderHeight=/);
  assert.doesNotMatch(grid, /employee-tool-panel/);
  assert.doesNotMatch(grid, /employee-performance-toolbar/);
  assert.doesNotMatch(styles, /\.employee-tool-panel-tabs/);
  assert.doesNotMatch(styles, /\.employee-quick-filter/);
  assert.doesNotMatch(styles, /\.employee-performance-toolbar/);
  assert.doesNotMatch(manifest, /ag-grid-enterprise/);
});

test("selects employees with checkboxes and deletes them in one validated request", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");

  assert.match(app, /selectedIds=\{employeePendingDeletes\}/);
  assert.match(app, /onSelectionChange=\{\(ids\)/);
  assert.match(app, /deletingLabel="Удалить сотрудников"/);
  assert.match(app, /body: JSON\.stringify\(\{ ids: employeePendingDeletes \}\)/);
  assert.match(api, /SELECT id, full_name AS fullName FROM employees WHERE id = ANY\(\?\) AND active = 1/);
  assert.match(api, /UPDATE employee_project_assignments SET active = 0, end_date = COALESCE/);
  assert.match(api, /UPDATE masters SET active = 0/);
  assert.match(api, /UPDATE employees SET active = 0, site_id = NULL WHERE id = ANY\(\?\) AND active = 1/);
  assert.match(api, /DELETE FROM employees[\s\S]*NOT EXISTS \(SELECT 1 FROM placement_entries WHERE employee_id = employees\.id\)[\s\S]*NOT EXISTS \(SELECT 1 FROM employee_project_assignments WHERE employee_id = employees\.id\)/);
  assert.match(app, /история ранее созданных отчётов сохранится/);
});

test("separates full-row editing from validated bulk editing and can clear the selection", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /editSelectionLabel="Редактировать"/);
  assert.match(app, /bulkEditSelectionLabel="Массовое редактирование"/);
  assert.match(app, /onEditSelection=\{editSelectedEmployeeRows\}/);
  assert.match(app, /onBulkEditSelection=\{openEmployeeBulkEdit\}/);
  assert.match(app, /onCancelEditing=\{cancelEmployeeEditing\}/);
  assert.match(app, /function cancelEmployeeEditing\(\)/);
  assert.match(app, /Выбрано сотрудников:/);
  assert.match(app, /Отменить выделение/);
  assert.match(app, /Отменить редактирование/);
  assert.match(app, /setEmployeePendingDeletes\(\[\]\)/);
  assert.match(app, /Массовое редактирование сотрудников/);
  assert.match(app, /Выберите хотя бы одно поле, которое нужно изменить/);
  assert.match(app, /validPositionCombinations\.has/);
  assert.match(app, /if \(changes\.position === undefined\) return nextDraft/);
  assert.match(app, /data\?\.positionCatalog \?\? \[\]\)\.find/);
  assert.match(app, /employmentType: catalogPosition\.employmentType, department: catalogPosition\.department/);
  assert.match(app, /Применить к таблице/);
  assert.match(app, /Проверьте таблицу и нажмите «Сохранить»/);
  assert.match(app, /employee-selection-bar/);
  assert.match(app, /employee-editing-bar/);
  assert.match(app, /employee-footer-base/);
  assert.match(app, /bulk-edit-selection-button/);
  assert.match(grid, /fullRowEditIds/);
  assert.match(grid, /const showEmployeeRowCancelActions = false/);
  assert.match(grid, /showEmployeeRowCancelActions && props\.drafts\.length/);
  assert.match(grid, /const fullRowEditor/);
  assert.match(grid, /autoOpen=\{activeCellEditor\}/);
  assert.match(styles, /\.employee-selection-actions \.bulk-edit-selection-button/);
  assert.match(styles, /\.employee-footer-base/);
});

test("edits rows on double click and provides spreadsheet-style copy and paste", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const filters = await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/gridFilters.css", import.meta.url), "utf8");
  const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(grid, /onRowDoubleClicked/);
  assert.match(grid, /onCellDoubleClicked/);
  assert.match(grid, /activeEditor\?\.rowKey === row\.rowKey/);
  assert.match(grid, /setActiveEditor\(\{ rowKey: row\.rowKey, field \}\)/);
  assert.match(grid, /currentProps\.onEdit\(row\.employee, changes\)/);
  assert.match(grid, /pastedOptionName\(currentProps\.employmentTypes/);
  assert.match(grid, /нельзя вставить в столбец «Тип»/);
  assert.doesNotMatch(grid, /function DefaultDeleteAction/);
  assert.doesNotMatch(grid, /GridIcon name="pencil"/);
  assert.doesNotMatch(grid, /width: 72, minWidth: 64/);
  assert.match(filters, /SpreadsheetPastePayload/);
  assert.match(filters, /onCopy=\{copySelection\}/);
  assert.match(filters, /onPaste=\{pasteSelection\}/);
  assert.match(filters, /event\.key === "Escape"/);
  assert.match(filters, /spreadsheetSelectionResetKey/);
  assert.match(filters, /clearSelectionOutsideGrid/);
  assert.match(filters, /body\.current\?\.contains\(target\)/);
  assert.match(filters, /sourceRows === 1 \? selectedRows : sourceRows/);
  assert.doesNotMatch(filters, /className="grid-spreadsheet-status"/);
  assert.match(filters, /suppressMovableColumns/);
  assert.match(grid, /suppressMovable: true/);
  assert.match(grid, /onSpreadsheetPaste=\{pasteIntoRow\}/);
  assert.match(styles, /ag-excel-selected/);
  assert.match(globalStyles, /ag-cell-editor-host/);
  assert.match(globalStyles, /\.ag-employee-grid \.editable-row \.ag-cell \{ background:#fafafa; \}/);
  assert.match(globalStyles, /box-shadow:none/);
});

test("validates employee cells before saving directory changes", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  assert.match(app, /const validEmploymentTypes = new Set/);
  assert.match(app, /const validDepartments = new Set/);
  assert.match(app, /const validPositions = new Set/);
  assert.match(app, /const validPositionCombinations = new Set/);
  assert.match(app, /значение «\$\{draft\.employmentType\}» не относится к столбцу «Тип»/);
  assert.match(app, /сочетание типа, отдела и должности отсутствует в справочнике должностей/);
  assert.match(app, /onValidationError=/);
});

test("saves edited placement rows as one validated batch", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /const \[editingRows, setEditingRows\]/);
  assert.match(app, /entries: editingRows\.map/);
  assert.match(app, /onSaveEditing=\{\(\) => void saveEditing\(\)\}/);
  assert.match(api, /Array\.isArray\(payload\.entries\)/);
  assert.match(api, /validateBulkPayloads\(placementUpdates, existing\.results\)/);
  assert.match(api, /existingRows: ExistingPlacementEntry\[\] = \[\]/);
  assert.match(styles, /\.save-edits-button/);
});

test("supports bulk editing in every reference table and refreshes master details", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");

  assert.match(grid, /const draftEmployeeIds = props\.drafts\.map/);
  assert.match(grid, /directory-new-\$\{draft\.key\}/);
  assert.match(app, /const \[directoryDrafts, setDirectoryDrafts\]/);
  assert.match(app, /const \[employeeDrafts, setEmployeeDrafts\]/);
  assert.match(app, /const \[projectEmployeeDrafts, setProjectEmployeeDrafts\]/);
  assert.match(app, /const \[positionDrafts, setPositionDrafts\]/);
  assert.match(app, /const \[siteDrafts, setSiteDrafts\]/);
  assert.match(app, /const \[userDrafts, setUserDrafts\]/);
  assert.match(app, /action: "save-directory-items"/);
  assert.match(app, /drafts=\{employeeDrafts\}/);
  assert.match(app, /drafts=\{positionDrafts\}/);
  assert.match(app, /drafts=\{siteDrafts\}/);
  assert.match(app, /drafts=\{userDrafts\}/);
  assert.match(app, /Сохранить \(\$\{pendingCount\}\)/);
  assert.match(api, /payload\.action === "save-directory-items"/);
  assert.match(api, /await env\.DB\.batch\(statements\)/);
});

test("uses the employee spreadsheet workflow in every general reference table", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");

  assert.match(app, /const \[positionFullRowEditIds, setPositionFullRowEditIds\]/);
  assert.match(app, /const \[userFullRowEditIds, setUserFullRowEditIds\]/);
  assert.match(app, /const \[siteFullRowEditIds, setSiteFullRowEditIds\]/);
  assert.match(app, /<PositionAgGrid[^>]*fullRowEditIds=\{positionFullRowEditIds\}[^>]*onSelectionChange=/);
  assert.match(app, /<UserAgGrid[^>]*fullRowEditIds=\{userFullRowEditIds\}[^>]*onSelectionChange=/);
  assert.match(app, /<ProjectAgGrid[^>]*fullRowEditIds=\{siteFullRowEditIds\}[^>]*onSelectionChange=/);
  assert.ok([...grid.matchAll(/rowSelection=\{\{ mode: "multiRow"/g)].length >= 4);
  assert.ok([...grid.matchAll(/onCellDoubleClicked=/g)].length >= 4);
  assert.ok([...grid.matchAll(/onSpreadsheetPaste=\{pasteIntoRow\}/g)].length >= 4);
  assert.ok([...app.matchAll(/uniformActions/g)].length >= 4);
});

test("uses checkbox selection and footer actions in reports and project settings tables", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");

  const placementGrid = grid.slice(grid.indexOf("export function PlacementAgGrid"), grid.indexOf("type EmployeeTableRow"));
  const projectEmployeeGrid = grid.slice(grid.indexOf("export function ProjectEmployeeAgGrid"), grid.indexOf("type DirectoryTableRow"));
  const directoryGrid = grid.slice(grid.indexOf("export function DirectoryAgGrid"), grid.indexOf("type PositionGridProps"));

  for (const source of [placementGrid, projectEmployeeGrid, directoryGrid]) {
    assert.match(source, /rowSelection=\{\{ mode: "multiRow"/);
    assert.match(source, /onSelectionChanged=/);
    assert.doesNotMatch(source, /colId: "actions"/);
  }
  assert.match(app, /function ReportGridFooter/);
  assert.match(app, /onSelectionChange=\{changeReportSelection\}/);
  assert.match(app, /onSelectionChange=\{changeDirectorySelection\}/);
  assert.match(app, /function editSelectedReportRows\(\)[\s\S]*setEditingRows\(\(current\)/);
  assert.match(app, /function editSelectedDirectoryItems\(\)[\s\S]*setDirectoryDrafts\(\(current\)/);
  assert.doesNotMatch(app, /selected\.forEach\(\(entry\) => startEdit\(entry\)\)/);
  assert.match(grid, /const editingStructureKey = props\.editing\.map/);
  assert.match(grid, /api\.refreshClientSideRowModel\("everything"\)/);
  assert.match(app, /Снять выделение/);
  assert.match(app, /Отменить редактирование/);
});

test("keeps creation, selection, and editing as exclusive table modes", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const projects = await readFile(new URL("../app/ProjectCards.tsx", import.meta.url), "utf8");
  const users = await readFile(new URL("../app/UserAccessCards.tsx", import.meta.url), "utf8");

  assert.match(app, /const showAdd = !editingExisting && deletingCount === 0 && \(allowMultiple \|\| !editorOpen\)/);
  assert.match(app, /editingCount === 0 && selectedCount === 0[^\n]+Добавить запись/);
  assert.ok([...app.matchAll(/editingExisting=\{[^}]+\.some\(\(draft\) => Boolean\(draft\.id\)\)\}/g)].length >= 5);
  assert.match(app, /function addRow[\s\S]*if \(!canEditDate \|\| \(!rosterMode && editingRows\.length\)\) return/);
  assert.match(app, /function addDirectoryItem[\s\S]*directoryDrafts\.some\(\(draft\) => Boolean\(draft\.id\)\)/);
  assert.match(grid, /propsRef\.current\.draftRows\.length === 0 && propsRef\.current\.editing\.length === 0/);
  assert.ok([...grid.matchAll(/propsRef\.current\.drafts\.length === 0 && params\.data\?\.kind === "entry"/g)].length >= 5);
  assert.ok([...grid.matchAll(/row\.kind === "entry" && [^\n]+\.drafts\.some\(\(draft\) => !draft\.id\)/g)].length >= 4);
  for (const source of [projects, users]) {
    assert.match(source, /const editorOpen = drafts\.length > 0/);
    assert.match(source, /disabled=\{editorOpen\}/);
  }
});

test("builds today's report from the active Bitrix24 project roster", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/data/route.ts", import.meta.url), "utf8");

  assert.match(app, /const useDailyRosterReport = true/);
  assert.match(app, /function makeRosterDraft[\s\S]*roster: true, lockedEmployee: true/);
  assert.match(app, /data\.placementEmployees[\s\S]*filter\(\(employee\) => !savedEmployeeIds\.has\(employee\.id\)\)/);
  assert.match(app, /<RosterReportFooter completed=\{rosterCompleted\}/);
  assert.match(app, /Сохранить проверенный отчёт/);
  assert.match(app, /Добавить дополнительную строку/);
  assert.match(app, /function makeCarriedDraft[\s\S]*carriedFromPreviousDay: true/);
  assert.match(app, /function buildRosterDraftRows[\s\S]*previousByEmployee/);
  assert.match(app, /date=\$\{previousDate\}&scope=entries/);
  assert.match(app, /Данные перенесены с/);
  assert.match(grid, /draft\.lockedEmployee[\s\S]*ag-roster-employee/);
  assert.match(grid, /"carried-row"[\s\S]*carriedFromPreviousDay/);
  assert.match(grid, /if \(!props\.rosterMode\) return rows/);
  assert.match(api, /const placementCreates = Array\.isArray\(payload\.newEntries\)/);
  assert.match(api, /validateBulkPayloads\(\[\.\.\.updates, \.\.\.placementCreates\], existing\.results\)/);
  assert.match(api, /updatedCount, createdCount: createRows\.length/);
});

test("shows users as access cards while keeping the grid fallback", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const cards = await readFile(new URL("../app/UserAccessCards.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /const useUserAccessCardLayout = true/);
  assert.match(app, /useUserAccessCardLayout\s*\? <UserAccessCards/);
  assert.match(app, /: <UserAgGrid/);
  assert.match(grid, /export function UserAgGrid/);
  assert.match(cards, /Управление пользователями и правами/);
  assert.match(cards, /Настроить доступ/);
  assert.match(cards, /function UserEditorDialog/);
  assert.match(cards, /Редактирование пользователя/);
  assert.match(cards, /Сохранить изменения/);
  assert.match(cards, /Пользователь \{safeActiveIndex \+ 1\} из \{drafts\.length\}/);
  assert.match(cards, /role="dialog" aria-modal="true"/);
  assert.match(cards, /Личные данные/);
  assert.match(cards, /Роль и доступ/);
  assert.match(cards, /Создать пользователя/);
  assert.match(cards, /onSelectionChange/);
  assert.match(styles, /\.user-access-card\.selected/);
  assert.match(styles, /\.user-access-editor/);
  assert.match(styles, /\.user-create-dialog/);
});

test("shows projects as portfolio cards while keeping the grid fallback", async () => {
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const cards = await readFile(new URL("../app/ProjectCards.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /const useProjectCardLayout = true/);
  assert.match(app, /useProjectCardLayout\s*\? <ProjectCards/);
  assert.match(app, /: <ProjectAgGrid/);
  assert.match(grid, /export function ProjectAgGrid/);
  assert.match(cards, /Портфель проектов/);
  assert.match(cards, /Текущий проект/);
  assert.match(cards, /employeeCounts/);
  assert.match(cards, /foremanCounts/);
  assert.doesNotMatch(cards, /timezoneLabel/);
  assert.doesNotMatch(cards, /Код:/);
  assert.match(styles, /\.project-card\.selected/);
  assert.match(cards, /function ProjectEditorDialog/);
  assert.doesNotMatch(cards, /Предпросмотр карточки/);
  assert.match(cards, /Создать проект/);
  assert.doesNotMatch(cards, /Основная информация/);
  assert.doesNotMatch(cards, /function ProjectEditor\(/);
  assert.match(styles, /\.project-editor-dialog/);
});

test("writes worksheet elements in Excel-compatible order", async () => {
  const xlsx = await readFile(
    new URL("../app/placementXlsx.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    [...xlsx.matchAll(/<\/sheetData><autoFilter[^>]*\/><mergeCells/g)].length,
    3,
  );
  assert.doesNotMatch(xlsx, /<\/sheetData><mergeCells[^]*?<autoFilter/);
  assert.match(xlsx, /export function createTableXlsx/);
  assert.match(xlsx, /export async function parseTableXlsx/);
  assert.match(xlsx, /getElementsByTagNameNS\("\*", name\)/);
  assert.doesNotMatch(xlsx, /getElementsByTagName\("(?:row|c|si|is|v)"\)/);
});
