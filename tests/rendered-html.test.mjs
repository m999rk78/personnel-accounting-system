import { readWorkspaceImplementation, readDataImplementation } from "./fixtures/read-implementation.mjs";
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
  assert.match(html, /<title>Ресурсный отчёт \| Отчёт персонала<\/title>/i);
  assert.match(html, /Ресурсный отчёт/);
  assert.match(html, /Проверяем доступ/);
  assert.match(html, /class="auth-loading"/i);
  assert.doesNotMatch(html, /type="date"/);
  assert.doesNotMatch(html, /compact-pagination/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);

  const app = await readWorkspaceImplementation();
  const authGate = await readFile(
    new URL("../app/AuthGate.tsx", import.meta.url),
    "utf8",
  );
  assert.match(app, /Отчёт персонала/);
  assert.match(app, /PersonnelReportWorkspace/);
  assert.doesNotMatch(app, /useUnifiedPersonnelReport|useDailyRosterReport|useUserAccessCardLayout|useProjectCardLayout/);
  assert.match(authGate, /useSyncExternalStore\(subscribeToHydration, hydratedInBrowser, hydratingOnServer\)/);
  assert.match(authGate, /if \(!hydrated \|\| checking \|\| !user\)/);

  const grid = await readFile(
    new URL("../app/AgDataGrids.tsx", import.meta.url),
    "utf8",
  );
  const gridProvider = await readFile(
    new URL("../app/AgGridEnterpriseProvider.tsx", import.meta.url),
    "utf8",
  );
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(grid, /AgGridReact/);
  assert.match(grid, /headerName: "Подвид работы"/);
  assert.match(grid, /headerName: "Должность"/);
  assert.doesNotMatch(grid, /AllCommunityModule/);
  assert.doesNotMatch(grid, /AgGridProvider/);
  assert.match(gridProvider, /AllCommunityModule/);
  assert.match(gridProvider, /AllEnterpriseModule/);
  assert.match(gridProvider, /configuredLicenseKey \? enterpriseModules : communityModules/);
  assert.match(layout, /process\.env\.AG_GRID_LICENSE_KEY/);
  assert.doesNotMatch(layout, /Using_this_/);
  assert.match(grid, /export function DirectoryAgGrid/);
  assert.match(grid, /selectEmployee/);
  assert.match(grid, /headerName: "ФИО"/);
  assert.match(grid, /headerName: "Тип"/);
  assert.match(grid, /headerName: "Отдел"/);
});

test("protects access with invitations, password hashing, and server sessions", async () => {
  const auth = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");
  const api = await readDataImplementation();
  const login = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  const invitation = await readFile(new URL("../app/invite/page.tsx", import.meta.url), "utf8");
  const password = await readFile(new URL("../app/api/auth/password/route.ts", import.meta.url), "utf8");
  const app = await readWorkspaceImplementation();

  assert.match(auth, /PBKDF2/);
  assert.match(auth, /PASSWORD_ITERATIONS = 600_000/);
  assert.match(auth, /HttpOnly; SameSite=Lax/);
  assert.match(auth, /CREATE TABLE IF NOT EXISTS user_invitations/);
  assert.match(auth, /CREATE TABLE IF NOT EXISTS user_sessions/);
  assert.match(auth, /https:\/\/api\.resend\.com\/emails/);
  assert.match(auth, /https:\/\/postbox\.cloud\.yandex\.net\/v2\/email\/outbound-emails/);
  assert.match(auth, /process\.env\.YANDEX_POSTBOX_API_KEY_ID/);
  assert.match(auth, /nodemailer\.createTransport/);
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
  const api = await readDataImplementation();

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
  const directoryImport = await readFile(new URL("../app/excelDirectoryImports.ts", import.meta.url), "utf8");
  assert.match(api, /prepareEmployeeExcelImport\(payload\.employees/);
  assert.match(directoryImport, /rawProjects\.split/);
  assert.match(directoryImport, /if \(!fullName \|\| !employmentType \|\| !department \|\| !position\)/);
  assert.match(api, /if \(!fullName \|\| !employmentType \|\| !department \|\| !position\)/);
  assert.match(api, /UPDATE employee_project_assignments SET active = 0, end_date = COALESCE\(end_date, DATE\('now'\)\)/);
  assert.match(api, /INSERT INTO employee_project_assignments \(employee_id, site_id, source, start_date\) SELECT \?, \?, 'excel', CURRENT_DATE WHERE NOT EXISTS/);
  assert.match(api, /unassigned: rows\.filter\(row => row\.siteIds\.length === 0\)\.length/);
  assert.match(api, /payload\.action === "import-positions"/);
  assert.match(api, /UPDATE app_users SET active = 0/);
  assert.match(api, /UPDATE employees SET active = 0, site_id = NULL WHERE id = ANY\(\?\) AND active = 1/);
  assert.match(api, /DELETE FROM position_catalog WHERE id = \?/);
  assert.match(api, /repairNumericPersonnelValues/);
  assert.match(api, /ensureStandardShifts/);
  const projectMasters = await readFile(new URL("../app/projectMasters.ts", import.meta.url), "utf8");
  assert.match(api, /await syncProjectMasters\(env\.DB, siteId\)/);
  assert.match(projectMasters, /PROJECT_MASTER_DEPARTMENTS/);
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
  const reportDayWrites = [...api.matchAll(/INSERT INTO placement_report_days[\s\S]*?(?:\.all|\.run)\(\)/g)];
  assert.equal(reportDayWrites.length, 2);
  assert.ok(reportDayWrites.every(([statement]) => statement.endsWith(".all()")), "composite report-day writes must not request a nonexistent id column");

  const app = await readWorkspaceImplementation();
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

test("loads report catalogs once without requesting the removed daily report interface", async () => {
  const api = await readDataImplementation();
  const app = await readWorkspaceImplementation();
  const auth = await readFile(new URL("../app/auth.ts", import.meta.url), "utf8");
  const database = await readFile(new URL("../db/client.ts", import.meta.url), "utf8");

  assert.match(api, /scope === "entries"/);
  assert.match(api, /scope === "workspace"/);
  assert.match(api, /personnelDatabaseInitializationPromise/);
  assert.match(api, /DATABASE_RUNTIME_BOOTSTRAP/);
  assert.match(app, /scope=report-catalog/);
  assert.doesNotMatch(app, /scope=entries|scope=carryover|const loadEntries = useCallback/);
  assert.match(auth, /personnelAuthSchemaPromise/);
  assert.match(auth, /DATABASE_RUNTIME_BOOTSTRAP/);
  assert.doesNotMatch(database, /client\.query\("SELECT 1"\)/);
  assert.match(database, /types\.setTypeParser\(1082, \(value\) => value\)/);
  assert.match(database, /async readBatch/);
  assert.match(api, /env\.DB\.readBatch/);
  assert.match(api, /id = ANY\(\?\)/);
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
  assert.match(select, /role="searchbox"/);
  assert.match(select, /const filteredOptions = useMemo/);
  assert.match(grids, /function DraftSelect[\s\S]*searchable options=/);
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
  assert.match(grid, /const \[searchQuery, setSearchQuery\] = useState\(""\)/);
  assert.match(grid, /onFocus=\{\(event\) => \{[\s\S]*const input = event\.currentTarget[\s\S]*requestAnimationFrame\(\(\) => input\.select\(\)\)/);
  assert.match(grid, /event\.key === "ArrowDown"[\s\S]*event\.stopPropagation\(\)/);
  assert.match(grid, /onClick=\{openMenu\}/);
  assert.match(grid, /field: "employmentType", headerName: "Тип"/);
  assert.match(grid, /field: "department", headerName: "Отдел"/);
  assert.match(grid, /field: "position", headerName: "Должность"/);
  assert.match(grid, /field: "siteName", headerName: "Проект"/);
  assert.match(grid, /rowSelection=\{[^\n]*?\{ mode: "multiRow"/);
  assert.match(grid, /onSelectionChanged=/);
  assert.doesNotMatch(grid, /headerName: "Сотрудник"/);
  assert.doesNotMatch(grid, /headerName: "Кадровые данные"/);
  assert.doesNotMatch(grid, /field: "siteName", headerName: "Назначение"/);
  assert.doesNotMatch(grid, /quickFilterText=/);
  assert.doesNotMatch(grid, /floatingFilterComponent:/);
  assert.doesNotMatch(grid, /floatingFiltersHeight=/);
  assert.doesNotMatch(grid, /groupHeaderHeight=/);
  assert.doesNotMatch(grid, /employee-tool-panel/);
  assert.doesNotMatch(grid, /employee-performance-toolbar/);
  assert.doesNotMatch(styles, /\.employee-tool-panel-tabs/);
  assert.doesNotMatch(styles, /\.employee-quick-filter/);
  assert.doesNotMatch(styles, /\.employee-performance-toolbar/);
  assert.match(manifest, /"ag-grid-enterprise": "36\.2\.0"/);
  assert.match(manifest, /"ag-grid-react": "36\.2\.0"/);
});

test("selects employees with checkboxes and deletes them in one validated request", async () => {
  const app = await readWorkspaceImplementation();
  const api = await readDataImplementation();

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
  const app = await readWorkspaceImplementation();
  const adminFooter = await readFile(new URL("../app/AdminGridFooter.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /editSelectionLabel="Редактировать"/);
  assert.match(app, /bulkEditSelectionLabel="Массовое редактирование"/);
  assert.match(app, /onEditSelection=\{editSelectedEmployeeRows\}/);
  assert.match(app, /onBulkEditSelection=\{openEmployeeBulkEdit\}/);
  assert.match(app, /onCancelEditing=\{cancelEmployeeEditing\}/);
  assert.match(app, /function cancelEmployeeEditing\(\)/);
  assert.match(app, /Выбрано сотрудников:/);
  assert.match(adminFooter, /Отменить выделение/);
  assert.match(adminFooter, /Отменить редактирование/);
  assert.match(app, /setEmployeePendingDeletes\(\[\]\)/);
  assert.match(app, /Массовое редактирование сотрудников/);
  assert.match(app, /Выберите хотя бы одно поле, которое нужно изменить/);
  assert.match(app, /validPositionCombinations\.has/);
  assert.match(app, /if \(changes\.position === undefined\) return nextDraft/);
  assert.match(app, /data\?\.positionCatalog \?\? \[\]\)\.find/);
  assert.match(app, /employmentType: catalogPosition\.employmentType, department: catalogPosition\.department/);
  assert.match(app, /Применить к таблице/);
  assert.match(app, /Проверьте таблицу и нажмите «Сохранить»/);
  assert.match(adminFooter, /employee-selection-bar/);
  assert.match(adminFooter, /employee-editing-bar/);
  assert.match(adminFooter, /employee-footer-base/);
  assert.match(adminFooter, /bulk-edit-selection-button/);
  assert.match(grid, /fullRowEditIds/);
  assert.match(grid, /function EditableCellDisplay/);
  assert.match(grid, /onSpreadsheetEdit=\{\(\{ row, columnId \}\) => openCellEditor\(row, columnId\)\}/);
  assert.match(styles, /\.employee-selection-actions \.bulk-edit-selection-button/);
  assert.match(styles, /\.employee-footer-base/);
});

test("edits rows on double click and provides spreadsheet-style copy and paste", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const filters = await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/gridFilters.css", import.meta.url), "utf8");
  const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(grid, /onCellDoubleClicked/);
  assert.match(grid, /onSpreadsheetEdit/);
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
  assert.match(filters, /undoSpreadsheetChange/);
  assert.match(filters, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(filters, /rememberCellUndo/);
  assert.match(filters, /Отменено изменений/);
  assert.match(filters, /ArrowLeft: \{ row: 0, column: -1 \}/);
  assert.match(filters, /ArrowRight: \{ row: 0, column: 1 \}/);
  assert.match(filters, /ArrowUp: \{ row: -1, column: 0 \}/);
  assert.match(filters, /ArrowDown: \{ row: 1, column: 0 \}/);
  assert.match(filters, /event\.shiftKey && event\.key !== "Tab" && selectionRef\.current/);
  assert.match(filters, /api\.ensureIndexVisible\(nextRowIndex\)/);
  assert.match(filters, /api\.ensureColumnVisible\(columns\[nextColumnIndex\]\)/);
  assert.match(filters, /rowId: event\.node\.id/);
  assert.match(filters, /api\.getRowNode\(current\.rowId\)/);
  assert.match(filters, /event\.key === "Escape"/);
  assert.match(filters, /spreadsheetSelectionResetKey/);
  assert.match(filters, /spreadsheetFocusRequestKey/);
  assert.match(filters, /lastSelectionRef/);
  assert.match(filters, /selectionToRestore/);
  assert.match(filters, /body\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(filters, /target\.closest\("\.custom-select-menu,\.ag-employee-menu,\.table-context-menu,\.personnel-spreadsheet-tools"\)/);
  assert.match(filters, /clearSelectionOutsideGrid/);
  assert.match(filters, /clearSelectionOnEmptySpace/);
  assert.match(filters, /onPointerDown=\{clearSelectionOnEmptySpace\}/);
  assert.match(filters, /body\.current\?\.contains\(target\)/);
  assert.match(filters, /sourceRows === 1 \? selectedRows : sourceRows/);
  assert.doesNotMatch(filters, /className="grid-spreadsheet-status"/);
  assert.match(filters, /suppressMovableColumns/);
  assert.match(grid, /suppressMovable: true/);
  assert.match(grid, /onSpreadsheetPaste=\{pasteIntoRow\}/);
  assert.match(grid, /spreadsheetFocusRequestKey=\{spreadsheetFocusRequestKey\}/);
  assert.match(grid, /setSpreadsheetFocusRequestKey\(\(key\) => key \+ 1\)/);
  const textEditor = await readFile(new URL("../app/GridTextEditor.tsx", import.meta.url), "utf8");
  assert.match(grid, /GridTextEditor/);
  assert.doesNotMatch(grid, /api\.redrawRows\(/);
  assert.match(textEditor, /createCellTextEditSession/);
  assert.match(textEditor, /onBlur=\{\(\) => \{ commit\(\); onBlur\?\.\(\); \}\}/);
  assert.doesNotMatch(textEditor, /onChange=\{/);
  assert.match(filters, /suppressKeyboardEvent:.*isInteractiveTarget/);
  assert.match(textEditor, /event\.key !== "Enter"/);
  assert.match(styles, /ag-excel-selected/);
  assert.match(globalStyles, /ag-cell-editor-host/);
  assert.match(globalStyles, /\.ag-employee-grid \.editable-row \.ag-cell \{ background:#fafafa; \}/);
  assert.match(globalStyles, /box-shadow:none/);
});

test("adds richer filters, multi-column sorting, and persistent employee row ordering", async () => {
  const filters = await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8");
  const filterModel = await readFile(new URL("../app/gridFilterModel.ts", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readWorkspaceImplementation();
  const api = await readDataImplementation();
  const migration = await readFile(new URL("../drizzle-postgres/0018_employee_manual_order.sql", import.meta.url), "utf8");

  assert.match(filterModel, /containsAllWords/);
  assert.match(filterModel, /containsAnyWord/);
  assert.match(filterModel, /notStartsWith/);
  assert.match(filterModel, /notEndsWith/);
  assert.match(filterModel, /Intl\.Collator\("ru-RU", \{ numeric: true/);
  assert.match(filters, /Сохранить сортировку других колонок/);
  assert.match(filters, /По алфавиту: от Я до А/);
  assert.match(filters, /sortIndex/);
  assert.match(filters, /grid-sort-chip/);
  assert.match(filters, /columnId !== "rowOrder"/);
  assert.match(filters, /source\?: "paste" \| "undo"/);
  assert.match(filters, /refreshCells\(\{ force: true \}\)/);
  assert.doesNotMatch(filters, /colId: "rowOrder"/);
  assert.match(filters, /cellRenderer: SelectionRowDragRenderer/);
  assert.match(filters, /rowDragManaged=\{false\}/);
  assert.match(filters, /onRowDragEnd/);
  assert.match(grid, /onReorder: \(employeeIds: number\[\]\) => Promise<void>/);
  assert.match(app, /action: "reorder-employees"/);
  assert.match(api, /payload\.action === "reorder-employees"/);
  assert.match(api, /Список сотрудников изменился\. Обновите таблицу и повторите перенос строки/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "sort_order"/);
  assert.match(migration, /idx_employees_active_sort_order/);
});

test("validates employee cells before saving directory changes", async () => {
  const app = await readWorkspaceImplementation();
  assert.match(app, /const validEmploymentTypes = new Set/);
  assert.match(app, /const validDepartments = new Set/);
  assert.match(app, /const validPositions = new Set/);
  assert.match(app, /const validPositionCombinations = new Set/);
  assert.match(app, /значение «\$\{draft\.employmentType\}» не относится к столбцу «Тип»/);
  assert.match(app, /сочетание типа, отдела и должности отсутствует в справочнике должностей/);
  assert.match(app, /onValidationError=/);
});

test("supports bulk editing in every reference table and refreshes master details", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readWorkspaceImplementation();
  const adminFooter = await readFile(new URL("../app/AdminGridFooter.tsx", import.meta.url), "utf8");
  const api = await readDataImplementation();

  assert.match(grid, /const draftEmployeeIds = props\.drafts\.map/);
  assert.match(grid, /usage = EMPTY_EMPLOYEE_USAGE/);
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
  assert.match(adminFooter, /Сохранить \(\$\{pendingCount\}\)/);
  assert.match(api, /payload\.action === "save-directory-items"/);
  assert.match(api, /await env\.DB\.batch\(statements\)/);
});

test("uses spreadsheet editing for positions and the active reference tables", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readWorkspaceImplementation();

  assert.match(app, /const \[positionFullRowEditIds, setPositionFullRowEditIds\]/);
  assert.match(app, /<PositionAgGrid[^>]*fullRowEditIds=\{positionFullRowEditIds\}[^>]*onSelectionChange=/);
  assert.ok([...grid.matchAll(/rowSelection=\{[^\n]*?\{ mode: "multiRow"/g)].length >= 2);
  assert.ok([...grid.matchAll(/onCellDoubleClicked=/g)].length >= 2);
  assert.ok([...grid.matchAll(/onSpreadsheetPaste=\{pasteIntoRow\}/g)].length >= 2);
  assert.ok([...app.matchAll(/uniformActions/g)].length >= 4);
});

test("uses checkbox selection and footer actions in reports and project settings tables", async () => {
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const app = await readWorkspaceImplementation();

  const reportGrid = await readFile(new URL("../app/PersonnelReportGrid.tsx", import.meta.url), "utf8");
  const projectEmployeeGrid = grid.slice(grid.indexOf("export function ProjectEmployeeAgGrid"), grid.indexOf("type DirectoryTableRow"));
  const directoryGrid = grid.slice(grid.indexOf("export function DirectoryAgGrid"), grid.indexOf("type PositionGridProps"));

  for (const source of [reportGrid, projectEmployeeGrid, directoryGrid]) {
    assert.match(source, /rowSelection=\{[^\n]*?\{ mode: "multiRow"/);
    assert.match(source, /onSelectionChanged=/);
    assert.doesNotMatch(source, /colId: "actions"/);
  }
  assert.match(app, /onSelectionChange=\{changeDirectorySelection\}/);
  assert.match(app, /function editSelectedDirectoryItems\(\)[\s\S]*setDirectoryDrafts\(\(current\)/);
  assert.doesNotMatch(app, /selected\.forEach\(\(entry\) => startEdit\(entry\)\)/);
  assert.match(grid, /api\.refreshClientSideRowModel\("everything"\)/);
});

test("offers permission-aware right-click actions throughout system tables", async () => {
  const filters = await readFile(new URL("../app/GridFilters.tsx", import.meta.url), "utf8");
  const clipboard = await readFile(new URL("../app/useTimesheetClipboard.ts", import.meta.url), "utf8");
  const timesheet = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
  const equipment = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const reportGrid = await readFile(new URL("../app/PersonnelReportGrid.tsx", import.meta.url), "utf8");

  assert.match(reportGrid, /Скопировать строку на сегодня/);
  assert.match(filters, /onContextMenu=\{openContextMenu\}/);
  assert.match(filters, /Копировать ячейку/);
  assert.match(filters, /Вставить в ячейку/);
  assert.match(filters, /Редактировать ячейку/);
  assert.match(filters, /Выбрать строку для действий/);
  assert.match(clipboard, /onContextMenu: \(event: MouseEvent<HTMLTableCellElement>\)/);
  assert.match(clipboard, /Удалить ручное значение/);
  assert.match(timesheet, /contextMenu: clipboardContextMenu/);
  assert.match(equipment, /contextMenu: timesheetClipboardContextMenu/);
  assert.match(styles, /\.table-context-menu/);
});

test("keeps creation, selection, and editing as exclusive table modes", async () => {
  const app = await readWorkspaceImplementation();
  const adminFooter = await readFile(new URL("../app/AdminGridFooter.tsx", import.meta.url), "utf8");
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const projects = await readFile(new URL("../app/ProjectCards.tsx", import.meta.url), "utf8");
  const users = await readFile(new URL("../app/UserAccessCards.tsx", import.meta.url), "utf8");

  assert.match(adminFooter, /const showAdd = canCreate && !editorOpen && !editingExisting && deletingCount === 0/);
  assert.match(adminFooter, /!editorOpen && deletingCount === 0 && <div className="employee-footer-base">/);
  assert.ok([...app.matchAll(/editingExisting=\{[^}]+\.some\(\(draft\) => Boolean\(draft\.id\)\)\}/g)].length >= 5);
  assert.match(app, /function addDirectoryItem[\s\S]*directoryDrafts\.some\(\(draft\) => Boolean\(draft\.id\)\)/);
  assert.ok([...grid.matchAll(/propsRef\.current\.drafts\.length === 0 && params\.data\?\.kind === "entry"/g)].length >= 3);
  assert.ok([...grid.matchAll(/row\.kind === "entry" && [^\n]+\.drafts\.some\(\(draft\) => !draft\.id\)/g)].length >= 2);
  for (const source of [projects, users]) {
    assert.match(source, /const editorOpen = drafts\.length > 0/);
    assert.match(source, /disabled=\{editorOpen\}/);
  }
});

test("shows users as a compact list with profile editing", async () => {
  const app = await readWorkspaceImplementation();
  const cards = await readFile(new URL("../app/UserAccessCards.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /<UserAccessCards layout="list"/);
  assert.match(cards, /Пользователи системы/);
  assert.match(cards, />Редактировать</);
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
  assert.match(styles, /\.user-create-dialog/);
});

test("shows projects as portfolio cards", async () => {
  const cards = await readFile(new URL("../app/ProjectCards.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

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

test("checks Bitrix24 read-only and links only explicitly confirmed employee matches", async () => {
  const app = await readWorkspaceImplementation();
  const grid = await readFile(new URL("../app/AgDataGrids.tsx", import.meta.url), "utf8");
  const api = await readDataImplementation();
  assert.match(app, /Проверить с Битрикс24/);
  assert.match(app, /ДАННЫЕ НЕ ИЗМЕНЕНЫ/);
  assert.match(app, /Нужно проверить сотрудников/);
  assert.match(app, /Требуют внимания/);
  assert.match(app, /bitrix-review-layout/);
  assert.match(app, /selectedBitrixDifferenceIndex/);
  assert.match(app, /Выбранный сотрудник/);
  assert.match(app, /Что обнаружено/);
  assert.match(app, /Сопоставить автоматически/);
  assert.match(app, /link-bitrix24-employees/);
  assert.match(app, /create-bitrix24-employee/);
  assert.match(app, /Добавить из Битрикс24/);
  assert.match(app, /Без объекта/);
  assert.match(app, /ariaLabel="Объект нового сотрудника"/);
  assert.doesNotMatch(app, /label: `\$\{site\.name\} · \$\{site\.code\}`/);
  assert.match(app, /Изменить/);
  assert.match(app, /Подтвердить предупреждение/);
  assert.match(app, /Актуализировать с Битрикс24/);
  assert.match(app, /update-selected-bitrix24-employees/);
  assert.match(app, /acknowledge-selected-bitrix24-differences/);
  assert.match(app, /selectedBitrixUpdatableEmployees/);
  assert.match(app, /selectedBitrixWarningEmployees/);
  assert.match(app, /differenceCounts/);
  assert.match(app, /Отличаются данные/);
  assert.match(app, /Уволены/);
  assert.match(app, /delete-bitrix24-employee/);
  assert.match(grid, /Не совпадает с Битрикс24/);
  assert.match(grid, /Отсутствует в Битрикс24/);
  assert.match(grid, /Уволен в Битрикс24/);
  assert.match(grid, /Проверка Б24 \/ расхождение/);
  assert.match(grid, /bitrix-grid-details/);
  assert.match(grid, /bitrix-mismatch-row/);
  assert.match(grid, /bitrix-missing-row/);
  assert.match(grid, /bitrix-dismissed-row/);
  assert.match(app, /bitrixManualLinks/);
  assert.match(app, /Изменения применяются только после выбора действия/);
  assert.match(app, /Добавить сотрудника/);
  assert.match(app, /Обновить из Битрикс24/);
  assert.match(app, /Оставить как есть/);
  assert.doesNotMatch(app, />Прочитано</);
  assert.doesNotMatch(app, />Сравнено</);
  assert.doesNotMatch(app, /"Стадия в Битрикс24"/);
  assert.doesNotMatch(grid, /headerName: "Стадия в Битрикс24"/);
  assert.doesNotMatch(grid, /employee\.bitrix24Stage/);
  assert.doesNotMatch(grid, /row\.employee\?\.source === "bitrix24"/);
  assert.doesNotMatch(grid, /params\.data\.employee\?\.source !== "bitrix24"/);
  assert.match(app, /allEmployees=\{data\?\.employees \?\? \[\]\}/);
  assert.match(api, /suggestBitrixEmployeeLinks/);
  assert.match(api, /payload\.action === "link-bitrix24-employees"/);
  assert.match(api, /payload\.action === "create-bitrix24-employee"/);
  assert.match(api, /payload\.action === "update-bitrix24-employee"/);
  assert.match(api, /payload\.action === "update-selected-bitrix24-employees"/);
  assert.match(api, /payload\.action === "acknowledge-selected-bitrix24-differences"/);
  assert.match(api, /updateBitrixEmployeeRecord\(sourceSnapshot, row\.id, row\.bitrix24Id\)/);
  assert.match(api, /check_state\.status AS "checkStatus"/);
  assert.match(api, /acknowledgedCount/);
  assert.match(api, /payload\.action === "delete-bitrix24-employee"/);
  assert.match(api, /payload\.action === "acknowledge-bitrix24-difference"/);
  assert.match(api, /bitrix24_employee_check_states/);
  assert.match(api, /differenceCounts/);
  assert.match(api, /RETURNING employee_id/);
  assert.match(api, /JSON\.stringify\(\[state\.status, details\]\)/);
  assert.match(api, /Используйте сопоставление, чтобы не создавать дубль/);
  assert.match(api, /INSERT INTO employee_profile_versions/);
  assert.match(api, /INSERT INTO employee_availability_periods/);
  assert.match(api, /WHERE id = \? AND active = 1 AND bitrix24_id IS NULL/);
  assert.match(api, /bitrix24_stage = \?/);
  assert.match(api, /sourceById\.get\(link\.bitrix24Id\)/);
  assert.doesNotMatch(api, /Рабочий не найден или управляется Битрикс24/);
  assert.doesNotMatch(api, /Карточки сотрудников, связанные с Битрикс24, доступны только для чтения/);
});

test("writes worksheet elements in Excel-compatible order", async () => {
  const xlsx = await readFile(
    new URL("../app/placementXlsx.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    [...xlsx.matchAll(/<\/sheetData><autoFilter[^>]*\/><mergeCells/g)].length,
    2,
  );
  assert.doesNotMatch(xlsx, /<\/sheetData><mergeCells[^]*?<autoFilter/);
  assert.match(xlsx, /export function createTableXlsx/);
  assert.match(xlsx, /export async function parseTableXlsx/);
  assert.match(xlsx, /getElementsByTagNameNS\("\*", name\)/);
  assert.doesNotMatch(xlsx, /getElementsByTagName\("(?:row|c|si|is|v)"\)/);
});

test("selects personnel and equipment export ranges directly in one calendar", async () => {
  const preview = await readFile(new URL("../app/ExcelExportPreview.tsx", import.meta.url), "utf8");
  const api = await readDataImplementation();
  const equipmentApi = await readFile(new URL("../app/api/equipment/route.ts", import.meta.url), "utf8");
  const equipmentView = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");
  const xlsx = await readFile(new URL("../app/placementXlsx.ts", import.meta.url), "utf8");

  assert.match(preview, /aria-label="Выбор периода отчёта"/);
  assert.match(preview, /selectCalendarDay/);
  assert.match(preview, /Весь месяц/);
  assert.match(preview, /Теперь выберите последнюю дату/);
  assert.match(preview, /scope: "export-range"/);
  assert.doesNotMatch(preview, /type="(?:date|month)"/);
  assert.match(api, /function placementEntriesForRangeStatement/);
  assert.match(api, /pe\.work_date >= \? AND pe\.work_date <= \?/);
  assert.match(api, /scope === "export-range"/);
  assert.match(preview, /\/api\/equipment\?\$\{query\.toString\(\)\}/);
  assert.match(preview, /excelFileName\("Отчёт техники", \[payload\.source\.siteName, suffix\]\)/);
  assert.match(equipmentApi, /scope === "export-range"/);
  assert.match(equipmentApi, /ee\.work_date >= \? AND ee\.work_date <= \?/);
  assert.match(equipmentView, /kind: "equipment"/);
  assert.match(xlsx, /"Виды основных работ"/);
  assert.match(xlsx, /"Тип - 2"/);
  assert.match(xlsx, /sheet1Name = "Расстановка"/);
  assert.match(xlsx, /"Расстановка1"/);
  assert.match(xlsx, /"Расстановка2"/);
  assert.match(xlsx, /SUBTOTAL\(9,J4:J\$\{lastRow\}\)/);
  assert.match(xlsx, /SUBTOTAL\(9,I4:I\$\{lastRow\}\)/);
  assert.match(preview, /excel-template-preview-table/);
  assert.match(preview, /ИТОГО ПО ФИЛЬТРУ/);
  assert.match(preview, /kind: "equipment-placement"/);
});

test("previews personnel and equipment timesheets before downloading Excel", async () => {
  const preview = await readFile(new URL("../app/ExcelExportPreview.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../app/excelExportPreviewStore.ts", import.meta.url), "utf8");
  const personnel = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
  const equipment = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");

  assert.match(store, /kind: "personnel-timesheet"/);
  assert.match(store, /kind: "equipment-timesheet"/);
  assert.match(personnel, /openExcelExportPreview/);
  assert.match(personnel, /kind: "personnel-timesheet"/);
  assert.match(equipment, /kind: "equipment-timesheet"/);
  assert.match(preview, /createPersonnelTimesheetXlsx/);
  assert.match(preview, /createEquipmentTimesheetXlsx/);
  assert.match(preview, /payload\.workbook\.kind === "personnel-timesheet"/);
  assert.match(preview, /selectPersonnelTimesheetRange/);
  assert.match(preview, /selectEquipmentTimesheetRange/);
  assert.match(preview, /buildPersonnelTimesheetRange/);
  assert.match(preview, /buildEquipmentTimesheetRange/);
  assert.match(preview, /monthKeysInRange/);
  assert.match(preview, /\/api\/timesheet\?/);
  assert.match(preview, /view: "timesheet"/);
  assert.doesNotMatch(preview, /disabled=\{unavailable\}/);
  assert.match(preview, /rangeEnabled/);
  assert.match(preview, /Скачать Excel/);
});

test("previews every settings table export before downloading Excel", async () => {
  const personnel = await readWorkspaceImplementation();
  const equipment = await readFile(new URL("../app/EquipmentAccountingView.tsx", import.meta.url), "utf8");

  assert.match(personnel, /function openSettingsExportPreview/);
  assert.match(personnel, /function exportEmployees/);
  assert.match(personnel, /function exportPositions/);
  assert.match(personnel, /function exportProjectEmployees/);
  assert.match(personnel, /function exportProjectDirectory/);
  assert.match(personnel, /function exportProjects/);
  assert.match(personnel, /function exportUsers/);
  assert.match(personnel, /id="project-equipment-actions"/);
  assert.match(personnel, /workbook: \{ kind: "table"/);
  assert.match(equipment, /function openRegistryExportPreview/);
  assert.match(equipment, /function openProjectEquipmentExportPreview/);
  assert.match(equipment, /section === "project" \? "project-equipment-actions"/);
  assert.match(equipment, /title: "Техника проекта"/);
  assert.match(equipment, /workbook: \{ kind: "table"/);
});
