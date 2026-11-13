import assert from "node:assert/strict";
import test from "node:test";
import { importProjectDirectoryExcel, importProjectEmployeesExcel, prepareEmployeeExcelImport } from "../app/excelDirectoryImports.ts";

const sites = [{ id: 1, code: "FIRST", name: "Первый проект" }, { id: 2, code: "SECOND", name: "Второй, сложный проект" }];
const employee = (name, projectCode = "FIRST") => ({ fullName: name, employmentType: "ОПР", department: "Отдел", position: "Монтажник", projectCode });

test("employee workbook resolves codes, full project names with commas and explicit multiple projects", () => {
  const rows = prepareEmployeeExcelImport([employee("  Петр  Иванов ", "Второй, сложный проект"), employee("Новый", "FIRST; SECOND"), employee("Без проекта", "Не назначен")], sites, [{ id: 7, fullName: "Пётр Иванов" }]);
  assert.deepEqual(rows.map(row => [row.existingId, row.siteIds]), [[7, [2]], [undefined, [1, 2]], [undefined, []]]);
  assert.deepEqual(prepareEmployeeExcelImport([employee("Новый", "FIRST, SECOND")], sites, [])[0].siteIds, [1, 2]);
});

test("employee import rejects ambiguity, duplicate normalized names and bad final rows before writes", () => {
  assert.throws(() => prepareEmployeeExcelImport([employee("Петр Иванов"), employee(" Пётр   Иванов ")], sites, []), /повторяется/);
  assert.throws(() => prepareEmployeeExcelImport([employee("Петр Иванов")], sites, [{ id: 1, fullName: "Петр Иванов" }, { id: 2, fullName: "Пётр Иванов" }]), /неоднозначно/);
  assert.throws(() => prepareEmployeeExcelImport([employee("Новый", "FIRST")], [...sites, { id: 3, name: "FIRST", code: "OTHER" }], []), /неоднозначен/);
  assert.throws(() => prepareEmployeeExcelImport([employee("Новый"), employee("Другой", "Нет такого")], sites, []), /Строка 2: проект/);
  assert.throws(() => prepareEmployeeExcelImport([employee("Новый"), { ...employee("Другой"), position: "" }], sites, []), /Строка 2:/);
  assert.throws(() => prepareEmployeeExcelImport([], sites, []), /от 1 до 2000/);
});

function memoryDatabase({ failInsertAt = 0, failEmployeeUpdate = 0, failOrderWrite = false, duplicateMasterName = false, terminalEmployee = {} } = {}) {
  let state = {
    sites: [{ id: 1, active: 1 }, { id: 2, active: 1 }],
    employees: [
      { id: 1, fullName: "Первый сотрудник", active: 1, siteId: null, source: "manual", availability: "unassigned", ...terminalEmployee },
      { id: 2, fullName: "Второй сотрудник", active: 1, siteId: 1, source: "manual", availability: "on_site" },
      { id: 3, fullName: "Третий сотрудник", active: 1, siteId: 2, source: "bitrix24", availability: "vacation" },
      { id: 4, fullName: duplicateMasterName ? "Первый сотрудник" : "Не в проекте", active: 1, siteId: 2, source: "manual", availability: "on_site" },
    ],
    assignments: [{ employeeId: 2, siteId: 1, active: 1 }, { employeeId: 3, siteId: 2, active: 1 }, { employeeId: 1, siteId: 1, active: 1 }, ...(duplicateMasterName ? [{ employeeId: 4, siteId: 1, active: 1 }] : [])],
    zones: [{ id: 1, siteId: 1, name: "Зона А", active: 1 }], masters: [],
    orders: new Map([["project-personnel:1", [2, 1]], ["project-personnel:2", [3]], ["import-order:project-personnel:1", [1, 2]], ["import-order:project-personnel:2", [3]]]),
  };
  const original = structuredClone(state);
  const result = (rows = [], changes = rows.length) => ({ results: rows, success: true, meta: { changes, last_row_id: null } });
  return {
    snapshot: () => structuredClone(state), original,
    async transaction(callback) {
      const pending = structuredClone(state);
      let inserted = 0;
      const eligible = (sql, row) => row.active && (!sql.includes("terminal_check")
        || !["blacklisted", "dismissed", "deleted"].includes(row.availability) && !["blacklisted_in_bitrix", "dismissed_in_bitrix"].includes(row.checkStatus));
      const execute = (sql, values) => {
        if (sql.includes("pg_advisory_xact_lock")) return result([]);
        if (sql.startsWith("INSERT INTO table_row_orders")) { if (!pending.orders.has(values[0])) pending.orders.set(values[0], []); return result([], 1); }
        if (sql.startsWith("SELECT row_ids AS ids FROM table_row_orders")) return result(pending.orders.has(values[0]) ? [{ ids: pending.orders.get(values[0]) }] : []);
        if (sql.startsWith("UPDATE table_row_orders")) {
          if (failOrderWrite) throw new Error("Тестовый сбой сохранения порядка");
          pending.orders.set(values[1], JSON.parse(values[0])); return result([], 1);
        }
        if (sql.startsWith("SELECT id FROM sites")) return result(pending.sites.filter(row => row.id === values[0] && row.active));
        if (sql.startsWith("SELECT id FROM employees")) return result(pending.employees.filter(row => values[0].includes(row.id) && eligible(sql, row)).map(row => ({ id: row.id })));
        if (sql.startsWith("SELECT employee_id AS employeeId")) return result(pending.assignments.filter(row => values[0].includes(row.employeeId) && row.siteId === values[1] && row.active).map(row => ({ employeeId: row.employeeId })));
        if (sql.startsWith("INSERT INTO employee_project_assignments")) { pending.assignments.push({ employeeId: values[0], siteId: values[1], active: 1 }); return result([], 1); }
        if (sql.startsWith("UPDATE employees")) {
          if (values[1] === failEmployeeUpdate) throw new Error("Тестовый сбой записи сотрудника");
          const employee = pending.employees.find(row => row.id === values[1] && eligible(sql, row));
          if (!employee) return result([], 0);
          employee.siteId ??= values[0]; if (employee.source !== "bitrix24") employee.availability = "on_site";
          return result([], 1);
        }
        if (sql.startsWith("SELECT e.id, e.full_name")) return result(pending.employees.filter(row => eligible(sql, row) && pending.assignments.some(assignment => assignment.employeeId === row.id && assignment.siteId === values[0] && assignment.active)).map(row => ({ id: row.id, fullName: row.fullName })));
        const table = sql.match(/(?:FROM|INTO) (zones|masters)/)?.[1];
        if (table && sql.startsWith("SELECT")) return result(pending[table].filter(row => row.siteId === values[0] && row.active));
        if (table && sql.startsWith("INSERT")) {
          if (++inserted === failInsertAt) throw new Error("Тестовый сбой записи справочника");
          pending[table].push({ id: pending[table].length + 1, siteId: values[0], name: values[1], active: 1 }); return result([], 1);
        }
        throw new Error(`Неожиданный SQL в проверке: ${sql}`);
      };
      const db = { prepare(sql) {
        const statement = values => ({ bind: (...next) => statement(next), all: async () => execute(sql, values), first: async () => execute(sql, values).results[0] ?? null, run: async () => execute(sql, values) });
        return statement([]);
      } };
      const output = await callback(db);
      state = pending;
      return output;
    },
  };
}

test("project employee import deduplicates IDs and preserves existing assignments and Bitrix state", async () => {
  const db = memoryDatabase();
  const output = await importProjectEmployeesExcel(db, 1, [3, 2, 3]);
  assert.deepEqual(output, { count: 1, skipped: 1 });
  const snapshot = db.snapshot();
  assert.ok(snapshot.assignments.some(row => row.employeeId === 3 && row.siteId === 1));
  assert.ok(snapshot.assignments.some(row => row.employeeId === 3 && row.siteId === 2));
  assert.equal(snapshot.employees.find(row => row.id === 3).availability, "vacation");
  assert.equal(snapshot.employees.find(row => row.id === 3).siteId, 2);
  assert.deepEqual(snapshot.orders.get("import-order:project-personnel:1"), [3, 2, 1]);
  assert.deepEqual(snapshot.orders.get("project-personnel:1"), [2, 1], "an import never changes the independently saved manual order");
  assert.deepEqual(snapshot.orders.get("import-order:project-personnel:2"), [3]);
});

test("Excel cannot assign or select a dismissed employee as a master, including a terminal Bitrix warning", async () => {
  for (const terminalEmployee of [{ availability: "blacklisted" }, { availability: "dismissed" }, { checkStatus: "dismissed_in_bitrix" }, { checkStatus: "blacklisted_in_bitrix" }]) {
    const db = memoryDatabase({ terminalEmployee });
    await assert.rejects(importProjectEmployeesExcel(db, 2, [1, 2]), /архивирован/);
    await assert.rejects(importProjectDirectoryExcel(db, 1, "master", { employeeIds: [1] }), /архивирован/);
    assert.deepEqual(db.snapshot(), db.original);
  }
});

test("reimporting existing project employees changes import order without duplicate assignments or touching other projects", async () => {
  const db = memoryDatabase();
  await importProjectEmployeesExcel(db, 1, [3, 2, 3]);
  assert.deepEqual(await importProjectEmployeesExcel(db, 1, [2, 3, 1, 3]), { count: 0, skipped: 3 });
  const snapshot = db.snapshot();
  assert.deepEqual(snapshot.orders.get("import-order:project-personnel:1"), [2, 3, 1]);
  assert.equal(snapshot.assignments.filter(row => row.siteId === 1 && row.employeeId === 3).length, 1);
  assert.deepEqual(snapshot.orders.get("project-personnel:1"), db.original.orders.get("project-personnel:1"));
  assert.deepEqual(snapshot.orders.get("import-order:project-personnel:2"), db.original.orders.get("import-order:project-personnel:2"));
});

test("a late import-order write failure rolls back project assignments and employee state", async () => {
  const db = memoryDatabase({ failOrderWrite: true });
  await assert.rejects(importProjectEmployeesExcel(db, 1, [4, 3]), /сбой сохранения порядка/);
  assert.deepEqual(db.snapshot(), db.original);
});

test("project employee import validates every ID and rolls back even a late write failure", async () => {
  const invalid = memoryDatabase();
  await assert.rejects(importProjectEmployeesExcel(invalid, 1, [3, 999]), /не найден/);
  assert.deepEqual(invalid.snapshot(), invalid.original);
  const failed = memoryDatabase({ failEmployeeUpdate: 3 });
  await assert.rejects(importProjectEmployeesExcel(failed, 1, [4, 3]), /Тестовый сбой/);
  assert.deepEqual(failed.snapshot(), failed.original);
  await assert.rejects(importProjectEmployeesExcel(failed, 1, [1, "3"]), /некорректные/);
});

test("project directories import skips existing normalized values and never partially saves a workbook", async () => {
  const db = memoryDatabase();
  assert.deepEqual(await importProjectDirectoryExcel(db, 1, "zone", { names: [" зона   а ", "Новая зона", "Новая зона"] }), { count: 1, skipped: 2 });
  assert.deepEqual(db.snapshot().zones.map(row => row.name), ["Зона А", "Новая зона"]);
  const failed = memoryDatabase({ failInsertAt: 2 });
  await assert.rejects(importProjectDirectoryExcel(failed, 1, "zone", { names: ["Первая новая", "Вторая новая"] }), /Тестовый сбой/);
  assert.deepEqual(failed.snapshot(), failed.original);
  await assert.rejects(importProjectDirectoryExcel(failed, 1, "subworkType", { names: ["Подвид без родителя"] }), /общий шаблон/);
});

test("master import uses active project employee IDs and rejects namesake ambiguity", async () => {
  const db = memoryDatabase();
  assert.deepEqual(await importProjectDirectoryExcel(db, 1, "master", { employeeIds: [1] }), { count: 1, skipped: 0 });
  assert.equal(db.snapshot().masters[0].name, "Первый сотрудник");
  await assert.rejects(importProjectDirectoryExcel(db, 1, "master", { employeeIds: [4] }), /не относится/);
  const ambiguous = memoryDatabase({ duplicateMasterName: true });
  await assert.rejects(importProjectDirectoryExcel(ambiguous, 1, "master", { employeeIds: [1] }), /неоднозначно/);
  assert.deepEqual(ambiguous.snapshot(), ambiguous.original);
});
