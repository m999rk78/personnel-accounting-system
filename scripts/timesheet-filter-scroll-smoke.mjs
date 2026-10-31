// Isolated browser UI regression; all fixture APIs are synthetic in-memory data.
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
  plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "timesheet-filter-scroll-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/unified-filters.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port: 3121, strictPort: true },
};
await build(config);
const server = await preview(config);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const menu = () => page.locator(".ag-filter-menu:visible");
async function scroll(element, left, top) {
  await element.evaluate((target, { left, top }) => new Promise(resolve => {
    target.addEventListener("scroll", () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
    target.scrollTo({ left, top, behavior: "instant" });
  }), { left, top });
}
async function anchored(trigger) {
  await page.waitForFunction(element => {
    const popup = document.querySelector(".ag-filter-menu");
    if (!popup) return false;
    const anchor = element.getBoundingClientRect(), box = popup.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12));
    const top = Math.max(12, Math.min(anchor.bottom + 6, innerHeight - box.height - 12));
    return Math.abs(box.x - left) < 1.1 && Math.abs(box.y - top) < 1.1;
  }, await trigger.elementHandle());
  const result = await trigger.evaluate(element => {
    const popup = document.querySelector(".ag-filter-menu");
    if (!popup) return null;
    const anchor = element.getBoundingClientRect(), box = popup.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      left: Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12)),
      top: Math.max(12, Math.min(anchor.bottom + 6, innerHeight - box.height - 12)) };
  });
  assert.ok(result, "Filter must remain open after scrolling");
  assert.ok(Math.abs(result.x - result.left) < 1.1, JSON.stringify(result));
  assert.ok(Math.abs(result.y - result.top) < 1.1, JSON.stringify(result));
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
}
try {
  await page.goto("http://127.0.0.1:3121/unified-filters.html");
  await page.evaluate(() => { document.body.style.minHeight = "1800px"; });
  for (const screen of ["Табель рабочих", "Табель техники"]) {
    await page.getByRole("button", { name: screen, exact: true }).click();
    const shell = page.locator(".timesheet-grid-shell");
    await shell.locator("tbody td").first().waitFor();
    await shell.evaluate(element => { element.style.maxHeight = "180px"; element.style.minHeight = "0"; });
    const trigger = shell.locator("thead .timesheet-header-filter.compact").nth(4);
    await trigger.click();
    await menu().waitFor();
    const descending = menu().getByRole("button", { name: /По убыванию/ });
    await descending.click();
    assert.equal(await descending.getAttribute("aria-pressed"), "true");
    const original = await menu().elementHandle();
    await scroll(shell, 100, 0);
    assert.equal(await original.evaluate(element => element.isConnected), true, `${screen}: horizontal scrolling closed the filter`);
    await anchored(trigger);
    assert.equal(await descending.getAttribute("aria-pressed"), "true", "Pending filter/sort choices must survive scrolling");
    await scroll(shell, 100, 70);
    assert.equal(await original.evaluate(element => element.isConnected), true, `${screen}: vertical scrolling closed the filter`);
    await anchored(trigger);
    await page.evaluate(() => new Promise(resolve => {
      window.addEventListener("scroll", () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true });
      window.scrollTo({ top: 100, behavior: "instant" });
    }));
    await anchored(trigger);
    await page.setViewportSize({ width: 1040, height: 760 });
    await anchored(trigger);
    await page.keyboard.press("Escape");
    await menu().waitFor({ state: "detached" });
    assert.equal(await trigger.evaluate(element => element.classList.contains("active")), false, "Escape cancels unapplied changes");
    await trigger.click();
    await menu().waitFor();
    assert.equal(await menu().getByRole("button", { name: /По убыванию/ }).getAttribute("aria-pressed"), "false");
    await menu().getByRole("button", { name: /По убыванию/ }).click();
    await menu().getByRole("button", { name: "Применить", exact: true }).click();
    await menu().waitFor({ state: "detached" });
    await page.waitForFunction(element => element.classList.contains("active"), await trigger.elementHandle());
    assert.equal(await trigger.evaluate(element => element.classList.contains("active")), true, "Apply must still commit the chosen sort");
    await trigger.click();
    await menu().waitFor();
    await page.getByRole("navigation", { name: "Тестовые таблицы" }).getByText("Единые фильтры — изолированный стенд", { exact: true }).click();
    await menu().waitFor({ state: "detached" });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1280, height: 900 });
    console.log(`PASS: ${screen}: table/page scroll and resize preserve the popup and pending choices; Cancel/Escape, Apply and outside click still work`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: "/tmp/timesheet-filter-scroll-failure.png", fullPage: true });
  throw error;
} finally { await browser.close(); await server.httpServer.close(); }
