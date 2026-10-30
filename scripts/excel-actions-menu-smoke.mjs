// Isolated UI fixture: no API, account, environment file or database access.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const config = {
  configFile: false, root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), publicDir: false,
  plugins: [react()], build: { outDir: await mkdtemp(join(tmpdir(), "excel-actions-menu-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/excel-actions-menu.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3112, strictPort: true },
};
await build(config);
const server = await preview(config);
const browser = await chromium.launch({ channel: "chrome", headless: true });
let page;
try {
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const failures = [];
    page.on("pageerror", error => failures.push(error.message));
    await page.goto("http://127.0.0.1:3112/excel-actions-menu.html");
    const report = page.getByRole("region", { name: "Отчёт персонала", exact: true });
    const trigger = report.getByRole("button", { name: "Excel", exact: true });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Действия с Excel", exact: true });
    await menu.waitFor();
    const appearance = await trigger.locator("span").evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, padding: style.padding, size: style.fontSize, weight: style.fontWeight }; });
    const menuAppearance = await menu.evaluate(element => { const style = getComputedStyle(element.querySelector("button")); const rect = element.getBoundingClientRect(); return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, x: rect.x, y: rect.y, parentIsBody: element.parentElement === document.body }; });
    console.log(JSON.stringify({ deviceScaleFactor, label: appearance, menu: menuAppearance }));
    assert.equal(appearance.background, "rgba(0, 0, 0, 0)", "Excel text must not become a count badge");
    assert.equal(appearance.padding, "0px");
    const countStyle = await report.locator(".personnel-report-queue-button > span").evaluate(element => getComputedStyle(element).backgroundColor);
    assert.notEqual(countStyle, "rgba(0, 0, 0, 0)", "The real count badge must retain its styling");
    assert.ok(parseFloat(menuAppearance.size) >= 12);
    assert.equal(menuAppearance.lineHeight, "18px");
    assert.equal(menuAppearance.parentIsBody, true);
    for (const coordinate of [menuAppearance.x, menuAppearance.y]) assert.ok(Math.abs(coordinate * deviceScaleFactor - Math.round(coordinate * deviceScaleFactor)) < .01, "Menu must align to physical pixels");
    await menu.getByRole("menuitem", { name: "Скачать шаблон", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Шаблон" }).waitFor();
    await menu.waitFor({ state: "detached" });
    await trigger.focus();
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.activeElement?.textContent === "Скачать шаблон");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await page.getByRole("checkbox", { name: "Импорт недоступен", exact: true }).check();
    await trigger.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.textContent === "Экспорт подтверждённых");
    assert.equal(await menu.getByRole("menuitem", { name: "Импорт в черновик", exact: true }).isDisabled(), true);
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.textContent === "Скачать шаблон");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 720 });
    await report.evaluate(element => { element.style.left = "auto"; element.style.right = "8.25px"; element.style.top = "auto"; element.style.bottom = "8.5px"; });
    await trigger.click();
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 7 && bounds.x + bounds.width <= 383);
    assert.ok(bounds.y >= 7 && bounds.y + bounds.height <= 713);
    const item = menu.getByRole("menuitem", { name: "Скачать шаблон", exact: true });
    assert.equal(await item.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + 15, rect.y + rect.height / 2)); }), true);
    await page.screenshot({ path: `/tmp/excel-actions-menu-${deviceScaleFactor}x.png`, fullPage: true });
    assert.deepEqual(failures, []);
    await context.close();
  }
  console.log("PASS: standard button, intact count badges, readable pixel-aligned menu at 1x/2x, actions, disabled states, keyboard and viewport edges");
} catch (failure) {
  await page?.screenshot({ path: "/tmp/excel-actions-menu-failure.png", fullPage: true });
  throw failure;
} finally { await browser.close(); await server.httpServer.close(); }
