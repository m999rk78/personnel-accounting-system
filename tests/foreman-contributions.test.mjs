import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { hasRestrictedProjectAccess } from "../app/roles.ts";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const boundaryUrl = moduleUrl("export let database; export function configure(value){database=value;} export const env={get DB(){return database;}};");
const boundary = await import(boundaryUrl);
const placement = await import(await compileModuleGraph(new URL("../app/server/data/placement.ts", import.meta.url), {
  "./context": boundaryUrl,
  "../../../db/client": moduleUrl("export function getDatabase(){throw new Error('No real database in contribution tests');}"),
}));
const { canManagePlacement } = await import(await compileModuleGraph(new URL("../app/server/data/access.ts", import.meta.url), {
  "./catalogs": moduleUrl("export function directoryTable(){return null;}"),
}));

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return text.slice(start, end);
}

test("stores report rows under a responsible foreman and tracks each personal submission", async () => {
  const [schema, migration] = await Promise.all([
    source("db/schema.ts"),
    source("drizzle-postgres/0012_foreman_report_contributions.sql"),
  ]);

  assert.match(schema, /responsibleUserId: integer\("responsible_user_id"\)\.references\(\(\) => appUsers\.id\)/);
  assert.match(schema, /revision: integer\("revision"\)\.notNull\(\)\.default\(1\)/);
  assert.match(schema, /export const placementReportContributions = pgTable\("placement_report_contributions"/);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.siteId, table\.workDate, table\.foremanId\] \}\)/);
  assert.match(schema, /table\.status} IN \('draft', 'submitted'\)/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "placement_report_contributions"/);
  assert.match(migration, /PRIMARY KEY\("site_id", "work_date", "foreman_id"\)/);
  assert.match(migration, /CHECK \("placement_report_contributions"\."status" IN \('draft', 'submitted'\)\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "idx_report_contributions_site_date_status"/);
  assert.match(migration, /ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "responsible_user_id" integer/);
  assert.match(migration, /ALTER TABLE "placement_entries" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL/);
});

test("carries forward the latest submitted report of the signed-in foreman", async () => {
  const api = await source("app/server/data/readWorkspace.ts");
  const carryover = section(api, 'if (scope === "carryover")', 'if (scope === "entries")');

  assert.match(carryover, /const previous = authUser\.role === "foreman"/);
  assert.match(carryover, /FROM placement_report_contributions/);
  assert.match(carryover, /site_id = \? AND foreman_id = \? AND status = 'submitted' AND work_date < \?/);
  assert.match(carryover, /ORDER BY work_date DESC LIMIT 1/);
  assert.match(carryover, /\.bind\(siteId, authUser\.id, workDate\)/);
  assert.match(carryover, /placementEntriesStatement\(siteId, previous\.workDate, responsibleUserId\)/);
  assert.match(carryover, /sourceDate: previous\.workDate, entries: entries\.results/);
});

test("returns ownership, revision, shared usage, and foreman progress with report entries", async () => {
  const [api, reads, updates] = await Promise.all([
    source("app/server/data/placement.ts"), source("app/server/data/readWorkspace.ts"), source("app/server/data/updateData.ts"),
  ]);

  assert.match(api, /pe\.responsible_user_id AS responsibleUserId, responsible\.full_name AS responsibleUserName, pe\.revision/);
  assert.match(reads, /const responsibleUserId = authUser\.role === "foreman" \? authUser\.id : undefined/);
  assert.match(api, /function employeeUsageStatement\(workDate: string, siteId: number, user: AuthUser\)/);
  assert.match(reads, /employeeUsageStatement\(workDate, siteId, authUser\)/);
  assert.match(api, /assignment\.site_id = \? AND assignment\.active = 1[\s\S]*UNION[\s\S]*historical\.site_id = \?/);
  assert.match(api, /function foremanProgressStatement\(siteId: number, workDate: string\)/);
  assert.match(api, /contribution\.status = 'submitted' THEN 'submitted'[\s\S]*contribution\.status = 'draft' THEN 'draft' ELSE 'not_started'/);
  assert.match(reads, /employeeUsage: employeeUsage\.results/);
  assert.match(reads, /foremanProgress:.*foremanProgress\.results/);
  const owner = { id: 17, role: "foreman", assignedSiteId: 1, permissions: rolePermissionTemplate("foreman") };
  const entry = { id: 1, siteId: 1, workDate: "2026-09-01", responsibleUserId: 17, revision: 2 };
  placement.assertPlacementOwnership(owner, [entry]);
  assert.throws(() => placement.assertPlacementOwnership(owner, [{ ...entry, responsibleUserId: 18 }]), error => error.status === 403 && error.code === "ENTRY_OWNERSHIP_FORBIDDEN");
  placement.assertEntryRevisions([{ id: 1, revision: 2 }], [entry]);
  assert.throws(() => placement.assertEntryRevisions([{ id: 1, revision: 1 }], [entry]), error => error.status === 409 && error.code === "STALE_ENTRY");
  assert.match(updates, /revision = revision \+ 1/);
});

test("allows permitted historical report actions without weakening foreman scope and ownership", async () => {
  const [access, creates, updates] = await Promise.all([
    source("app/server/data/access.ts"), source("app/server/data/createData.ts"), source("app/server/data/updateData.ts"),
  ]);
  const permissionGuard = section(access, "function canManagePlacement", "function canRunAction");
  assert.match(permissionGuard, /hasPermission\(user\.permissions, "workers_report", action\)/);
  assert.match(permissionGuard, /canAccessProject\(user, siteId\)/);
  assert.doesNotMatch(permissionGuard, /todayInMoscow|workDate\s*[!=]==?\s*today/);

  assert.match(creates, /canManagePlacement\(authUser, asPositiveInteger\(row\.siteId\) \?\? undefined, row\.workDate, "create"\)/);
  assert.match(updates, /canManagePlacement\(authUser, asPositiveInteger\(entry\.siteId\) \?\? undefined, entry\.workDate, "update"\)/);
  assert.match(access, /if \(!entity\) return hasPermission\(user\.permissions, "workers_report", "delete"\)/);
});

test("historical placement actions keep engineer project limits independent of resource overrides", async () => {
  const actor = role => ({ role, assignedSiteId: role === "foreman" ? 1 : null, projectAccess: { mode: "selected", siteIds: [1] }, permissions: rolePermissionTemplate("superadmin") });
  for (const role of ["engineer", "foreman"]) for (const action of ["view", "create", "update", "delete"]) {
    assert.equal(canManagePlacement(actor(role), 1, "2026-09-01", action), true);
    assert.equal(canManagePlacement(actor(role), 2, "2026-09-01", action), false);
    assert.equal(canManagePlacement({ ...actor(role), assignedSiteId: null, projectAccess: { mode: "selected", siteIds: [] } }, 1, "2026-09-01", action), false);
  }
  for (const role of ["engineer", "superadmin"]) assert.equal(canManagePlacement({ ...actor(role), projectAccess: { mode: "all", siteIds: [] } }, 2, "2026-09-01"), true);
  const restricted = actor("engineer");
  restricted.permissions.workers_report.update = false;
  assert.equal(canManagePlacement(restricted, 1, "2026-09-01"), false);
  assert.equal(canManagePlacement(actor("engineer"), 1, "invalid"), false);
});

test("shared hour warnings anonymize owners from other projects for scoped roles", async () => {
  const env = { DB: { prepare(sql) { return { bind(...values) { return { sql, values }; } }; } } };
  boundary.configure(env.DB);
  for (const actor of [{ role: "foreman", assignedSiteId: 1 }, { role: "engineer", projectAccess: { mode: "selected", siteIds: [1] } }, { role: "viewer", projectAccess: { mode: "selected", siteIds: [1] } }, { role: "engineer" }, { role: "superadmin" }]) {
    const { sql, values } = placement.employeeUsageStatement("2026-10-30", 1, actor);
    assert.deepEqual(values, ["2026-10-30", 1, 1, "2026-10-30"]);
    if (hasRestrictedProjectAccess(actor)) {
      assert.match(sql, /CASE WHEN pe\.site_id = 1 THEN pe\.responsible_user_id ELSE NULL END/);
      assert.match(sql, /CASE WHEN pe\.site_id = 1 THEN COALESCE\(responsible\.full_name, 'Без ответственного'\) ELSE 'Другой проект' END/);
    } else {
      assert.match(sql, /CASE WHEN TRUE THEN pe\.responsible_user_id ELSE NULL END/);
    }
    assert.match(sql, /SUM\(pe\.hours\) AS hours/);
    assert.match(sql, /GROUP BY pe\.employee_id, CASE WHEN/);
  }
});

test("serializes daily-hour mutations and reports a conflict instead of overspending 10 hours", async () => {
  const [api, patch, deletion, responses] = await Promise.all([
    source("app/server/data/placement.ts"), source("app/server/data/updateData.ts"), source("app/server/data/deleteData.ts"), source("app/server/data/responses.ts"),
  ]);
  const lock = section(api, "async function lockPlacementHours", "async function resolveResponsibleUsers");

  assert.match(lock, /placement-hours:\$\{key\}/);
  assert.match(lock, /\[\.\.\.keys\]\.sort\(\)/);
  assert.match(lock, /pg_advisory_xact_lock\(hashtext\(\?\)\)/);
  assert.match(patch, /env\.DB\.transaction\(async \(db\) =>/);
  assert.match(patch, /assertPlacementOwnership\(authUser, existing/);
  assert.match(patch, /lockPlacementHours\(db,/);
  assert.match(deletion, /env\.DB\.transaction\(async \(db\) =>/);
  assert.match(deletion, /assertPlacementOwnership\(authUser, entries\.results\)/);
  assert.match(deletion, /lockPlacementHours\(db, \[\], entries\.results\)/);
  assert.match(api, /used \+ hours > 10/);
  assert.match(api, /У сотрудника «\$\{employee\.fullName\}» уже учтено/);
  assert.doesNotMatch(api, /Строка \$\{index \+ 1\}: у сотрудника уже учтено/);
  assert.match(api, /new PlacementRequestError\([\s\S]*409,[\s\S]*"HOURS_CONFLICT"/);
  assert.match(responses, /status: error\.status/);
});

test("keeps personal submission separate from the engineer's global finalization", async () => {
  const api = await source("app/server/data/updateData.ts");

  assert.match(api, /submitOwnReport\?: ReportFinalizationPayload/);
  assert.match(api, /finalizeReport\?: ReportFinalizationPayload/);
  assert.match(api, /touchForemanContribution\([\s\S]*Boolean\(ownSubmission\)/);
  assert.match(api, /finalizeGlobalReport\(db, authUser, finalizationSiteId, finalizationWorkDate\)/);
  assert.match(api, /if \(finalization && authUser\.role === "foreman"\) return forbidden\(\)/);

});

test("both report grids label the responsible person without a role qualifier", async () => {
  for (const path of ["app/PersonnelReportGrid.tsx", "app/EquipmentReportGrid.tsx"]) {
    const grid = await source(path);
    assert.match(grid, /column\("responsibleUserName", "Ответственный",/);
    assert.doesNotMatch(grid, /Ответственный прораб/);
  }
});
