// Browser check of the actual workspace and timesheet with synthetic HTTP responses.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3171);
const fixtures = new URL("../tests/fixtures/", import.meta.url);
const config = {
  configFile: false,
  envDir: false,
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  root: fileURLToPath(fixtures),
  plugins: [react()],
  build: {
    outDir: await mkdtemp(join(tmpdir(), "personnel-timesheet-periods-")),
    emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("workspace-header.html", fixtures)) },
  },
  preview: { host: "127.0.0.1", port, strictPort: true },
};
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8_000);
  const errors = [];
  const requests = [];
  const unmocked = [];
  page.on("pageerror", error => errors.push(error.message));

  const site = { id: 1, name: "Учебный проект", code: "TEST", timezone: "Europe/Moscow" };
  const employees = ["Новый сотрудник", "Уволенный сотрудник", "Переведённый сотрудник", "Постоянный сотрудник", "Исторический инженер", "Сотрудник без даты", "Сотрудник с отметкой"].map((fullName, index) => ({
    id: index + 1, fullName, employmentType: index === 4 ? "ИТР" : "ОПР", department: "МУТТ", position: index === 4 ? "Инженер" : "Монтажник", source: "manual", siteId: site.id, siteName: site.name,
  }));
  const period = (startDate, endDate) => ({ startDate, endDate });
  const novemberPeriods = new Map([
    [1, period("2026-11-12", "2026-12-01")],
    [2, period("2026-11-01", "2026-11-12")],
    [3, period("2026-11-01", "2026-11-18")],
    [4, period("2026-11-01", "2026-12-01")],
  ]);
  const novemberReports = new Map([[1, ["2026-11-03"]], [5, ["2026-11-09"]]]);
  let revision = 0;
  const mark = (employeeId, workDate, code) => ({ employeeId, workDate, hours: null, code, note: "Историческая отметка", updatedBy: "Проверка", revision: `v${++revision}` });
  const marks = new Map([
    ["2:2026-11-12", mark(2, "2026-11-12", "УВ")],
    ["3:2026-11-18", mark(3, "2026-11-18", "ПЕ")],
    ["7:2026-11-14", mark(7, "2026-11-14", "В")],
  ]);
  const posted = [];
  let holdWrite;
  const data = {
    sites: [site], employees, projectEmployees: employees, placementEmployees: employees, reportEmployees: employees,
    positionCatalog: [], positions: [], employmentTypes: [], departments: [], users: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [],
    masters: [], entries: [], filledDates: [], employeeUsage: [], foremanProgress: [], timesheetMarks: [], reportSubmitted: false, projectStats: [],
    bitrix24Cooldowns: { inspect: { nextAllowedAt: null }, sync: { nextAllowedAt: null } },
  };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/timesheet") {
      const { employeeId, workDate, value, expectedRevision, allowRosterRemoval } = request.postDataJSON();
      posted.push({ employeeId, workDate, value, expectedRevision, allowRosterRemoval });
      if (holdWrite) await holdWrite;
      const key = `${employeeId}:${workDate}`;
      if (expectedRevision !== (marks.get(key)?.revision ?? null)) return route.fulfill({ status: 409, json: { error: "Эта ячейка уже изменена." } });
      if (!value) {
        marks.delete(key);
        return route.fulfill({ json: { deleted: true, employeeId, workDate } });
      }
      const savedMark = mark(employeeId, workDate, value);
      marks.set(key, savedMark);
      return route.fulfill({ json: { mark: savedMark } });
    }
    if (request.method() === "GET") {
      if (url.pathname === "/api/data") return route.fulfill({ json: data });
      if (url.pathname === "/api/table-order") return route.fulfill({ json: { ids: [1, 2, 3, 4, 5, 6, 7], importIds: [4, 1, 2, 3, 5, 6, 7], canWrite: false, hasSavedOrder: false, hasImportOrder: true } });
      if (url.pathname === "/api/timesheet") {
        const month = url.searchParams.get("month");
        const roster = url.searchParams.get("roster");
        const siteId = url.searchParams.get("siteId");
        requests.push({ month, roster, siteId });
        const november = month === "2026-11";
        const displayed = november ? employees.filter(employee => employee.id !== 7 || marks.has("7:2026-11-14")).map(employee => {
          const { id } = employee;
          const days = Array.from({ length: 30 }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
          const assignment = novemberPeriods.get(id);
          const reportDates = novemberReports.get(id) ?? [];
          const outsideDates = assignment ? days.filter(day => (day < assignment.startDate || day >= assignment.endDate) && !reportDates.includes(day) && !marks.has(`${id}:${day}`)) : [];
          return { ...employee, reportDates, profileSource: reportDates.length ? "report" : "directory", profileDate: reportDates.at(-1) ?? null, roster: {
            included: true, periods: assignment ? [assignment] : [], outsideDates,
            unknownDates: assignment ? [] : days.filter(day => !reportDates.includes(day) && !marks.has(`${id}:${day}`)),
            conflictDates: id === 1 ? reportDates : [],
            warnings: id === 1 ? ["Подтверждённый отчёт до даты назначения"] : id === 6 ? ["Дата назначения неизвестна"] : [],
            reason: id === 5 || id === 7 ? "history" : "assignment",
          } };
        }) : month === "2026-12" ? employees.filter(employee => employee.id === 1 || employee.id === 4 && !marks.has("4:2026-11-20")).map(employee => ({
          ...employee, reportDates: [], roster: { included: true, periods: [period("2026-12-01", "2027-01-01")], outsideDates: [], unknownDates: [], conflictDates: [], warnings: [], reason: "assignment" },
        })) : [];
        return route.fulfill({ json: {
          siteId: site.id, siteName: site.name, month, employees: displayed,
          canEdit: true, canCreate: true, canUpdate: true, canDelete: true,
          entries: november ? [{ employeeId: 1, workDate: "2026-11-03", hours: 8, masters: "Мастер", zones: "Зона" }] : [],
          marks: november ? [...marks.values()] : [],
        } });
      }
    }
    unmocked.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: "Этот запрос не подключён к стенду." } });
  });

  const summary = page.locator(".personnel-timesheet-summary");
  const table = page.locator(".personnel-timesheet-table");
  const row = name => table.locator("tbody tr[data-virtual-row]").filter({ has: page.getByText(name, { exact: true }) });
  const cell = (name, day) => row(name).locator(`[data-timesheet-column="${day - 1}"]`);
  const value = (name, day) => cell(name, day).locator(".timesheet-cell-value").textContent();
  const excel = page.getByRole("button", { name: "Excel", exact: true });
  const exportAction = page.getByRole("menuitem", { name: "Экспорт в Excel", exact: true });
  async function ready(month, employeeCount) {
    await page.waitForFunction(({ month, employeeCount }) => {
      const summary = document.querySelector(".personnel-timesheet-summary");
      return summary?.getAttribute("aria-busy") === "false" && summary.getAttribute("aria-label")?.includes(month)
        && document.querySelectorAll(".personnel-timesheet-table tbody tr[data-virtual-row]").length === employeeCount;
    }, { month, employeeCount });
  }
  async function assertNovemberHistory() {
    assert.equal(await value("Новый сотрудник", 3), "8");
    assert.equal(await value("Уволенный сотрудник", 12), "УВ");
    assert.equal(await value("Переведённый сотрудник", 18), "ПЕ");
    assert.equal(await table.locator(".assignment-conflict, .outside-assignment, .personnel-timesheet-roster-warning").count(), 0, "Retrospective entries are not flagged by assignment dates");
    assert.match(await cell("Новый сотрудник", 3).getAttribute("title"), /Отчёт рабочих: 8 ч/);
    assert.equal(await value("Исторический инженер", 9), "", "A non-OPR report does not create hours");
    assert.equal(await cell("Исторический инженер", 9).getByRole("img", { name: "Подтверждённый отчёт" }).count(), 1);
    assert.match(await cell("Исторический инженер", 9).getAttribute("title"), /Часы этого типа персонала заполняются вручную/);
    assert.equal(await summary.getByText("С отчётами", { exact: true }).locator("..").locator("strong").textContent(), "2");
    assert.equal(await summary.locator(".productive strong").textContent(), "8 ч.");
  }

  await page.goto(`http://127.0.0.1:${port}/workspace-header.html?route=${encodeURIComponent("/timesheets/workers?month=2026-11")}`);
  await ready("Ноябрь", 7).catch(async error => {
    const screen = await page.locator("body").innerText();
    throw new Error(`Timesheet did not load: ${JSON.stringify({ requests, unmocked, errors, screen: screen.slice(0, 1800) })}`, { cause: error });
  });
  assert.equal(await page.getByRole("combobox", { name: "Режим расчёта табеля", exact: true }).count(), 0);
  assert.equal(await table.count(), 1);
  assert.equal(await value("Новый сотрудник", 11), "");
  assert.equal(await cell("Новый сотрудник", 11).getAttribute("title"), "");
  await page.waitForFunction(() => document.querySelector(".personnel-timesheet-table tbody tr[data-virtual-row] th[scope=row]")?.textContent?.includes("Постоянный сотрудник"));
  assert.match(await row("Новый сотрудник").locator("th[scope=row]").getAttribute("title"), /С 12 ноября 2026 г\. по 30 ноября 2026 г\./);
  assert.match(await row("Исторический инженер").locator("th[scope=row]").getAttribute("title"), /Данные сотрудника из отчёта за 9 ноября 2026 г\./);
  assert.match(await row("Сотрудник без даты").locator("th[scope=row]").getAttribute("title"), /Текущие данные из справочника сотрудников/);
  const background = name => cell(name, 11).evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(await background("Новый сотрудник"), await background("Постоянный сотрудник"), "Empty cells remain visually neutral across assignment dates");
  await assertNovemberHistory();
  if (process.argv[4]) await page.screenshot({ path: process.argv[4] });

  await page.getByRole("button", { name: "Информация", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Как формируется табель" });
  assert.match(await help.textContent(), /УВ и ПЕ прекращают автоматическое включение со следующего месяца/);
  await help.getByRole("button", { name: "Понятно" }).click();

  await cell("Сотрудник с отметкой", 14).click();
  await page.keyboard.press("Delete");
  const removal = page.getByRole("alertdialog", { name: "Удалить последние отметки сотрудника?" });
  assert.match(await removal.textContent(), /Ctrl\+Z не восстановит/);
  assert.equal(posted.length, 0, "The last mark is preserved until confirmation");
  await removal.getByRole("button", { name: "Отмена", exact: true }).click();
  await removal.waitFor({ state: "hidden" });
  assert.equal(await value("Сотрудник с отметкой", 14), "В");
  assert.equal(posted.length, 0, "Cancelling the deletion performs no writes");
  await cell("Сотрудник с отметкой", 14).click();
  await page.keyboard.press("Delete");
  await removal.getByRole("button", { name: "Удалить отметки", exact: true }).click();
  await ready("Ноябрь", 6);
  assert.equal(await page.getByText("Последняя отметка удалена. Сотрудник больше не входит в табель за этот месяц.", { exact: true }).count(), 1);
  await page.keyboard.press("Control+z");
  assert.equal(posted.length, 1, "Undo cannot post a restore for the vanished row");

  await page.getByRole("button", { name: "Следующий месяц", exact: true }).click();
  await ready("Декабрь", 2);
  assert.equal(await row("Уволенный сотрудник").count(), 0);
  assert.equal(await row("Переведённый сотрудник").count(), 0);

  await page.getByRole("button", { name: "Предыдущий месяц", exact: true }).click();
  await ready("Ноябрь", 6);
  await assertNovemberHistory();

  const protectedCell = cell("Уволенный сотрудник", 12);
  await protectedCell.dblclick();
  const conflictEditor = protectedCell.locator("input");
  await conflictEditor.fill("8");
  const originalRevision = marks.get("2:2026-11-12").revision;
  marks.set("2:2026-11-12", mark(2, "2026-11-12", "Б"));
  const response409 = page.waitForResponse(response => response.status() === 409 && new URL(response.url()).pathname === "/api/timesheet");
  await conflictEditor.press("Enter");
  await response409;
  const reload = page.getByRole("button", { name: "Обновить данные", exact: true });
  await reload.waitFor();
  assert.equal(posted.at(-1).expectedRevision, originalRevision);
  assert.equal(await conflictEditor.inputValue(), "8", "The rejected edit remains available until the user refreshes");
  await excel.click();
  assert.equal(await exportAction.isDisabled(), true, "Excel cannot export stale or unsaved values");
  await page.keyboard.press("Escape");
  await reload.click();
  await page.getByRole("alertdialog", { name: "Обновить данные табеля?" }).getByRole("button", { name: "Обновить данные", exact: true }).click();
  await ready("Ноябрь", 6);
  assert.equal(await value("Уволенный сотрудник", 12), "Б", "Reload shows the newer server mark");
  await excel.click();
  assert.equal(await exportAction.isEnabled(), true);
  await page.keyboard.press("Escape");

  const terminalCell = cell("Постоянный сотрудник", 20);
  await terminalCell.dblclick();
  const editor = terminalCell.locator("input");
  await editor.fill("ПЕ");
  const readsBeforeSave = requests.length;
  let releaseWrite;
  holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  const postRequest = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/timesheet");
  const rosterResponse = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/timesheet");
  try {
    await editor.press("Enter");
    await postRequest;
    assert.equal(requests.length, readsBeforeSave, "A pending terminal write does not reload the grid");
  } finally {
    releaseWrite();
    holdWrite = null;
  }
  await rosterResponse;
  assert.deepEqual(posted, [
    { employeeId: 7, workDate: "2026-11-14", value: "", expectedRevision: "v3", allowRosterRemoval: true },
    { employeeId: 2, workDate: "2026-11-12", value: "8", expectedRevision: originalRevision, allowRosterRemoval: undefined },
    { employeeId: 4, workDate: "2026-11-20", value: "ПЕ", expectedRevision: null, allowRosterRemoval: undefined },
  ]);
  assert.equal(await value("Постоянный сотрудник", 20), "ПЕ");

  await page.getByRole("button", { name: "Следующий месяц", exact: true }).click();
  await ready("Декабрь", 1);
  await page.getByRole("button", { name: "Следующий месяц", exact: true }).click();
  await ready("Январь", 0);
  assert.equal(await page.getByText("За этот месяц нет сотрудников в табеле", { exact: true }).count(), 1);

  const uniqueRequests = [...new Map(requests.map(request => [JSON.stringify(request), request])).values()];
  assert.deepEqual(uniqueRequests, [
    { month: "2026-11", roster: null, siteId: "1" },
    { month: "2026-12", roster: null, siteId: "1" },
    { month: "2027-01", roster: null, siteId: "1" },
  ]);
  assert.deepEqual(unmocked, []);
  assert.deepEqual(errors, []);
  console.log("PASS: personnel project order, preserved facts, settled refresh, conflict-safe writes and exports, last-mark removal and next-month exclusion after УВ/ПЕ");
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
}
