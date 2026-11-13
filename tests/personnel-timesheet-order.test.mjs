import { personnelTimesheetExportDifference } from "../app/placementXlsx.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { orderPersonnelTimesheetEmployees, personnelTimesheetReferenceKey } from "../app/personnelTimesheetOrder.ts";
import { buildPersonnelTimesheetRange, monthKeysInRange, selectPersonnelTimesheetRange } from "../app/timesheetExportRange.ts";

const expectedDepartments = [
  ["АУП", "Дирекция"], ["АУП", "УП"], ["АУП", "ОК"],
  ["ИТР", "ПТО"], ["ИТР", "ЛНК"], ["ИТР", "МУ"], ["ИТР", "ОГС"], ["ИТР", "ОК"],
  ["ИТР", "МУТТ"], ["ИТР", "МУСК"], ["ИТР", "СИГ"], ["ИТР", "ОГЭ"], ["ИТР", "ЭМУ"],
  ["ВСП", "АХО"], ["ВСП", "МТО"], ["МЕХ", "ОГМ"], ["ИТР", "ОТПБ"],
  ["ОПР", "МУСК"], ["ОПР", "МУТТ"], ["ОПР", "МУВСП"], ["ОПР", "МУСЛП"],
];
const employee = (id, employmentType, department, fullName = `Сотрудник ${id}`) => ({ id, employmentType, department, fullName, hours: id });
const ids = rows => rows.map(row => row.id);

test("a shuffled roster follows the complete 21 department sequence from the timesheet", () => {
  const canonical = expectedDepartments.map(([employmentType, department], index) => employee(index + 1, employmentType, department));
  const permutation = [20, 7, 2, 16, 9, 0, 18, 13, 5, 3, 19, 10, 1, 12, 8, 15, 6, 14, 4, 17, 11];
  const shuffled = permutation.map(index => canonical[index]);
  const result = orderPersonnelTimesheetEmployees(shuffled);
  assert.deepEqual(result.map(row => [row.employmentType, row.department]), expectedDepartments);
  assert.deepEqual(ids(result), canonical.map(row => row.id));
  assert.equal(result.length, shuffled.length);
});

test("АУП/ОК and ИТР/ОК remain distinct, and ИТР/ОТПБ follows МЕХ before production departments", () => {
  const rows = [employee(1, "ИТР", "ОК"), employee(2, "ИТР", "ОТПБ"), employee(3, "ОПР", "МУСК"),
    employee(4, "АУП", "ОК"), employee(5, "МЕХ", "ОГМ"), employee(6, "ВСП", "АХО")];
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(rows)), [4, 1, 6, 5, 2, 3]);
});

test("incoming order within a department survives duplicate names and never becomes alphabetical", () => {
  const rows = [
    employee(5, "ОПР", "МУТТ", "Яков Синтетический"),
    employee(9, "ИТР", "ПТО", "Яков Проверочный"),
    employee(2, "ОПР", "МУТТ", "Алексей Синтетический"),
    employee(8, "ИТР", "ПТО", "Одинаковое ФИО"),
    employee(7, "ИТР", "ПТО", "Одинаковое ФИО"),
    employee(1, "ОПР", "МУТТ", "Одинаковое ФИО"),
    employee(3, "ОПР", "МУТТ", "Одинаковое ФИО"),
  ];
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(rows)), [9, 8, 7, 5, 2, 1, 3]);
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(orderPersonnelTimesheetEmployees(rows))), [9, 8, 7, 5, 2, 1, 3]);
});

test("case and surrounding/repeated whitespace affect group matching without changing displayed labels", () => {
  const rows = [
    employee(1, " итр ", " Новый   отдел "),
    employee(2, "мЕх", " огм\n"),
    employee(3, " АуП ", "\tдирекция  "),
    employee(4, "ИТР", "НОВЫЙ ОТДЕЛ"),
    employee(5, "итр", "  отпб "),
    employee(6, "ауп", "ДИРЕКЦИЯ"),
  ];
  const before = structuredClone(rows);
  const result = orderPersonnelTimesheetEmployees(rows);
  assert.deepEqual(ids(result), [3, 6, 2, 5, 1, 4]);
  assert.equal(result[0].department, "\tдирекция  ");
  assert.deepEqual(rows, before);
});

test("unknown and missing departments remain grouped after known groups without losing employees or cell data", () => {
  const rows = [
    employee(1, "ИТР", "Новый отдел"), employee(2, "", "Без типа"), employee(3, "ИТР", "ПТО"),
    employee(4, "ВСП", "Новая служба"), employee(5, "итр", " новый  отдел "),
    employee(6, "ИТР", ""), employee(7, "", ""), employee(8, " ", "\t"), employee(9, "", "Без типа"),
    employee(10, "ИТР", "ёще отдел"), employee(11, "ИТР", "ЕЩЕ ОТДЕЛ"),
  ];
  const before = structuredClone(rows);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  const result = orderPersonnelTimesheetEmployees(rows);
  assert.deepEqual(ids(result), [3, 1, 5, 2, 9, 4, 6, 7, 8, 10, 11]);
  assert.equal(result.length, rows.length);
  assert.equal(new Set(ids(result)).size, rows.length);
  assert.deepEqual([...ids(result)].sort((a, b) => a - b), [...ids(rows)].sort((a, b) => a - b));
  for (const row of result) assert.strictEqual(row, rows.find(source => source.id === row.id));
  assert.deepEqual(rows, before);
});

test("partial project rosters skip absent departments and place new employees inside their own department", () => {
  const initial = [employee(1, "ОПР", "МУТТ"), employee(2, "ИТР", "ПТО"), employee(3, "МЕХ", "ОГМ")];
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(initial)), [2, 3, 1]);
  const withNewEmployee = [...initial, employee(4, "ИТР", "ПТО")];
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(withNewEmployee)), [2, 4, 3, 1]);
  const withNewDepartment = [...withNewEmployee, employee(5, "АУП", "УП")];
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(withNewDepartment)), [5, 2, 4, 3, 1]);
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(withNewDepartment.filter(row => row.id !== 2))), [5, 4, 3, 1]);
  assert.deepEqual(orderPersonnelTimesheetEmployees([]), []);
});

test("reference employee ranks override alphabetic and incoming order only within their own department", () => {
  const rows = [
    { ...employee(1, "ИТР", "ПТО", "А Сотрудник"), timesheetOrder: 40 },
    { ...employee(2, "ИТР", "ПТО", "Я Сотрудник"), timesheetOrder: 10 },
    { ...employee(3, "ОПР", "МУТТ", "Б Сотрудник"), timesheetOrder: 0 },
    employee(4, "ИТР", "ПТО", "В Новый сотрудник"),
    { ...employee(5, "ИТР", "ПТО", "Я Сотрудник"), timesheetOrder: 10 },
    { ...employee(6, "ИТР", "ПТО", "Г Сотрудник"), timesheetOrder: 0 },
    { ...employee(7, "АУП", "Дирекция", "Д Сотрудник"), timesheetOrder: 300 },
  ];
  const before = structuredClone(rows);
  const result = orderPersonnelTimesheetEmployees(rows);
  assert.deepEqual(ids(result), [7, 6, 2, 5, 1, 4, 3]);
  assert.deepEqual(rows, before);
  assert.equal(new Set(ids(result)).size, rows.length);
});

test("missing, malformed and unsafe ranks preserve incoming order after the ranked employees", () => {
  const ranks = [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, "2", 1.5, Number.MAX_SAFE_INTEGER + 1];
  const rows = ranks.map((timesheetOrder, index) => ({ ...employee(index + 1, "ИТР", "ПТО"), timesheetOrder }));
  rows.push({ ...employee(8, "ИТР", "ПТО"), timesheetOrder: 2 }, { ...employee(9, "ИТР", "ПТО"), timesheetOrder: 0 });
  const result = orderPersonnelTimesheetEmployees(rows);
  assert.deepEqual(ids(result), [9, 8, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ids(orderPersonnelTimesheetEmployees(result)), ids(result));
});

test("the server reference hashes normalized identities and assigns ranks without merging employees or changing inputs", async () => {
  const source = await readFile(new URL("../app/personnelTimesheetReference.server.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("personnelTimesheetReference.server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const implementation = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "orderPersonnelTimesheetReferenceEmployees");
  assert.ok(implementation, "Execute the actual server boundary against synthetic reference fingerprints");
  const code = ts.transpileModule(implementation.getText(file).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const fingerprint = key => createHash("sha256").update(key).digest("hex");
  const referenceRanks = new Map([
    [fingerprint("ИТР\u0000ПТО\u0000ЯКОВ ТЕСТОВЫЙ ЕЛКИН"), 0],
    [fingerprint("ИТР\u0000ПТО\u0000АЛЕКСЕЙ СИНТЕТИЧЕСКИЙ"), 1],
    [fingerprint("АУП\u0000ДИРЕКЦИЯ\u0000МАЙЯ ПРОВЕРОЧНАЯ"), 2],
  ]);
  const orderReference = new Function("createHash", "personnelTimesheetReferenceKey", "referenceRanks", "orderPersonnelTimesheetEmployees",
    `${code}\nreturn orderPersonnelTimesheetReferenceEmployees;`)(createHash, personnelTimesheetReferenceKey, referenceRanks, orderPersonnelTimesheetEmployees);
  const rows = [
    employee(3, "ИТР", "ПТО", "Новый Сотрудник"),
    employee(4, "ИТР", "ЛНК", "Яков Тестовый Ёлкин"),
    employee(1, "ИТР", "ПТО", "Алексей Синтетический"),
    employee(2, " итр  ", "\tпто ", "  яков   тестовый елкин  "),
    employee(7, "ИТР", "ПТО", "Ещё Новый Сотрудник"),
    employee(5, "ИТР", "ПТО", "Яков Тестовый Ёлкин"),
    employee(6, "АУП", "Дирекция", "Майя Проверочная"),
    employee(8, "ИТР", "ПТО", "Яков Тестовый Ёлкин младший"),
  ];
  const before = structuredClone(rows);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  const result = orderReference(rows);
  assert.deepEqual(ids(result), [6, 2, 5, 1, 3, 7, 8, 4]);
  assert.deepEqual(result.map(row => row.timesheetOrder), [2, 0, 0, 1, undefined, undefined, undefined, undefined]);
  assert.equal(personnelTimesheetReferenceKey(rows[3]), "ИТР\u0000ПТО\u0000ЯКОВ ТЕСТОВЫЙ ЕЛКИН");
  assert.equal(new Set(ids(result)).size, rows.length);
  for (const row of result) {
    const original = before.find(item => item.id === row.id);
    for (const [field, value] of Object.entries(original)) assert.deepEqual(row[field], value);
  }
  assert.deepEqual(rows, before);
});

test("multi-month Excel preserves incoming canonical order and retains all hours when the date range narrows", () => {
  const roster = [
    employee(1, "ОПР", "МУТТ", "А Производственный"),
    { ...employee(2, "ИТР", "ПТО", "А Проектный"), timesheetOrder: 20 },
    employee(3, "МЕХ", "ОГМ", "Б Механический"),
    employee(4, "СЛ", "Новая служба", "В Неизвестный"),
  ].map(row => ({ ...row, position: "Должность" }));
  const newEmployees = [{ ...employee(5, "ИТР", "ПТО", "Я Новый проектный"), timesheetOrder: 10 }, employee(6, "АУП", "Дирекция", "Г Управленческий")]
    .map(row => ({ ...row, position: "Должность" }));
  const mark = (employeeId, workDate, hours) => ({ employeeId, workDate, hours, code: null, note: "", updatedBy: "Тест" });
  const report = (workDate, hours) => ({ employeeId: 1, workDate, hours, masters: "Тестовый мастер", zones: "Тестовая зона" });
  const months = [
    { employees: roster, entries: [report("2026-10-31", 7)], marks: [mark(2, "2026-10-31", 6)] },
    { employees: [{ ...roster[1], position: "Обновлённая должность" }, ...newEmployees], entries: [report("2026-11-01", 8)],
      marks: [mark(2, "2026-11-01", 8), mark(3, "2026-11-01", 5), mark(4, "2026-11-01", 4), mark(5, "2026-11-01", 2), mark(6, "2026-11-01", 8)] },
  ];
  const before = structuredClone(months);
  const exported = buildPersonnelTimesheetRange(months, "2026-10-31", "2026-11-01");
  const expectedNames = ["А Производственный", "А Проектный", "Б Механический", "В Неизвестный", "Я Новый проектный", "Г Управленческий"];
  assert.deepEqual(exported.rows.map(row => row.fullName), expectedNames);
  assert.deepEqual(exported.rows.map(row => row.timesheetHours), [15, 14, 5, 4, 2, 8]);
  assert.equal(exported.rows[1].position, "Обновлённая должность");
  assert.deepEqual(exported.dayTotals, [13, 35]);
  assert.equal(exported.totalHours, 48);
  assert.equal(exported.totalDifference, 0);
  assert.deepEqual(months, before);
  const selected = selectPersonnelTimesheetRange(exported.dates, exported.rows, exported.dayTotals, "2026-11-01", "2026-11-01");
  assert.deepEqual(selected.rows.map(row => row.fullName), expectedNames);
  assert.deepEqual(selected.rows.map(row => row.timesheetHours), [8, 8, 5, 4, 2, 8]);
  assert.deepEqual(selected.rows[0].dailyReportHours, [8]);
  assert.deepEqual(selected.dayTotals, [35]);
  assert.equal(selected.totalHours, 35);
});

test("multi-month Excel uses a saved project order without adding employees outside the loaded monthly rosters", () => {
  const months = [{
    employees: [
      { ...employee(1, "ОПР", "МУТТ", "Первый"), position: "Рабочий" },
      { ...employee(2, "ИТР", "ПТО", "Второй"), position: "Инженер" },
    ],
    entries: [], marks: [],
  }, {
    employees: [
      { ...employee(2, "ИТР", "ПТО", "Второй"), position: "Старший инженер" },
      { ...employee(3, "АУП", "Дирекция", "Третий"), position: "Руководитель" },
    ],
    entries: [], marks: [],
  }];

  const fallback = buildPersonnelTimesheetRange(months, "2026-10-31", "2026-11-01");
  assert.deepEqual(fallback.rows.map(row => row.fullName), ["Первый", "Второй", "Третий"]);

  const ordered = buildPersonnelTimesheetRange(months, "2026-10-31", "2026-11-01", [2, 999, 1]);
  assert.deepEqual(ordered.rows.map(row => row.fullName), ["Второй", "Первый", "Третий"]);
  assert.equal(ordered.rows.length, 3);
  assert.equal(ordered.rows[0].position, "Старший инженер");
  assert.doesNotMatch(ordered.rows.map(row => row.fullName).join("|"), /999/);
});

test("multi-month preview uses one range snapshot and preserves project order, filtered selection and new participants", async () => {
  const preview = await readFile(new URL("../app/ExcelExportPreview.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ExcelExportPreview.tsx", preview, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let loadRange;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "loadExportRange") loadRange = node;
    else ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(loadRange);
  const code = ts.transpileModule(loadRange.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const employees = [
    { ...employee(1, "ОПР", "МУТТ", "Рабочий"), position: "Монтажник" },
    { ...employee(2, "АУП", "Дирекция", "Директор"), position: "Руководитель" },
    { ...employee(3, "ОПР", "МУТТ", "Новый сотрудник"), position: "Монтажник" },
  ];
  for (const scenario of [
    { order: { ids: [1, 2, 3], hasSavedOrder: true }, names: ["Рабочий", "Директор", "Новый сотрудник"] },
    { order: { ids: [1, 2, 3], importIds: [3, 2, 1], hasImportOrder: true }, names: ["Новый сотрудник", "Директор", "Рабочий"] },
    { order: { ids: [2, 1, 3] }, names: ["Директор", "Рабочий", "Новый сотрудник"] },
    { order: { ids: [1, 2, 3] }, source: { employeeIds: [1, 2], orderedEmployeeIds: [2, 1] }, names: ["Директор", "Рабочий"] },
    { failed: true },
  ]) {
    const requests = [], replacements = [], errors = [];
    const payload = { source: { kind: "personnel-timesheet", siteId: 7, ...scenario.source }, workbook: { kind: "personnel-timesheet", siteName: "Проект", dates: ["2026-10-31"] } };
    const noop = () => {};
    const environment = { payload, baseTimesheetPayload: payload, monthKeysInRange, buildPersonnelTimesheetRange, personnelTimesheetExportDifference,
      rangeInsideDates: () => false, dateHeaders: dates => dates, periodText: () => "Период", excelFileName: () => "Табель.xlsx",
      setPayload: value => replacements.push(value), setRangeError: value => errors.push(value), setRangeLoading: noop,
      setDownloadError: noop, setDownloaded: noop, setWaitingForEnd: noop, setCalendarOpen: noop,
      fetch: async path => {
        const url = new URL(path, "http://localhost");
        requests.push(url);
        assert.equal(url.searchParams.get("siteId"), "7");
        if (url.pathname === "/api/table-order") return scenario.failed
          ? Response.json({ error: "Порядок временно недоступен." }, { status: 503 })
          : Response.json(scenario.order);
        assert.equal(url.pathname, "/api/timesheet");
        assert.equal(url.searchParams.get("startMonth"), "2026-10");
        assert.equal(url.searchParams.get("endMonth"), "2026-11");
        assert.equal(url.searchParams.get("month"), null);
        return Response.json({ months: [
          { month: "2026-10", employees: employees.slice(0, 2), entries: [{ employeeId: 1, workDate: "2026-10-31", hours: 4 }], marks: [] },
          { month: "2026-11", employees: employees.slice(1), entries: [{ employeeId: 3, workDate: "2026-11-01", hours: 8 }], marks: [] },
        ] });
      },
    };
    const load = new Function(...Object.keys(environment), `${code}\nreturn loadExportRange;`)(...Object.values(environment));
    await load("2026-10-31", "2026-11-01");
    assert.equal(requests.filter(url => url.pathname === "/api/timesheet").length, 1, "All months come from one database snapshot");
    assert.equal(requests.find(url => url.pathname === "/api/table-order")?.searchParams.get("scope"), "project-personnel");
    if (scenario.failed) {
      assert.deepEqual(replacements, []);
      assert.equal(errors.at(-1), "Порядок временно недоступен.");
    } else {
      assert.deepEqual(replacements[0].workbook.rows.map(row => row.fullName), scenario.names);
      assert.deepEqual(replacements[0].workbook.rows.find(row => row.fullName === "Рабочий").dailyValues, [4, ""]);
      assert.equal(replacements[0].workbook.totalHours, scenario.source ? 4 : 12);
      assert.equal(errors.at(-1), "");
    }
  }
});
