// Real personnel workspace; isolated in-memory API, with no environment files or DB.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = 3162;
const base = `http://127.0.0.1:${port}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./personnel-report-smoke.mjs", import.meta.url)), "--scenario", "autosave", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
let browser, context, page, output = "";
const errors = [];
const names = ["Иван Тестовый", "Пётр Примеров", ...Array.from({ length: 8 }, (_, index) => `Сотрудник Проверочный ${index + 4}`)];
const poll = async (read, check, description) => {
  const deadline = Date.now() + 20_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (check(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}. Latest: ${JSON.stringify(latest)}`);
};
const snapshotRows = buffer => Object.values(buffer.snapshot?.edits ?? {}).flat();
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  context = await browser.newContext({ viewport: { width: 2800, height: 1050 } });
  const attach = current => {
    current.setDefaultTimeout(12_000);
    current.on("pageerror", error => errors.push(error.message));
    current.on("dialog", dialog => dialog.accept());
    return current;
  };
  page = attach(await context.newPage());
  const open = async () => {
    await page.goto(`${base}/personnel-report-smoke.html`);
    await page.getByRole("button", { name: "Обновить отчёты", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Обновить отчёты"]')?.disabled);
  };
  const draftTab = () => page.getByRole("group", { name: "Показать отчёты" }).getByRole("button", { name: /^Черновик/ });
  const cells = field => page.locator(`.personnel-history-table .ag-row [col-id="${field}"]`);
  const selectRole = async role => {
    const previous = await page.locator(".personnel-report-workspace").elementHandle();
    await page.getByRole("combobox", { name: "Роль в проверке" }).selectOption(role);
    await page.waitForFunction(element => !element.isConnected, previous);
    await page.waitForFunction(() => [...document.querySelectorAll(".personnel-report-workspace button")].find(button => button.textContent.trim() === "Добавить строку")?.disabled === false);
  };
  const expectTen = async () => {
    await draftTab().click();
    assert.equal(await draftTab().getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelectorAll('.personnel-history-table .ag-row [col-id="employeeName"]').length === 10);
    assert.deepEqual((await cells("employeeName").allTextContents()).map(value => value.trim()).sort(), [...names].sort());
  };
  const buffer = async (siteId = 1, api = context.request) => (await (await api.get(`${base}/api/personnel-report-draft?siteId=${siteId}`)).json());
  const reports = async () => (await (await context.request.get(`${base}/api/personnel-report?siteId=1&all=true`)).json()).reports;
  const paste = async text => page.locator(".localized-grid-body").evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, text);

  await open();
  await page.getByRole("button", { name: "Добавить строку", exact: true }).click();
  await cells("employeeName").first().click();
  await paste(names.join("\n"));
  await expectTen();
  const initial = await poll(() => buffer(), value => snapshotRows(value).length === 10, "ten incomplete employees autosaved to server buffer");
  assert.ok(snapshotRows(initial).every(row => row.hours === "" && row.zoneId === ""));
  assert.equal((await reports()).length, 0, "autosave must not publish or canonical-save incomplete work");
  assert.equal((await buffer(2)).snapshot, null, "another project must have a separate buffer");

  await page.reload();
  await expectTen();
  assert.equal(new Set(snapshotRows(await buffer()).map(row => row.key)).size, 10, "reload must not duplicate rows");
  await page.close();
  page = attach(await context.newPage());
  await open(); await expectTen();

  // Another browser session has no local cache and must restore the private server buffer.
  const otherContext = await browser.newContext({ viewport: { width: 2800, height: 1050 } });
  const otherPage = attach(await otherContext.newPage());
  await otherPage.goto(`${base}/personnel-report-smoke.html`);
  await otherPage.getByRole("group", { name: "Показать отчёты" }).getByRole("button", { name: /^Черновик/ }).click();
  await otherPage.waitForFunction(() => document.querySelectorAll('.personnel-history-table .ag-row [col-id="employeeName"]').length === 10);
  await otherContext.close();

  await selectRole("foreman2");
  await draftTab().click();
  assert.equal(await draftTab().getAttribute("aria-pressed"), "true");
  await page.getByText("У вас пока нет черновиков", { exact: true }).waitFor();
  assert.equal((await buffer()).snapshot, null, "another foreman must never get the first foreman's buffer");
  await selectRole("foreman");
  await expectTen();

  // Invalid cell text remains recoverable instead of being dropped by canonical validation.
  await cells("zone").first().click(); await paste("ЗОНА ПОСЛЕ ОБЕДА");
  await poll(() => buffer(), value => snapshotRows(value).some(row => row.inputValues?.zone === "ЗОНА ПОСЛЕ ОБЕДА"), "unmatched cell text autosaved");
  await page.reload(); await expectTen();
  assert.ok((await cells("zone").allTextContents()).some(text => text.includes("ЗОНА ПОСЛЕ ОБЕДА")));

  // Keep the final uncommitted editor value as well, including while connectivity is lost.
  await page.route("**/api/personnel-report-draft*", route => route.abort("internetdisconnected"));
  await cells("note").first().dblclick();
  const noteInput = page.getByRole("textbox", { name: "Примечание к отчёту", exact: true });
  await noteInput.fill("Продолжить после обеда, ничего не потерять");
  await page.waitForTimeout(400);
  await page.reload(); await expectTen();
  assert.ok((await cells("note").allTextContents()).some(text => text.includes("Продолжить после обеда, ничего не потерять")));
  await page.unroute("**/api/personnel-report-draft*");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await poll(() => buffer(), value => snapshotRows(value).some(row => row.note === "Продолжить после обеда, ничего не потерять"), "offline browser recovery uploaded after reconnect");

  // Correct the raw value; explicit Save persists the canonical draft and clears only its buffer.
  await cells("zone").filter({ hasText: "ЗОНА ПОСЛЕ ОБЕДА" }).first().click();
  await page.locator(".localized-grid-body").focus(); await page.keyboard.press("Delete");
  await page.getByRole("button", { name: /^Сохранить изменения/ }).click();
  await poll(() => reports(), value => value.some(report => report.status === "draft" && report.rows.length === 10), "manual save creates one canonical ten-person draft");
  await poll(() => buffer(), value => value.snapshot === null, "manual save clears recovered working buffer");
  await page.reload(); await expectTen();
  assert.equal((await reports()).length, 1);
  await cells("note").first().dblclick();
  await page.getByRole("textbox", { name: "Примечание к отчёту", exact: true }).fill("Новая заметка в сохранённом черновике");
  await poll(() => buffer(), value => snapshotRows(value).some(row => row.note === "Новая заметка в сохранённом черновике"), "uncommitted edit to a saved draft retains its frozen session");
  await page.reload(); await expectTen();
  assert.ok((await cells("note").allTextContents()).some(text => text.includes("Новая заметка в сохранённом черновике")));

  // Completing and submitting the same rows must not resurrect old local drafts on the next visit.
  await cells("employeeName").first().click();
  const complete = name => [name, "", "", "", "", "", "Дневная", "Зона А", "Монтаж", "Установка конструкций", "Анна Демонстрационная", "1", "Готово"].join("\t");
  await paste(names.map(complete).join("\n"));
  await page.getByRole("button", { name: "Отправить на проверку…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Отправить отчёты на проверку" });
  const send = dialog.getByRole("button", { name: "Отправить на проверку (1)", exact: true });
  await poll(() => send.isEnabled(), Boolean, "submission preflight passes");
  await send.click();
  await poll(() => reports(), value => value.length === 1 && value[0].status === "submitted" && value[0].rows.length === 10, "submit preserves exactly the completed ten workers");
  await poll(() => buffer(), value => value.snapshot === null, "submission leaves no stale working buffer");
  await page.reload(); await draftTab().click();
  await page.getByText("У вас пока нет черновиков", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/private/tmp/personnel-report-autosave-smoke.png", fullPage: true });
  console.log("PASS: ten incomplete workers autosave; reload/close/new-browser recovery; user/project isolation; invalid and active text; offline recovery/retry; manual save and submit cleanup");
} catch (failure) {
  console.error("Workflow tabs at failure:", await page?.getByRole("group", { name: "Показать отчёты" }).getByRole("button").evaluateAll(buttons => buttons.map(button => ({ text: button.textContent, pressed: button.getAttribute("aria-pressed") }))));
  console.error((await page?.locator("body").innerText())?.slice(-12_000));
  await page?.screenshot({ path: "/private/tmp/personnel-report-autosave-failure.png", fullPage: true });
  throw failure;
} finally {
  await browser?.close();
  fixture.kill();
}
