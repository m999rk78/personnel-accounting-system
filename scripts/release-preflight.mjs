// Production build against a disposable, explicitly acknowledged loopback database.
// Database settings are explicit; only an optional AG Grid UI license is read
// from local configuration. No production/Bitrix/email services are contacted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseEnv } from "node:util";
import { get as httpGet } from "node:http";
import pg from "pg";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.equal(process.env.RELEASE_TEST_ISOLATED, "true", "A disposable test database must be explicitly acknowledged.");
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.equal(databaseUrl.port, "55439", "Only the dedicated release-test container is supported.");
assert.equal(databaseUrl.pathname, "/personnel");
const origin = "http://127.0.0.1:3310";
const pool = new pg.Pool({ connectionString: databaseUrl.href, ssl: false, max: 2, connectionTimeoutMillis: 5000 });
const outputDirectory = await mkdtemp(join(tmpdir(), "personnel-release-preflight-"));
const localLicense = process.env.AG_GRID_LICENSE_KEY || parseEnv(await readFile(".env.local","utf8").catch(()=>"")).AG_GRID_LICENSE_KEY || "";
const metrics = { environment: { origin, postgres: "isolated Docker, 2 CPU / 2 GiB", synthetic: true, agGridLicenseConfigured:Boolean(localLicense) }, counts: {}, api: [], transfers: [], concurrency: [], pages: [], failures: [] };
let server;
let browser;
let serverLog = "";

async function seed() {
  const target = (await pool.query("SELECT current_database() AS name, current_user AS username")).rows[0];
  assert.deepEqual(target, { name: "personnel", username: "personnel" });
  const existing = (await pool.query("SELECT (SELECT COUNT(*) FROM employees)::int AS employees, (SELECT COUNT(*) FROM sites)::int AS sites, (SELECT COUNT(*) FROM app_users)::int AS users")).rows[0];
  if (process.argv.includes("--reuse-fixture")) {
    assert.equal(existing.employees,100000); assert.equal(existing.sites,100);
    const marker = (await pool.query("SELECT COUNT(*)::int AS count FROM sites WHERE code LIKE 'RELEASE-TEST-%'")).rows[0];
    assert.equal(marker.count,100,"Only this script's isolated fixture may be reused.");
    metrics.counts = existing;
    return;
  }
  assert.deepEqual(existing, { employees: 0, sites: 0, users: 0 }, "Seeding is permitted only into a fresh disposable database.");
  await pool.query(`
    INSERT INTO sites(id,name,code) SELECT n,'Нагрузочный проект '||n,'RELEASE-TEST-'||n FROM generate_series(1,100) n;
    INSERT INTO app_users(id,full_name,email,role,assigned_site_id) VALUES (1,'Тестовый прораб','foreman@release.invalid','foreman',1);
    INSERT INTO employees(id,full_name,employment_type,department,position,source)
      SELECT n,'Сотрудник '||lpad(n::text,7,'0'),CASE WHEN n%5=0 THEN 'ИТР' ELSE 'ОПР' END,'УСР',
        CASE WHEN n%50=0 THEN 'Мастер участка строительных конструкций' ELSE 'Монтажник' END,'manual'
      FROM generate_series(1,100000) n;
    INSERT INTO employee_project_assignments(employee_id,site_id,start_date)
      SELECT n,1+(n-1)%100,DATE '2026-01-01' FROM generate_series(1,100000) n;
    INSERT INTO shifts(id,site_id,name) SELECT n,n,'день' FROM generate_series(1,100) n;
    INSERT INTO zones(id,site_id,name) SELECT n,n,'Зона проекта '||n FROM generate_series(1,100) n;
    INSERT INTO main_work_types(id,site_id,name) SELECT n,n,'Монтаж' FROM generate_series(1,100) n;
    INSERT INTO subwork_types(id,site_id,name,main_work_type_id) SELECT n,n,'Установка конструкций',n FROM generate_series(1,100) n;
    INSERT INTO masters(id,site_id,name) SELECT n,n,'Мастер '||n FROM generate_series(1,100) n;
    INSERT INTO placement_entries(site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,position_snapshot,employee_name_snapshot,employment_type_snapshot,department_snapshot,master_name_snapshot,created_by,responsible_user_id)
      SELECT 1+(e-1)%100,CASE WHEN batch=4 THEN DATE '2026-10-29' ELSE DATE '2026-01-01'+batch*60 END,e,
        1+(e-1)%100,1+(e-1)%100,1+(e-1)%100,1+(e-1)%100,1+(e-1)%100,6,'Монтажник',
        'Сотрудник '||lpad(e::text,7,'0'),CASE WHEN e%5=0 THEN 'ИТР' ELSE 'ОПР' END,'УСР','Мастер '||(1+(e-1)%100),'release-test',1
      FROM generate_series(1,100000) e CROSS JOIN generate_series(0,4) batch;
    INSERT INTO timesheet_marks(site_id,employee_id,work_date,hours,created_by)
      SELECT 1+(e-1)%100,e,DATE '2026-10-27'+day,8,'release-test'
      FROM generate_series(1,100000) e CROSS JOIN generate_series(0,2) day;
    INSERT INTO equipment_units(id,site_id,identity_key,organization,equipment_type,brand,model,registration_number)
      SELECT n,1+(n-1)%100,'release-unit-'||n,'Тестовая организация','Кран','Тест','Модель '||n,'TEST-'||n FROM generate_series(1,20000) n;
    INSERT INTO equipment_project_assignments(equipment_id,site_id)
      SELECT n,1+(n-1)%100 FROM generate_series(1,20000) n;
    INSERT INTO equipment_entries(site_id,work_date,equipment_id,shift_id,zone_id,main_work_type_id,subwork_type_id,hours,created_by,responsible_user_id)
      SELECT 1+(e-1)%100,DATE '2026-10-01'+day,e,1+(e-1)%100,1+(e-1)%100,1+(e-1)%100,1+(e-1)%100,8,'release-test',1
      FROM generate_series(1,20000) e CROSS JOIN generate_series(0,14) day;
    INSERT INTO equipment_timesheet_marks(site_id,equipment_id,work_date,productive_hours,downtime_hours,created_by)
      SELECT 1+(e-1)%100,e,DATE '2026-10-29',8,0,'release-test' FROM generate_series(1,20000) e;
    INSERT INTO audit_events(actor_name,actor_role,category,action_key,entity_type,summary,created_at)
      SELECT 'Нагрузочный тест','superadmin','reports','release-test','entry','Синтетическое событие '||n,now()-n*INTERVAL '1 second' FROM generate_series(1,200000) n;
  `);
  // Explicit IDs above must not collide with subsequent genuine API inserts.
  for (const table of ["sites", "app_users", "employees", "shifts", "zones", "main_work_types", "subwork_types", "masters", "equipment_units"]) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT MAX(id) FROM ${table}))`);
  }
  await pool.query("ANALYZE");
  metrics.counts = { employees: 100000, projects: 100, personnelEntries: 500000, personnelMarks: 300000, equipmentUnits: 20000, equipmentEntries: 300000, equipmentMarks: 20000, auditEvents: 200000 };
  console.log("Seeded isolated production-schema dataset:", metrics.counts);
}

async function start() {
  server = spawn(process.execPath, ["dist/standalone/server.js"], {
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: "3310", DATABASE_URL: databaseUrl.href, DATABASE_SSL: "disable", DATABASE_POOL_SIZE: "5", DATABASE_RUNTIME_BOOTSTRAP: "false", APP_ORIGIN: origin, PUBLIC_APP_ORIGIN: origin, AG_GRID_LICENSE_KEY: localLicense },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { serverLog += chunk; });
  server.stderr.on("data", chunk => { serverLog += chunk; });
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${serverLog}`);
    try { if ((await fetch(`${origin}/login`)).ok) return; } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${serverLog}`);
}

let cookie;
async function get(path, expected = 200) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${response.status} ${text.slice(0,300)}`);
  return { path, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

async function apiChecks() {
  for (const path of ["/api/data?scope=navigation", "/api/timesheet?siteId=1&month=2026-10", "/api/equipment?siteId=1&date=2026-10-29&month=2026-10", "/api/personnel-report?siteId=1", "/api/audit-log", "/api/access-rights"]) await get(path,401);
  const credentials = { fullName: "Администратор нагрузочной проверки", email: "admin@release.invalid", password: "Local-test-only-2026!" };
  const auth = await fetch(`${origin}/api/auth/${process.argv.includes("--reuse-fixture")?"login":"bootstrap"}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
  assert.equal(auth.status,process.argv.includes("--reuse-fixture")?200:201,await auth.text());
  cookie = auth.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  // Same-site validation must still run with a valid authenticated cookie.
  const rejected = await fetch(`${origin}/api/personnel-report`, { method: "POST", headers: { Origin: "https://not-our-site.invalid", Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(rejected.status,403);

  const paths = [
    "/api/data?scope=navigation&siteId=1", "/api/data?scope=workspace&siteId=1&date=2026-10-29",
    ...["employees","positions","users","projects","projectEmployees","directories"].map(section=>`/api/data?scope=settings&section=${section}&siteId=1&date=2026-10-29`),
    "/api/data?scope=settings&siteId=1&date=2026-10-29",
    "/api/timesheet?siteId=1&month=2026-10",
    "/api/equipment?siteId=1&date=2026-10-29&month=2026-10&scope=project&view=timesheet&section=month",
    "/api/equipment?siteId=1&date=2026-10-29&month=2026-10&scope=global&view=registry&section=registry",
    "/api/equipment?siteId=1&date=2026-10-29&month=2026-10&scope=assignments&view=project&section=project",
    "/api/personnel-report?siteId=1&all=true", "/api/audit-log?limit=500", "/api/access-rights",
    "/api/equipment-report?siteId=1&all=true",
  ];
  for (const path of paths) {
    const result = await get(path);
    metrics.api.push({ path: result.path, ms: result.ms, bytes: result.bytes });
    if(path.includes("section=positions")) { assert.equal(result.body.employees.length,0); assert.equal(result.body.users.length,0); }
    if(path.includes("section=users")) assert.equal(result.body.employees.length,0);
    if(path.includes("section=projects")) {
      assert.equal(result.body.employees.length,0); assert.equal(result.body.users.length,0);
      assert.equal(result.body.projectStats.find(stats=>stats.siteId===1).employeeCount,1000);
      assert.equal(result.body.projectStats.find(stats=>stats.siteId===1).foremanCount,1);
    }
    if(path.includes("scope=workspace")) assert.ok(result.body.employeeUsage.length<=1000,"Hours checks must not download employees from unrelated projects");
  }
  const catalog = paths.find(path=>path.includes("section=employees"));
  const transfer = await new Promise((resolve,reject)=>{
    const started=performance.now();
    const request=httpGet(`${origin}${catalog}`,{headers:{Cookie:cookie,"Accept-Encoding":"gzip"}},response=>{
      let bytes=0;
      response.on("data",chunk=>{bytes+=chunk.length;});
      response.on("end",()=>resolve({path:catalog,wireBytes:bytes,encoding:response.headers["content-encoding"],ms:Math.round(performance.now()-started)}));
      response.on("error",reject);
    });
    request.on("error",reject);
  });
  assert.equal(transfer.encoding,"gzip");
  const uncompressed=metrics.api.find(item=>item.path===catalog).bytes;
  assert.ok(transfer.wireBytes<uncompressed/5,"Large catalogs must not cross the network uncompressed");
  metrics.transfers.push({...transfer,uncompressedBytes:uncompressed});
  // Project-scoped payloads must still count hours from OTHER sites, and preserve
  // archived staff/equipment whose old monthly marks and reports remain valid.
  const cross = await pool.query(`INSERT INTO placement_entries(site_id,work_date,employee_id,shift_id,zone_id,main_work_type_id,subwork_type_id,master_id,hours,position_snapshot,employee_name_snapshot,employment_type_snapshot,created_by,responsible_user_id)
    VALUES(2,'2026-10-29',1,2,2,2,2,2,2,'Монтажник','Сотрудник 0000001','ОПР','release-test',1) RETURNING id`);
  const crossId = cross.rows[0].id;
  assert.ok(Number.isSafeInteger(crossId)&&crossId>0);
  try {
    await pool.query("UPDATE employees SET active=0 WHERE id=1; UPDATE employee_project_assignments SET active=0 WHERE employee_id=1; UPDATE equipment_units SET active=0 WHERE id=1; UPDATE equipment_project_assignments SET active=0 WHERE equipment_id=1");
    const usage = (await get(paths[1])).body.employeeUsage.find(employee=>employee.employeeId===1);
    assert.equal(usage.hours,8,"Scoped usage must preserve cross-project daily-hour conflicts");
    assert.ok((await get(paths[9])).body.employees.some(employee=>employee.id===1),"Archived employee must remain in historical timesheets");
    assert.ok((await get(paths[10])).body.units.some(unit=>unit.id===1),"Archived equipment must remain in historical timesheets");
  } finally {
    await pool.query("UPDATE employees SET active=1 WHERE id=1; UPDATE employee_project_assignments SET active=1 WHERE employee_id=1; UPDATE equipment_units SET active=1 WHERE id=1; UPDATE equipment_project_assignments SET active=1 WHERE equipment_id=1");
    await pool.query("DELETE FROM placement_entries WHERE id=$1 AND created_by='release-test'",[crossId]);
  }
  const endpoints = [paths[0], paths[3], paths[9], paths[10], paths[13], paths[14]];
  const started = performance.now();
  const responses = await Promise.all(Array.from({length:40},(_,index)=>get(endpoints[index%endpoints.length])));
  const times = responses.map(item=>item.ms).sort((a,b)=>a-b);
  metrics.concurrency.push({ requests:40, databasePool:5, wallMs:Math.round(performance.now()-started), p50:times[19], p95:times[37], max:times.at(-1) });
  console.table(metrics.api.map(item=>({path:item.path,ms:item.ms,kib:Math.round(item.bytes/1024)})));
  console.log("Authenticated HTTP concurrency:",metrics.concurrency);
  console.log("Catalog transfer:",metrics.transfers);

  // Exercise real authorization, not just visibility/mocked API flags.
  await pool.query(`UPDATE app_users foreman SET password_hash=admin.password_hash,password_salt=admin.password_salt,password_iterations=admin.password_iterations
    FROM app_users admin WHERE foreman.id=1 AND admin.email='admin@release.invalid'`);
  const login=await fetch(`${origin}/api/auth/login`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email:"foreman@release.invalid",password:credentials.password})});
  assert.equal(login.status,200,await login.text());
  const adminCookie=cookie;
  cookie=login.headers.get("set-cookie").split(";")[0];
  try {
    for(const path of ["/api/data?scope=settings&section=employees&siteId=1","/api/data?scope=settings&section=users&siteId=1","/api/access-rights","/api/audit-log","/api/timesheet?siteId=1&month=2026-10","/api/personnel-report?siteId=2&all=true"]) await get(path,403);
    const project=(await get("/api/data?scope=settings&section=projectEmployees&siteId=1")).body;
    assert.equal(project.employees.length,0); assert.equal(project.users.length,0);
    assert.equal(project.projectEmployees.length,1000);
  } finally {cookie=adminCookie;}
}

async function uiChecks() {
  const { chromium } = await import(process.argv[2] ? `${process.argv[2]}/index.mjs` : "playwright");
  browser = await chromium.launch({ channel:"chrome",headless:true });
  const context = await browser.newContext({viewport:{width:1440,height:900}});
  const separator = cookie.indexOf("=");
  await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:origin}]);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror",error=>metrics.failures.push({type:"browser",message:error.message}));
  page.on("console",message=>{ if(message.type()==="error" && /Minified React error|Hydration|AG Grid: error|Uncaught/i.test(message.text())) metrics.failures.push({type:"console",path:page.url(),message:message.text()}); });
  await page.addInitScript(()=>{
    window.__longTasks=[];
    new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(entry=>({duration:entry.duration,start:entry.startTime})))).observe({type:"longtask",buffered:true});
  });
  const screens = [
    ["/reports/workers","Отчёт персонала"],
    ["/reports/equipment","Отчёт техники"],
    ["/timesheets/workers?month=2026-10","Табель рабочих"],
    ["/timesheets/equipment?month=2026-10","Табель техники"],
    ["/settings/general","Общие настройки"], ["/settings/project","Настройки проекта"],
    ["/settings/general/employees","Сотрудники"], ["/settings/general/equipment","Реестр техники"],
    ["/settings/general/positions","Список должностей"], ["/settings/general/users","Пользователи системы"],
    ["/settings/general/projects","Проекты"], ["/settings/general/activity","Журнал действий"],
    ["/settings/general/access","Права доступа"], ["/settings/project/employees","Сотрудники проекта"],
    ["/settings/project/equipment","Техника проекта"], ["/settings/project/zones","Зоны"],
    ["/settings/project/work-types","Виды и подвиды работ"], ["/settings/project/subwork-types","Виды и подвиды работ"],
    ["/settings/project/masters","Мастера"],
  ];
  for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    for (const [path,title] of screens) {
      const started = performance.now();
      try {
        const response = await page.goto(`${origin}${path}`);
        assert.equal(response.status(),200);
        await page.getByRole("heading",{name:title,exact:true}).first().waitFor();
        await page.waitForLoadState("networkidle");
        await page.waitForFunction(()=>!document.querySelector('[role="status"]')?.textContent?.match(/Загружа|Проверяем/));
        // Wait for async grid/data completion, not just the HTML shell's title.
        await page.waitForFunction(()=>!document.querySelector('.table-workspace-loading,.personnel-report-loading,.auth-loading'));
        await page.waitForTimeout(200);
        assert.equal(await page.getByRole("heading",{name:title,exact:true}).first().isVisible(),true,"The actual screen must remain visible after loading, not just its initial shell");
        const errors = await page.locator(".message.error").allTextContents();
        assert.deepEqual(errors,[],`${path}: error banner`);
        const layout = await page.evaluate(()=>({
          width:innerWidth,documentWidth:document.documentElement.scrollWidth,
          dom:document.querySelectorAll("*").length,cells:document.querySelectorAll("td,.ag-cell").length,
          mountedRows:document.querySelectorAll("tbody tr,.ag-center-cols-container .ag-row").length,
          longTasks:window.__longTasks.length,maxLongTaskMs:Math.round(Math.max(0,...window.__longTasks.map(task=>task.duration))),
        }));
        assert.ok(layout.documentWidth<=viewport.width+2,`${path}: page overflows horizontally (${layout.documentWidth})`);
        assert.ok(layout.cells<12000,`${path}: missing table virtualization`);
        assert.match(await page.title(),/^Ресурсный отчёт \| /);
        metrics.pages.push({path,viewport:viewport.width,ms:Math.round(performance.now()-started),...layout});
        if(viewport.width===1440 && ["Сотрудники","Табель рабочих","Виды и подвиды работ"].includes(title)) await page.screenshot({path:join(outputDirectory,`${screens.findIndex(screen=>screen[0]===path)}-desktop.png`),fullPage:true});
      } catch(error) {
        metrics.failures.push({type:"page",path,viewport:viewport.width,message:error.message});
        await page.screenshot({path:join(outputDirectory,`failure-${metrics.failures.length}.png`),fullPage:true});
      }
    }
  }
  await context.close();
}

try {
  await seed();
  await start();
  await apiChecks();
  await uiChecks();
} catch(error) {
  metrics.failures.push({type:"fatal",message:error.stack});
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
  if(server && server.exitCode===null) await Promise.race([new Promise(resolve=>server.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
  await pool.end();
  await writeFile(join(outputDirectory,"results.json"),JSON.stringify(metrics,null,2));
  await writeFile(join(outputDirectory,"server.log"),serverLog);
  console.log("Results:",outputDirectory);
  console.table(metrics.pages);
  console.log("Failures:",metrics.failures);
  if(metrics.failures.length) process.exitCode=1;
}
