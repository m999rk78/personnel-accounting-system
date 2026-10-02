import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

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
  const api = await source("app/api/data/route.ts");
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
  const api = await source("app/api/data/route.ts");

  assert.match(api, /pe\.responsible_user_id AS responsibleUserId, responsible\.full_name AS responsibleUserName, pe\.revision/);
  assert.match(api, /const responsibleUserId = authUser\.role === "foreman" \? authUser\.id : undefined/);
  assert.match(api, /function employeeUsageStatement\(workDate: string\)/);
  assert.match(api, /GROUP BY pe\.employee_id, pe\.responsible_user_id, responsible\.full_name/);
  assert.match(api, /function foremanProgressStatement\(siteId: number, workDate: string\)/);
  assert.match(api, /contribution\.status = 'submitted' THEN 'submitted'[\s\S]*contribution\.status = 'draft' THEN 'draft' ELSE 'not_started'/);
  assert.match(api, /employeeUsage: employeeUsage\.results/);
  assert.match(api, /foremanProgress: foremanProgress\.results/);

  const ownership = section(api, "function assertPlacementOwnership", "function assertEntryRevisions");
  assert.match(ownership, /entry\.responsibleUserId !== user\.id/);
  const revisions = section(api, "function assertEntryRevisions", "async function lockPlacementHours");
  assert.match(revisions, /payload\.revision/);
  assert.match(revisions, /existing\.revision !== expectedRevision/);
  assert.match(revisions, /409/);
  assert.match(revisions, /STALE_ENTRY/);
  assert.match(api, /revision = revision \+ 1/);
});

test("allows permitted historical report actions without weakening foreman scope and ownership", async () => {
  const [api, app] = await Promise.all([
    source("app/api/data/route.ts"),
    source("app/PersonnelApp.tsx"),
  ]);

  const permissionGuard = section(api, "function canManagePlacement", "function canRunAction");
  assert.match(permissionGuard, /hasPermission\(user\.permissions, "workers_report", action\)/);
  assert.match(permissionGuard, /user\.role !== "foreman" \|\| user\.assignedSiteId === siteId/);
  assert.doesNotMatch(permissionGuard, /todayInMoscow|workDate\s*[!=]==?\s*today/);

  assert.match(api, /canManagePlacement\(authUser, asPositiveInteger\(row\.siteId\) \?\? undefined, row\.workDate, "create"\)/);
  assert.match(api, /canManagePlacement\(authUser, asPositiveInteger\(entry\.siteId\) \?\? undefined, entry\.workDate, "update"\)/);
  assert.match(api, /if \(!entity\) return hasPermission\(user\.permissions, "workers_report", "delete"\)/);

  const ownership = section(api, "function assertPlacementOwnership", "function assertEntryRevisions");
  assert.match(ownership, /entry\.responsibleUserId !== user\.id/);

  const clientPermissions = section(app, "const canCreateReportDate", "const entryTypeById");
  assert.match(clientPermissions, /const canCreateReportDate = mayCreateWorkersReport/);
  assert.match(clientPermissions, /const canUpdateReportDate = mayUpdateWorkersReport/);
  assert.match(clientPermissions, /const canDeleteReportDate = mayDeleteWorkersReport/);
  assert.match(clientPermissions, /const rosterMode = useDailyRosterReport && workDate === initialToday && canEditDate/);
  assert.match(app, /<ReportGridFooter[\s\S]*canCreate=\{canCreateReportDate\}[\s\S]*canUpdate=\{canUpdateReportDate\}[\s\S]*canDelete=\{canDeleteReportDate\}/);
});

test("serializes daily-hour mutations and reports a conflict instead of overspending 10 hours", async () => {
  const api = await source("app/api/data/route.ts");
  const lock = section(api, "async function lockPlacementHours", "async function resolveResponsibleUsers");
  const patch = section(api, "async function handlePATCH", "async function handleDELETE");
  const deletion = section(api, "async function handleDELETE", "export async function POST");

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
  assert.match(api, /status: error\.status/);
});

test("keeps personal submission separate from the engineer's global finalization", async () => {
  const api = await source("app/api/data/route.ts");
  const app = await source("app/PersonnelApp.tsx");
  const grid = await source("app/AgDataGrids.tsx");

  assert.match(api, /submitOwnReport\?: ReportFinalizationPayload/);
  assert.match(api, /finalizeReport\?: ReportFinalizationPayload/);
  assert.match(api, /touchForemanContribution\([\s\S]*Boolean\(ownSubmission\)/);
  assert.match(api, /finalizeGlobalReport\(db, authUser, finalizationSiteId, finalizationWorkDate\)/);
  assert.match(api, /if \(finalization && authUser\.role === "foreman"\) return forbidden\(\)/);

  assert.match(app, /data\.reportEmployees\.map\(\(employee\) => \[employee\.id, employee\]\)/);
  assert.match(app, /scope=carryover&beforeDate=\$\{workDate\}/);
  assert.match(app, /submitOwnReport: \{ siteId, workDate \}/);
  assert.match(app, /finalizeReport: \{ siteId, workDate \}/);
  assert.match(app, /employeeUsage=\{data\?\.employeeUsage \?\? \[\]\}/);
  assert.match(app, /Сдали прорабы:/);
  assert.match(grid, /headerName: "Ответственный прораб"/);
  assert.match(grid, /Сегодня учтено \{used\} ч\. · доступно/);
});
