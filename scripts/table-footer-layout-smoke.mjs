// Actual application grids and footers, using the existing catalog fixture's in-memory APIs.
// Optional third CLI argument reuses an already running catalog fixture instead of starting one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const base = process.argv[3] ?? "http://127.0.0.1:3164";
const fixture = process.argv[3] ? null : spawn(process.execPath, [fileURLToPath(new URL("./catalog-spreadsheet-smoke.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
const cases = [
  { key: "equipment", path: "/settings/general/equipment", add: "Добавить технику", widths: [1170, 843, 390] },
  { key: "project-equipment", path: "/settings/project/equipment", add: "Добавить технику в проект", widths: [1170, 843] },
  { key: "employees", path: "/settings/general/employees", add: "Добавить сотрудника", grid: ".ag-employee-grid", widths: [1170, 843] },
  { key: "positions", path: "/settings/general/positions", add: "Добавить должность", widths: [1170] },
  { key: "zones", path: "/settings/project/zones", add: /^Добавить:/, widths: [1170, 843, 390] },
  { key: "masters", path: "/settings/project/masters", add: /^Добавить:/, widths: [1170] },
  { key: "work-types", path: "/settings/project/work-types", add: "Добавить вид работы", grid: ".work-types-master-grid", footer: ".work-types-master > .employee-spreadsheet-footer", widths: [1170, 843, 390] },
];
let browser, page, output = "";
const errors = [], measurements = [];
const poll = async (read, check, label) => {
  const deadline = Date.now() + 15_000; let actual;
  while (Date.now() < deadline) { actual = await read(); if (check(actual)) return actual; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`Timed out: ${label}. Actual: ${JSON.stringify(actual)}`);
};
const settle = async () => page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

const measure = footer => footer.evaluate(element => {
  const footerHost = element.parentElement?.classList.contains("table-page-scroll-footer") ? element.parentElement : element;
  let grid = footerHost.previousElementSibling;
  while (grid && !grid.matches(".ag-grid-shell,.employee-performance-frame")) grid = grid.previousElementSibling;
  if (!grid) throw new Error("The footer has no preceding application grid/frame");
  const shell = grid.matches(".ag-grid-shell") ? grid : grid.querySelector(".ag-grid-shell");
  const inner = shell.querySelector(".ag-root-wrapper"), summary = element.querySelector(".employee-spreadsheet-footer-summary");
  const bounds = node => { const box = node.getBoundingClientRect(); return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height }; };
  const styles = node => { const style = getComputedStyle(node); return { topLeft: parseFloat(style.borderTopLeftRadius), topRight: parseFloat(style.borderTopRightRadius), bottomLeft: parseFloat(style.borderBottomLeftRadius), bottomRight: parseFloat(style.borderBottomRightRadius), topBorder: parseFloat(style.borderTopWidth), bottomBorder: parseFloat(style.borderBottomWidth), background: style.backgroundColor, borderColor: style.borderTopColor }; };
  const buttons = [...element.querySelectorAll("button")].filter(button => button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== "hidden").map(button => ({ ...bounds(button), label: button.innerText.trim(), clipped: button.scrollWidth > button.clientWidth + 1 }));
  return { footer: bounds(element), grid: bounds(grid), shell: bounds(shell), footerStyle: styles(element), gridStyle: styles(grid), innerStyle: inner ? styles(inner) : null,
    summary: summary ? bounds(summary) : null, buttons, pageWidth: window.innerWidth, pageHeight: window.innerHeight, pageOverflow: document.scrollingElement.scrollWidth - window.innerWidth };
});
function assertLayout(value, label, { idle = false, nested = false } = {}) {
  assert.ok(value.pageOverflow <= 1, `${label}: the document must not overflow horizontally (${value.pageOverflow}px)`);
  assert.ok(Math.abs(value.grid.left - value.footer.left) <= 1 && Math.abs(value.grid.width - value.footer.width) <= 1, `${label}: footer and grid share the same outside bounds`);
  assert.ok(Math.abs(value.footer.top - value.grid.bottom) <= 1, `${label}: footer joins the grid without a separate gap`);
  assert.ok(value.gridStyle.bottomBorder + value.footerStyle.topBorder <= 1.1, `${label}: the grid/footer seam has one border`);
  assert.ok(value.gridStyle.bottomLeft <= 1 && value.gridStyle.bottomRight <= 1, `${label}: the grid's bottom join corners are square`);
  if (value.innerStyle) assert.ok(value.innerStyle.bottomLeft <= 1 && value.innerStyle.bottomRight <= 1, `${label}: the inner AG frame does not introduce rounded bottom corners`);
  assert.ok(value.gridStyle.topLeft >= 7 && value.gridStyle.topRight >= 7, `${label}: the outside top corners remain rounded`);
  assert.ok(value.footerStyle.topLeft <= 1 && value.footerStyle.topRight <= 1 && value.footerStyle.bottomLeft >= 7 && value.footerStyle.bottomRight >= 7, `${label}: only the outer bottom footer corners are rounded`);
  assert.ok(value.grid.height >= (nested ? 160 : value.pageWidth < 500 ? 350 : 550), `${label}: the footer leaves a useful grid work area (${value.grid.height}px)`);
  assert.ok(value.footer.bottom <= value.pageHeight + 1, `${label}: bottom actions remain inside the viewport`);
  for (const button of value.buttons) {
    assert.ok(button.left >= value.footer.left - 1 && button.right <= value.footer.right + 1 && button.top >= value.footer.top - 1 && button.bottom <= value.footer.bottom + 1, `${label}: button “${button.label}” fits the footer`);
    assert.equal(button.clipped, false, `${label}: button “${button.label}” does not clip its label`);
    assert.ok(button.height >= 30, `${label}: button “${button.label}” remains usable`);
  }
  for (let index = 0; index < value.buttons.length; index++) for (const other of value.buttons.slice(index + 1)) {
    const button = value.buttons[index];
    assert.ok(Math.min(button.right, other.right) - Math.max(button.left, other.left) <= 1 || Math.min(button.bottom, other.bottom) - Math.max(button.top, other.top) <= 1, `${label}: action buttons do not overlap`);
  }
  if (idle && value.pageWidth >= 1170) {
    assert.ok(value.footer.height <= 58, `${label}: idle footer fits one compact row (${value.footer.height}px)`);
    const first = value.buttons[0];
    assert.ok(value.summary && first && Math.abs((value.summary.top + value.summary.bottom) / 2 - (first.top + first.bottom) / 2) <= 2, `${label}: summary and actions share one vertically centered row`);
  }
}
async function inspect(footer, label, options) {
  await settle();
  const value = await measure(footer);
  assertLayout(value, label, options);
  measurements.push({ label, gridHeight: value.grid.height, footerHeight: value.footer.height, background: value.footerStyle.background, radius: value.footerStyle.bottomLeft, buttonHeights: [...new Set(value.buttons.map(button => button.height))] });
  return value;
}
async function screenshot(key, width, state) {
  await page.screenshot({ path: `/private/tmp/table-footer-layout-${key}-${width}-${state}.png`, fullPage: false });
}

try {
  if (fixture) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 60_000);
    const capture = chunk => { output += chunk; if (output.includes(`${base}/`)) { clearTimeout(timer); resolve(); } };
    fixture.stdout.on("data", capture); fixture.stderr.on("data", capture);
    fixture.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${output}`)); });
    fixture.once("error", error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ channel: "chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  page = await browser.newPage({ viewport: { width: 1170, height: 953 } });
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());

  for (const example of cases) for (const width of example.widths) {
    await page.setViewportSize({ width, height: 953 });
    await page.goto(`${base}${example.path}?mode=full`);
    const grid = page.locator(example.grid ?? ".ag-catalog-grid").first();
    await grid.locator(".ag-row").first().waitFor();
    const scrollFrame = grid.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " table-page-scroll-frame ")][1]');
    const footer = await scrollFrame.count()
      ? scrollFrame.locator(":scope > .table-page-scroll-footer > .employee-spreadsheet-footer").first()
      : page.locator(example.footer ?? ".employee-spreadsheet-footer").first();
    await footer.waitFor();
    // The mobile navigation starts open over the workspace. Close it through
    // its real control before interacting with the table behind the drawer.
    if (width <= 680 && await page.locator(".app-shell:not(.sidebar-collapsed)").count()) {
      await page.locator(".sidebar").getByRole("button", { name: "Свернуть меню", exact: true }).click();
      await page.locator(".app-shell.sidebar-collapsed").waitFor();
    }
    await poll(() => measure(footer), value => value.buttons.length >= 1 && value.grid.height > 200, `${example.key}: loaded footer`);
    await inspect(footer, `${example.key}/${width}/idle`, { idle: true });
    await screenshot(example.key, width, "idle");

    // Real selection changes the shared action menu without pushing controls outside the panel.
    await grid.locator('.ag-row input[type="checkbox"]').first().check();
    await footer.getByRole("button", { name: "Снять выделение", exact: true }).waitFor();
    await inspect(footer, `${example.key}/${width}/selected`);
    await footer.getByRole("button", { name: "Действия", exact: true }).click();
    await page.getByRole("menu").last().waitFor();
    await page.keyboard.press("Escape");
    await footer.getByRole("button", { name: "Снять выделение", exact: true }).click();

    // Add only an unsaved synthetic draft: show the real save/cancel state without any API save.
    await footer.getByRole("button", { name: example.add, exact: typeof example.add === "string" }).click();
    await footer.getByRole("button", { name: "Отменить редактирование", exact: true }).waitFor();
    await inspect(footer, `${example.key}/${width}/editing`);
    await screenshot(example.key, width, "editing");
    await footer.getByRole("button", { name: "Отменить редактирование", exact: true }).click();
    await inspect(footer, `${example.key}/${width}/cancelled`, { idle: true });

    if (example.key === "work-types" && width === 1170) {
      await grid.locator(".ag-group-contracted").first().click();
      const detail = page.locator(".work-types-detail-content").first();
      const detailFooter = detail.locator(".employee-spreadsheet-footer");
      await detailFooter.waitFor();
      await inspect(detailFooter, "work-types/detail/idle", { idle: true, nested: true });
      await screenshot("work-types-detail", width, "idle");
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(measurements, null, 2));
  console.log("PASS: actual equipment, project, employee and reference grids have joined borders and outer corners, compact wide summaries/actions, usable wrapped buttons, healthy grid area, and no page overflow across idle/selected/editing states");
} catch (failure) {
  console.error((await page?.locator("body").innerText())?.slice(-12_000));
  await page?.screenshot({ path: "/private/tmp/table-footer-layout-failure.png", fullPage: false });
  throw failure;
} finally { await browser?.close(); fixture?.kill(); }
