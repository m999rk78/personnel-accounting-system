import type { UserRole } from "./roles";

export const PERMISSION_ACTIONS = ["view", "create", "update", "delete"] as const;
export type PermissionAction = typeof PERMISSION_ACTIONS[number];

export const PERMISSION_RESOURCES = [
  "workers_report",
  "equipment_report",
  "workers_timesheet",
  "equipment_timesheet",
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

export type PermissionResourceDefinition = {
  key: PermissionResource;
  group: "reports" | "timesheets" | "general" | "project";
  title: string;
  description: string;
  actions: PermissionAction[];
};

export const PERMISSION_GROUP_LABELS: Record<PermissionResourceDefinition["group"], string> = {
  reports: "Отчёты",
  timesheets: "Табели",
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
  { key: "workers_report", group: "reports", title: "Отчёт рабочих", description: "Ежедневный отчёт персонала и сдача своей части.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_report", group: "reports", title: "Отчёт техники", description: "Ежедневные строки работы техники.", actions: [...PERMISSION_ACTIONS] },
  { key: "workers_timesheet", group: "timesheets", title: "Табель рабочих", description: "Месячные отметки и часы сотрудников.", actions: [...PERMISSION_ACTIONS] },
  { key: "equipment_timesheet", group: "timesheets", title: "Табель техники", description: "Рабочие часы и простой техники.", actions: [...PERMISSION_ACTIONS] },
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
  if (role === "foreman") {
    grant(set, "workers_report");
    grant(set, "equipment_report");
    grant(set, "project_employees", ["view"]);
    grant(set, "project_equipment", ["view"]);
    grant(set, "project_directories", ["view"]);
    return set;
  }
  if (role === "engineer") {
    for (const resource of ["workers_report", "equipment_report", "workers_timesheet", "equipment_timesheet", "employees", "equipment_registry", "project_employees", "project_equipment", "project_directories"] as PermissionResource[]) grant(set, resource);
    for (const resource of ["positions", "system_users", "projects", "audit_log", "access_rights"] as PermissionResource[]) grant(set, resource, ["view"]);
    return set;
  }
  for (const definition of PERMISSION_CATALOG) grant(set, definition.key, definition.actions);
  return set;
}

export function normalizePermissionSet(input: Partial<Record<PermissionResource, Partial<ResourcePermission>>>, fallback?: PermissionSet): PermissionSet {
  const normalized = emptyPermissionSet();
  for (const definition of PERMISSION_CATALOG) {
    const source = input[definition.key];
    const fallbackRow = fallback?.[definition.key];
    for (const action of PERMISSION_ACTIONS) normalized[definition.key][action] = source?.[action] ?? fallbackRow?.[action] ?? false;
    for (const action of PERMISSION_ACTIONS) if (!definition.actions.includes(action)) normalized[definition.key][action] = false;
    if (PERMISSION_ACTIONS.some((action) => action !== "view" && normalized[definition.key][action])) normalized[definition.key].view = true;
    if (!normalized[definition.key].view) {
      normalized[definition.key].create = false;
      normalized[definition.key].update = false;
      normalized[definition.key].delete = false;
    }
  }
  return normalized;
}

export function hasPermission(permissions: PermissionSet, resource: PermissionResource, action: PermissionAction) {
  return Boolean(permissions[resource]?.[action]);
}

export function permissionSetsEqual(left: PermissionSet, right: PermissionSet) {
  return PERMISSION_RESOURCES.every((resource) => PERMISSION_ACTIONS.every((action) => left[resource][action] === right[resource][action]));
}
