// Browser assertions against synthetic rows only; never loads .env or a real API.
import assert from "node:assert/strict";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
const port = Number(process.argv[3] ?? 3166);
const config = { configFile: false, envDir: false, publicDir: false,
  root: fileURLToPath(new URL("../tests/fixtures", import.meta.url)), plugins: [react()],
  build: { outDir: await mkdtemp(join(tmpdir(), "date-filter-tree-check-")), emptyOutDir: false, rolldownOptions: { input: fileURLToPath(new URL("../tests/fixtures/date-filter-tree.html", import.meta.url)) } },
  preview: { host: "127.0.0.1", port, strictPort: true } };
await build(config);
const server = await preview(config);
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/date-filter-tree.html`);
  const observation = page.getByLabel("Наблюдение за фильтрами");
  async function rows(expected) {
    await page.waitForFunction(count => JSON.parse(document.querySelector("output").textContent).rows === count, expected);
    return JSON.parse(await observation.textContent());
  }
  const item = label => page.locator(".ag-set-filter-tree-list .ag-set-filter-item").filter({ has: page.getByText(label, { exact: true }) });
  async function openDate() {
    await page.getByRole("button", { name: "Открыть фильтр даты", exact: true }).click();
    await page.locator(".ag-set-filter-tree-list").waitFor();
  }
  async function expand(label) {
    const closed = item(label).locator(".ag-set-filter-group-closed-icon:visible");
    if (await closed.count()) await closed.click();
  }
  async function count(label, expected) {
    await page.waitForFunction(({ label, expected }) => [...document.querySelectorAll(".ag-set-filter-tree-list .grid-date-set-filter-value")].some(element => element.querySelector("span")?.textContent === label && Number(element.querySelector("small")?.textContent) === expected), { label, expected });
  }
  const cancel = () => page.getByRole("button", { name: "Отмена", exact: true }).click();
  const apply = () => page.getByRole("button", { name: "Применить", exact: true }).click();
  const search = value => page.locator(".ag-set-filter .ag-mini-filter input").fill(value);
  const reset = async () => { await page.getByRole("button", { name: "Сбросить стенд", exact: true }).click(); await rows(34); };
  await rows(34);
  await openDate();
  await count("2026", 30);
  await expand("2026");
  await count("Ноябрь", 28);
  await expand("Ноябрь");
  await count("28.11.2026", 1);
  await item("28.11.2026").locator(".ag-checkbox-label").click();
  assert.match(await item("2026").locator(".ag-checkbox-input-wrapper").getAttribute("class"), /ag-indeterminate/);
  // The month has 28 dates: later virtual rows must remain scroll-accessible.
  await page.locator(".ag-set-filter-list .ag-virtual-list-viewport").evaluate(element => { element.scrollTop = 900; });
  await count("06.11.2026", 1);
  await rows(34); // An unapplied checkbox must not change application rows.
  await cancel();
  await rows(34);

  for (const [query, expected] of [["2026-11-06", 1], ["06.11", 1], ["ноябрь", 29]]) {
    await openDate();
    await search(query);
    await apply();
    const state = await rows(expected);
    assert.ok(state.model.date.filterModels[1].values.every(value => value == null || /^\d{4}-\d{2}-\d{2}$/.test(value)), "Native filter models must retain original ISO keys");
    await reset();
  }

  await page.getByRole("button", { name: "Только МУТТ", exact: true }).click();
  await rows(17);
  await openDate();
  await count("2026", 15);
  await expand("2026");
  await count("Ноябрь", 14);
  await cancel();
  await page.getByRole("button", { name: "+1 строка 06.11.2026", exact: true }).click();
  await rows(18);
  await openDate();
  await count("2026", 16);
  await expand("2026");
  await count("Ноябрь", 15);
  await expand("Ноябрь");
  await search("2026-11-06");
  await count("06.11.2026", 2);
  await cancel();

  await reset();
  const start = Date.now();
  await page.getByRole("button", { name: "100 000 строк", exact: true }).click();
  await rows(100_000);
  await openDate();
  await count("2026", 88_234);
  assert.ok(await page.locator(".ag-grid-shell .ag-row").count() < 120, "Large row data must remain virtualised");
  await cancel();
  const stressMs = Date.now() - start;
  await reset();

  // Same-column sibling conditions must constrain the native tree and badges.
  // Set the interval through the real accordion controls, not a programmatic model.
  await openDate();
  await page.getByText("Период и условия", { exact: true }).click();
  const periodInputs = page.locator(".ag-date-filter input[type=date]:visible");
  await periodInputs.nth(0).fill("2026-11-01");
  await periodInputs.nth(1).fill("2026-11-06");
  await apply();
  const periodState = await rows(6);
  assert.equal(periodState.model.date.filterModels[2].type, "inRange");
  assert.equal(periodState.model.date.filterModels[2].dateFrom.slice(0, 10), "2026-11-01");
  assert.equal(periodState.model.date.filterModels[2].dateTo.slice(0, 10), "2026-11-06");
  await openDate();
  await count("2026", 6);
  await expand("2026");
  await count("Ноябрь", 6);
  await expand("Ноябрь");
  const periodLabels = await page.locator(".ag-set-filter-tree-list .grid-date-set-filter-value > span").allTextContents();
  assert.deepEqual(periodLabels.filter(value => /^\d{2}\.\d{2}\.\d{4}$/.test(value)).sort(), Array.from({ length: 6 }, (_, index) => `0${index + 1}.11.2026`));
  assert.equal(await item("Октябрь").count(), 0);
  assert.equal(await item("07.11.2026").count(), 0);
  assert.equal(await item("2025").count(), 0);
  await cancel();
  await rows(6);
  await reset();

  // Some production valueGetters supply display-formatted strings. Tree paths
  // are presentation only: selecting, searching and applying must retain those
  // exact raw DD.MM.YYYY keys rather than silently converting models to ISO.
  const displayDates = async () => {
    await page.getByRole("button", { name: "Даты ДД.ММ.ГГГГ", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector("output").textContent).dates[0] === "01.11.2025");
    await rows(34);
  };
  await displayDates();
  await openDate();
  await count("2026", 30);
  await expand("2026");
  await count("Ноябрь", 28);
  await expand("Ноябрь");
  await item("28.11.2026").locator(".ag-checkbox-label").click();
  assert.match(await item("2026").locator(".ag-checkbox-input-wrapper").getAttribute("class"), /ag-indeterminate/);
  await rows(34);
  await apply();
  const displaySelection = await rows(33);
  const displayKeys = displaySelection.model.date.filterModels[1].values;
  assert.ok(displayKeys.includes("06.11.2026"));
  assert.ok(!displayKeys.includes("28.11.2026"));
  assert.ok(displayKeys.every(value => value == null || value === "2026" || /^\d{2}\.\d{2}\.\d{4}$/.test(value)), "Checking display dates must preserve raw DD.MM.YYYY filter keys");
  await reset();
  for (const [query, expected] of [["2026-11-06", 1], ["06.11", 1], ["ноябрь", 29]]) {
    await displayDates();
    await openDate();
    await search(query);
    await apply();
    const state = await rows(expected);
    assert.ok(state.model.date.filterModels[1].values.every(value => /^\d{2}\.\d{2}\.\d{4}$/.test(value)), "Searching display dates must preserve raw DD.MM.YYYY filter keys");
    await reset();
  }

  await page.getByRole("button", { name: "Резервный фильтр", exact: true }).click();
  await rows(34);
  await page.getByRole("button", { name: "Открыть фильтр даты", exact: true }).click();
  await page.getByRole("textbox", { name: "Поиск значений", exact: true }).fill("2026-11-06");
  await apply();
  await rows(1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: "native tree, tri-state, Apply/Cancel, ISO and DD.MM models/search, sibling period conditions, counts, 100k virtualisation, fallback", stressMs }));
} finally {
  await browser?.close();
  await server.httpServer.close();
}
