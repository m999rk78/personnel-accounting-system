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
  assert.match(api, /payload\.action === "import-positions"/);
  assert.match(api, /UPDATE app_users SET active = 0/);
  assert.match(api, /DELETE FROM employees WHERE id = \?/);
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
  assert.match(database, /async readBatch/);
  assert.match(api, /env\.DB\.readBatch/);
  assert.match(api, /id = ANY\(\?\)/);
  assert.match(app, /JSON\.stringify\(\{ ids: pendingDeletes \}\)/);
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
});
