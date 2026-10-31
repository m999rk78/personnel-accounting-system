// Reads real local PostgreSQL data through the actual GET handlers. No login,
// account changes, invitations or SQL writes; schema/master sync is disabled.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import ts from "typescript";
import { limitPermissionsToRole, rolePermissionTemplate } from "../app/permissionModel.ts";
import { accessibleProjectIds, canAccessProject, effectiveProjectAccess, isUserRole } from "../app/roles.ts";

const modulesOnly = process.argv.includes("--check-modules");
const dateArgument = process.argv.indexOf("--date");
const diagnosticDate = dateArgument >= 0 ? process.argv[dateArgument + 1] : "2026-10-31";
assert.match(diagnosticDate ?? "", /^\d{4}-\d{2}-\d{2}$/, "Use --date YYYY-MM-DD");
assert.equal(new Date(`${diagnosticDate}T12:00:00Z`).toISOString().slice(0, 10), diagnosticDate, "Use a valid calendar date");
const address = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : process.env.PGHOST;
if (!modulesOnly) assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(address), "This diagnostic only accepts a loopback database.");
process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const fileUrl = name => new URL(`../app/${name}.ts`, import.meta.url).href;
async function compile(path, replacements) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, value] of Object.entries(replacements)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(value));
  return moduleUrl(code);
}
async function load(path, replacements) { return import(await compile(path, replacements)); }
const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  ssl: false, max: 3, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
  options: "-c default_transaction_read_only=on -c statement_timeout=5000" });
const boundaryUrl = moduleUrl(`export let actor, database; export function configure(user,db){actor=user;database=db;}
  export function getDatabase(){return database;} export async function getAuthUser(){return actor;}
  export function assertSameOrigin(){} export async function ensureAuthSchema(){}
  export function createInvitation(){throw new Error('Invitations disabled');} export function sendInvitationEmail(){throw new Error('Email disabled');}`);
const disabled = names => moduleUrl(names.map(name => `export function ${name}(){throw new Error('Unexpected mutation: ${name}');}`).join("\n"));
const readonlySync = moduleUrl("export async function ensureProjectMastersSchema(){} export async function syncProjectMasters(){}");
const audit = moduleUrl("export async function ensureAuditSchema(){} export async function withAuditTrail(){throw new Error('Only GET is supported');}");
const replacements = {
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl, "../../auditLog": audit,
  "../../projectMasters": readonlySync,
  "../../workTypeHierarchyServer": disabled(["saveSubworkDirectory"]),
  "../../excelDirectoryImports": disabled(["importProjectDirectoryExcel", "importProjectEmployeesExcel", "normalizeExcelDirectoryName", "prepareEmployeeExcelImport"]),
  "../../bitrix24Sync": disabled(["compareBitrixEmployees", "fetchBitrixEmployeeSnapshot", "normalizeBitrixText", "selectBitrixEmployeesForImport", "suggestBitrixEmployeeLinks"]),
  ...Object.fromEntries(["compressJsonResponse", "roles", "permissionModel", "projectScopedData", "readOptionalBatch", "settingsReadPolicy", "bitrix24Cooldown", "equipmentAvailability", "equipmentImport", "equipmentTimesheetUnits", "equipmentReportWorkflow", "personnelReportWorkflow", "tableRowOrder", "personnelReportRowOrder", "equipmentReportRowOrder", "workTypesRowOrder"].map(name => [`../../${name}`, fileUrl(name)])),
  "../../equipmentImportServer": disabled(["importEquipmentEntries"]),
};
const originalError = console.error;
console.error = (label, error) => originalError(label, error instanceof Error ? (error.message.replace(/data:[^\s"']+/g, "[compiled module]").slice(0, 1200) || error.code || error.errors?.map(item => item.code).join(", ") || error.name) : "");
let queries = 0;
try {
  if (!modulesOnly) assert.equal((await pool.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
  const { PostgresDatabase } = await load("../db/client.ts", { pg: import.meta.resolve("pg") });
  const database = new PostgresDatabase(pool);
  const readonly = { prepare(sql) { assert.match(sql.trim(), /^(SELECT|WITH)\b/i, "Diagnostic attempted a non-read query"); queries++; return database.prepare(sql); },
    readBatch: statements => Promise.all(statements.map(statement => statement.all())),
    batch() { throw new Error("Diagnostic attempted a write batch"); }, transaction() { throw new Error("Diagnostic attempted a write transaction"); } };
  const boundary = await import(boundaryUrl);
  const permissionsUrl = await compile("../app/permissions.ts", { "../db/client": boundaryUrl, "./permissionModel": fileUrl("permissionModel") });
  const projectAccessUrl = await compile("../app/projectAccessServer.ts", { "../db/client": boundaryUrl, "./roles.ts": fileUrl("roles") });
  const tableOrderUrl = moduleUrl(ts.transpileModule(await readFile(new URL("../app/tableRowOrderServer.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"../db/client"', JSON.stringify(boundaryUrl))
    .replace(/"\.\/(permissionModel|roles|tableRowOrder|personnelReportRowOrder|equipmentReportRowOrder|workTypesRowOrder)(?:\.ts)?"/g, (_whole, name) => JSON.stringify(fileUrl(name))));
  const stores = {};
  for (const domain of ["personnel", "equipment"]) {
    const source = ts.transpileModule(await readFile(new URL(`../app/${domain}ReportStore.ts`, import.meta.url), "utf8"), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    stores[domain] = moduleUrl(source.replace(/"\.\/([A-Za-z]+)"/g, (_whole,name)=>JSON.stringify(fileUrl(name))));
  }
  const routes = {};
  for (const name of ["data", "equipment", "timesheet", "audit-log", "access-rights", "personnel-report", "equipment-report", "table-order"]) {
    routes[name] = await load(`../app/api/${name}/route.ts`, { ...replacements, "../../permissions": permissionsUrl, "../../projectAccessServer": projectAccessUrl,
      "../../tableRowOrderServer": tableOrderUrl, "../../personnelReportStore": stores.personnel, "../../equipmentReportStore": stores.equipment });
  }
  if (modulesOnly) {
    console.log("PASS: read-only diagnostic modules load without connecting to PostgreSQL.");
  } else {
  const sites = (await pool.query("SELECT id FROM sites WHERE active=1 ORDER BY id")).rows.map(row=>row.id);
  assert.ok(sites.length, "No active projects to test");
  const date = diagnosticDate, month = date.slice(0,7);
  const cases = [
    ["data", "scope=navigation", null], ["data", `scope=workspace&date=${date}`, "workers_report"],
    ...[["employees","employees"],["positions","positions"],["users","system_users"],["projects","projects"],["projectEmployees","project_employees"],["directories","project_directories"]].map(([section,resource])=>["data",`scope=settings&section=${section}&date=${date}`,resource]),
    ["personnel-report","all=true","workers_report"], ["equipment-report","all=true","equipment_report"],
    ["timesheet",`month=${month}`,"workers_timesheet"],
    ["equipment",`view=timesheet&section=month&scope=project&date=${date}&month=${month}`,"equipment_timesheet"],
    ["equipment",`view=registry&section=registry&scope=global&date=${date}&month=${month}`,"equipment_registry"],
    ["equipment",`view=project&section=project&scope=assignments&date=${date}&month=${month}`,"project_equipment"],
    ["audit-log","limit=2","audit_log"], ["access-rights","","access_rights"],
    ...[["personnel-report-rows","workers_report"],["equipment-report-rows","equipment_report"],["employees","employees"],["equipment","equipment_registry"],["users","system_users"],["projects","projects"],["directory-work-types","project_directories"]].map(([scope,resource])=>["table-order",`scope=${scope}`,resource]),
  ];
  const selected = {mode:"selected",siteIds:sites.slice(0,2)}, single = {mode:"selected",siteIds:sites.slice(0,1)}, none = {mode:"selected",siteIds:[]}, all = {mode:"all",siteIds:[]};
  const variants = [
    ["foreman","legacy",undefined,true], ["foreman","all",all,true], ["foreman","multi",selected,true], ["foreman","none",none,true],
    ["engineer","legacy",undefined,true], ["engineer","multi",selected,true], ["engineer","single",single,true], ["engineer","none",none,true],
    ["viewer","all-confirmed",all,false], ["viewer","multi-confirmed",selected,false], ["viewer","multi-pending",selected,true], ["viewer","none",none,false],
    ["viewer","all-sections-confirmed",selected,false,true], ["viewer","all-sections-pending",selected,true,true],
    ["superadmin","all",undefined,true],
  ];
  let passed = 0;
  for (const [role,label,projectAccess,canViewPendingReports,allSections] of variants) for (const siteId of sites.slice(0,2)) {
    const actor = { id: 2147483000, fullName: "Read-only diagnostic", role, assignedSiteId: role === "foreman" ? sites[0] : null,
      ...(projectAccess ? {projectAccess} : {}), canViewPendingReports, permissionsCustomized: false };
    actor.permissions = limitPermissionsToRole(role, rolePermissionTemplate(allSections ? "superadmin" : role), effectiveProjectAccess(actor));
    boundary.configure(actor, readonly);
    for (const [name,params,resource] of cases) {
      const navigation = name === "data" && params === "scope=navigation";
      const globalSettings = name === "audit-log" || name === "access-rights";
      const projectAllowed = navigation || globalSettings || canAccessProject(actor,siteId);
      const auditAllowed = name !== "audit-log" || accessibleProjectIds(actor) === null || accessibleProjectIds(actor).length > 0;
      const expected = projectAllowed && auditAllowed && (!resource || actor.permissions[resource].view) ? 200 : 403;
      const response = await routes[name].GET(new Request(`http://localhost/api/${name}?siteId=${siteId}&${params}`));
      const body = await response.json();
      assert.equal(response.status, expected, `${role}/${label} project ${siteId} ${name} ${params}: ${body.error ?? response.status}`);
      if (response.ok) {
        if (body.sites) assert.ok(body.sites.every(site=>canAccessProject(actor,Number(site.id))), `${role}/${label}: inaccessible project metadata`);
        if (navigation) assert.deepEqual(body.sites.map(site=>site.id).sort((a,b)=>a-b), sites.filter(id=>canAccessProject(actor,id)));
        if (name === "access-rights") {
          assert.ok(body.users.every(user=>isUserRole(user.role)), "Removed roles must not appear in API metadata");
          if (accessibleProjectIds(actor)?.length === 0) assert.deepEqual(body.users, []);
          for (const user of body.users) {
            assert.ok(user.projectAccess && ["all","selected"].includes(user.projectAccess.mode));
            if (accessibleProjectIds(actor) !== null) {
              assert.equal(user.projectAccess.mode,"selected");
              assert.ok(user.projectAccess.siteIds.every(id=>canAccessProject(actor,id)), "User-list metadata reveals an inaccessible project");
              assert.ok(user.assignedSiteId === null || canAccessProject(actor,user.assignedSiteId));
            }
            assert.equal(typeof user.canViewPendingReports,"boolean");
            if (user.role === "viewer") assert.ok(Object.values(user.permissions).every(permission=>!permission.create&&!permission.update&&!permission.delete));
          }
        }
        if (role === "viewer") {
          assert.equal(body.canReview ?? false,false);
          if (body.canWrite !== undefined) assert.equal(body.canWrite,false);
          if (!canViewPendingReports) {
            if (body.reports) assert.ok(body.reports.every(report=>report.status==="approved" && report.reviewComment===""));
            if (body.foremanProgress) assert.deepEqual(body.foremanProgress,[]);
            if (body.reportSubmitted !== undefined) assert.equal(body.reportSubmitted,false);
          }
        }
      }
      passed++;
    }
  }
  console.log(`PASS ${date}: ${passed} role/project GET checks across ${variants.length} access variants, ${queries} read-only SQL queries; no data written.`);
  }
} catch (error) {
  console.error("Read-only role diagnostic failed:", error);
  process.exitCode = 1;
} finally { console.error = originalError; await pool.end(); }
