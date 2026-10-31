import { PERMISSION_ACTIONS, PERMISSION_CATALOG, normalizePermissionSet, type PermissionSet } from "./permissionModel.ts";
import { ROLE_LABELS } from "./roles.ts";

export type CustomRoleBaseRole = "engineer" | "viewer";
export type CustomRole = { id: number; name: string; baseRole: CustomRoleBaseRole; permissions: PermissionSet; revision: number };
export type CustomRoleInput = { name?: unknown; permissions?: unknown };

export class CustomRoleError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = "INVALID_ROLE") {
    super(message);
    this.name = "CustomRoleError";
    this.status = status;
    this.code = code;
  }
}

export function customRoleNameKey(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

export function normalizeCustomRoleName(value: unknown) {
  if (typeof value !== "string") throw new CustomRoleError("Укажите название роли.");
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new CustomRoleError("Название роли должно содержать от 1 до 80 символов без управляющих знаков.");
  const reserved = [...Object.values(ROLE_LABELS), "foreman", "engineer", "viewer", "superadmin", "office", "admin"];
  if (reserved.some(label => customRoleNameKey(label) === customRoleNameKey(name))) throw new CustomRoleError("Это название уже используется системной ролью. Выберите другое название.", 400, "ROLE_NAME_RESERVED");
  return name;
}

export function normalizeCustomRolePermissions(value: unknown): PermissionSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CustomRoleError("Выберите права для роли.");
  const input = value as Record<string, unknown>;
  for (const [resource, row] of Object.entries(input)) {
    if (!PERMISSION_CATALOG.some(item => item.key === resource) || !row || typeof row !== "object" || Array.isArray(row)) throw new CustomRoleError("Набор прав роли содержит неизвестный раздел.");
    for (const [action, enabled] of Object.entries(row)) {
      if (!(PERMISSION_ACTIONS as readonly string[]).includes(action) || typeof enabled !== "boolean") throw new CustomRoleError("Значения прав роли должны быть логическими.");
    }
  }
  return normalizePermissionSet(input as Partial<PermissionSet>);
}

export function inferCustomRoleBaseRole(permissions: PermissionSet): CustomRoleBaseRole {
  return Object.values(permissions).some(row => row.create || row.update || row.delete) ? "engineer" : "viewer";
}

export function normalizeCustomRoleInput(input: CustomRoleInput) {
  const name = normalizeCustomRoleName(input.name);
  const permissions = normalizeCustomRolePermissions(input.permissions);
  return { name, nameKey: customRoleNameKey(name), permissions, baseRole: inferCustomRoleBaseRole(permissions) };
}
