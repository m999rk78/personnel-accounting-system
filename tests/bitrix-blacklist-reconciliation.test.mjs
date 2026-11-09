import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as bitrix from '../app/bitrix24Sync.ts';
import {bitrixReviewUpdateIds} from '../app/bitrixReviewSelection.ts';

const scope={stageKeys:['На объекте','Черный список','Увольнения'],projectKeys:['QA7']};
const source=(bitrix24Id='B1',changes={})=>({bitrix24Id,fullName:'Исходное имя',employmentType:'ОПР',department:'УСР',position:'Монтажник',stageId:'BLACK',stageName:'Черный список',availabilityStatus:'blacklisted',projectKeys:[],sourceUpdatedAt:null,...changes});
const local=(id=1,changes={})=>({id,bitrix24Id:`B${id}`,fullName:'Исходное имя',employmentType:'ОПР',department:'УСР',position:'Монтажник',bitrix24Stage:'На объекте',availabilityStatus:'on_site',active:1,syncMissCount:0,siteId:7,...changes});
const readDeclarations=async(file,names)=>{
  const text=await readFile(new URL(`../app/server/data/${file}.ts`,import.meta.url),'utf8');
  const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  return names.map(name=>{const node=tree.statements.find(item=>ts.isFunctionDeclaration(item)&&item.name?.text===name);assert.ok(node,name);return node.getText(tree).replace(/^export\s+/,'');}).join('\n');
};
const reviewCode=await readDeclarations('bitrixReview',['buildBitrixInspection','createBitrixEmployee','resolveBitrixEmployeeSites','archiveTerminalBitrixEmployeeRecord','updateBitrixEmployeeRecord','updateBitrixEmployee','updateSelectedBitrixEmployees','deleteBitrixEmployee','linkBitrixEmployees']);
const syncCode=await readDeclarations('bitrixSync',['employeeProfileChanged','synchronizeBitrixEmployees']);

/** An isolated SQL boundary; any unexpected read or report/history mutation fails. */
function fixture(initial=[local()]){
  let state={employees:structuredClone(initial),assignments:initial.filter(row=>row.active).map(row=>({employeeId:row.id,siteId:7,active:1,endDate:null})),profiles:initial.map(row=>({employeeId:row.id,fullName:row.fullName,position:row.position,validTo:null})),periods:initial.map(row=>({employeeId:row.id,status:row.availabilityStatus,validTo:null})),checks:new Map(),reports:[{id:77,hours:8,note:'История отчёта'}],marks:[{id:88,hours:7,note:'Ручная отметка'}]};
  const queries=[],writes=[],validations=[];
  const db={prepare(sql){let values=[];const execute=()=>{
    queries.push({sql,values});
    if(sql.includes('STRING_AGG(DISTINCT assigned_site.name'))return state.employees.filter(row=>row.active||row.bitrix24Id).map(row=>({...row,projectNames:state.assignments.some(a=>a.employeeId===row.id&&a.active)?'QA7':null,projectCodes:'QA7'}));
    if(sql.startsWith('SELECT employee_id AS "employeeId", status'))return [...state.checks].filter(([id])=>values[0].includes(id)).map(([employeeId,row])=>({employeeId,...row}));
    if(sql.includes('FROM employees WHERE id = ? AND bitrix24_id = ? FOR UPDATE'))return state.employees.filter(row=>row.id===values[0]&&row.bitrix24Id===values[1]);
    if(sql.includes('FROM employees WHERE bitrix24_id IS NOT NULL'))return state.employees.filter(row=>row.bitrix24Id);
    if(sql.startsWith('SELECT id, full_name AS fullName FROM employees WHERE bitrix24_id IS NULL'))return state.employees.filter(row=>!row.bitrix24Id&&row.active);
    if(sql.includes('FROM employees WHERE active = 1 OR bitrix24_id IS NOT NULL'))return state.employees.filter(row=>row.active||row.bitrix24Id);
    if(sql.includes('FROM employees WHERE id = ?'))return state.employees.filter(row=>row.id===values[0]);
    if(sql.includes('FROM sites WHERE active = 1'))return [{id:7,name:'QA7',code:'QA7'}];
    if(sql.includes('FROM position_catalog'))return [{employmentType:'ОПР',department:'УСР',position:'Монтажник'}];
    if(sql.startsWith('SELECT employee_id AS employeeId FROM employee_profile_versions'))return state.profiles.filter(row=>!row.validTo);
    if(sql.includes('pg_try_advisory_xact_lock'))return [{locked:true}];
    writes.push({sql,values});
    if(sql.startsWith('INSERT INTO bitrix24_employee_check_states')){state.checks.set(values[0],{status:values[1],details:values[2],fingerprint:values[3],acknowledgedAt:state.checks.get(values[0])?.fingerprint===values[3]?state.checks.get(values[0]).acknowledgedAt:null});return [];}
    if(sql.startsWith('DELETE FROM bitrix24_employee_check_states')){state.checks.delete(values[0]);return [];}
    if(sql.startsWith('UPDATE employees SET bitrix24_stage = ?, availability_status = ?, active = 0')){const row=state.employees.find(row=>row.id===values[4]&&row.bitrix24Id===values[5]);if(row)Object.assign(row,{bitrix24Stage:values[0],availabilityStatus:values[1],active:0,siteId:null});return [];}
    if(sql.startsWith('INSERT INTO employees')){let row=state.employees.find(row=>row.bitrix24Id===values[0]);if(!row){row={id:100+state.employees.length,bitrix24Id:values[0]};state.employees.push(row);}Object.assign(row,{bitrix24Stage:values[1],availabilityStatus:values[2],syncError:values[5],syncMissCount:0,fullName:values[6],employmentType:values[7],department:values[8],position:values[9],siteId:values[10],active:values[11]});return [];}
    if(sql.startsWith('UPDATE employee_project_assignments')){for(const row of state.assignments)if(row.employeeId===values[0]&&row.active&&(!sql.includes('site_id NOT IN')||!values.slice(1).includes(row.siteId)))Object.assign(row,{active:0,endDate:row.endDate??'today'});return [];}
    if(sql.startsWith('INSERT INTO employee_project_assignments')){if(!state.assignments.some(row=>row.employeeId===values[0]&&row.siteId===values[1]&&row.active))state.assignments.push({employeeId:values[0],siteId:values[1],active:1,endDate:null});return [];}
    if(sql.startsWith('UPDATE employee_profile_versions')){for(const row of state.profiles)if(row.employeeId===values[1]&&!row.validTo)row.validTo=values[0];return [];}
    if(sql.startsWith('INSERT INTO employee_profile_versions')){state.profiles.push({employeeId:values[0],fullName:values[1],position:values[4],stage:values[5],validTo:null});return [];}
    if(sql.startsWith('UPDATE employee_availability_periods')){for(const row of state.periods)if(row.employeeId===values[1]&&!row.validTo)row.validTo=values[0];return [];}
    if(sql.startsWith('INSERT INTO employee_availability_periods')){state.periods.push({employeeId:values[0],status:values[1],validTo:null});return [];}
    if(sql.startsWith('INSERT INTO employee_sync_runs'))return [{id:1}];
    if(sql.startsWith('UPDATE employee_sync_runs')||sql.startsWith('INSERT INTO employee_sync_issues'))return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  };const statement={bind(...next){values=next;return statement;},async first(){return structuredClone(execute()[0]??null);},async all(){return {results:structuredClone(execute())};},async run(){const result=execute();return {results:result,meta:{changes:1,last_row_id:result[0]?.id??null}};}};return statement;},
    async batch(statements){return Promise.all(statements.map(statement=>statement.run()));},async readBatch(statements){return Promise.all(statements.map(statement=>statement.all()));},async transaction(callback){const old=structuredClone(state);try{return await callback(db);}catch(error){state=old;throw error;}}};
  const environment={...bitrix,bitrixReviewUpdateIds,env:{DB:db},projectOverrides:()=>({}),asPositiveInteger:value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null,
    selectBitrixEmployeesForImport:full=>bitrix.selectBitrixEmployeesForImport(full,scope),selectLinkedBitrixEmployeesForReview:(full,ids)=>bitrix.selectLinkedBitrixEmployeesForReview(full,ids,scope),
    validateEmployeeDirectoryValues:async(...args)=>validations.push(args),fetchBitrixEmployeeSnapshot:async()=>[],process:{env:{BITRIX24_SYNC_ENABLED:'true'}}};
  const compile=(code,names,extra={})=>{const deps={...environment,...extra};const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(deps),`${js};return {${names.join(',')}};`)(...Object.values(deps));};
  const api=compile(reviewCode,['buildBitrixInspection','createBitrixEmployee','updateBitrixEmployee','deleteBitrixEmployee','linkBitrixEmployees']);
  return {api,state:()=>structuredClone(state),queries,writes,validations,acknowledge(id){state.checks.get(id).acknowledgedAt='accepted';},sync:async full=>compile(syncCode,['synchronizeBitrixEmployees'],{fetchBitrixEmployeeSnapshot:async()=>full}).synchronizeBitrixEmployees()};
}

test('inspection reconciles only linked terminal cards, persists a dedicated warning and never acknowledges away blacklist',async()=>{
  const ui=fixture();const full=[source(),source('B2')];
  const first=await ui.api.buildBitrixInspection(full);
  assert.deepEqual(first.snapshot.map(row=>row.bitrix24Id),['B1']);assert.equal(first.response.totalDifferences,1);
  assert.equal(first.response.differences[0].kind,'blacklisted_in_bitrix');assert.deepEqual(first.response.updatableEmployeeIds,[1]);assert.deepEqual(first.suggestions,[]);
  assert.equal(ui.state().checks.get(1).status,'blacklisted_in_bitrix');ui.acknowledge(1);
  assert.equal((await ui.api.buildBitrixInspection(full)).response.differences[0].acknowledged,false);
});

test('blacklist apply archives an existing employee without HR fields, preserves profile/history and matches on the next inspection',async()=>{
  const ui=fixture(),before=ui.state();const full=[source('B1',{fullName:'',employmentType:'',department:'',position:''}),source('B2')];
  const result=await ui.api.updateBitrixEmployee(full,{employeeId:1,bitrix24Id:'B1'});
  assert.equal(result.updatedEmployee.name,'Исходное имя');assert.equal(result.totalDifferences,0);
  const state=ui.state();assert.equal(state.employees[0].active,0);assert.equal(state.employees[0].siteId,null);assert.equal(state.employees[0].availabilityStatus,'blacklisted');
  for(const field of ['fullName','employmentType','department','position'])assert.equal(state.employees[0][field],before.employees[0][field]);
  assert.equal(state.assignments[0].active,0);assert.equal(state.periods.at(-1).status,'blacklisted');assert.equal(state.checks.size,0);
  assert.deepEqual(state.reports,before.reports);assert.deepEqual(state.marks,before.marks);assert.deepEqual(ui.validations,[]);
  await ui.api.updateBitrixEmployee(full,{employeeId:1,bitrix24Id:'B1'});assert.equal(ui.state().periods.length,state.periods.length);
});

test('legacy archived identities are recognized and dismissal archives without relabelling as deleted',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'out_of_scope',bitrix24Stage:'Черный список'})]);
  assert.equal((await ui.api.buildBitrixInspection([source()])).response.differences[0].kind,'blacklisted_in_bitrix');
  await ui.api.updateBitrixEmployee([source()],{employeeId:1,bitrix24Id:'B1'});
  const blocked=await ui.api.buildBitrixInspection([source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']})]);
  assert.equal(blocked.response.totalDifferences,0);assert.deepEqual(blocked.suggestions,[]);
  const dismissed=fixture([local(1,{active:0,siteId:null,availabilityStatus:'out_of_scope'})]);
  const result=await dismissed.api.deleteBitrixEmployee([source('B1',{availabilityStatus:'dismissed',stageName:'Увольнения',fullName:''})],{employeeId:1,bitrix24Id:'B1'});
  assert.equal(result.totalDifferences,0);assert.equal(dismissed.state().employees[0].availabilityStatus,'dismissed');assert.equal(dismissed.state().employees[0].bitrix24Stage,'Увольнения');
});

test('sync archives linked blacklist with incomplete HR data, excludes unlinked terminal cards and cannot reactivate a previous blacklist',async()=>{
  const ui=fixture([local(),local(3,{active:0,siteId:null,availabilityStatus:'blacklisted',bitrix24Stage:'Черный список'})]),before=ui.state();
  await ui.sync([source('B1',{fullName:'',employmentType:'',department:'',position:''}),source('B2'),source('B3',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']})]);
  const state=ui.state();assert.deepEqual(state.employees.map(row=>row.bitrix24Id),['B1','B3']);
  const identityReads=ui.queries.filter(({sql})=>sql.includes('FROM employees WHERE bitrix24_id IS NOT NULL'));
  assert.match(identityReads[0].sql,/ORDER BY id FOR UPDATE/);assert.doesNotMatch(identityReads.at(-1).sql,/FOR UPDATE/);
  assert.equal(state.employees[0].active,0);assert.equal(state.employees[0].availabilityStatus,'blacklisted');assert.equal(state.employees[0].fullName,before.employees[0].fullName);
  assert.deepEqual(state.employees[1],before.employees[1]);assert.equal(state.assignments[0].active,0);
  assert.deepEqual(state.reports,before.reports);assert.deepEqual(state.marks,before.marks);
});

test('later missing or out-of-scope snapshots do not erase the non-rehire state',async()=>{
  for(const card of [null,source('B3',{availabilityStatus:'unknown',stageName:'Другая стадия'})]){
    const ui=fixture([local(),local(3,{active:0,siteId:null,availabilityStatus:'blacklisted',bitrix24Stage:'Черный список',syncMissCount:4})]);
    const previous=ui.state().employees[1];await ui.sync([source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']}),...(card?[card]:[])]);
    assert.deepEqual(ui.state().employees[1],previous);
  }
});

test('a stale direct dismissal action cannot downgrade an archived blacklist marker',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'blacklisted',bitrix24Stage:'Черный список'})]);
  const before=ui.state();
  await assert.rejects(ui.api.deleteBitrixEmployee([source('B1',{availabilityStatus:'dismissed',stageName:'Увольнения'})],{employeeId:1,bitrix24Id:'B1'}),/чёрном списке/);
  assert.deepEqual(ui.state(),before);assert.deepEqual(ui.writes,[]);
});

test('sync applies every linked termination status without HR validation and closes current assignments',async()=>{
  for(const availabilityStatus of ['dismissed','deleted']){
    const ui=fixture(),before=ui.state();
    await ui.sync([source('B1',{availabilityStatus,stageName:availabilityStatus==='dismissed'?'Увольнения':'Удалён',fullName:'',employmentType:'',department:'',position:''})]);
    const state=ui.state();assert.equal(state.employees[0].availabilityStatus,availabilityStatus);
    assert.equal(state.employees[0].active,0);assert.equal(state.employees[0].siteId,null);assert.equal(state.assignments[0].active,0);
    assert.equal(state.periods.at(-1).status,availabilityStatus);
    for(const field of ['fullName','employmentType','department','position'])assert.equal(state.employees[0][field],before.employees[0][field]);
    assert.deepEqual(state.reports,before.reports);assert.deepEqual(state.marks,before.marks);
  }
});

test('terminal cards cannot be first-created or linked to a different active employee',async()=>{
  const ui=fixture();
  await assert.rejects(ui.api.createBitrixEmployee([source('B2')],{bitrix24Id:'B2',positionId:1,projectSiteId:7}),/нельзя добавить/);
  await assert.rejects(ui.api.linkBitrixEmployees([source()],[{bitrix24Id:'B1',employeeId:1}]),/нельзя связывать/);
  assert.equal(ui.state().employees.length,1);assert.ok(ui.writes.every(({sql})=>!sql.startsWith('INSERT INTO employees')));
});

test('unrelated archived identities do not produce old missing warnings and inactive ordinary cards are not bulk-updatable',async()=>{
  const ui=fixture([local(),local(3,{active:0,siteId:null,availabilityStatus:'out_of_scope'}),local(4,{active:0,siteId:null,availabilityStatus:'deleted'})]);
  const result=await ui.api.buildBitrixInspection([source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']}),source('B3',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7'],position:'Сварщик'})]);
  assert.equal(result.response.differences.some(row=>row.bitrix24Id==='B4'),false);
  assert.equal(result.response.differences.some(row=>row.bitrix24Id==='B3'&&row.kind==='missing_locally'),false);
  assert.deepEqual(result.response.updatableEmployeeIds,[]);
  await assert.rejects(ui.api.updateBitrixEmployee([source('B3',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']})],{employeeId:3,bitrix24Id:'B3'}),/архивирован/);
  assert.equal(ui.state().employees[1].active,0);
});
