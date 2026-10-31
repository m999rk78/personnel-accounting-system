import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { effectiveProjectAccess } from "../../app/roles.ts";

const root = new URL("../../", import.meta.url);
const sourceUrl = value => `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const appUrl = name => new URL(`app/${name}.ts`, root).href;
async function compile(path, replacements) {
  let code = ts.transpileModule(await readFile(new URL(path, root), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return sourceUrl(code);
}

export function memoryProjectAccessDatabase() {
  let state = {
    users: new Map([
      [1, { id: 1, role: "foreman", fullName: "Прораб", email: "foreman@invalid.test", assignedSiteId: 7 }],
      [2, { id: 2, role: "engineer", fullName: "Инженер", email: "engineer@invalid.test", assignedSiteId: null }],
      [3, { id: 3, role: "viewer", fullName: "Наблюдатель", email: "viewer@invalid.test", assignedSiteId: null }],
      [4, { id: 4, role: "superadmin", fullName: "Супер-админ", email: "owner@invalid.test", assignedSiteId: null }],
      [5, { id: 5, role: "viewer", fullName: "Без доступа", email: "none@invalid.test", assignedSiteId: null }],
      [6, { id: 6, role: "admin", fullName: "Прежняя роль", email: "legacy@invalid.test", assignedSiteId: null }],
    ]),
    sites: new Map([[7, { id: 7, name: "Северный", active: true }], [8, { id: 8, name: "Южный", active: true }], [9, { id: 9, name: "Архив", active: false }]]),
    settings: new Map(), grants: new Map(), permissions: new Map(), customRoles: new Map(), sessions: new Map(),
  };
  const queries = [], attemptedWrites = [];
  let failureResource = null;
  const normalizedUser = user => user && { ...user, role: user.role === "admin" ? "engineer" : user.role === "office" ? "superadmin" : user.role };
  const accessFor = user => {
    const saved = state.settings.get(user.id);
    return saved ? { mode: saved.allProjects ? "all" : "selected", siteIds: [...(state.grants.get(user.id) ?? [])] } : effectiveProjectAccess(normalizedUser(user));
  };
  function select(sql, values) {
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("FROM custom_roles")) {
      const roles = [...state.customRoles.values()].filter(role => role.active !== 0);
      return sql.includes("WHERE id = ?") ? roles.filter(role => role.id === values[0]) : roles;
    }
    if (sql.includes("FROM user_sessions s JOIN app_users u")) {
      const userId = state.sessions.get(values[0]);
      return userId && state.users.has(userId) ? [normalizedUser(state.users.get(userId))] : [];
    }
    if (sql.includes("FROM user_project_access WHERE user_id")) return state.settings.has(values[0]) ? [state.settings.get(values[0])] : [];
    if (sql.includes("FROM user_project_access_sites access")) return [...(state.grants.get(values[0]) ?? [])].filter(id => state.sites.get(id)?.active).sort((a,b)=>a-b).map(id=>({id}));
    if (sql.includes("FROM user_permissions WHERE user_id")) return [...(state.permissions.get(values[0])?.values() ?? [])];
    if (sql.includes("FROM sites WHERE id = ANY")) return values[0].filter(id=>state.sites.get(id)?.active).map(id=>({id}));
    if (sql.includes("FROM sites WHERE active = 1")) return [...state.sites.values()].filter(site=>site.active && (!values.length || values[0].includes(site.id)));
    if (sql.includes("FROM app_users u LEFT JOIN sites") || sql.includes("FROM app_users target WHERE active = 1")) {
      return [...state.users.values()].filter(user => {
        if (!values.length) return true;
        const access = accessFor(user);
        return access.mode === "all" || access.siteIds.some(id=>values[0].includes(id));
      }).map(user=>({ ...normalizedUser(user), assignedSiteName: state.sites.get(user.assignedSiteId)?.name ?? null }));
    }
    if (sql.includes("FROM app_users WHERE id = ?")) return state.users.has(values[0]) ? [normalizedUser(state.users.get(values[0]))] : [];
    if (sql.includes("SELECT role, password_hash")) return state.users.has(values[0]) ? [{ ...normalizedUser(state.users.get(values[0])), passwordHash: "fixture-already-activated" }] : [];
    if (sql.includes("FROM app_users WHERE email = ?")) return [...state.users.values()].filter(user => user.active !== 0 && user.email === values[0] && (values.length < 2 || user.id !== values[1])).map(user => ({ id: user.id }));
    if (sql.includes("SELECT COUNT(*)") && sql.includes("FROM app_users")) return [{ count: [...state.users.values()].filter(user => user.active !== 0 && user.role === "superadmin").length }];
    if (sql.includes("FROM sites WHERE id = ?")) return state.sites.get(values[0])?.active ? [state.sites.get(values[0])] : [];
    throw new Error(`Unexpected SELECT in project access test: ${sql.slice(0,120)}`);
  }
  function mutate(sql, values) {
    attemptedWrites.push({sql,values:structuredClone(values)});
    if (/^(CREATE|ALTER)\b/.test(sql)) return;
    if (sql.startsWith("INSERT INTO app_users")) {
      const id = Math.max(...state.users.keys()) + 1;
      const columns = sql.match(/app_users\s*\(([^)]+)\)/)[1].split(",").map(column => column.trim());
      const names = { full_name: "fullName", assigned_site_id: "assignedSiteId", custom_role_id: "customRoleId" };
      const user = { id, active: 1, assignedSiteId: null, customRoleId: null };
      columns.forEach((column, index) => { user[names[column] ?? column] = values[index]; });
      state.users.set(id, user);
      return { changes: 1, last_row_id: id };
    }
    if (sql.startsWith("UPDATE app_users SET full_name")) {
      const id = values.at(-1), user = state.users.get(id);
      if (!user) return { changes: 0, last_row_id: null };
      const assignments = sql.slice(sql.indexOf("SET ") + 4, sql.indexOf(" WHERE")).split(",");
      const names = { full_name: "fullName", assigned_site_id: "assignedSiteId", custom_role_id: "customRoleId" };
      let index = 0;
      for (const assignment of assignments) {
        const column = assignment.trim().split(/\s*=/)[0];
        if (assignment.includes("?")) user[names[column] ?? column] = values[index++];
      }
      return { changes: 1, last_row_id: null };
    }
    if (sql.startsWith("INSERT INTO user_project_access(")) {
      for (const user of state.users.values()) if (user.role === "admin" && !state.settings.has(user.id)) state.settings.set(user.id,{allProjects:1,canViewPendingReports:1});
    } else if (sql.startsWith("UPDATE app_users SET role = 'engineer'")) {
      for (const user of state.users.values()) if (user.role === "admin") user.role="engineer";
    } else if (sql.startsWith("INSERT INTO user_project_access (")) {
      state.settings.set(values[0], { allProjects: values[1], canViewPendingReports: values[2], updatedByUserId: values[3] });
    } else if (sql.startsWith("DELETE FROM user_project_access_sites")) state.grants.set(values[0], new Set());
    else if (sql.startsWith("INSERT INTO user_project_access_sites")) {
      const ids=state.grants.get(values[0]) ?? new Set(); ids.add(values[1]); state.grants.set(values[0],ids);
    } else if (sql.startsWith("DELETE FROM user_permissions")) state.permissions.delete(values[0]);
    else if (sql.startsWith("INSERT INTO user_permissions")) {
      if (values[1] === failureResource) throw new Error("Injected permission persistence failure");
      const rows=state.permissions.get(values[0]) ?? new Map();
      rows.set(values[1],{ resource:values[1],canView:values[2],canCreate:values[3],canUpdate:values[4],canDelete:values[5] }); state.permissions.set(values[0],rows);
    } else throw new Error(`Unexpected mutation in project access test: ${sql.slice(0,100)}`);
  }
  const db={
    get state(){return state;}, queries, attemptedWrites,
    failPermissionResource(value){failureResource=value;},
    prepare(sql){let values=[]; const execute=()=>{
      assert.equal((sql.match(/\?/g)??[]).length,values.length,`Wrong bind count: ${sql}`);
      queries.push({sql,values:structuredClone(values)});
      const reading=/^SELECT\b/.test(sql.trim());
      const changed=reading ? null : mutate(sql.trim(),values);
      const rows=reading ? select(sql.trim(),values) : [];
      return {results:structuredClone(rows),success:true,meta:{changes:rows.length||1,last_row_id:null,...changed}};
    };return {bind(...next){values=next;return this;},async all(){return execute();},async first(){return execute().results[0]??null;},async run(){return execute();}};},
    async batch(statements){const result=[];for(const statement of statements)result.push(await statement.run());return result;},
    async readBatch(statements){const result=[];for(const statement of statements)result.push(await statement.all());return result;},
    async transaction(callback){const snapshot=structuredClone(state);try{return await callback(db);}catch(error){state=snapshot;throw error;}},
  };
  return db;
}

export async function projectAccessHarness() {
  const db=memoryProjectAccessDatabase();
  const boundaryUrl=sourceUrl(`export let user,db; export const invitations=[]; export function configure(nextUser,nextDb){user=nextUser;db=nextDb;} export function getDatabase(){return db;} export async function getAuthUser(){return user;} export function assertSameOrigin(){} export async function ensureAuthSchema(){} export async function createInvitation(userId){invitations.push(userId);return 'https://invalid.test/invitation/'+userId;} export async function sendInvitationEmail(){return {sent:false};}`);
  const boundary=await import(boundaryUrl);
  boundary.configure(null,db);
  const settingsUrl=await compile("app/projectAccessServer.ts", {"../db/client":boundaryUrl,"./roles.ts":appUrl("roles")});
  const permissionsUrl=await compile("app/permissions.ts", {"../db/client":boundaryUrl,"./permissionModel":appUrl("permissionModel")});
  const customRolesUrl=await compile("app/customRolesServer.ts", {"../db/client":boundaryUrl,"./customRoles":appUrl("customRoles"),"./customRoles.ts":appUrl("customRoles"),"./permissionModel":appUrl("permissionModel"),"./permissionModel.ts":appUrl("permissionModel"),"./roles.ts":appUrl("roles")});
  const customRoles=await import(customRolesUrl);
  const settings=await import(settingsUrl), permissions=await import(permissionsUrl);
  const route=await import(await compile("app/api/access-rights/route.ts", {
    "../../../db/client":boundaryUrl,"../../auth":boundaryUrl,
    "../../auditLog":sourceUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
    "../../permissions":permissionsUrl,"../../projectAccessServer":settingsUrl,
    "../../customRolesServer":customRolesUrl,
    "../../permissionModel":appUrl("permissionModel"),"../../roles":appUrl("roles"),
  }));
  const services = {"../../../db/client":boundaryUrl,"../../auth":boundaryUrl,"../../permissions":permissionsUrl,"../../projectAccessServer":settingsUrl,"../../customRolesServer":customRolesUrl,"../../roles":appUrl("roles"),"../../permissionModel":appUrl("permissionModel")};
  return {db,settings,permissions,customRoles,route,boundary,
    async loadRolesRoute() { return import(await compile("app/api/roles/route.ts", {...services,
      "../../customRoles":appUrl("customRoles"),
      "../../auditLog":sourceUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
    })); },
    async loadAuth() { return import(await compile("app/auth.ts", {
      "../db/client":boundaryUrl, "nodemailer":import.meta.resolve("nodemailer"), "./permissions":permissionsUrl,
      "./permissionModel":appUrl("permissionModel"), "./roles":appUrl("roles"),
      "./projectAccessServer":settingsUrl, "./customRolesServer":customRolesUrl,
    })); },
    async loadDataRoute() {
      const noop=names=>sourceUrl(names.map(name=>`export async function ${name}(){return {};}`).join("\n"));
      return import(await compile("app/api/data/route.ts", {...services,
        "../../auditLog":sourceUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
        "../../compressJsonResponse":sourceUrl("export async function compressJsonResponse(request,response){return response;}"),
        ...Object.fromEntries(["projectScopedData","readOptionalBatch","settingsReadPolicy","bitrix24Cooldown","equipmentAvailability","equipmentImport","equipmentTimesheetUnits","equipmentReportWorkflow"].map(name=>[`../../${name}`,appUrl(name)])),
        "../../projectMasters":noop(["ensureProjectMastersSchema","syncProjectMasters"]),
        "../../workTypeHierarchyServer":noop(["saveSubworkDirectory"]),
        "../../excelDirectoryImports":noop(["importProjectDirectoryExcel","importProjectEmployeesExcel","normalizeExcelDirectoryName","prepareEmployeeExcelImport"]),
        "../../bitrix24Sync":noop(["compareBitrixEmployees","fetchBitrixEmployeeSnapshot","normalizeBitrixText","selectBitrixEmployeesForImport","suggestBitrixEmployeeLinks"]),
      }));
    },
    async asUser(id,override={}){
      const row=db.state.users.get(id), user={...row,role:row.role==="admin"?"engineer":row.role};
      const scope=await settings.loadUserProjectAccess(user,db);
      const customRole=user.customRoleId ? await customRoles.loadCustomRole(user.customRoleId,db) : null;
      const access=await permissions.loadEffectivePermissions(id,user.role,scope.projectAccess,db,customRole);
      boundary.configure({...user,...scope,...access,...(customRole?{customRoleName:customRole.name,roleTemplate:customRole.permissions}:{}),...override},db);
    },
  };
}

export const accessRequest = body => new Request("http://localhost/api/access-rights",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
