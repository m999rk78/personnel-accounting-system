import { getReportStatusPermission, normalizePermissionSet, rolePermissionTemplate, type PermissionSet, type ResourcePermission } from "./permissionModel.ts";
import { canViewPendingReportsFor, type UserRole } from "./roles.ts";

export function reportWorkspacePermissions(resource: "workers_report" | "equipment_report", user: { role: UserRole; canViewPendingReports?: boolean; permissions?: Partial<PermissionSet> }, granted: Pick<ResourcePermission, "create" | "update" | "delete">) {
  const permissions = normalizePermissionSet(user.permissions ?? {}, rolePermissionTemplate(user.role));
  const pending = canViewPendingReportsFor({ ...user, permissions });
  const forStatus = (status: "draft" | "submitted" | "approved"): ResourcePermission => {
    const row = getReportStatusPermission(permissions, resource, status);
    const view = row.view && (status === "approved" || pending);
    const writable = view;
    return { view, create: writable && granted.create && row.create, update: writable && granted.update && row.update, delete: writable && granted.delete && row.delete };
  };
  return { draft: forStatus("draft"), submitted: forStatus("submitted"), approved: forStatus("approved") };
}
