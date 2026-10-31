// Explicit local QA: creates a disposable database, runs real migrations and
// integration checks there, then drops only that database. Business data is never written.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import ts from "typescript";

assert.ok(process.env.DATABASE_URL, "Set DATABASE_URL to the local PostgreSQL server.");
const sourceUrl = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(sourceUrl.hostname), "This check only accepts a loopback database.");
const control = new pg.Pool({ connectionString: sourceUrl.href, ssl: false, max: 1, connectionTimeoutMillis: 5000 });
const databaseName = `personnel_qa_${randomUUID().replaceAll("-", "")}`;
const identifier = value => `"${value.replaceAll('"', '""')}"`;
const isolatedUrl = new URL(sourceUrl);
isolatedUrl.pathname = `/${databaseName}`;
const env = { ...process.env, DATABASE_URL: isolatedUrl.href, NODE_ENV: "production" };
delete env.DATABASE_RUNTIME_BOOTSTRAP;
let created = false, pool, migrationDirectory;
async function compile(path, imports = {}) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, target] of Object.entries(imports)) code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      // Compiled data URLs in a stack can be enormous. Keep failures readable.
      const safeOutput = output.replace(/data:[^\s"']+/g, "[compiled module]").slice(-12000);
      if (code === 0) { console.log(safeOutput.trim()); resolve(); }
      else reject(new Error(`${script} failed (${code}):\n${safeOutput}`));
    });
  });
}
try {
  const role = (await control.query("SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.equal(role?.allowed, true, "Local DB account cannot create an isolated test database; no business data was changed.");
  if (process.argv.includes("--probe-only")) {
    console.log("PASS: local PostgreSQL is reachable and permits an isolated test database; no data written.");
  } else {
    await control.query(`CREATE DATABASE ${identifier(databaseName)}`);
    created = true;
    pool = new pg.Pool({ connectionString: isolatedUrl.href, ssl: false, max: 3, connectionTimeoutMillis: 5000 });
    assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name, databaseName);
    migrationDirectory = await mkdtemp(join(tmpdir(), "personnel-qa-migrations-"));
    const journal = JSON.parse(await readFile(new URL("../drizzle-postgres/meta/_journal.json", import.meta.url), "utf8"));
    await mkdir(join(migrationDirectory, "meta"));
    await writeFile(join(migrationDirectory, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(entry => entry.idx < 25) }));
    for (const entry of journal.entries) await symlink(new URL(`../drizzle-postgres/${entry.tag}.sql`, import.meta.url), join(migrationDirectory, `${entry.tag}.sql`));
    await migrate(drizzle(pool), { migrationsFolder: migrationDirectory });
    console.log("PASS: clean PostgreSQL schema migrated through 0024.");

    const siteIds = (await pool.query("INSERT INTO sites(name,code) VALUES ('QA project A','qa-a'),('QA project B','qa-b') RETURNING id")).rows.map(row => row.id);
    const users = (await pool.query(`INSERT INTO app_users(full_name,email,role,assigned_site_id) VALUES
      ('Legacy admin','admin@invalid.test','admin',NULL),
      ('Legacy engineer','engineer@invalid.test','engineer',$1),
      ('Legacy foreman','foreman@invalid.test','foreman',$1),
      ('Viewer','viewer@invalid.test','viewer',NULL),
      ('Super admin','super@invalid.test','superadmin',NULL) RETURNING id,role`, [siteIds[0]])).rows;
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle-postgres", import.meta.url)) });
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle-postgres", import.meta.url)) });
    assert.equal((await pool.query("SELECT role FROM app_users WHERE id=$1", [users[0].id])).rows[0].role, "engineer");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations")).rows[0].count, journal.entries.length);

    const { PostgresDatabase } = await import(await compile("../db/client.ts", { pg: import.meta.resolve("pg") }));
    const database = new PostgresDatabase(pool);
    globalThis.prepushIsolatedDatabase = database;
    const dbBoundary = `data:text/javascript,${encodeURIComponent("export function getDatabase(){return globalThis.prepushIsolatedDatabase;}")}`;
    const { loadUserProjectAccess, saveUserProjectAccess } = await import(await compile("../app/projectAccessServer.ts", {
      "../db/client": dbBoundary, "./roles.ts": new URL("../app/roles.ts", import.meta.url).href,
    }));
    const { effectiveProjectAccess, canAccessProject } = await import("../app/roles.ts");
    const admin = { id: users[0].id, role: "engineer", assignedSiteId: null };
    const engineer = { id: users[1].id, role: "engineer", assignedSiteId: siteIds[0] };
    const foreman = { id: users[2].id, role: "foreman", assignedSiteId: siteIds[0] };
    const viewer = { id: users[3].id, role: "viewer", assignedSiteId: null };
    const superadmin = { id: users[4].id, role: "superadmin", assignedSiteId: null };
    assert.deepEqual((await loadUserProjectAccess(admin)).projectAccess, { mode: "all", siteIds: [] });
    assert.deepEqual((await loadUserProjectAccess(engineer)).projectAccess, { mode: "all", siteIds: [] });
    assert.deepEqual((await loadUserProjectAccess(foreman)).projectAccess, { mode: "selected", siteIds: [siteIds[0]] });
    assert.deepEqual(await loadUserProjectAccess(viewer), { projectAccess: { mode: "selected", siteIds: [] }, canViewPendingReports: false });
    await saveUserProjectAccess(viewer.id, { projectAccess: { mode: "selected", siteIds }, canViewPendingReports: true }, superadmin.id);
    assert.deepEqual(await loadUserProjectAccess(viewer), { projectAccess: { mode: "selected", siteIds }, canViewPendingReports: true });
    await assert.rejects(saveUserProjectAccess(viewer.id, { projectAccess: { mode: "selected", siteIds: [2147483647] } }, superadmin.id), /не найден|архивирован/);
    assert.deepEqual((await loadUserProjectAccess(viewer)).projectAccess.siteIds, siteIds, "invalid grant rolls back");
    await assert.rejects(database.transaction(async tx => {
      await saveUserProjectAccess(viewer.id, { projectAccess: { mode: "all", siteIds: [] }, canViewPendingReports: false }, superadmin.id, tx);
      throw new Error("later permission failure");
    }), /later permission failure/);
    assert.deepEqual(await loadUserProjectAccess(viewer), { projectAccess: { mode: "selected", siteIds }, canViewPendingReports: true }, "combined transaction rollback retains scope and pending setting");
    await saveUserProjectAccess(viewer.id, { projectAccess: { mode: "selected", siteIds: [] }, canViewPendingReports: false }, superadmin.id);
    assert.equal(canAccessProject({ ...viewer, ...await loadUserProjectAccess(viewer) }, siteIds[0]), false, "revocation is loaded on the next request");
    await saveUserProjectAccess(engineer.id, { projectAccess: { mode: "selected", siteIds } }, superadmin.id);
    assert.deepEqual(effectiveProjectAccess({ ...engineer, ...await loadUserProjectAccess(engineer) }).siteIds, siteIds);
    await saveUserProjectAccess(superadmin.id, { projectAccess: { mode: "selected", siteIds: [] } }, superadmin.id);
    assert.deepEqual((await loadUserProjectAccess(superadmin)).projectAccess, { mode: "all", siteIds: [] });
    console.log("PASS: 0025 upgrade, repeat migrations, legacy role defaults, multi-project grants, rollback, revocation and super-admin protection on real PostgreSQL.");

    const customRoles = await import(await compile("../app/customRolesServer.ts", {
      "../db/client": dbBoundary, "./customRoles.ts": new URL("../app/customRoles.ts", import.meta.url).href,
    }));
    const permissionStore = await import(await compile("../app/permissions.ts", {
      "../db/client": dbBoundary, "./permissionModel": new URL("../app/permissionModel.ts", import.meta.url).href,
    }));
    const { emptyPermissionSet, rolePermissionTemplate } = await import("../app/permissionModel.ts");
    const readPermissions = emptyPermissionSet(); readPermissions.equipment_timesheet.view = true;
    const readRole = await customRoles.createCustomRole({ name: "Контроль техники", permissions: readPermissions }, superadmin.id);
    const workRole = await customRoles.createCustomRole({ name: "Инженер ПТО", permissions: { workers_report: { view: true, create: true, update: true, delete: false } } }, superadmin.id);
    assert.equal(readRole.baseRole, "viewer"); assert.equal(workRole.baseRole, "engineer");
    assert.deepEqual((await customRoles.listCustomRoles()).map(role => role.name), [workRole.name, readRole.name]);
    await assert.rejects(customRoles.createCustomRole({ name: " контроль  ТЕХНИКИ ", permissions: readPermissions }, superadmin.id), error => error.status === 409);
    const customUserId = (await pool.query("INSERT INTO app_users(full_name,email,role,custom_role_id) VALUES ('Custom QA','custom@invalid.test',$1,$2) RETURNING id", [readRole.baseRole, readRole.id])).rows[0].id;
    const customUser = { id: customUserId, role: readRole.baseRole, customRoleId: readRole.id, assignedSiteId: null };
    assert.deepEqual(await loadUserProjectAccess(customUser), { projectAccess: { mode: "selected", siteIds: [] }, canViewPendingReports: false });
    let effective = await permissionStore.loadEffectivePermissions(customUser.id, customUser.role, undefined, database, readRole);
    assert.equal(effective.permissions.equipment_timesheet.view, true);
    assert.equal(effective.permissions.workers_report.view, false, "custom template cannot inherit the standard viewer's other reports");
    await permissionStore.saveUserPermissions(customUser.id, rolePermissionTemplate("superadmin"), superadmin.id);
    effective = await permissionStore.loadEffectivePermissions(customUser.id, customUser.role, undefined, database, readRole);
    assert.equal(effective.permissions.equipment_timesheet.update, false, "custom read-only role rejects forged write overrides");
    await database.transaction(async tx => {
      await tx.prepare("UPDATE app_users SET role = ?, custom_role_id = ? WHERE id = ?").bind(workRole.baseRole, workRole.id, customUser.id).run();
      await permissionStore.resetUserPermissions(customUser.id, tx);
      await saveUserProjectAccess(customUser.id, { projectAccess: { mode: "selected", siteIds: [siteIds[0]] } }, superadmin.id, tx);
    });
    effective = await permissionStore.loadEffectivePermissions(customUser.id, workRole.baseRole, { mode: "selected", siteIds: [siteIds[0]] }, database, workRole);
    assert.equal(effective.permissions.workers_report.update, true);
    assert.equal(effective.permissions.equipment_report.view, false, "switching roles clears the old full permission override");
    assert.equal(effective.permissionsCustomized, false);
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle-postgres", import.meta.url)) });
    assert.equal((await customRoles.loadCustomRole(readRole.id)).name, readRole.name);
    console.log("PASS: 0026 custom roles, JSON permission templates, case-insensitive duplicates, assignment/default isolation, readonly ceiling, transactional role change and repeat migration on real PostgreSQL.");

    for (const script of ["scripts/test-personnel-report-integration.mjs", "scripts/test-equipment-report-integration.mjs", "scripts/test-table-order-integration.mjs"]) await run(script);
    console.log("PASS: all integration checks used the disposable database only.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  delete globalThis.prepushIsolatedDatabase;
  if (pool) await pool.end();
  if (created) {
    await control.query(`DROP DATABASE ${identifier(databaseName)} WITH (FORCE)`);
    console.log("Disposable QA database removed.");
  }
  await control.end();
  if (migrationDirectory) await rm(migrationDirectory, { recursive: true, force: true });
}
