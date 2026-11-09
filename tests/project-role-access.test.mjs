import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { limitPermissionsToRole, rolePermissionTemplate } from "../app/permissionModel.ts";
import { accessRequest, projectAccessHarness } from "./fixtures/project-access-boundary.mjs";

process.env.NODE_ENV="production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const sourceUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const fileUrl=path=>new URL(path,import.meta.url).href;
async function loadRoute(path,replacements){
  let source=ts.transpileModule(await readFile(new URL(path,import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for(const [specifier,target]of Object.entries(replacements))source=source.replaceAll(JSON.stringify(specifier),JSON.stringify(target));
  return import(sourceUrl(source));
}

test("engineer actions and project scope are independent while viewing never grants writes",()=>{
  const engineer=rolePermissionTemplate("engineer");
  assert.equal(engineer.workers_report.update,true);
  assert.equal(engineer.equipment_timesheet.update,true);
  assert.equal(engineer.access_rights.update,false);
  const selected=limitPermissionsToRole("engineer",rolePermissionTemplate("superadmin"),{mode:"selected",siteIds:[7,8]});
  assert.equal(selected.workers_report.update,true);
  assert.equal(selected.project_directories.create,true);
  assert.equal(selected.access_rights.update,true);
  const all=limitPermissionsToRole("engineer",rolePermissionTemplate("superadmin"),{mode:"all",siteIds:[]});
  assert.equal(all.access_rights.update,true);
  for(const scope of [{mode:"all",siteIds:[]},{mode:"selected",siteIds:[7,8]}]){
    const viewer=limitPermissionsToRole("viewer",rolePermissionTemplate("superadmin"),scope);
    assert.deepEqual(viewer,rolePermissionTemplate("superadmin"));
    for(const row of Object.values(rolePermissionTemplate("viewer")))for(const action of ["create","update","delete"])assert.equal(row[action],false);
    assert.equal(viewer.workers_report.view,true);
    assert.equal(viewer.workers_timesheet.view,true);
  }
});

test("rights read lists only overlapping project users and an empty grant closes the list",async()=>{
  const h=await projectAccessHarness();
  await h.settings.saveUserProjectAccess(2,{projectAccess:{mode:"selected",siteIds:[7]}},4,h.db);
  await h.settings.saveUserProjectAccess(3,{projectAccess:{mode:"selected",siteIds:[7]}},4,h.db);
  await h.settings.saveUserProjectAccess(5,{projectAccess:{mode:"selected",siteIds:[8]}},4,h.db);
  await h.asUser(2);
  let response=await h.route.GET(new Request("http://localhost/api/access-rights"));
  assert.equal(response.status,200);
  let payload=await response.json();
  assert.deepEqual(payload.users.map(user=>user.id),[1,2,3,4,6]);
  assert.deepEqual(payload.sites.map(site=>site.id),[7]);
  assert.equal(payload.canManage,false);
  const writes=h.db.attemptedWrites.length;
  assert.equal((await h.route.POST(accessRequest({userId:3,projectAccess:{mode:"all",siteIds:[]}}))).status,403);
  assert.equal(h.db.attemptedWrites.length,writes);
  await h.settings.saveUserProjectAccess(2,{projectAccess:{mode:"selected",siteIds:[]}},4,h.db);
  await h.asUser(2);
  response=await h.route.GET(new Request("http://localhost/api/access-rights"));
  assert.equal(response.status,200);payload=await response.json();
  assert.deepEqual(payload.users,[]);assert.deepEqual(payload.sites,[]);assert.equal(payload.canManage,false);
});

test("audit history and pagination honor a project set, revocation and unrestricted engineers",async()=>{
  const authUrl=sourceUrl("export let actor; export function setActor(value){actor=value;} export async function getAuthUser(){return actor;}");
  const dbUrl=sourceUrl(`export let calls=0; const events=[{id:5,siteId:2},{id:4,siteId:1},{id:3,siteId:null},{id:2,siteId:1}];
    export function getDatabase(){return {prepare(sql){let values=[];return {bind(...next){values=next;return this;},async all(){calls++;let index=0;let rows=events;if(sql.includes('site_id = ANY')){const sites=values[index++];rows=rows.filter(row=>sites.includes(row.siteId));}if(sql.includes('id < ?')){const before=values[index++];rows=rows.filter(row=>row.id<before);}return {results:rows.slice(0,values[index])};}};}};}`);
  const auth=await import(authUrl),db=await import(dbUrl);
  const route=await loadRoute("../app/api/audit-log/route.ts",{
    "../../../db/client":dbUrl,"../../auth":authUrl,"../../roles":fileUrl("../app/roles.ts"),
    "../../auditLog":sourceUrl("export async function ensureAuditSchema(){}"),"../../permissionModel":fileUrl("../app/permissionModel.ts"),
  });
  auth.setActor({role:"engineer",assignedSiteId:null,projectAccess:{mode:"selected",siteIds:[1,2]},permissions:rolePermissionTemplate("engineer")});
  let response=await route.GET(new Request("http://localhost/api/audit-log?beforeId=5&limit=2"));
  assert.equal(response.status,200);assert.deepEqual((await response.json()).events.map(row=>row.id),[4,2]);
  auth.setActor({role:"engineer",assignedSiteId:null,projectAccess:{mode:"selected",siteIds:[]},permissions:rolePermissionTemplate("engineer")});
  const calls=db.calls;assert.equal((await route.GET(new Request("http://localhost/api/audit-log"))).status,403);assert.equal(db.calls,calls);
  auth.setActor({role:"engineer",assignedSiteId:null,permissions:rolePermissionTemplate("engineer")});
  response=await route.GET(new Request("http://localhost/api/audit-log"));
  assert.deepEqual((await response.json()).events.map(row=>row.id),[5,4,3,2]);
});
