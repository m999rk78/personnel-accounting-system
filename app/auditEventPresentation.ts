import type { AuditNavigationTarget } from "./auditNavigation";
import { PERMISSION_ACTION_LABELS, PERMISSION_CATALOG } from "./permissionModel.ts";
import { isUserRole, ROLE_LABELS } from "./roles.ts";
import { PERSONNEL_TIMESHEET_CODES } from "./personnelTimesheetValues.ts";

export type AuditEvent = {
  id: number; actorUserId: number | null; actorName: string; actorRole: string;
  category: string; actionKey: string; entityType: string; entityId: string;
  siteId: number | null; siteName: string; summary: string;
  beforeData: unknown; afterData: unknown; createdAt: string;
};
export type AuditDetailField = { label: string; before?: string; value: string };
export type AuditRelatedLink = { label: string; target: AuditNavigationTarget };
export type AuditEventPresentation = {
  title: string; context: AuditDetailField[];
  sections: { title: string; fields: AuditDetailField[] }[];
  links: AuditRelatedLink[]; notes: string[]; searchText: string;
};
type RecordValue = Record<string, unknown>;
type Reference = { kind: string; id: string | number; label: string; siteId?: number; workDate?: string };
type FieldDefinition = { key: string; label: string; aliases?: string[]; kind?: string; names?: string[]; date?: boolean; hours?: boolean; values?: Record<string, string> };

const STATUS: Record<string, string> = { draft: "Черновик", submitted: "На проверке", approved: "Подтверждён", rejected: "Возвращён на доработку" };
const ENTITY_LABELS: Record<string, string> = { employee: "Сотрудник", equipment: "Техника", project: "Проект", user: "Пользователь", position: "Должность", shift: "Смена", zone: "Зона", workType: "Вид работы", subworkType: "Подвид работы", master: "Мастер", directory: "Значение справочника" };
const SCOPE_LABELS: Record<string, string> = {
  employees: "Сотрудники", users: "Пользователи системы", projects: "Проекты", positions: "Должности", equipment: "Реестр техники",
  "project-personnel": "Сотрудники проекта и табель персонала", "project-equipment": "Техника проекта и табель техники",
  "personnel-report-rows": "Отчёт персонала", "equipment-report-rows": "Отчёт техники",
  "directory-work-types": "Виды и подвиды работ", "directory-zone": "Зоны", "directory-master": "Мастера",
};
const FIELD_DEFINITIONS: FieldDefinition[] = [
  { key: "fullName", label: "ФИО", aliases: ["full_name"] },
  { key: "name", label: "Название" },
  { key: "subworkName", label: "Подвид работы" },
  { key: "employeeId", label: "Сотрудник", aliases: ["employee_id"], kind: "employee", names: ["employeeName", "employee_name_snapshot"] },
  { key: "equipmentId", label: "Техника", aliases: ["equipment_id"], kind: "equipment", names: ["equipmentName", "equipment_name_snapshot"] },
  { key: "workDate", label: "Дата", aliases: ["work_date"], date: true },
  { key: "status", label: "Статус", values: STATUS },
  { key: "hours", label: "Часы", hours: true },
  { key: "productiveHours", label: "Работа", aliases: ["productive_hours"], hours: true },
  { key: "downtimeHours", label: "Простой", aliases: ["downtime_hours"], hours: true },
  { key: "code", label: "Отметка" },
  { key: "value", label: "Отметка" },
  { key: "shiftId", label: "Смена", aliases: ["shift_id"], kind: "shift", names: ["shiftName"] },
  { key: "zoneId", label: "Зона", aliases: ["zone_id"], kind: "zone", names: ["zoneName"] },
  { key: "mainWorkTypeId", label: "Вид работы", aliases: ["main_work_type_id", "parentId"], kind: "workType", names: ["mainWorkTypeName"] },
  { key: "subworkTypeId", label: "Подвид работы", aliases: ["subwork_type_id"], kind: "subworkType", names: ["subworkTypeName"] },
  { key: "masterId", label: "Мастер", aliases: ["master_id"], kind: "master", names: ["masterName", "master_name_snapshot"] },
  { key: "ownerUserId", label: "Автор отчёта", aliases: ["owner_user_id"], kind: "user", names: ["ownerName"] },
  { key: "responsibleUserId", label: "Ответственный", aliases: ["responsible_user_id"], kind: "user", names: ["responsibleUserName"] },
  { key: "projectSiteId", label: "Проект", aliases: ["site_id"], kind: "project", names: ["siteName"] },
  { key: "assignedSiteId", label: "Основной проект пользователя", aliases: ["assigned_site_id"], kind: "project", names: ["assignedSiteName"] },
  { key: "employmentType", label: "Тип сотрудника", aliases: ["employment_type", "employment_type_snapshot"] },
  { key: "department", label: "Отдел", aliases: ["department_snapshot"] },
  { key: "position", label: "Должность", aliases: ["positionSnapshot", "position_snapshot"] },
  { key: "organization", label: "Организация" },
  { key: "equipmentType", label: "Тип техники", aliases: ["equipment_type"] },
  { key: "brand", label: "Марка" },
  { key: "model", label: "Модель" },
  { key: "registrationNumber", label: "Регистрационный номер", aliases: ["registration_number"] },
  { key: "email", label: "Электронная почта" },
  { key: "role", label: "Роль" },
  { key: "customRoleName", label: "Роль пользователя" },
  { key: "availabilityStatus", label: "Состояние сотрудника", aliases: ["availability_status"], values: { on_site: "На объекте", unassigned: "Без проекта", dismissed: "Уволен", blacklisted: "В чёрном списке", vacation: "В отпуске", transferred: "Переведён" } },
  { key: "startDate", label: "Начало назначения", aliases: ["start_date"], date: true },
  { key: "endDate", label: "Окончание назначения", aliases: ["end_date"], date: true },
  { key: "note", label: "Примечание" },
  { key: "comment", label: "Комментарий" },
  { key: "reviewComment", label: "Комментарий проверяющего", aliases: ["review_comment"] },
  { key: "active", label: "Активен" },
  { key: "canViewPendingReports", label: "Просмотр отчётов на проверке" },
];
const MISSING = "Не сохранено в журнале";
const EMPTY = "Не указано";
const MAX_ROWS = 200;
const MOSCOW_DATE = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" });

function record(value: unknown): RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : Array.isArray(record(value).items) ? record(value).items as unknown[] : []; }
function text(value: unknown): string { return typeof value === "string" ? value.trim().slice(0, 1_000) : typeof value === "number" && Number.isFinite(value) ? String(value) : ""; }
function id(value: unknown): number | undefined { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : undefined; }
function at(value: RecordValue, ...keys: string[]): unknown {
  for (const key of keys) for (const candidate of [key, key.toLowerCase()]) if (Object.prototype.hasOwnProperty.call(value, candidate)) return value[candidate];
  return undefined;
}
function date(value: unknown): string {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) {
    const parsed = new Date(raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    if (Number.isFinite(parsed.valueOf())) return MOSCOW_DATE.format(parsed);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : raw || EMPTY;
}
function month(value: unknown): string | undefined {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(raw)) {
    const formatted = date(value), match = /^\d{2}\.(\d{2})\.(\d{4})$/.exec(formatted);
    if (match) return `${match[2]}-${match[1]}`;
  }
  return /^(\d{4}-(?:0[1-9]|1[0-2]))(?:-\d{2})?$/.exec(raw)?.[1];
}
function primitive(value: unknown): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (value === "[вложенные данные скрыты]") return MISSING;
  return text(value) || MISSING;
}
function timesheetMark(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Пустая ячейка";
  const code = PERSONNEL_TIMESHEET_CODES.find(item => item.value === value);
  return code ? `${code.value} — ${code.label}` : /^\d+(?:\.\d+)?$/.test(String(value)) ? `${value} ч.` : primitive(value);
}
function containsTruncation(value: unknown, depth = 0): boolean {
  if (depth > 7 || !value || typeof value !== "object") return value === "[вложенные данные скрыты]";
  if (record(value).truncated === true) return true;
  return Object.values(value).some(item => containsTruncation(item, depth + 1));
}

/** Format saved evidence only: the current catalogs must never rewrite an old event. */
export function presentAuditEvent(event: AuditEvent): AuditEventPresentation {
  const after = record(event.afterData), request = record(after.requested), result = record(after.result), savedContext = record(after.context);
  const before = record(savedContext.before ?? event.beforeData);
  const references = list(savedContext.references).map(record).filter(ref => text(ref.kind) && text(ref.label)) as Reference[];
  const referenceByKey = new Map(references.map(ref => [`${ref.kind}:${ref.id}`, ref]));
  const report = record(result.report), entry = record(result.entry);
  const action = event.actionKey || "";
  const equipment = action.startsWith("equipment") || event.entityType.startsWith("equipment");
  const isReport = action.startsWith("personnel_report.") || action.startsWith("equipment_report.");
  const isTimesheet = action.startsWith("personnel_timesheet.") || action.startsWith("equipment_timesheet.");
  const deleted = /(?:\.delete(?:-approved-rows)?|\.unassign)$/.test(action);
  const employeeDeleted = action === "employee.delete" || action === "bitrix.employee.delete";
  const equipmentDeleted = action === "equipment.delete";
  const sections: AuditEventPresentation["sections"] = [], context: AuditDetailField[] = [], links: AuditRelatedLink[] = [], notes: string[] = [];
  const linkKeys = new Set<string>();
  const title = (event.summary || "Сохранено изменение").replace(/\b\d{4}-\d{2}-\d{2}\b/g, value => date(value));
  const workDate = at(report, "workDate") ?? at(entry, "workDate") ?? at(request, "workDate") ?? at(before, "workDate");
  const eventMonth = month(workDate) ?? month(event.createdAt);
  const eventSiteId = id(event.siteId) ?? id(at(request, "siteId")) ?? id(at(before, "siteId"));

  const referenceLabel = (kind: string, value: unknown, fallback?: unknown): string => {
    if (text(fallback)) return text(fallback);
    if (value === null || value === "" || value === undefined) return EMPTY;
    const found = referenceByKey.get(`${kind}:${value}`);
    return found?.label || (id(value) ? `${ENTITY_LABELS[kind] ?? "Запись"} №${id(value)}` : "Название не сохранено в журнале");
  };
  const addLink = (label: string, target: AuditNavigationTarget) => {
    const key = JSON.stringify(target);
    if (!linkKeys.has(key)) { links.push({ label, target }); linkKeys.add(key); }
  };
  const addEntityLink = (kind: string, value: unknown, label: string, siteId = eventSiteId, workMonth = eventMonth) => {
    const entityId = id(value);
    if (!entityId) return;
    // A deleted report row/mark does not delete its employee or equipment.
    if (kind === "employee") {
      addLink(employeeDeleted ? "Открыть раздел сотрудников" : `Сотрудник: ${label}`, { view: "employees", ...(employeeDeleted ? {} : { employeeId: entityId, ...(workMonth ? { month: workMonth } : {}) }) });
      if (!employeeDeleted && siteId && workMonth && (isReport || isTimesheet || action === "employee.unassign")) addLink(`Табель: ${label}`, { view: "timesheet", siteId, employeeId: entityId, month: workMonth });
    } else if (kind === "equipment") {
      addLink(equipmentDeleted ? "Открыть реестр техники" : `Техника: ${label}`, { view: "equipmentRegistry", ...(equipmentDeleted ? {} : { equipmentId: entityId, ...(workMonth ? { month: workMonth } : {}) }) });
      if (!equipmentDeleted && siteId && workMonth && (isReport || isTimesheet || action === "equipment.unassign")) addLink(`Табель техники: ${label}`, { view: "equipmentTimesheet", siteId, equipmentId: entityId, month: workMonth });
    } else if (kind === "project") {
      if (action === "project.delete") addLink("Открыть список проектов", { view: "projects" });
      else addLink(`Настройки проекта: ${label}`, { view: "projectSettings", siteId: entityId });
    } else if (kind === "user") addLink("Открыть пользователей системы", { view: "users" });
    else if (kind === "position") addLink("Открыть список должностей", { view: "positions" });
    else if (siteId && ["zone", "workType", "subworkType", "master"].includes(kind)) addLink(`Открыть раздел «${ENTITY_LABELS[kind]}»`, { view: "directories", siteId, directoryFocus: kind === "workType" ? "mainWorkType" : kind as "zone" | "subworkType" | "master" });
  };
  const formatField = (definition: FieldDefinition, row: RecordValue): string => {
    const value = at(row, definition.key, ...(definition.aliases ?? []));
    if (definition.kind) return referenceLabel(definition.kind, value, definition.names ? at(row, ...definition.names) : undefined);
    if (definition.date) return date(value);
    if (definition.hours) return value === null || value === undefined || value === "" ? EMPTY : `${primitive(value)} ч.`;
    if (definition.key === "role") return isUserRole(value) ? ROLE_LABELS[value] : text(at(row, "customRoleName")) || "Пользовательская роль";
    if (definition.key === "active" && (value === 0 || value === 1)) return value === 1 ? "Да" : "Нет";
    if (definition.values) return value === null || value === undefined || value === "" ? EMPTY : definition.values[String(value)] ?? "Другое состояние";
    return primitive(value);
  };
  const fields = (old: RecordValue, current: RecordValue, mode: "changes" | "saved" = "changes"): AuditDetailField[] => FIELD_DEFINITIONS.flatMap(definition => {
    const oldValue = at(old, definition.key, ...(definition.aliases ?? []));
    const value = at(current, definition.key, ...(definition.aliases ?? []));
    const currentName = definition.names && at(current, ...definition.names);
    if (value === undefined && currentName === undefined) return [];
    const formatted = formatField(definition, current);
    const oldFormatted = formatField(definition, old);
    if (mode === "changes" && oldValue !== undefined && formatted === oldFormatted) return [];
    if (definition.kind && id(value)) addEntityLink(definition.kind, value, formatted, id(at(current, "siteId", "site_id")) ?? eventSiteId, month(at(current, "workDate", "work_date")) ?? eventMonth);
    return [{ label: definition.label, value: formatted, ...(mode === "changes" && oldValue !== undefined ? { before: oldFormatted } : {}) }];
  });
  const addSection = (heading: string, values: AuditDetailField[]) => { if (values.length) sections.push({ title: heading, fields: values }); };
  const addRows = (oldValue: unknown, nextValue: unknown, heading: string, deletion = false, complete = false) => {
    if (!deletion && !Array.isArray(nextValue) && !Array.isArray(record(nextValue).items)) return;
    const oldRows = list(oldValue).map(item => record(record(item).entry ?? item));
    const rows = deletion ? oldRows : list(nextValue).map(record);
    const previousById = new Map(oldRows.filter(row => id(row.id)).map(row => [Number(row.id), row]));
    const showSavedRows = deletion || /\.(?:submit|approve|reject|reopen)$/.test(action);
    const seen = new Set<number>();
    let displayed = 0;
    for (const row of rows) {
      const rowId = id(row.id);
      if (rowId) seen.add(rowId);
      const old = rowId ? previousById.get(rowId) ?? {} : {};
      const values = fields(showSavedRows ? {} : old, row, showSavedRows ? "saved" : "changes");
      if (!values.length) continue;
      if (displayed++ >= MAX_ROWS) continue;
      const kind = equipment ? "equipment" : "employee";
      const entityId = at(row, equipment ? "equipmentId" : "employeeId", equipment ? "equipment_id" : "employee_id");
      const name = referenceLabel(kind, entityId, at(row, equipment ? "equipmentName" : "employeeName", equipment ? "equipment_name_snapshot" : "employee_name_snapshot"));
      const rowDate = at(row, "workDate", "work_date");
      addEntityLink(kind, entityId, name, id(at(row, "siteId", "site_id")) ?? eventSiteId, month(rowDate) ?? eventMonth);
      addSection(`${heading} ${displayed}${name !== EMPTY ? ` · ${name}` : ""}${rowDate ? ` · ${date(rowDate)}` : ""}`, values);
    }
    // A full saved report replaces its rows. Missing old rows are deletions, not hidden data.
    if (complete && !deletion && record(nextValue).truncated !== true) {
      for (const row of oldRows) if (id(row.id) && !seen.has(Number(row.id))) {
        if (displayed++ < MAX_ROWS) addSection(`Удалённая строка · ${referenceLabel(equipment ? "equipment" : "employee", at(row, equipment ? "equipmentId" : "employeeId", equipment ? "equipment_id" : "employee_id"), at(row, equipment ? "equipmentName" : "employeeName", equipment ? "equipment_name_snapshot" : "employee_name_snapshot"))}`, fields({}, row, "saved"));
      }
    }
    if (displayed > MAX_ROWS) notes.push(`Показаны первые ${MAX_ROWS} изменённых строк из ${displayed}.`);
  };

  if (event.siteName || eventSiteId) {
    const label = referenceLabel("project", eventSiteId, event.siteName);
    context.push({ label: "Проект", value: label });
    addEntityLink("project", eventSiteId, label);
  }
  if (workDate !== undefined) context.push({ label: "Дата отчёта / табеля", value: date(workDate) });
  const contextEntityKind = isTimesheet ? equipment ? "equipment" : "employee" : event.entityType === "user_permissions" ? "user" : ["employee", "equipment", "project", "user", "position"].includes(event.entityType) ? event.entityType : "";
  const contextEntityId = id(at(request, `${contextEntityKind}Id`)) ?? (contextEntityKind ? id(event.entityId) : undefined) ?? (!isReport ? id(result.id) : undefined);
  if (contextEntityKind && contextEntityId) {
    const label = referenceLabel(contextEntityKind, contextEntityId, at(before, "fullName", "employeeName", "equipmentName", ...(contextEntityKind === "position" ? ["position"] : [])) ?? at(request, "fullName"));
    context.push({ label: ENTITY_LABELS[contextEntityKind], value: label });
    addEntityLink(contextEntityKind, contextEntityId, label);
  }

  if (action === "table.reorder") {
    const rowLabels = list(savedContext.rowLabels).map(record);
    const rowLabel = (value: unknown) => {
      const row = rowLabels.find(row => String(row.id) === String(value));
      return row ? `${text(row.label)}${row.workDate ? ` · ${date(row.workDate)}` : ""}` : id(value) ? `Строка №${id(value)}` : "Строка, название которой не сохранено";
    };
    const moving = list(request.movingIds);
    const placement = request.placement;
    const destination = placement === "start" ? "В начало таблицы" : placement === "end" ? "В конец таблицы" : placement === "before" ? `Перед строкой «${rowLabel(request.targetId)}»` : placement === "after" ? `После строки «${rowLabel(request.targetId)}»` : MISSING;
    const values: AuditDetailField[] = [
      { label: "Таблица", value: SCOPE_LABELS[text(request.scope) || event.entityId] ?? "Таблица системы" },
      { label: "Перемещено строк", value: String(Number(record(request.movingIds).total) || moving.length) },
      { label: "Какие строки", value: moving.slice(0, MAX_ROWS).map(rowLabel).join("; ") || MISSING },
      { label: "Куда", value: destination },
    ];
    addSection("Перемещение строк", values);
    const tableTargets: Record<string, AuditNavigationTarget> = {
      employees: { view: "employees" }, users: { view: "users" }, projects: { view: "projects" }, positions: { view: "positions" }, equipment: { view: "equipmentRegistry" },
      ...(eventSiteId ? {
        "project-personnel": { view: "projectEmployees", siteId: eventSiteId }, "project-equipment": { view: "projectEquipment", siteId: eventSiteId },
        "personnel-report-rows": { view: "placement", siteId: eventSiteId }, "equipment-report-rows": { view: "equipment", siteId: eventSiteId },
        "directory-work-types": { view: "directories", directoryFocus: "mainWorkType", siteId: eventSiteId }, "directory-zone": { view: "directories", directoryFocus: "zone", siteId: eventSiteId }, "directory-master": { view: "directories", directoryFocus: "master", siteId: eventSiteId },
      } as Record<string, AuditNavigationTarget> : {}),
    };
    const tableTarget = tableTargets[text(request.scope) || event.entityId];
    if (tableTarget) addLink("Открыть таблицу", tableTarget);
    for (const token of [...moving.slice(0, MAX_ROWS), request.targetId]) {
      const row = rowLabels.find(item => String(item.id) === String(token));
      if (row) addEntityLink(text(row.kind), row.entityId ?? row.id, text(row.label), id(row.siteId) ?? eventSiteId, month(row.workDate) ?? eventMonth);
    }
    if (moving.length > MAX_ROWS) notes.push(`Названия показаны для первых ${MAX_ROWS} перемещённых строк.`);
  } else if (isTimesheet) {
    const current = { ...request };
    if (!equipment) {
      const previousMark = at(before, "code") || at(before, "hours");
      const value = deleted ? "Ручная отметка удалена; значение определяется отчётом" : timesheetMark(request.value);
      addSection("Отметка в табеле", [{ label: "Значение", ...(at(before, "code", "hours") !== undefined ? { before: timesheetMark(previousMark) } : {}), value }, ...fields(before, current).filter(field => !["Отметка", "Сотрудник", "Дата"].includes(field.label))]);
    } else addSection("Отметка в табеле техники", fields(before, current));
  } else if (isReport) {
    const current = Object.keys(report).length ? report : Object.keys(entry).length ? entry : { ...record(request.row), ...request };
    addSection(deleted ? "Данные до удаления" : "Изменения отчёта", fields(deleted ? {} : before, deleted ? before : current, deleted ? "saved" : "changes"));
    if (deleted) addRows(at(before, "rows") ?? event.beforeData, [], "Удалённая строка", true);
    else if (Object.keys(entry).length || request.row) {
      const values = fields(before, current);
      const kind = equipment ? "equipment" : "employee", entityId = at(current, equipment ? "equipmentId" : "employeeId", equipment ? "equipment_id" : "employee_id");
      addEntityLink(kind, entityId, referenceLabel(kind, entityId, at(current, equipment ? "equipmentName" : "employeeName", equipment ? "equipment_name_snapshot" : "employee_name_snapshot")));
      if (!values.length && !Object.keys(before).length) notes.push("Прежние значения этой записи не были сохранены в журнале.");
    } else if (report.rows !== undefined || request.rows !== undefined) addRows(at(before, "rows"), report.rows ?? request.rows, "Строка", false, true);
    else {
      if (request.updates !== undefined) addRows(event.beforeData, request.updates, "Изменённая строка");
      if (request.creates !== undefined || request.entries !== undefined) addRows([], request.creates ?? request.entries, "Добавленная строка");
    }
    if (eventSiteId) addLink(equipment ? "Открыть раздел отчётов техники" : "Открыть раздел отчётов персонала", { view: equipment ? "equipment" : "placement", siteId: eventSiteId });
    if (!sections.length) notes.push("Состав строк и прежние значения для этого действия не были сохранены в журнале.");
  } else if (action === "account.password") {
    addSection("Изменение учётной записи", [{ label: "Действие", value: "Пароль изменён" }]);
  } else {
    const current = Object.keys(record(result.role)).length ? record(result.role) : request;
    const changes = fields(deleted ? {} : before, deleted ? before : current, deleted ? "saved" : "changes");
    if (!deleted && (action === "employee.update" || action === "equipment.update") && request.projectSiteId !== undefined && Array.isArray(before.assignments)) {
      const assignments = list(before.assignments).map(record);
      const source = assignments.map(assignment => referenceLabel("project", assignment.siteId, assignment.siteName)).join("; ") || "Без назначений на проекты";
      const destination = request.projectSiteId === null || request.projectSiteId === "" ? "Без назначений на проекты" : referenceLabel("project", request.projectSiteId);
      const projectIndex = changes.findIndex(field => field.label === "Проект");
      if (projectIndex >= 0) changes.splice(projectIndex, 1);
      if (source !== destination) changes.push({ label: "Назначения на проекты", before: source, value: destination });
      for (const assignment of assignments) addEntityLink("project", assignment.siteId, referenceLabel("project", assignment.siteId, assignment.siteName));
    }
    addSection(deleted ? "Данные до удаления" : "Сохранённые изменения", changes);
    for (const assignment of list(before.assignments).map(record).slice(0, MAX_ROWS)) {
      addSection("Назначение до изменения", [{ label: "Проект", value: referenceLabel("project", assignment.siteId, assignment.siteName) }, ...fields({}, assignment, "saved").filter(field => field.label !== "Проект")]);
    }
    if (/\.(?:assign|unassign)$/.test(action)) {
      const siteId = at(request, "siteId", "assignedSiteId") ?? eventSiteId;
      const target = referenceLabel("project", siteId, event.siteName);
      addSection("Назначение на проект", [{ label: deleted ? "Из какого проекта удалён" : "В какой проект добавлен", value: target }]);
      addEntityLink("project", siteId, target);
    }
    const bulkBefore = list(before.employees).length ? before.employees : before.equipment ?? before.items;
    if (deleted && list(bulkBefore).length) {
      for (const item of list(bulkBefore).slice(0, MAX_ROWS)) addSection(`Удалена запись · ${text(at(record(item), "fullName", "name", "equipmentName")) || "Без названия"}`, fields({}, record(item), "saved"));
    }
    if (employeeDeleted) addLink("Открыть раздел сотрудников", { view: "employees" });
    if (equipmentDeleted) addLink("Открыть реестр техники", { view: "equipmentRegistry" });
    if (action.startsWith("work_types.")) {
      for (const [key, heading] of [["parents", "Вид работы"], ["children", "Подвид работы"]] as const) {
        const oldRows = list(before[key]).map(record);
        const currentRows: RecordValue[] = action.endsWith("archive") ? oldRows.length ? oldRows : list(request[key]).map(value => ({ id: value })) : list(request[key]).map(record);
        for (const row of currentRows.slice(0, MAX_ROWS)) {
          const old = oldRows.find(item => item.id === row.id) ?? {};
          addSection(`${heading} · ${text(row.name ?? old.name) || referenceLabel(key === "parents" ? "workType" : "subworkType", row.id)}`, fields(old, action.endsWith("archive") ? { ...old, ...row, active: false } : row));
        }
      }
      if (action.endsWith("assign")) addSection("Назначение вида работы", [{ label: "Подвиды работ", value: list(request.ids).map(value => referenceLabel("subworkType", value)).join("; ") || MISSING }, { label: "Назначенный вид работы", value: referenceLabel("workType", request.mainWorkTypeId) }]);
      if (eventSiteId) addLink("Открыть виды и подвиды работ", { view: "directories", directoryFocus: "mainWorkType", siteId: eventSiteId });
    }
    const directory = request.kind ?? request.entity;
    if (action.startsWith("directory.") && eventSiteId && ["zone", "mainWorkType", "subworkType", "master"].includes(text(directory))) addLink("Открыть справочник проекта", { view: "directories", directoryFocus: directory as "zone" | "mainWorkType" | "subworkType" | "master", siteId: eventSiteId });
    if (action === "directory.save") {
      for (const [index, item] of list(request.directories ?? request.rows).slice(0, MAX_ROWS).entries()) {
        const row = record(item), old = list(before.items).map(record).find(item => item.id === row.directoryId) ?? {};
        addSection(`Строка справочника ${index + 1}`, fields(old, row));
      }
    }
    if (action.includes(".import")) {
      const imported = request.rows ?? request.entries ?? request.employees ?? request.units ?? request.items;
      for (const [index, item] of list(imported).slice(0, MAX_ROWS).entries()) addSection(`Импортированная строка ${index + 1}`, fields({}, record(item), "saved"));
      if (list(imported).length > MAX_ROWS) notes.push(`Показаны первые ${MAX_ROWS} строк импорта.`);
    }
    const permissionSet = record(result.permissions ?? record(result.role).permissions ?? request.permissions);
    const previousPermissions = record(before.permissions);
    addSection("Права доступа", PERMISSION_CATALOG.flatMap(resource => {
      const permissions = record(permissionSet[resource.key]);
      if (!Object.keys(permissions).length) return [];
      const describe = (value: RecordValue) => resource.actions.filter(permission => value[permission] === true).map(permission => PERMISSION_ACTION_LABELS[permission]).join(", ") || "Нет доступа";
      const old = record(previousPermissions[resource.key]);
      const value = describe(permissions);
      if (Object.keys(old).length && value === describe(old)) return [];
      return [{ label: resource.title, value, ...(Object.keys(old).length ? { before: describe(old) } : {}) }];
    }));
    const access = record(result.projectAccess ?? request.projectAccess);
    if (access.mode === "all" || access.mode === "selected") addSection("Доступ к проектам", [{ label: "Разрешённые проекты", value: access.mode === "all" ? "Все проекты" : list(access.siteIds).map(value => referenceLabel("project", value)).join("; ") || "Нет доступных проектов" }]);
    if (action === "access_rights.reset") addSection("Права доступа", [{ label: "Правила доступа", value: "Восстановлены права, заданные ролью пользователя" }]);
    if (action.startsWith("access_rights.") || action.startsWith("roles.")) addLink("Открыть права доступа", { view: "accessRights" });
    if (!deleted && !Object.keys(before).length && /\.(?:update|update_selected)$/.test(action)) notes.push("Прежние значения для этого действия не были сохранены в журнале.");
  }
  const counters: AuditDetailField[] = [];
  for (const [key, label] of Object.entries({ count: "Обработано записей", created: "Добавлено", updated: "Изменено", deleted: "Удалено", imported: "Импортировано", skipped: "Пропущено", linked: "Связано с Битрикс24", acknowledgedCount: "Подтверждено расхождений", emailSent: "Письмо с приглашением отправлено" })) {
    const value = result[key];
    if (typeof value === "number" || typeof value === "boolean") counters.push({ label, value: primitive(value) });
  }
  addSection("Результат", counters);
  if (!sections.length && !notes.length) notes.push("Дополнительные сведения для этого действия не были сохранены в журнале.");
  if (savedContext.restricted === true) notes.push("Часть сведений недоступна по правам доступа.");
  if (containsTruncation(event.beforeData) || containsTruncation(event.afterData)) notes.push("В сохранённой записи есть сокращённые данные; часть подробностей недоступна.");
  const uniqueNotes = [...new Set(notes)];
  return { title, context, sections, links, notes: uniqueNotes,
    searchText: [title, event.actorName, event.siteName, ...context.map(field => field.value), ...sections.flatMap(section => [section.title, ...section.fields.flatMap(field => [field.label, field.before ?? "", field.value])]), ...uniqueNotes].join(" ") };
}
