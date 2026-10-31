import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hasPermission, rolePermissionTemplate } from "../app/permissionModel.ts";
import { canAccessProject } from "../app/roles.ts";
import { accessRequest, projectAccessHarness } from "./fixtures/project-access-boundary.mjs";

process.env.NODE_ENV="production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const getRequest=()=>new Request("http://localhost/api/access-rights");

test("project access persists selected, all and none independently of the user's role",async()=>{
  const h=await projectAccessHarness();
  const viewer=h.db.state.users.get(3);
  assert.deepEqual(await h.settings.loadUserProjectAccess(viewer,h.db),{projectAccess:{mode:"selected",siteIds:[]},canViewPendingReports:false});
  const selected=await h.settings.saveUserProjectAccess(3,{projectAccess:{mode:"selected",siteIds:[8,7,8]}},4,h.db);
  assert.deepEqual(selected,{projectAccess:{mode:"selected",siteIds:[7,8]},canViewPendingReports:false});
  assert.deepEqual(await h.settings.loadUserProjectAccess(viewer,h.db),selected);
  assert.equal(h.db.state.settings.get(3).updatedByUserId,4);
  assert.equal(canAccessProject({...viewer,...selected},7),true);
  assert.equal(canAccessProject({...viewer,...selected},9),false);
  await h.settings.saveUserProjectAccess(3,{projectAccess:{mode:"all",siteIds:[]}},4,h.db);
  assert.deepEqual((await h.settings.loadUserProjectAccess(viewer,h.db)).projectAccess,{mode:"all",siteIds:[]});
  assert.deepEqual([...h.db.state.grants.get(3)],[]);
  await h.settings.saveUserProjectAccess(3,{projectAccess:{mode:"selected",siteIds:[]}},4,h.db);
  const revoked=await h.settings.loadUserProjectAccess(viewer,h.db);
  assert.equal(canAccessProject({...viewer,...revoked},7),false);
  assert.deepEqual(revoked.projectAccess,{mode:"selected",siteIds:[]});
  assert.equal(h.db.state.users.get(3).role,"viewer");
});

test("pending-report visibility defaults off for a viewer and partial saves preserve prior settings",async()=>{
  const h=await projectAccessHarness();
  await h.settings.saveUserProjectAccess(3,{projectAccess:{mode:"selected",siteIds:[7]}},4,h.db);
  await h.settings.saveUserProjectAccess(3,{canViewPendingReports:true},4,h.db);
  assert.deepEqual(await h.settings.loadUserProjectAccess(h.db.state.users.get(3),h.db),{projectAccess:{mode:"selected",siteIds:[7]},canViewPendingReports:true});
  await h.settings.saveUserProjectAccess(3,{projectAccess:{mode:"selected",siteIds:[8]}},4,h.db);
  assert.equal((await h.settings.loadUserProjectAccess(h.db.state.users.get(3),h.db)).canViewPendingReports,true);
  await h.settings.saveUserProjectAccess(3,{canViewPendingReports:false},4,h.db);
  assert.equal((await h.settings.loadUserProjectAccess(h.db.state.users.get(3),h.db)).canViewPendingReports,false);
  await assert.rejects(h.settings.saveUserProjectAccess(3,{canViewPendingReports:"true"},4,h.db),/доступ к черновикам/);
});

test("the real rights route saves section permissions and project grants as one transaction",async()=>{
  const h=await projectAccessHarness(); await h.asUser(4);
  const permissions=rolePermissionTemplate("viewer"); permissions.employees.view=true;
  const response=await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"selected",siteIds:[7,8]},permissions,canViewPendingReports:true}));
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.deepEqual(payload.projectAccess,{mode:"selected",siteIds:[7,8]});
  assert.equal(payload.canViewPendingReports,true);
  assert.equal(payload.customized,true);
  assert.equal(payload.permissions.employees.view,true);
  assert.equal(h.db.state.permissions.get(3).get("employees").canView,1);
  const list=await(await h.route.GET(getRequest())).json();
  const user=list.users.find(user=>user.id===3);
  assert.deepEqual(user.projectAccess,payload.projectAccess);
  assert.equal(user.canViewPendingReports,true);
  assert.equal(user.permissions.employees.view,true);
});

test("an invalid or archived project rolls back the combined rights save",async t=>{
  t.mock.method(console,"error",()=>{});
  const h=await projectAccessHarness(); await h.asUser(4);
  assert.equal((await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"selected",siteIds:[7]},permissions:rolePermissionTemplate("viewer")}))).status,200);
  const before=structuredClone(h.db.state);
  const broad=rolePermissionTemplate("superadmin");
  for(const invalid of [9,999]){
    const response=await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"selected",siteIds:[7,invalid]},permissions:broad,canViewPendingReports:true}));
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/не найден или архивирован/);
    assert.deepEqual(h.db.state,before);
  }
});

test("a later permission persistence error rolls back already saved project grants",async t=>{
  t.mock.method(console,"error",()=>{});
  const h=await projectAccessHarness(); await h.asUser(4);
  assert.equal((await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"selected",siteIds:[7]},permissions:rolePermissionTemplate("viewer")}))).status,200);
  const before=structuredClone(h.db.state);
  h.db.failPermissionResource("equipment_report");
  const response=await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"all",siteIds:[]},permissions:rolePermissionTemplate("superadmin"),canViewPendingReports:true}));
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/Injected permission persistence failure/);
  assert.deepEqual(h.db.state,before);
  assert.ok(h.db.attemptedWrites.some(write=>write.sql.startsWith("INSERT INTO user_project_access (")&&write.values[1]===1));
});

test("a viewer cannot acquire writes through custom permissions or administer access",async()=>{
  const h=await projectAccessHarness(); await h.asUser(4);
  const response=await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"all",siteIds:[]},permissions:rolePermissionTemplate("superadmin"),canViewPendingReports:true}));
  assert.equal(response.status,200);
  const payload=await response.json();
  for(const row of Object.values(payload.permissions))for(const action of ["create","update","delete"])assert.equal(row[action],false);
  await h.asUser(3,{permissions:rolePermissionTemplate("superadmin")});
  const writes=h.db.attemptedWrites.length;
  assert.equal((await h.route.POST(accessRequest({userId:2,projectAccess:{mode:"all",siteIds:[]}}))).status,403);
  assert.equal(h.db.attemptedWrites.length,writes);
  const fresh=await h.permissions.loadEffectivePermissions(3,"viewer",{mode:"all",siteIds:[]},h.db);
  assert.equal(hasPermission(fresh.permissions,"workers_report","view"),true);
  assert.equal(hasPermission(fresh.permissions,"workers_report","update"),false);
});

test("resetting section permissions preserves project revocation and pending-report settings",async()=>{
  const h=await projectAccessHarness(); await h.asUser(4);
  await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"selected",siteIds:[]},permissions:rolePermissionTemplate("superadmin"),canViewPendingReports:true}));
  const response=await h.route.POST(accessRequest({userId:3,reset:true}));
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.equal(payload.customized,false);
  assert.deepEqual(payload.projectAccess,{mode:"selected",siteIds:[]});
  assert.equal(payload.canViewPendingReports,true);
  assert.equal(h.db.state.permissions.has(3),false);
});

test("removed administrator accounts migrate to engineer with their existing scope preserved",async()=>{
  const h=await projectAccessHarness();
  const otherUsers=structuredClone([...h.db.state.users].filter(([id])=>id!==6));
  try{
    process.env.NODE_ENV="development";
    await h.settings.ensureUserProjectAccessSchema(h.db);
  }finally{process.env.NODE_ENV="production";}
  assert.equal(h.db.state.users.get(6).role,"engineer");
  assert.deepEqual(await h.settings.loadUserProjectAccess(h.db.state.users.get(6),h.db),{projectAccess:{mode:"all",siteIds:[]},canViewPendingReports:true});
  assert.deepEqual([...h.db.state.users].filter(([id])=>id!==6),otherUsers);
  const migration=await readFile(new URL("../drizzle-postgres/0025_user_project_access.sql",import.meta.url),"utf8");
  assert.match(migration,/WHERE "role" = 'admin'/);
  assert.match(migration,/SET "role" = 'engineer'/);
  assert.doesNotMatch(migration,/DELETE FROM "app_users"/);
});

test("migration does not widen an administrator account that already has explicit grants",async()=>{
  const h=await projectAccessHarness();
  h.db.state.settings.set(6,{allProjects:0,canViewPendingReports:0});
  h.db.state.grants.set(6,new Set([8]));
  try{
    process.env.NODE_ENV="development";
    await h.settings.ensureUserProjectAccessSchema(h.db);
  }finally{process.env.NODE_ENV="production";}
  assert.equal(h.db.state.users.get(6).role,"engineer");
  assert.equal(h.db.state.settings.get(6).allProjects,0);
  assert.deepEqual((await h.settings.loadUserProjectAccess(h.db.state.users.get(6),h.db)).projectAccess,{mode:"selected",siteIds:[8]});
  const writes=h.db.attemptedWrites.length;
  try{process.env.NODE_ENV="development";await h.settings.ensureUserProjectAccessSchema(h.db);}finally{process.env.NODE_ENV="production";}
  assert.equal(h.db.attemptedWrites.length,writes);
});

test("project access can bootstrap before the first application data load creates sites", async () => {
  const h = await projectAccessHarness();
  const availableTables = new Set(["app_users"]);
  const prepare = h.db.prepare.bind(h.db);
  h.db.prepare = sql => {
    const created = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
    if (created) {
      for (const reference of sql.matchAll(/REFERENCES (\w+)\(/g)) assert.ok(availableTables.has(reference[1]), `Missing referenced table ${reference[1]} during authentication bootstrap`);
      availableTables.add(created[1]);
    }
    return prepare(sql);
  };
  const previousEnvironment = process.env.NODE_ENV;
  try { process.env.NODE_ENV = "development"; await h.settings.ensureUserProjectAccessSchema(h.db); }
  finally { process.env.NODE_ENV = previousEnvironment; }
  assert.ok(availableTables.has("sites"));
  assert.ok(availableTables.has("user_project_access_sites"));
});
