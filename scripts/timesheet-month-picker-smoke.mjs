// Real browser, synthetic read-only APIs. No env files or database connections.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const outDir = await mkdtemp(join(tmpdir(), "timesheet-month-picker-"));
const config = {
  configFile: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  plugins: [react()], build: { outDir, emptyOutDir: false },
  preview: { host: "127.0.0.1", port: 3111, strictPort: true },
};
await build(config);
const server = await preview(config);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10_000);
const failures = [];
page.on("pageerror", error => failures.push(error.message));
await page.route("**/api/**", async route => {
  assert.equal(route.request().method(), "GET", "Selecting a period must not modify records");
  const url = new URL(route.request().url());
  const month = url.searchParams.get("month") ?? "2026-10";
  const common = { siteId: 1, siteName: "Учебный объект", month, entries: [], marks: [] };
  const body = url.pathname === "/api/timesheet" ? {
    ...common, employees: [{ id: 1, fullName: "Иван Тестовый", employmentType: "ОПР", department: "Тест", position: "Монтажник" }], canEdit: false, canCreate: false, canUpdate: false, canDelete: false,
  } : {
    ...common, units: [{ id: 1, organization: "Тест", equipmentType: "Кран", brand: "Тестовый", model: "1", registrationNumber: "TEST-1", note: "" }], availableUnits: [], sites: [], workDate: `${month}-21`, currentUserRole: "foreman", currentUserName: "Тест", canEditTimesheet: false, canCreateTimesheet: false, canUpdateTimesheet: false, canDeleteTimesheet: false, dailyTimesheetMarks: [], shifts: [], zones: [], mainWorkTypes: [], subworkTypes: [], filledDates: [], foremanProgress: [],
  };
  await route.fulfill({ json: body });
});
const picker = () => page.getByRole("button", { name: /^Выбрать месяц, сейчас/ });
const popup = () => page.getByRole("dialog", { name: "Выбор месяца табеля", exact: true });
const monthRequest = (endpoint, month) => page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === endpoint && url.searchParams.get("month") === month; });
async function visibleAboveTable() {
  assert.equal(await popup().evaluate(element => element.parentElement === document.body), true);
  const target = popup().locator("[data-picker-option]").first();
  assert.equal(await target.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true, "Calendar must not be clipped by the summary or covered by the table");
}
try {
  await page.goto("http://127.0.0.1:3111/");
  for (const [tab, endpoint] of [["Рабочие (2000)", "/api/timesheet"], ["Техника (1000)", "/api/equipment"]]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await picker().waitFor();
    await picker().click();
    await popup().waitFor();
    await visibleAboveTable();
    assert.equal(await popup().locator("[data-picker-option]").count(), 12);
    await popup().getByRole("button", { name: "Выбрать год, сейчас 2026", exact: true }).click();
    await popup().getByRole("button", { name: "2024", exact: true }).click();
    const mayRequest = monthRequest(endpoint, "2024-05");
    await popup().getByRole("button", { name: "май", exact: true }).click();
    await mayRequest;
    await popup().waitFor({ state: "detached" });
    assert.match(await picker().innerText(), /Май 2024/);

    const juneRequest = monthRequest(endpoint, "2024-06");
    await page.getByRole("button", { name: "Следующий месяц", exact: true }).click();
    await juneRequest;
    assert.match(await picker().innerText(), /Июнь 2024/);
    const returnRequest = monthRequest(endpoint, "2024-05");
    await page.getByRole("button", { name: "Предыдущий месяц", exact: true }).click();
    await returnRequest;

    await picker().locator("svg").click();
    await popup().getByRole("button", { name: "Предыдущий год", exact: true }).click();
    const decemberRequest = monthRequest(endpoint, "2023-12");
    await popup().getByRole("button", { name: "дек", exact: true }).click();
    await decemberRequest;
    assert.match(await picker().innerText(), /Декабрь 2023/);

    await picker().click();
    const currentRequest = monthRequest(endpoint, "2026-10");
    await popup().getByRole("button", { name: "Текущий месяц", exact: true }).click();
    await currentRequest;
    assert.match(await picker().innerText(), /Октябрь 2026/);
    await picker().focus();
    await page.keyboard.press("Enter");
    await popup().waitFor();
    await page.keyboard.press("Escape");
    await popup().waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.matches(".timesheet-month-picker-trigger"));
    await picker().click();
    await page.locator("nav strong").click();
    await popup().waitFor({ state: "detached" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await picker().click();
  await popup().waitFor();
  await visibleAboveTable();
  const bounds = await popup().boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await page.screenshot({ path: "/tmp/timesheet-month-picker-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  assert.deepEqual(failures, []);
  console.log("PASS: both timesheets open an unclipped calendar; year/month selection, month arrows, current month, icon click, keyboard, outside click and mobile layout");
} catch (failure) {
  console.error((await page.locator("body").innerText()).slice(-5000));
  await page.screenshot({ path: "/tmp/timesheet-month-picker-failure.png", fullPage: true });
  throw failure;
} finally { await browser.close(); await server.httpServer.close(); }
