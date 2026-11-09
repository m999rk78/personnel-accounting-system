// Actual report workspaces against synthetic HTTP fixtures; no env files or DB.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3185, base = `http://127.0.0.1:${port}`;
const config = { configFile: false, envDir: false, publicDir: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)),
  plugins: [react()], logLevel: "error", build: { outDir: await mkdtemp(join(tmpdir(), "flexible-report-permissions-")), emptyOutDir: false,
    rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/flexible-report-permissions.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
const errors = [], reportWrites = [];
const now = "2026-11-09T08:00:00Z";
function data(domain) {
  const reports = [[100, "approved", 20], [200, "submitted", 21], [201, "submitted", 22], [300, "draft", 20], [301, "draft", 22]].map(([id, status, ownerUserId]) => ({
    id, siteId: 1, workDate: status === "approved" ? "2026-11-08" : "2026-11-09", ownerUserId, ownerName: `Прораб ${ownerUserId}`, status, revision: 4, createdAt: now, updatedAt: now,
    submittedAt: status === "draft" ? null : now, reviewedAt: status === "approved" ? now : null, reviewedByUserId: null, reviewedByName: null, reviewComment: "",
    rows: [{ id: id * 10 + 1, reportId: id, siteId: 1, workDate: status === "approved" ? "2026-11-08" : "2026-11-09", rowOrder: 0, employeeId: 1, employeeName: "Иван Тестовый", employmentType: "ОПР", department: "Участок", positionSnapshot: "Монтажник",
      equipmentId: 1, equipmentName: "Экскаватор Тест ЭК-1", equipmentType: "Экскаватор", brand: "Тест", model: "ЭК-1", organization: "Учебная механизация", registrationNumber: "ТЕСТ",
      shiftId: 1, shiftName: "Доступное значение", zoneId: 1, zoneName: "Доступное значение", mainWorkTypeId: 1, mainWorkTypeName: "Доступное значение", subworkTypeId: 1, subworkTypeName: "Доступное значение", masterId: 1, masterName: "Доступное значение",
      hours: 4, note: `${domain} ${status} ${ownerUserId}`, approvedEntryId: status === "approved" ? 5001 : null, approvedEntryRevision: status === "approved" ? 2 : null, createdAt: now, updatedAt: now }],
  }));
  return { reports, entries: [], availabilityMarks: [], canReview: true, from: null, to: null };
}
try {
  browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  const page = await browser.newPage({ viewport: { width: 2600, height: 1100 } });
  page.setDefaultTimeout(12_000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/table-order") return route.fulfill({ json: { ids: [], canWrite: false, hasSavedOrder: false, importIds: [], hasImportOrder: false } });
    if (/\/api\/(personnel|equipment)-report-draft$/.test(url.pathname)) {
      const body = request.method() === "GET" ? null : request.postDataJSON();
      return route.fulfill({ json: { revision: body ? (body.revision ?? 0) + 1 : 0, snapshot: body?.snapshot ?? null } });
    }
    if (/\/api\/(personnel|equipment)-report$/.test(url.pathname)) {
      if (request.method() !== "GET") { reportWrites.push(request.postDataJSON()); return route.fulfill({ status: 400, json: { error: "Проверка не выполняет записи отчётов" } }); }
      return route.fulfill({ json: data(url.pathname.includes("personnel") ? "personnel" : "equipment") });
    }
    throw new Error(`Unexpected fixture request: ${request.url()}`);
  });
  await page.goto(`${base}/flexible-report-permissions.html`);
  const row = id => page.locator(`.personnel-history-table .ag-row[row-id="report-${id}-${id * 10 + 1}"]`);
  const tab = text => page.locator(".personnel-report-views button").filter({ hasText: text });
  const switchCase = async (domain, scenario) => {
    await page.evaluate(() => localStorage.clear());
    await page.getByRole("combobox", { name: "Раздел проверки" }).selectOption(domain);
    await page.getByRole("combobox", { name: "Права проверки" }).selectOption(scenario);
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled);
    await page.waitForTimeout(150);
  };
  const editNote = async (id, allowed) => {
    const cell = row(id).locator('[col-id="note"]');
    await cell.dblclick();
    const input = cell.locator("textarea,input");
    if (allowed) { await input.first().waitFor(); await input.first().fill("Правка по разрешённому статусу"); await input.first().press("Enter"); }
    else { await page.waitForTimeout(100); assert.equal(await input.count(), 0, "Read-only status does not open an editor"); }
  };
  for (const domain of ["personnel", "equipment"]) {
    for (const role of ["viewer", "engineer", "superadmin"]) {
      await page.getByRole("combobox", { name: "Роль проверки" }).selectOption(role);
      await switchCase(domain, "defaults");
      await tab("На проверке").click(); await row(200).waitFor();
      const choose = page.getByRole("button", { name: role === "viewer" ? "Отчёт на проверке" : "Отчёт для проверки", exact: true });
      await choose.click();
      const list = page.getByRole("listbox");
      await list.getByRole("option").filter({ hasText: "Прораб 21" }).waitFor();
      await list.getByRole("option").filter({ hasText: "Прораб 22" }).click();
      await row(201).waitFor();
      await editNote(201, role !== "viewer");
      if (role === "viewer") {
        assert.equal(await tab("Черновик").count(), 0, "Default viewer has no private draft grant");
        assert.equal(await page.getByRole("button", { name: "Подтвердить отчёт", exact: true }).count(), 0);
      }
      console.log(`PASS ${domain}: ${role} sees both foremen submitted reports with correct editing access`);
    }
    for (const role of ["foreman", "viewer"]) {
      await page.getByRole("combobox", { name: "Роль проверки" }).selectOption(role);
      await switchCase(domain, "full");
      await tab("Подтверждённые").click(); await row(100).waitFor();
      await editNote(100, true);
      await tab("На проверке").click(); await row(200).waitFor();
      const approve = page.getByRole("button", { name: "Подтвердить отчёт", exact: true });
      assert.equal(await approve.isEnabled(), true, `${role} has an explicit approval grant`);
      await tab("Черновик").click(); await row(300).waitFor();
      assert.equal(await row(301).count(), 0, "Even full grants never reveal another author's draft");
      await editNote(300, true);
      console.log(`PASS ${domain}: ${role} full grants edit confirmed/review/own draft, foreign drafts hidden`);
    }
    await page.getByRole("combobox", { name: "Роль проверки" }).selectOption("foreman");
    await switchCase(domain, "defaults");
    await tab("Подтверждённые").click(); await row(100).waitFor(); await editNote(100, false);
    await tab("Черновик").click(); await row(300).waitFor(); await editNote(300, true);
  }
  await page.screenshot({ path: "/private/tmp/flexible-report-permissions.png", fullPage: true });
  assert.deepEqual(reportWrites, [], "All permission checks are read-only");
  assert.deepEqual(errors, []);
  console.log("PASS flexible report permissions: both domains, four roles, zero report writes or runtime errors");
} finally { await browser?.close(); await server.httpServer.close(); }
