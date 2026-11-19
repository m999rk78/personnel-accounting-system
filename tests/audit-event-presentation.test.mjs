import assert from "node:assert/strict";
import test from "node:test";
import { presentAuditEvent } from "../app/auditEventPresentation.ts";

const event = (overrides = {}) => ({ id: 1, actorUserId: 9, actorName: "Инженер", actorRole: "engineer", category: "directories", actionKey: "employee.update", entityType: "employee", entityId: "7", siteId: 2, siteName: "Объект А", summary: "Изменил сотрудника", beforeData: null, afterData: { requested: {}, result: { ok: true } }, createdAt: "2026-11-18T08:00:00Z", ...overrides });
const refs = [{ kind: "employee", id: 7, label: "Иван Старый" }, { kind: "employee", id: 8, label: "Пётр" }, { kind: "project", id: 2, label: "Объект А" }, { kind: "project", id: 3, label: "Объект Б" }];
const values = result => result.sections.flatMap(section => section.fields);
const field = (result, label) => values(result).find(field => field.label === label);

test("employee transfer describes actual assignments, renamed person and destination without rewriting historical names", () => {
  const source = event({ siteId: 3, siteName: "Объект Б", afterData: { requested: { action: "update-employee", employeeId: 7, fullName: "Иван Новый", position: "Сварщик", projectSiteId: 3 }, result: { ok: true }, context: { version: 1, references: refs, before: { id: 7, fullName: "Иван Старый", position: "Монтажник", projectSiteId: 99, assignments: [{ siteId: 2, siteName: "Объект А", startDate: "2026-11-01", endDate: null }] } } } });
  const original = structuredClone(source), view = presentAuditEvent(source);
  assert.deepEqual(field(view, "ФИО"), { label: "ФИО", before: "Иван Старый", value: "Иван Новый" });
  assert.deepEqual(field(view, "Назначения на проекты"), { label: "Назначения на проекты", before: "Объект А", value: "Объект Б" });
  assert.deepEqual(field(view, "Должность"), { label: "Должность", before: "Монтажник", value: "Сварщик" });
  assert.equal(field(view, "Начало назначения").value, "01.11.2026");
  assert.ok(view.links.some(link => link.target.view === "projectSettings" && link.target.siteId === 2));
  assert.ok(view.links.some(link => link.target.view === "employees" && link.target.employeeId === 7));
  assert.doesNotMatch(view.searchText, /99|projectSiteId|on_site/);
  assert.deepEqual(source, original, "formatter never mutates audit evidence");
});

test("adding another assignment does not falsely describe a transfer out of the original project", () => {
  const view = presentAuditEvent(event({ actionKey: "employee.assign", afterData: { requested: { employeeId: 7, siteId: 3 }, result: { ok: true }, context: { references: refs, before: { fullName: "Иван", assignments: [{ siteId: 2, siteName: "Объект А", startDate: "2026-11-01", endDate: null }] } } }, siteId: 3, siteName: "Объект Б" }));
  assert.equal(field(view, "В какой проект добавлен").value, "Объект Б");
  assert.equal(field(view, "Назначения на проекты"), undefined);
  assert.ok(view.sections.some(section => section.title === "Назначение до изменения"));
});

test("legacy missing values are explicitly unavailable, never assumed empty or reconstructed from current catalogs", () => {
  const view = presentAuditEvent(event({ afterData: { requested: { employeeId: 7, fullName: "Иван", projectSiteId: 3 }, result: { ok: true } } }));
  assert.equal(field(view, "ФИО").before, undefined);
  assert.equal(field(view, "Проект").value, "Проект №3");
  assert.match(view.notes.join(" "), /Прежние значения.*не были сохранены/);
  assert.doesNotMatch(view.searchText, /"requested"|\{|\}/);
});

test("manual personnel marks distinguish zero, empty cell, removal and codes with their meanings", () => {
  const base = event({ actionKey: "personnel_timesheet.set", entityType: "employee_timesheet", category: "timesheets", beforeData: { hours: 0, code: null, employeeName: "Иван" }, afterData: { requested: { employeeId: 7, siteId: 2, workDate: "2026-11-16", value: "УВ" }, result: { ok: true }, context: { references: refs } } });
  let view = presentAuditEvent(base);
  assert.deepEqual(field(view, "Значение"), { label: "Значение", before: "0 ч.", value: "УВ — Увольнение" });
  assert.ok(view.links.some(link => link.target.view === "timesheet" && link.target.employeeId === 7 && link.target.month === "2026-11" && link.target.siteId === 2));
  view = presentAuditEvent({ ...base, beforeData: { hours: null, code: null } });
  assert.equal(field(view, "Значение").before, "Пустая ячейка");
  view = presentAuditEvent({ ...base, actionKey: "personnel_timesheet.delete" });
  assert.match(field(view, "Значение").value, /значение определяется отчётом/);
});

test("equipment mark changes preserve zero working and downtime hours", () => {
  const view = presentAuditEvent(event({ actionKey: "equipment_timesheet.set", entityType: "equipment_timesheet", entityId: "12", beforeData: { productiveHours: 6, downtimeHours: 0, note: "" }, afterData: { requested: { equipmentId: 12, workDate: "2026-11-17", productiveHours: 0, downtimeHours: 4, note: "Ремонт" }, result: { ok: true }, context: { references: [{ kind: "equipment", id: 12, label: "Кран А123" }] } } }));
  assert.deepEqual(field(view, "Работа"), { label: "Работа", before: "6 ч.", value: "0 ч." });
  assert.deepEqual(field(view, "Простой"), { label: "Простой", before: "0 ч.", value: "4 ч." });
  assert.ok(view.links.some(link => link.target.equipmentId === 12));
});

test("report date change links use employee identifiers from rows, never report id", () => {
  const view = presentAuditEvent(event({ actionKey: "personnel_report.change-date", entityType: "personnel_report_draft", entityId: "501", summary: "Изменил дату на 2026-11-16", beforeData: { id: 501, workDate: "2026-11-18", status: "draft", rows: [{ id: 21, employee_id: 7, employee_name_snapshot: "Иван", hours: 8 }] }, afterData: { requested: { action: "change-date", reportId: 501, workDate: "2026-11-16" }, result: { report: { id: 501, workDate: "2026-11-16", status: "draft", rows: [{ id: 21, employeeId: 7, employeeName: "Иван", workDate: "2026-11-16", hours: 8 }] } } } }));
  assert.equal(view.title, "Изменил дату на 16.11.2026");
  assert.deepEqual(field(view, "Дата"), { label: "Дата", before: "18.11.2026", value: "16.11.2026" });
  assert.ok(view.links.some(link => link.target.employeeId === 7));
  assert.ok(view.links.every(link => link.target.employeeId !== 501));
  assert.ok(view.links.some(link => link.label === "Открыть раздел отчётов персонала" && link.target.siteId === 2));
});

test("report changes are matched by row identity when one employee has several work rows", () => {
  const view = presentAuditEvent(event({ actionKey: "personnel_report.save", entityType: "personnel_report_draft", beforeData: { rows: [{ id: 21, employee_id: 7, hours: 4, note: "А" }, { id: 22, employee_id: 7, hours: 5, note: "Б" }] }, afterData: { requested: { reportId: 9, rows: [{ id: 22, employeeId: 7, hours: 3, note: "Б" }, { id: 21, employeeId: 7, hours: 4, note: "А" }] }, result: {}, context: { references: refs } } }));
  assert.deepEqual(values(view).filter(field => field.label === "Часы"), [{ label: "Часы", before: "5 ч.", value: "3 ч." }]);
  assert.equal(view.sections.filter(section => section.title.startsWith("Строка ")).length, 1);
  assert.ok(view.links.some(link => link.target.employeeId === 7));
});

test("removed report rows retain employee and hours; unrelated response datasets are ignored", () => {
  const view = presentAuditEvent(event({ actionKey: "personnel_report.delete-approved-rows", entityType: "placement_entry", entityId: "501", beforeData: [{ entry: { id: 501, employee_id: 7, employee_name_snapshot: "Историческое имя", work_date: "2026-11-16", hours: 10, note: "Смена" }, report: { owner_password: "secret" } }], afterData: { requested: { rows: [{ entryId: 501 }] }, result: { entries: [{ employeeName: "Посторонний человек", hours: 200 }], deleted: 1 } } }));
  assert.match(view.searchText, /Историческое имя.*16\.11\.2026/s);
  assert.equal(field(view, "Часы").value, "10 ч.");
  assert.doesNotMatch(view.searchText, /Посторонний|secret|owner_password/);
  assert.ok(view.links.some(link => link.target.employeeId === 7), "deleting a report row keeps the employee and its history available");
});

test("a single old equipment report deletion shows its saved fields", () => {
  const view = presentAuditEvent(event({ actionKey: "equipment_report.delete", entityType: "equipment_report", beforeData: { workDate: "2026-11-10", equipmentType: "Кран", brand: "SANY", hours: 7, note: "Монтаж" }, afterData: { requested: { action: "delete-entry", id: 12 }, result: { ok: true } } }));
  assert.equal(field(view, "Часы").value, "7 ч.");
  assert.equal(field(view, "Тип техники").value, "Кран");
});

test("snapshot truncation never invents removed rows and all 200 stored rows remain readable", () => {
  const base = event({ actionKey: "personnel_report.save", entityType: "personnel_report_draft", beforeData: { rows: [{ id: 1, employee_id: 7, hours: 9 }] }, afterData: { requested: {}, result: { report: { rows: "[вложенные данные скрыты]" } } } });
  let view = presentAuditEvent(base);
  assert.ok(view.sections.every(section => !section.title.startsWith("Удалённая строка")));
  assert.match(view.notes.join(" "), /сокращённые данные/);
  const rows = Array.from({ length: 200 }, (_, index) => ({ employeeId: index + 1, hours: index % 10 + 1 }));
  view = presentAuditEvent({ ...base, beforeData: null, afterData: { requested: { rows: { items: rows, total: 240, truncated: true } }, result: {} } });
  assert.equal(view.sections.filter(section => section.title.startsWith("Строка ")).length, 200);
  assert.match(view.notes.join(" "), /сокращённые данные/);
});

test("table move uses frozen employee names, date, exact before/after relation and safe targets", () => {
  const moving = "2026-11-18/approved-501", target = "2026-11-18/report-17-23";
  const view = presentAuditEvent(event({ actionKey: "table.reorder", entityType: "table_row_order", entityId: "personnel-report-rows", afterData: { requested: { scope: "personnel-report-rows", movingIds: [moving], targetId: target, placement: "before" }, result: { ids: [moving, target] }, context: { references: refs, rowLabels: [{ kind: "employee", id: moving, entityId: 7, label: "Иван", workDate: "2026-11-18", siteId: 2 }, { kind: "employee", id: target, entityId: 8, label: "Пётр", workDate: "2026-11-18", siteId: 2 }] } } }));
  assert.equal(field(view, "Таблица").value, "Отчёт персонала");
  assert.equal(field(view, "Куда").value, "Перед строкой «Пётр · 18.11.2026»");
  assert.equal(field(view, "Какие строки").value, "Иван · 18.11.2026");
  assert.doesNotMatch(view.searchText, /approved-501|report-17-23|personnel-report-rows/);
  assert.ok(view.links.some(link => link.target.employeeId === 7));
  assert.ok(view.links.some(link => link.label === "Открыть таблицу" && link.target.view === "placement"));
});

test("legacy table move tokens are not exposed as system code", () => {
  const view = presentAuditEvent(event({ actionKey: "table.reorder", entityType: "table_row_order", entityId: "directory-work-types", afterData: { requested: { scope: "directory-work-types", movingIds: ["parent-381"], targetId: "child-931", placement: "after" }, result: {} } }));
  assert.equal(field(view, "Таблица").value, "Виды и подвиды работ");
  assert.match(field(view, "Куда").value, /^После строки/);
  assert.doesNotMatch(view.searchText, /parent-381|child-931/);
});

test("bulk deleted names remain searchable without offering filtered links to deleted records", () => {
  const view = presentAuditEvent(event({ actionKey: "employee.delete", entityId: "", afterData: { requested: { ids: [7, 8] }, result: { count: 2 }, context: { references: refs, before: { employees: [{ id: 7, fullName: "Иван", position: "Сварщик" }, { id: 8, fullName: "Пётр", position: "Монтажник" }] } } } }));
  assert.match(view.searchText, /Иван/);
  assert.match(view.searchText, /Пётр/);
  assert.equal(view.sections.filter(section => section.title.startsWith("Удалена запись")).length, 2);
  assert.ok(view.links.every(link => link.target.employeeId === undefined));
});

test("permissions are named in Russian and only explicit granted actions are displayed", () => {
  const view = presentAuditEvent(event({ actionKey: "access_rights.update", entityType: "user_permissions", entityId: "9", afterData: { requested: { userId: 9, permissions: { workers_timesheet: { view: true, create: false, update: true, delete: false }, unknown_system_feature: { view: true } }, projectAccess: { mode: "selected", siteIds: [2] } }, result: {}, context: { references: [...refs, { kind: "user", id: 9, label: "Инженер" }] } } }));
  assert.deepEqual(field(view, "Табель рабочих"), { label: "Табель рабочих", value: "Просмотр, Редактирование" });
  assert.equal(field(view, "Разрешённые проекты").value, "Объект А");
  assert.ok(view.context.some(field => field.label === "Пользователь" && field.value === "Инженер"));
  assert.doesNotMatch(view.searchText, /workers_timesheet|unknown_system_feature|permissions/);
});

test("work type archive resolves numeric selections and cascaded children from snapshots", () => {
  const view = presentAuditEvent(event({ actionKey: "work_types.archive", entityType: "directory", beforeData: { parents: [{ id: 3, name: "Монтаж", active: 1 }], children: [{ id: 4, name: "Установка опор", parentId: 3, active: 1 }] }, afterData: { requested: { action: "archive", parents: [3], children: [] }, result: { count: 2 }, context: { references: [{ kind: "workType", id: 3, label: "Монтаж" }] } } }));
  assert.ok(view.sections.some(section => section.title === "Вид работы · Монтаж"));
  assert.ok(view.sections.some(section => section.title === "Подвид работы · Установка опор"));
  assert.equal(values(view).filter(field => field.label === "Активен" && field.before === "Да" && field.value === "Нет").length, 2);
});

test("directory bulk save describes each name change from actual directories payload", () => {
  const view = presentAuditEvent(event({ actionKey: "directory.save", entityType: "directory", afterData: { requested: { action: "save-directory-items", entity: "zone", directories: [{ directoryId: 3, name: "Зона Б" }, { name: "Новая зона" }] }, result: { count: 2 }, context: { before: { items: [{ id: 3, name: "Зона А" }] }, references: [] } } }));
  assert.deepEqual(values(view).filter(field => field.label === "Название"), [{ label: "Название", before: "Зона А", value: "Зона Б" }, { label: "Название", value: "Новая зона" }]);
  assert.ok(view.links.some(link => link.target.directoryFocus === "zone"));
});

test("sensitive and unrecognized fields never appear even in historical unsanitized payloads", () => {
  const view = presentAuditEvent(event({ actionKey: "user.create", entityType: "user", afterData: { requested: { fullName: "Иван", password: "PASSWORD_VALUE", token: "TOKEN_VALUE", cookie: "COOKIE_VALUE", internals: { webHook: "HOOK" } }, result: { id: 8, invitationUrl: "https://secret.invalid", emailSent: false, secret: "SECRET_VALUE" } } }));
  assert.doesNotMatch(view.searchText, /PASSWORD_VALUE|TOKEN_VALUE|COOKIE_VALUE|HOOK|SECRET_VALUE|secret.invalid/);
  assert.equal(field(view, "Письмо с приглашением отправлено").value, "Нет");
});

test("invalid and missing envelopes do not crash or make up detailed changes", () => {
  for (const beforeData of [null, 1, "bad", {}, []]) for (const afterData of [null, 1, "bad", {}, [], { requested: null, result: null }]) {
    const view = presentAuditEvent(event({ beforeData, afterData, actionKey: "legacy.unknown", entityType: "legacy", entityId: "" }));
    assert.ok(view.notes.length);
    assert.equal(view.sections.length, 0);
    assert.doesNotMatch(view.searchText, /undefined|\[object Object\]|legacy\.unknown/);
  }
});

test("unassignment still links the employee and historical month in Moscow time", () => {
  const view = presentAuditEvent(event({ actionKey: "employee.unassign", createdAt: "2026-10-31T22:00:00Z", afterData: { requested: { entity: "employee-assignment", id: 7, siteId: 2 }, result: { ok: true }, context: { references: refs, before: { id: 7, fullName: "Иван", assignments: [{ siteId: 2, siteName: "Объект А", startDate: "2026-10-31 22:00:00+00", endDate: null }] } } } }));
  assert.equal(field(view, "Начало назначения").value, "01.11.2026");
  assert.ok(view.links.some(link => link.target.view === "timesheet" && link.target.employeeId === 7 && link.target.month === "2026-11"));
});

test("redacted cross-project context is explained without inventing old assignments", () => {
  const view = presentAuditEvent(event({ afterData: { requested: { employeeId: 7, fullName: "Иван", projectSiteId: 2 }, result: { ok: true }, context: { version: 1, references: [], restricted: true } } }));
  assert.match(view.notes.join(" "), /Часть сведений недоступна по правам доступа/);
  assert.equal(field(view, "Назначения на проекты"), undefined);
});

test("directory deletion with kind retains its section link", () => {
  const view = presentAuditEvent(event({ actionKey: "directory.delete", entityType: "directory", afterData: { requested: { entity: "directory", kind: "zone", id: 3 }, result: { ok: true }, context: { before: { id: 3, name: "Зона А" }, references: [] } } }));
  assert.ok(view.links.some(link => link.target.view === "directories" && link.target.directoryFocus === "zone" && link.target.siteId === 2));
  assert.equal(field(view, "Название").value, "Зона А");
});

test("report workflow transitions describe the affected saved rows even when their hours did not change", () => {
  for (const [action, status] of [["submit", "submitted"], ["approve", "approved"], ["reject", "rejected"], ["reopen", "draft"]]) {
    const view = presentAuditEvent(event({ actionKey: `personnel_report.${action}`, entityType: "personnel_report_draft", beforeData: { status: "submitted", rows: [{ id: 21, employee_id: 7, employee_name_snapshot: "Иван", hours: 10 }] }, afterData: { requested: { action, reportId: 9 }, result: { report: { id: 9, status, workDate: "2026-11-16", rows: [{ id: 21, employeeId: 7, employeeName: "Иван", hours: 10 }] } } } }));
    assert.equal(field(view, "Часы").value, "10 ч.", action);
    assert.equal(field(view, "Часы").before, undefined, action);
    assert.ok(view.sections.some(section => section.title.startsWith("Строка ") && section.title.includes("Иван")), action);
    assert.ok(view.links.some(link => link.target.view === "timesheet" && link.target.employeeId === 7), action);
  }
});
