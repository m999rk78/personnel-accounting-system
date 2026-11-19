import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

process.env.NODE_ENV = "production";
delete process.env.DATABASE_RUNTIME_BOOTSTRAP;
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const boundaryUrl = asModule(`export let database;
  export function configure(db) { database = db; }
  export const getDatabase = () => database;
  export const getAuthUser = async () => ({id:9,fullName:'Инженер',role:'engineer'});
`);
const boundary = await import(boundaryUrl);
let code = ts.transpileModule(await readFile(new URL("../app/auditLog.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
code = code.replaceAll('"../db/client"', JSON.stringify(boundaryUrl)).replaceAll('"./auth"', JSON.stringify(boundaryUrl));
const audit = await import(asModule(code));

function fixture() {
  const events = [], reads = [];
  const employees = [{id:7,fullName:"Иван Старый",employmentType:"ОПР",department:"УСР",position:"Монтажник",availabilityStatus:"on_site",projectSiteId:2}, {id:8,fullName:"Пётр",employmentType:"ОПР",department:"УСР",position:"Монтажник",availabilityStatus:"on_site",projectSiteId:3}];
  const sites = [{id:2,name:"Объект А"},{id:3,name:"Объект Б"}];
  const assignments = [{entityId:7,siteId:2,siteName:"Объект А",startDate:"2026-11-01",endDate:null}];
  const tables = {
    employee_project_assignments: assignments,
    employees,
    sites,
    placement_entries: [{id:501,siteId:2,workDate:"2026-11-18",entityId:7,label:"Историческое имя"}],
    personnel_report_rows: [{id:23,reportId:17,siteId:2,workDate:"2026-11-18",entityId:8,label:"Пётр"}],
    zones: [{id:55,name:"Участок 55",siteId:2}],
  };
  boundary.configure({ prepare(sql) {
    let values = [];
    return { bind(...next) { values = next; return this; }, async first() {
      reads.push({sql,values});
      if (sql.includes("SELECT name FROM sites")) return sites.find(site => site.id === values[0]) ?? null;
      return null;
    }, async all() {
      reads.push({sql,values});
      const table = Object.keys(tables).find(name => new RegExp(`FROM ${name}\\b`).test(sql));
      const rows = (tables[table] ?? []).filter(row => Array.isArray(values[0]) && values[0].includes(row.entityId && table === "employee_project_assignments" ? row.entityId : row.id));
      return {results: structuredClone(rows)};
    }, async run() {
      assert.match(sql, /INSERT INTO audit_events/);
      events.push(values);
      return {meta:{changes:1}};
    } };
  } });
  return { events, reads, employees };
}
const request = (path, payload, method="POST") => new Request(`http://localhost${path}`, {method,headers:{"content-type":"application/json"},body:JSON.stringify(payload)});

test("employee transfer audit freezes old identity, original assignments and target labels, with secrets redacted", async () => {
  const h = fixture();
  const payload = {action:"update-employee",employeeId:7,fullName:"Иван Новый",employmentType:"ОПР",department:"УСР",position:"Сварщик",projectSiteId:3,password:"never save"};
  await audit.withAuditTrail(request("/api/data",payload,"PATCH"), async () => {
    h.employees[0].fullName = payload.fullName;
    h.employees[0].projectSiteId = 3;
    return Response.json({ok:true});
  });
  const event = h.events[0], after = JSON.parse(event[11]);
  assert.equal(event[7],3);
  assert.equal(event[8],"Объект Б");
  assert.equal(event[10],"null","Legacy catalog beforeData remains hidden and separate");
  assert.equal(after.requested.password,undefined);
  assert.equal(after.context.before.fullName,"Иван Старый");
  assert.equal(after.context.before.projectSiteId,2);
  assert.deepEqual(after.context.before.assignments,[{siteId:2,siteName:"Объект А",startDate:"2026-11-01",endDate:null}]);
  assert.deepEqual(after.context.references.map(({kind,id,label})=>({kind,id,label})).sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),[
    {kind:"employee",id:7,label:"Иван Старый"}, {kind:"project",id:2,label:"Объект А"}, {kind:"project",id:3,label:"Объект Б"},
  ]);
  assert.ok(h.reads.every(({sql})=>!/FROM (placement_entries|personnel_reports|equipment_entries)\b/.test(sql)));
  assert.ok(h.reads.every(({sql})=>!/password|token|secret|SELECT \*/i.test(sql)));
});

test("bulk employee deletion retains names with a bounded batch, and denied mutation creates no event",async()=>{
  const h=fixture();
  await audit.withAuditTrail(request("/api/data?entity=employee",{ids:[7,8]},"DELETE"),async()=>Response.json({ok:true,count:2}));
  const context=JSON.parse(h.events[0][11]).context;
  assert.deepEqual(context.before.employees.map(row=>row.fullName),["Иван Старый","Пётр"]);
  assert.equal(context.before.employees[0].assignments[0].startDate,"2026-11-01");
  assert.equal(h.reads.filter(({sql})=>/FROM employees\b/.test(sql)).length,1);
  await audit.withAuditTrail(request("/api/data?entity=employee",{ids:[7]},"DELETE"),async()=>Response.json({error:"Нет доступа"},{status:403}));
  assert.equal(h.events.length,1);
});

test("reordering report rows snapshots the exact row token and entity instead of treating report IDs as employee IDs",async()=>{
  const h=fixture();
  const moving="2026-11-18/approved-501", target="2026-11-18/report-17-23";
  await audit.withAuditTrail(request("/api/table-order",{scope:"personnel-report-rows",siteId:2,movingIds:[moving],placement:"after",targetId:target}),async()=>Response.json({ids:[target,moving]}));
  const context=JSON.parse(h.events[0][11]).context;
  assert.deepEqual(context.rowLabels,[
    {kind:"employee",id:moving,entityId:7,label:"Историческое имя",siteId:2,workDate:"2026-11-18"},
    {kind:"employee",id:target,entityId:8,label:"Пётр",siteId:2,workDate:"2026-11-18"},
  ]);
  assert.equal(context.references.find(row=>row.kind==="employee"&&row.id===7).label,"Историческое имя");
  assert.deepEqual(h.reads.find(({sql})=>/FROM employees\b/.test(sql)).values,[[7,8]]);
});

test("created employee receives a stable link identity from the successful response",async()=>{
  const h=fixture();
  await audit.withAuditTrail(request("/api/data",{action:"create-employee",fullName:"Новый сотрудник",projectSiteId:3,employeeId:7}),async()=>Response.json({id:99},{status:201}));
  assert.equal(h.events[0][6],"99");
  assert.ok(JSON.parse(h.events[0][11]).context.references.some(row=>row.kind==="employee"&&row.id===99&&row.label==="Новый сотрудник"));
  assert.ok(h.reads.every(({sql})=>!/FROM employees\b/.test(sql)),"An ignored employeeId on creation cannot expose another employee's snapshot");
});

test("directory snapshots use the directory ID, never the numeric project ID or ignored payload identifiers",async()=>{
  const h=fixture();
  await audit.withAuditTrail(request("/api/data",{action:"update-directory",entity:"zone",siteId:2,directoryId:55,name:"Новое название",employeeId:7,ownerUserId:99},"PATCH"),async()=>Response.json({ok:true}));
  const event=h.events[0], context=JSON.parse(event[11]).context;
  assert.equal(event[6],"55");
  assert.equal(context.before.id,55);
  assert.equal(context.before.name,"Участок 55");
  assert.deepEqual(h.reads.find(({sql})=>/FROM zones\b/.test(sql)).values,[[55]]);
  assert.ok(h.reads.every(({sql})=>!/FROM (employees|app_users)\b/.test(sql)));
  await audit.withAuditTrail(request("/api/data?entity=directory&kind=zone&id=55&siteId=2",{},"DELETE"),async()=>Response.json({ok:true}));
  assert.equal(JSON.parse(h.events[1][11]).context.before.name,"Участок 55");
});

test("an unavailable enrichment lookup never loses a successful audit event",async()=>{
  const events=[];
  boundary.configure({prepare(sql){
    if(!sql.includes("INSERT INTO audit_events")) throw new Error("Reference lookup unavailable");
    return {bind(...values){return {async run(){events.push(values);return {meta:{changes:1}};}};}};
  }});
  const original=console.error, errors=[];
  console.error=(...args)=>errors.push(args);
  try {
    const response=await audit.withAuditTrail(request("/api/data",{action:"update-employee",employeeId:7,fullName:"Иван"},"PATCH"),async()=>Response.json({ok:true}));
    assert.equal(response.status,200);
    assert.equal(events.length,1);
    assert.equal(JSON.parse(events[0][11]).context,undefined);
    assert.ok(errors.some(([message])=>message==="Audit context lookup failed"));
  } finally {console.error=original;}
});

test("workflow actions resolve only their accepted row container, not ignored identifiers",async()=>{
  const h=fixture();
  await audit.withAuditTrail(request("/api/personnel-report",{action:"save",siteId:2,workDate:"2026-11-18",rows:[],employeeId:7,entries:[{employeeId:8}],updates:[{employeeId:7}]}),async()=>Response.json({report:{id:19}}));
  assert.ok(h.reads.every(({sql})=>!/FROM employees\b/.test(sql)));
  await audit.withAuditTrail(request("/api/personnel-report",{action:"change-date",reportId:19,siteId:2,workDate:"2026-11-17",row:{employeeId:7},rows:[{employeeId:8}]}),async()=>Response.json({report:{id:19}}));
  assert.ok(h.reads.every(({sql})=>!/FROM employees\b/.test(sql)));
  assert.equal(h.events.length,2);
});
