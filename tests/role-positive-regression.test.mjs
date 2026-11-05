import assert from "node:assert/strict";
import test from "node:test";
import { compileModuleGraph } from "./fixtures/compile-module-graph.mjs";
import { rolePermissionTemplate } from "../app/permissionModel.ts";
import { noCustomRolesUrl, noPermissionChangesUrl } from "./fixtures/custom-role-imports.mjs";

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = moduleUrl(`export let actor; export let database; export function configure(user,db){actor=user;database=db;}
  export const getDatabase=()=>database; export const getAuthUser=async()=>actor;
  export function assertSameOrigin(){} export async function ensureAuthSchema(){}
  export async function createInvitation(){throw new Error('No invitations in regression checks');}
  export async function sendInvitationEmail(){throw new Error('No outgoing email in regression checks');}`);
const boundary = await import(boundaryUrl);
const noop = names => moduleUrl(names.map(name => `export async function ${name}(){return {};}`).join("\n"));
const file = name => new URL(`../app/${name}.ts`, import.meta.url).href;
const replacements = {
  "../../customRolesServer": noCustomRolesUrl,
  "../../permissions": noPermissionChangesUrl,
  "../../projectAccessServer": moduleUrl("export let saves=[]; export async function loadUserProjectAccess(user){return {projectAccess:user.projectAccess??{mode:user.role==='engineer'||user.role==='superadmin'?'all':'selected',siteIds:user.assignedSiteId?[user.assignedSiteId]:[]},canViewPendingReports:user.role!=='viewer'};} export async function saveUserProjectAccess(userId,settings,actorId){saves.push({userId,settings,actorId});if(settings.projectAccess?.siteIds?.includes(99))throw new Error('Unknown project');return settings;}"),
  "../../../db/client": boundaryUrl, "../../auth": boundaryUrl,
  "../../auditLog": moduleUrl("export async function withAuditTrail(request,handler){return handler(request);}"),
  "../../compressJsonResponse": moduleUrl("export async function compressJsonResponse(request,response){return response;}"),
  ...Object.fromEntries(["roles", "permissionModel", "projectScopedData", "readOptionalBatch", "settingsReadPolicy", "bitrix24Cooldown", "bitrixReviewSelection", "excelDirectoryImports", "personnelImportOrderServer", "equipmentAvailability", "equipmentImport", "equipmentTimesheetUnits", "equipmentReportWorkflow", "personnelTimesheetReference.server"].map(name=>[`../../${name}`,file(name)])),
  "../../projectMasters": noop(["ensureProjectMastersSchema", "syncProjectMasters"]),
  "../../workTypeHierarchyServer": noop(["saveSubworkDirectory"]),
  "../../bitrix24Sync": noop(["compareBitrixEmployees", "fetchBitrixEmployeeSnapshot", "normalizeBitrixText", "selectBitrixEmployeesForImport", "suggestBitrixEmployeeLinks"]),
  "../../equipmentImportServer": noop(["importEquipmentEntries"]),
};
async function route(path) {
  return import(await compileModuleGraph(new URL(path, import.meta.url), replacements));
}
process.env.NODE_ENV="production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const data=await route("../app/api/data/route.ts"), equipment=await route("../app/api/equipment/route.ts"), timesheet=await route("../app/api/timesheet/route.ts");
const actor=(role="engineer")=>({id:17,fullName:"Проверяющий",role,assignedSiteId:role==="engineer"?7:null,projectAccess:role==="engineer"?{mode:"selected",siteIds:[7]}:{mode:"all",siteIds:[]},permissions:rolePermissionTemplate(role)});
const request=(path,method="GET",body)=>new Request(`http://localhost${path}`,{method,...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
const assignments=(own,foreign=false)=>[{siteId:7,active:own},...(foreign?[{siteId:8,active:true}]:[])];
function fixture(role="engineer") {
  const state={employees:[{id:10,active:true,assignments:assignments(true)},{id:20,active:true,assignments:assignments(false)},{id:30,active:true,assignments:assignments(false,true)},{id:40,active:false,assignments:assignments(false)}],
    units:[{id:11,active:true,assignments:assignments(true)},{id:21,active:true,assignments:assignments(false)},{id:31,active:true,assignments:assignments(false,true)},{id:41,active:false,assignments:assignments(false)}],marks:new Map(),equipmentMarks:new Map(),queries:[],writes:[]};
  const owned=e=>e.assignments.some(a=>a.siteId===7&&a.active);
  const former=e=>e.assignments.some(a=>a.siteId===7)&&!e.assignments.some(a=>a.active);
  const catalog=(records,sql)=>records.filter(e=>e.active&&(role!=="engineer"||owned(e)||sql.includes("former_assignment")&&former(e))).map(e=>({...e,fullName:`Сотрудник ${e.id}`,siteId:owned(e)?7:null,assignedSiteId:owned(e)?7:null}));
  const sqlRows=(sql,values)=>{
    if(sql.includes("SELECT entity.id FROM")) {
      const records=sql.includes("FROM employees entity")?state.employees:state.units;
      return records.filter(e=>values[0].includes(e.id)&&e.active&&(owned(e)||sql.includes("former_assignment")&&former(e))&&(!sql.includes("other_assignment")||!e.assignments.some(a=>a.siteId!==7&&a.active))).map(e=>({id:e.id}));
    }
    if(/FROM employees e\s+LEFT JOIN employee_project_assignments/.test(sql)) return catalog(state.employees,sql);
    if(/FROM equipment_units eu WHERE eu.active = 1/.test(sql)) return catalog(state.units,sql);
    if(/FROM equipment_units eu JOIN equipment_project_assignments/.test(sql)) return catalog(state.units,"");
    if(/FROM employees e JOIN employee_project_assignments/.test(sql)) return catalog(state.employees,"");
    if(/SELECT id FROM sites WHERE id = \?/.test(sql)||/SELECT id, name FROM sites WHERE id = \?/.test(sql)) return [7,8].includes(values[0])?[{id:values[0],name:`Проект ${values[0]}`}]:[];
    if(/SELECT id, name(?:, code, timezone)? FROM sites WHERE active = 1/.test(sql)) return [{id:7,name:"Проект 7"},{id:8,name:"Проект 8"}];
    if(/SELECT id FROM employees WHERE id = \?/.test(sql)) return state.employees.filter(e=>e.id===values[0]&&e.active).map(e=>({id:e.id}));
    if(/SELECT id FROM equipment_units WHERE id = \?/.test(sql)) return state.units.filter(e=>e.id===values[0]&&e.active).map(e=>({id:e.id}));
    if(/SELECT id FROM employees WHERE id = ANY/.test(sql)) return state.employees.filter(e=>values[0].includes(e.id)&&e.active).map(e=>({id:e.id}));
    if(/SELECT id, full_name AS fullName FROM employees WHERE id = ANY/.test(sql)) return state.employees.filter(e=>values[0].includes(e.id)&&e.active).map(e=>({id:e.id,fullName:`Сотрудник ${e.id}`}));
    if(/SELECT id FROM equipment_units WHERE identity_key/.test(sql)) return state.identityUnit?[{id:state.identityUnit}]:[];
    if(/SELECT employee_id AS employeeId FROM employee_project_assignments/.test(sql)) return state.employees.filter(e=>values[0].includes(e.id)&&owned(e)).map(e=>({employeeId:e.id}));
    if(/SELECT id FROM employee_project_assignments WHERE employee_id/.test(sql)) return state.employees.some(e=>e.id===values[0]&&owned(e))?[{id:101}]:[];
    if(/SELECT site_id AS "siteId" FROM equipment_project_assignments/.test(sql)) return state.units.find(e=>e.id===values[0])?.assignments.filter(a=>a.active).map(a=>({siteId:a.siteId}))??[];
    if(/SELECT e.id FROM employees e WHERE e.id/.test(sql)) return state.employees.filter(e=>e.id===values[0]&&owned(e)).map(e=>({id:e.id}));
    if(/SELECT eu.id FROM equipment_units eu WHERE eu.id/.test(sql)) return state.units.filter(e=>e.id===values[0]&&owned(e)).map(e=>({id:e.id}));
    if(/SELECT id FROM timesheet_marks/.test(sql)) return state.marks.has(values.join(":"))?[{id:1}]:[];
    if(/SELECT id FROM equipment_timesheet_marks/.test(sql)) return state.equipmentMarks.has(values.join(":"))?[{id:1}]:[];
    if(/FROM personnel_options|FROM position_catalog/.test(sql)) return [{id:1}];
    return [];
  };
  const write=(sql,values)=>{
    state.writes.push({sql,values});
    const relation=(records,id,siteId,active)=>{const e=records.find(e=>e.id===id);if(!e)return;const previous=e.assignments.find(a=>a.siteId===siteId);if(previous)previous.active=active;else e.assignments.push({siteId,active});};
    if(sql.startsWith("INSERT INTO employee_project_assignments"))relation(state.employees,values[0],values[1],true);
    if(sql.startsWith("UPDATE employee_project_assignments SET active = 0")&&sql.includes("site_id = ?"))relation(state.employees,values[0],values[1],false);
    if(sql.startsWith("UPDATE employee_project_assignments SET active = 0")&&sql.includes("employee_id = ANY"))for(const e of state.employees.filter(e=>values[0].includes(e.id)))e.assignments.forEach(a=>a.active=false);
    if(sql.startsWith("UPDATE employees SET active = 0"))for(const e of state.employees.filter(e=>values[0].includes(e.id)))e.active=false;
    if(sql.startsWith("INSERT INTO equipment_project_assignments")||sql.startsWith("UPDATE equipment_project_assignments SET active = 1"))relation(state.units,values[0],values[1],true);
    if(sql.startsWith("UPDATE equipment_project_assignments SET active = 0")&&sql.includes("site_id = ?"))relation(state.units,values[0],values[1],false);
    if(sql.startsWith("UPDATE equipment_project_assignments SET active = 0")&&!sql.includes("site_id"))state.units.find(e=>e.id===values[0])?.assignments.forEach(a=>a.active=false);
    if(sql.startsWith("UPDATE equipment_units SET active = 0")){const e=state.units.find(e=>e.id===values[0]);if(e)e.active=false;}
    if(sql.startsWith("INSERT INTO timesheet_marks"))state.marks.set(values.slice(0,3).join(":"),values.slice(3));
    if(sql.startsWith("DELETE FROM timesheet_marks"))state.marks.delete(values.join(":"));
    if(sql.startsWith("INSERT INTO equipment_timesheet_marks"))state.equipmentMarks.set(values.slice(0,3).join(":"),values.slice(3));
    if(sql.startsWith("DELETE FROM equipment_timesheet_marks"))state.equipmentMarks.delete(values.join(":"));
    return {results:[],success:true,meta:{changes:1,last_row_id:500}};
  };
  const db={prepare(sql){let values=[];const record=()=>{assert.equal((sql.match(/\?/g)??[]).length,values.length,`SQL bind mismatch: ${sql}`);state.queries.push({sql,values});};const statement={bind(...next){values=next;return statement;},async all(){record();return {results:sqlRows(sql,values),success:true,meta:{changes:0,last_row_id:null}};},async first(){record();return sqlRows(sql,values)[0]??null;},async run(){record();return /^SELECT\b/.test(sql.trim())?{results:sqlRows(sql,values),success:true,meta:{changes:0,last_row_id:null}}:write(sql,values);}};return statement;},async readBatch(statements){return Promise.all(statements.map(s=>s.all()));},async batch(statements){return Promise.all(statements.map(s=>s.run()));},async transaction(callback){state.beforeTransaction?.();state.beforeTransaction=undefined;return callback(db);}};
  boundary.configure(actor(role),db);
  return state;
}

test("an engineer assigned to a non-default project keeps catalog, report and timesheet reads",async()=>{
  fixture();
  for(const [handler,path] of [[data,"/api/data?scope=navigation"],[data,"/api/data?siteId=7&scope=settings&section=employees"],[data,"/api/data?siteId=7&scope=settings&section=projectEmployees"],[data,"/api/data?siteId=7&scope=workspace&date=2026-10-30"],[timesheet,"/api/timesheet?siteId=7&month=2026-10"],[equipment,"/api/equipment?siteId=7&scope=project&section=daily&view=daily&date=2026-10-30&month=2026-10"],[equipment,"/api/equipment?siteId=7&scope=assignments&section=project&view=project&date=2026-10-30&month=2026-10"]])assert.equal((await handler.GET(request(path))).status,200,path);
});

test("project membership catalogs include former unassigned assets but never foreign or archived ones",async()=>{
  fixture();
  let result=await(await data.GET(request("/api/data?siteId=7&scope=settings&section=projectEmployees"))).json();
  assert.deepEqual(result.employees.map(e=>e.id),[10,20]);
  assert.deepEqual(result.projectEmployees.map(e=>e.id),[10]);
  result=await(await data.GET(request("/api/data?siteId=7&scope=settings&section=employees"))).json();
  assert.deepEqual(result.employees.map(e=>e.id),[10]);
  result=await(await equipment.GET(request("/api/equipment?siteId=7&scope=assignments&section=project&view=project&date=2026-10-30&month=2026-10"))).json();
  assert.deepEqual(result.availableUnits.map(e=>e.id),[11,21]);
  assert.deepEqual(result.units.map(e=>e.id),[11]);
});

test("engineers can remove and restore their employee without gaining access to transferred employees",async()=>{
  const state=fixture();
  assert.equal((await data.DELETE(request("/api/data?entity=employee-assignment&id=10&siteId=7","DELETE"))).status,200);
  assert.equal(state.employees[0].assignments[0].active,false);
  assert.equal((await data.POST(request("/api/data","POST",{action:"assign-employee-project",employeeId:10,siteId:7}))).status,201);
  assert.equal(state.employees[0].assignments[0].active,true);
  const writes=state.writes.length;
  assert.equal((await data.POST(request("/api/data","POST",{action:"assign-employee-project",employeeId:30,siteId:7}))).status,403);
  assert.equal(state.writes.length,writes);
});

test("employee Excel restores eligible former members and leaves transferred members untouched",async()=>{
  const state=fixture();
  let response=await data.POST(request("/api/data","POST",{action:"import-project-employees",siteId:7,employeeIds:[10,20]}));
  assert.equal(response.status,201);
  assert.deepEqual(await response.json(),{count:1,skipped:1});
  assert.equal(state.employees[1].assignments[0].active,true);
  assert.ok(state.queries.some(q=>q.sql.includes("FOR UPDATE")&&q.sql.includes("FROM employees")));
  const writes=state.writes.length;
  response=await data.POST(request("/api/data","POST",{action:"import-project-employees",siteId:7,employeeIds:[10,30]}));
  assert.equal(response.status,403);
  assert.equal(state.writes.length,writes);
});

test("restoration import rechecks project eligibility after acquiring its employee row locks",async()=>{
  const state=fixture();
  state.beforeTransaction=()=>state.employees[1].assignments.push({siteId:8,active:true});
  const response=await data.POST(request("/api/data","POST",{action:"import-project-employees",siteId:7,employeeIds:[20]}));
  assert.equal(response.status,403);
  assert.equal(state.writes.length,0);
  assert.equal(state.employees[1].assignments[0].active,false);
});

test("engineers can remove and restore equipment without changing another project's assignment",async()=>{
  const state=fixture();
  assert.equal((await equipment.POST(request("/api/equipment","POST",{action:"remove-unit-project",siteId:7,equipmentId:11}))).status,200);
  assert.equal(state.units[0].assignments[0].active,false);
  assert.equal((await equipment.POST(request("/api/equipment","POST",{action:"assign-unit-project",siteId:7,equipmentId:11}))).status,200);
  assert.equal(state.units[0].assignments[0].active,true);
  const writes=state.writes.length;
  assert.equal((await equipment.POST(request("/api/equipment","POST",{action:"assign-unit-project",siteId:7,equipmentId:31}))).status,403);
  assert.equal(state.writes.length,writes);
});

test("engineer can create, update and clear both timesheets in the assigned project",async()=>{
  const state=fixture();
  for(const value of [8,"В",""])assert.equal((await timesheet.POST(request("/api/timesheet","POST",{siteId:7,employeeId:10,workDate:"2026-10-30",value}))).status,200);
  assert.equal(state.marks.size,0);
  for(const values of [{productiveHours:8,downtimeHours:2},{productiveHours:7,downtimeHours:1},{clear:true}])assert.equal((await equipment.POST(request("/api/equipment","POST",{action:"save-timesheet-mark",siteId:7,equipmentId:11,workDate:"2026-10-30",...values}))).status,200);
  assert.equal(state.equipmentMarks.size,0);
  assert.equal(state.writes.filter(q=>q.sql.startsWith("INSERT INTO timesheet_marks")).length,2);
  assert.equal(state.writes.filter(q=>q.sql.startsWith("INSERT INTO equipment_timesheet_marks")).length,2);
});

test("engineer retains own employee and equipment profile updates",async()=>{
  const state=fixture();
  assert.equal((await data.PATCH(request("/api/data","PATCH",{action:"update-employee",employeeId:10,fullName:"Свой сотрудник",employmentType:"ОПР",department:"УСР",position:"Монтажник",projectSiteId:7}))).status,200);
  assert.equal((await equipment.POST(request("/api/equipment","POST",{action:"save-unit",siteId:7,id:11,projectSiteId:7,organization:"Организация",equipmentType:"Кран",brand:"Марка",model:"Модель",registrationNumber:"001"}))).status,200);
  assert.ok(state.writes.some(q=>q.sql.startsWith("UPDATE employees SET full_name")));
  assert.ok(state.writes.some(q=>q.sql.startsWith("UPDATE equipment_units SET identity_key")));
});

test("engineer can delete exclusively owned profiles while preserving other projects",async()=>{
  const state=fixture();
  assert.equal((await data.DELETE(request("/api/data?entity=employee&id=10","DELETE"))).status,200);
  assert.equal(state.employees[0].active,false);
  assert.equal(state.employees[2].active,true);
  assert.equal((await equipment.POST(request("/api/equipment","POST",{action:"delete-unit",siteId:7,id:11}))).status,200);
  assert.equal(state.units[0].active,false);
  assert.equal(state.units[2].active,true);
});

for(const action of ["update-employee","delete-employee","save-unit","delete-unit"])test(`${action} rechecks exclusive project scope under the profile row lock`,async()=>{
  const state=fixture();
  const records=action.endsWith("employee")?state.employees:state.units;
  state.beforeTransaction=()=>records[0].assignments.push({siteId:8,active:true});
  let response;
  if(action==="update-employee")response=await data.PATCH(request("/api/data","PATCH",{action,employeeId:10,fullName:"Устаревшая правка",employmentType:"ОПР",department:"УСР",position:"Монтажник",projectSiteId:7}));
  if(action==="delete-employee")response=await data.DELETE(request("/api/data?entity=employee&id=10","DELETE"));
  if(action==="save-unit")response=await equipment.POST(request("/api/equipment","POST",{action,siteId:7,id:11,projectSiteId:7,organization:"Организация",equipmentType:"Кран",model:"Устаревшая правка"}));
  if(action==="delete-unit")response=await equipment.POST(request("/api/equipment","POST",{action,siteId:7,id:11}));
  assert.equal(response.status,403);
  assert.equal(state.writes.length,0);
  assert.equal(records[0].active,true);
  assert.ok(state.queries.some(q=>q.sql.includes("FOR UPDATE")));
  assert.ok(state.queries.filter(q=>q.sql.includes("SELECT entity.id FROM")).length>=2);
});

test("a concurrently discovered equipment identity cannot overwrite another project's profile",async()=>{
  const state=fixture();
  state.beforeTransaction=()=>{state.identityUnit=11;state.units[0].assignments.push({siteId:8,active:true});};
  const response=await equipment.POST(request("/api/equipment","POST",{action:"save-unit",siteId:7,projectSiteId:7,organization:"Организация",equipmentType:"Кран",model:"Совпавшая новая запись"}));
  assert.equal(response.status,403);
  assert.equal(state.writes.length,0);
  assert.ok(state.queries.some(q=>q.sql.includes("identity_key")&&q.sql.includes("FOR UPDATE")));
});
