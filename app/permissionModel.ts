import { isUserRole, type ProjectAccess, type UserRole } from "./roles.ts";

export const PERMISSION_ACTIONS = ["view", "create", "update", "delete"] as const;
export type PermissionAction = typeof PERMISSION_ACTIONS[number];

export const PERMISSION_RESOURCES = [
  "workers_report",
  "workers_report_draft",
  "workers_report_submitted",
  "workers_report_approved",
  "equipment_report",
  "equipment_report_draft",
  "equipment_report_submitted",
  "equipment_report_approved",
  "workers_timesheet",
  "equipment_timesheet",
  "workers_statistics",
  "equipment_statistics",
  "employees",
  "equipment_registry",
  "positions",
  "system_users",
  "projects",
  "audit_log",
  "access_rights",
  "project_employees",
  "project_equipment",
  "project_directories",
] as const;

export type PermissionResource = typeof PERMISSION_RESOURCES[number];
export type ResourcePermission = Record<PermissionAction, boolean>;
export type PermissionSet = Record<PermissionResource, ResourcePermission>;
export type ReportPermissionResource = "workers_report" | "equipment_report";
export type ReportPermissionStatus = "draft" | "rejected" | "submitted" | "approved";
export const REPORT_PERMISSION_RESOURCES: readonly ReportPermissionResource[] = ["workers_report", "equipment_report"];
export const STATISTICS_REPORT_RESOURCES = {
  workers_statistics: "workers_report",
  equipment_statistics: "equipment_report",
} as const;
export function reportStatusPermissionResource(resource: ReportPermissionResource, status: ReportPermissionStatus): PermissionResource {
  return `${resource}_${status === "rejected" ? "draft" : status}`;
}

export type PermissionResourceDefinition = {
  key: PermissionResource;
  group: "reports" | "timesheets" | "statistics" | "general" | "project";
  title: string;
  description: string;
  actions: PermissionAction[];
  parent?: ReportPermissionResource;
  shortTitle?: string;
};

export const PERMISSION_GROUP_LABELS: Record<PermissionResourceDefinition["group"], string> = {
  reports: "Отчёты",
  timesheets: "Табели",
  statistics: "Статистика",
  general: "Общие настройки",
  project: "Настройки проекта",
};

export const PERMISSION_ACTION_LABELS: Record<PermissionAction, string> = {
  view: "Просмотр",
  create: "Добавление",
  update: "Редактирование",
  delete: "Удаление",
};

export const PERMISSION_CATALOG: PermissionResourceDefinition[] = [
  { key: "workers_report", group: "reports", title: "Отчёт рабочих", description: "Общий доступ к отчёту. Ниже можно ограничить права отдельных вкладок.", actions: [...PERMISSION_ACTIONS] },
  { key: "workers_report_draft", parent: "workers_report", shortTitle: "Черновики", group: "reports", title: "Отчёт рабочих — Черновики", description: "Свои черновики и возвраты на доработку. Редактирование также разрешает отправку и снятие своего отчёта с проверки.", actions: [...PERMISSION_ACTIONS] },
  { key: "workers_report_submitted", parent: "workers_report", shortTitle: "На проверке", group: "reports", title: "Отчёт рабочих — На проверке", description: "Редактирование — исправления, проверка и возврат отчётов на доработку.", actions: [...PERMISSION_ACTIONS] },
  { key: "workers_report_approved", parent: "workers_report", shortTitle: "Подтверждённые", group: "reports", title: "Отчёт рабочих — Подтверждённые", description: "Добавление — подтверждение новых отчётов. Редактирование и удаление — исправление учтённых записей.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_report", group: "reports", title: "Отчёт техники", description: "Общий доступ к отчёту. Ниже можно ограничить права отдельных вкладок.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_report_draft", parent: "equipment_report", shortTitle: "Черновики", group: "reports", title: "Отчёт техники — Черновики", description: "Свои черновики и возвраты на доработку. Редактирование также разрешает отправку и снятие своего отчёта с проверки.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_report_submitted", parent: "equipment_report", shortTitle: "На проверке", group: "reports", title: "Отчёт техники — На проверке", description: "Редактирование — исправления, проверка и возврат отчётов на доработку.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_report_approved", parent: "equipment_report", shortTitle: "Подтверждённые", group: "reports", title: "Отчёт техники — Подтверждённые", description: "Добавление — подтверждение новых отчётов. Редактирование и удаление — исправление учтённых записей.", actions: [...PERMISSION_ACTIONS] },
  { key: "workers_timesheet", group: "timesheets", title: "Табель рабочих", description: "Месячные отметки и часы сотрудников.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_timesheet", group: "timesheets", title: "Табель техники", description: "Рабочие часы и простой техники.", actions: [...PERMISSION_ACTIONS] },
  { key: "workers_statistics", group: "statistics", title: "Статистика персонала", description: "Сводные часы по зонам из подтверждённых отчётов персонала в доступных проектах.", actions: ["view"] },
  { key: "equipment_statistics", group: "statistics", title: "Статистика техники", description: "Рабочие часы и простой по зонам из подтверждённых отчётов техники в доступных проектах.", actions: ["view"] },
  { key: "employees", group: "general", title: "Сотрудники", description: "Общий кадровый справочник и проверка Битрикс24.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_registry", group: "general", title: "Реестр техники", description: "Единый реестр техники всех проектов.", actions: [...PERMISSION_ACTIONS] },
  { key: "positions", group: "general", title: "Список должностей", description: "Типы, отделы и должности сотрудников.", actions: [...PERMISSION_ACTIONS] },
  { key: "system_users", group: "general", title: "Пользователи системы", description: "Учётные записи, приглашения и роли.", actions: [...PERMISSION_ACTIONS] },
  { key: "projects", group: "general", title: "Проекты", description: "Создание и настройка строительных проектов.", actions: [...PERMISSION_ACTIONS] },
  { key: "audit_log", group: "general", title: "Журнал действий", description: "История сохранений и изменений в системе.", actions: ["view"] },
  { key: "access_rights", group: "general", title: "Права доступа", description: "Настройка разрешений других пользователей.", actions: ["view", "update"] },
  { key: "project_employees", group: "project", title: "Сотрудники проекта", description: "Добавление сотрудников в проект и удаление из его состава.", actions: ["view", "create", "delete"] },
  { key: "project_equipment", group: "project", title: "Техника проекта", description: "Назначение техники на выбранный проект.", actions: [...PERMISSION_ACTIONS] },
  { key: "project_directories", group: "project", title: "Справочники проекта", description: "Зоны, работы, подработы и мастера.", actions: [...PERMISSION_ACTIONS] },
];

const emptyRow = (): ResourcePermission => ({ view: false, create: false, update: false, delete: false });

export function emptyPermissionSet(): PermissionSet {
  return Object.fromEntries(PERMISSION_RESOURCES.map((resource) => [resource, emptyRow()])) as PermissionSet;
}

function grant(set: PermissionSet, resource: PermissionResource, actions: PermissionAction[] = [...PERMISSION_ACTIONS]) {
  for (const action of actions) set[resource][action] = true;
  if (actions.some((action) => action !== "view")) set[resource].view = true;
}

export function rolePermissionTemplate(role: UserRole): PermissionSet {
  const set = emptyPermissionSet();
  if (!isUserRole(role)) return set;
  grant(set, "workers_statistics", ["view"]);
  grant(set, "equipment_statistics", ["view"]);
  if (role === "foreman") {
    grant(set, "workers_report");
    grant(set, "equipment_report");
    for (const resource of REPORT_PERMISSION_RESOURCES) {
      grant(set, reportStatusPermissionResource(resource, "draft"));
      grant(set, reportStatusPermissionResource(resource, "submitted"), ["view"]);
      grant(set, reportStatusPermissionResource(resource, "approved"), ["view"]);
    }
    grant(set, "project_employees", ["view"]);
    grant(set, "project_equipment", ["view"]);
    grant(set, "project_directories", ["view"]);
    return set;
  }
  if (role === "viewer") {
    for (const resource of ["workers_report", "equipment_report", "workers_timesheet", "equipment_timesheet"] as PermissionResource[]) grant(set, resource, ["view"]);
    for (const resource of REPORT_PERMISSION_RESOURCES) for (const status of ["submitted", "approved"] as const) grant(set, reportStatusPermissionResource(resource, status), ["view"]);
    return set;
  }
  if (role === "engineer") {
    for (const resource of ["workers_report", "equipment_report", "workers_timesheet", "equipment_timesheet", "employees", "equipment_registry", "project_employees", "project_equipment", "project_directories"] as PermissionResource[]) grant(set, resource);
    for (const resource of ["positions", "system_users", "projects", "audit_log", "access_rights"] as PermissionResource[]) grant(set, resource, ["view"]);
    for (const resource of REPORT_PERMISSION_RESOURCES) for (const status of ["draft", "submitted", "approved"] as const) grant(set, reportStatusPermissionResource(resource, status));
    return set;
  }
  if (role === "superadmin") for (const definition of PERMISSION_CATALOG) grant(set, definition.key, definition.actions);
  return set;
}

export function normalizePermissionSet(input: Partial<Record<PermissionResource, Partial<ResourcePermission>>>, fallback?: Partial<PermissionSet>): PermissionSet {
  const normalized = emptyPermissionSet();
  for (const definition of PERMISSION_CATALOG) {
    const source = input[definition.key];
    // A legacy matrix has only the report's general row. Prefer the role's
    // status defaults when supplied, otherwise preserve that legacy grant.
    const statisticsReport = STATISTICS_REPORT_RESOURCES[definition.key as keyof typeof STATISTICS_REPORT_RESOURCES];
    const fallbackRow = fallback?.[definition.key] ?? (definition.parent ? normalized[definition.parent]
      : statisticsReport ? { view: hasReportStatusPermission(normalized, statisticsReport, "approved", "view"), create: false, update: false, delete: false }
      : undefined);
    for (const action of PERMISSION_ACTIONS) normalized[definition.key][action] = source?.[action] ?? fallbackRow?.[action] ?? false;
    for (const action of PERMISSION_ACTIONS) if (!definition.actions.includes(action)) normalized[definition.key][action] = false;
    if (PERMISSION_ACTIONS.some((action) => action !== "view" && normalized[definition.key][action])) normalized[definition.key].view = true;
    if (!normalized[definition.key].view) {
      normalized[definition.key].create = false;
      normalized[definition.key].update = false;
      normalized[definition.key].delete = false;
    }
    if (definition.parent) for (const action of PERMISSION_ACTIONS) normalized[definition.key][action] &&= normalized[definition.parent][action];
  }
  return normalized;
}

export function hasPermission(permissions: PermissionSet, resource: PermissionResource, action: PermissionAction) {
  return Boolean(permissions[resource]?.[action]);
}

export function getReportStatusPermission(permissions: PermissionSet, resource: ReportPermissionResource, status: ReportPermissionStatus): ResourcePermission {
  const parent = permissions[resource];
  const child = permissions[reportStatusPermissionResource(resource, status)] ?? parent;
  return Object.fromEntries(PERMISSION_ACTIONS.map(action => [action, Boolean(parent?.view && parent[action] && child?.view && child[action])])) as ResourcePermission;
}

export function hasReportStatusPermission(permissions: PermissionSet, resource: ReportPermissionResource, status: ReportPermissionStatus, action: PermissionAction) {
  return getReportStatusPermission(permissions, resource, status)[action];
}

/** One checkbox update preserves the general report bound and its status rows. */
export function patchPermissionSet(value: PermissionSet, resource: PermissionResource, action: PermissionAction, enabled: boolean): PermissionSet {
  const next = normalizePermissionSet(value);
  const definition = PERMISSION_CATALOG.find(item => item.key === resource);
  next[resource][action] = enabled;
  if (enabled && action !== "view") next[resource].view = true;
  if (!enabled && action === "view") next[resource] = emptyRow();
  if (definition?.parent && enabled) {
    next[definition.parent][action] = true;
    next[definition.parent].view = true;
  }
  if (REPORT_PERMISSION_RESOURCES.includes(resource as ReportPermissionResource)) {
    for (const child of PERMISSION_CATALOG.filter(item => item.parent === resource)) {
      if (action === "view" && !enabled) next[child.key] = emptyRow();
      else {
        next[child.key][action] = enabled;
        if (enabled && action !== "view") next[child.key].view = true;
      }
    }
  }
  return normalizePermissionSet(next);
}

/** Roles supply defaults; the permission catalog defines which actions exist. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Preserve callers' legacy role/scope signature.
export function roleAllowsPermission(_role: UserRole, resource: PermissionResource, action: PermissionAction, _projectAccess?: ProjectAccess) {
  return Boolean(PERMISSION_CATALOG.find(definition => definition.key === resource)?.actions.includes(action));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Role and project scope no longer cap explicit grants.
export function limitPermissionsToRole(_role: UserRole, permissions: PermissionSet, _projectAccess?: ProjectAccess): PermissionSet {
  return normalizePermissionSet(permissions);
}

export function permissionSetsEqual(left: PermissionSet, right: PermissionSet) {
  return PERMISSION_RESOURCES.every((resource) => PERMISSION_ACTIONS.every((action) => left[resource][action] === right[resource][action]));
}
