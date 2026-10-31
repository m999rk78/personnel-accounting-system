// Existing route fixtures intentionally have no custom roles. Keep their SQL
// boundaries explicit while the custom-role regression suite uses real stores.
const sourceUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

export const noCustomRolesUrl = sourceUrl(`
  export async function ensureCustomRolesSchema() {}
  export async function loadCustomRole() { return null; }
  export async function listCustomRoles() { return []; }
`);

export const noPermissionChangesUrl = sourceUrl(`
  export async function ensurePermissionSchema() {}
  export async function resetUserPermissions() {}
`);
