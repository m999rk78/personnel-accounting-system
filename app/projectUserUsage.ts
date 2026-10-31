import { canAccessProject, type ProjectAccessUser } from "./roles.ts";

/** A foreman can belong to several projects; a closed grant belongs to none. */
export function projectForemanCounts(projects: readonly { id: number }[], users: readonly ProjectAccessUser[]) {
  return new Map(projects.map(project => [project.id, users.filter(user => user.role === "foreman" && canAccessProject(user, project.id)).length]));
}
