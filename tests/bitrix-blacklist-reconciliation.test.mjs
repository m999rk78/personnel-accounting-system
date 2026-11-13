import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
const reviewCode=await readDeclarations('bitrixReview',['officeTransferFingerprint','assertBitrixEmployeeNotInCentralOffice','buildBitrixInspection','createBitrixEmployee','resolveBitrixEmployeeSites','legacyTerminalCandidates','archiveTerminalBitrixEmployeeRecord','requireOfficeTransferConfirmation','moveBitrixEmployeeToCentralOffice','updateBitrixEmployeeRecord','updateBitrixEmployee','updateSelectedBitrixEmployees','deleteBitrixEmployee','linkBitrixEmployees']);
const syncCode=await readDeclarations('bitrixSync',['employeeProfileChanged','synchronizeBitrixEmployees']);

/** An isolated SQL boundary; any unexpected read or report/history mutation fails. */
function fixture(initial=[local()],{failActiveUpdate=false,failLinkAttach=false,initialProfiles=true,reviewScope=scope}={}){
  let state={employees:structuredClone(initial),assignments:initial.filter(row=>row.active&&row.siteId).map(row=>({employeeId:row.id,siteId:row.siteId,active:1,endDate:null})),profiles:initialProfiles?initial.map(row=>({employeeId:row.id,fullName:row.fullName,position:row.position,validTo:null})):[],periods:initial.map(row=>({employeeId:row.id,status:row.availabilityStatus,validTo:null})),checks:new Map(),reports:[{id:77,hours:8,note:'История отчёта'}],marks:[{id:88,hours:7,note:'Ручная отметка'}]};
  const queries=[],writes=[],validations=[];
  const db={prepare(sql){let values=[];const execute=()=>{
    queries.push({sql,values});
    if(sql.includes('STRING_AGG(DISTINCT assigned_site.name'))return state.employees.filter(row=>row.active||row.bitrix24Id).map(row=>({
      ...row,projectNames:state.assignments.filter(a=>a.employeeId===row.id&&a.active).map(a=>`QA${a.siteId}`).join('|||')||null,
      projectCodes:state.assignments.filter(a=>a.employeeId===row.id&&a.active).map(a=>`QA${a.siteId}`).join('|||')||null,
      hasProjectHistory:state.assignments.some(a=>a.employeeId===row.id),
      archivedCheckStatus:row.active===0?state.checks.get(row.id)?.status??null:null,
    }));
    if(sql.startsWith('SELECT employee_id AS "employeeId", status'))return [...state.checks].filter(([id])=>values[0].includes(id)).map(([employeeId,row])=>({employeeId,...row}));
    if(sql.startsWith('SELECT fingerprint FROM bitrix24_employee_check_states')){
      const warning=state.checks.get(values[0]);
      return warning?.status==='mismatch'&&!warning.acknowledgedAt?[warning]:[];
    }
    if(sql.includes('LEFT JOIN bitrix24_employee_check_states check_state')&&sql.includes('WHERE e.id = ANY(?)'))return state.employees
      .filter(row=>values[0].includes(row.id)&&(row.active||(sql.includes("OR e.availability_status = 'central_office'")&&row.availabilityStatus==='central_office'
        &&state.checks.get(row.id)?.fingerprint.startsWith('office_transfer:'))
        ||(sql.includes("OR check_state.status = 'blacklisted_in_bitrix'")&&state.checks.get(row.id)?.status==='blacklisted_in_bitrix')))
      .map(row=>({...row,checkStatus:state.checks.get(row.id)?.status??null,acknowledgedAt:state.checks.get(row.id)?.acknowledgedAt??null}));
    if(sql.includes('FROM employees WHERE id = ? AND bitrix24_id = ? AND active = 1 FOR UPDATE'))return state.employees.filter(row=>row.id===values[0]&&row.bitrix24Id===values[1]&&row.active);
    if(sql.includes('FROM employees WHERE id = ? AND bitrix24_id = ? FOR UPDATE'))return state.employees.filter(row=>row.id===values[0]&&row.bitrix24Id===values[1])
      .map(row=>({...row,hasProjectHistory:state.assignments.some(a=>a.employeeId===row.id)}));
    if(sql.includes('FROM employees WHERE id = ANY(?::integer[]) ORDER BY id FOR UPDATE'))return state.employees.filter(row=>values[0].includes(row.id)).sort((a,b)=>a.id-b.id);
    if(sql.includes('FROM employees WHERE bitrix24_id IS NOT NULL'))return state.employees.filter(row=>row.bitrix24Id);
    if(sql.startsWith('SELECT id, full_name AS fullName FROM employees WHERE bitrix24_id IS NULL'))return state.employees.filter(row=>!row.bitrix24Id&&row.active);
    if(sql.startsWith('SELECT id FROM employees WHERE full_name = ? AND id <> ? AND active = 1'))return state.employees.filter(row=>row.fullName===values[0]&&row.id!==values[1]&&row.active);
    if(sql.includes('FROM employees WHERE active = 1 OR bitrix24_id IS NOT NULL'))return state.employees.filter(row=>row.active||row.bitrix24Id);
    if(sql.includes('FROM employees WHERE id = ?'))return state.employees.filter(row=>row.id===values[0]);
    if(sql.includes('FROM sites WHERE active = 1'))return [{id:7,name:'QA7',code:'QA7'},{id:8,name:'QA8',code:'QA8'}];
    if(sql.includes('FROM position_catalog'))return [{employmentType:'ОПР',department:'УСР',position:'Монтажник'}];
    if(sql.startsWith('SELECT employee_id AS employeeId FROM employee_profile_versions'))return state.profiles.filter(row=>!row.validTo);
    if(sql.includes('pg_try_advisory_xact_lock'))return [{locked:true}];
    writes.push({sql,values});
    if(sql.startsWith('INSERT INTO bitrix24_employee_check_states')&&sql.includes('AS observation')){
      const [checkedAt,ids,bitrixIds,statuses,details,fingerprints]=values;
      assert.match(sql,/WHERE employee.active = 0.*ORDER BY employee.id FOR UPDATE OF employee/s);
      for(const [index,id] of ids.entries()){
        const row=state.employees.find(employee=>employee.id===id&&employee.active===0&&employee.bitrix24Id===bitrixIds[index]);
        const status=statuses[index],previous=state.checks.get(id);
        if(!row||['deleted','blacklisted'].includes(row.availabilityStatus)||['blacklisted_in_bitrix',status].includes(previous?.status))continue;
        state.checks.set(id,{status,details:details[index],fingerprint:fingerprints[index],checkedAt,acknowledgedAt:null,acknowledgedBy:null});
      }
      return [];
    }
    if(sql.startsWith('INSERT INTO bitrix24_employee_check_states')){
      const [id,status,details,fingerprint]=values;
      const previous=state.checks.get(id);
      const unchanged=status!=='blacklisted_in_bitrix'&&previous?.fingerprint===fingerprint;
      state.checks.set(id,{status,details,fingerprint,acknowledgedAt:unchanged?previous.acknowledgedAt:null,acknowledgedBy:unchanged?previous.acknowledgedBy:null});
      return [];
    }
    if(sql.startsWith('DELETE FROM bitrix24_employee_check_states')){state.checks.delete(values[0]);return [];}
    if(sql.startsWith('UPDATE employees AS employee SET bitrix24_id = NULL')){
      const [ids,bitrixIds]=values;
      assert.match(sql,/employee.active = 0 AND employee.bitrix24_id = link.bitrix_id/);
      assert.match(sql,/check_state.status IN \('dismissed_in_bitrix', 'blacklisted_in_bitrix'\)/);
      return ids.flatMap((id,index)=>{
        const row=state.employees.find(employee=>employee.id===id&&employee.active===0&&employee.bitrix24Id===bitrixIds[index]);
        if(!row||['dismissed_in_bitrix','blacklisted_in_bitrix'].includes(state.checks.get(id)?.status))return [];
        row.bitrix24Id=null;return [row];
      });
    }
    if(sql.startsWith('UPDATE employees AS employee SET bitrix24_id = link.bitrix_id')){
      const [ids,bitrixIds]=values;
      assert.match(sql,/employee.active = 1 AND employee.bitrix24_id IS NULL/);
      if(failLinkAttach)return [];
      return ids.flatMap((id,index)=>{
        const row=state.employees.find(employee=>employee.id===id&&employee.active===1&&employee.bitrix24Id===null);
        if(!row)return [];
        assert.equal(state.employees.some(employee=>employee.bitrix24Id===bitrixIds[index]),false,'the remote ID remains unique');
        row.bitrix24Id=bitrixIds[index];return [row];
      });
    }
    if(sql.startsWith('UPDATE employees SET bitrix24_stage = ?, availability_status = ?, active = 0')){const row=state.employees.find(row=>row.id===values[4]&&row.active===1&&row.bitrix24Id===values[5]);if(row)Object.assign(row,{bitrix24Stage:values[0],availabilityStatus:values[1],active:0,siteId:null});return row?[row]:[];}
    if(sql.startsWith("UPDATE employees SET availability_status = 'central_office'")){
      const row=state.employees.find(row=>row.id===values[2]&&row.active===1&&row.bitrix24Id===values[3]);
      if(row)Object.assign(row,{availabilityStatus:'central_office',active:0,siteId:null});
      return row?[row]:[];
    }
    if(sql.startsWith('UPDATE employees SET full_name = ?')){
      const [fullName,employmentType,department,position,bitrix24Stage,availabilityStatus,,,siteId,id,bitrix24Id]=values;
      const returning=sql.includes("WHERE id = ? AND active = 0 AND availability_status = 'central_office'");
      const employee=state.employees.find(row=>row.id===id&&row.bitrix24Id===bitrix24Id
        &&(returning?row.active===0&&row.availabilityStatus==='central_office':row.active===1));
      if(employee)Object.assign(employee,{fullName,employmentType,department,position,bitrix24Stage,availabilityStatus,siteId,active:1});
      return employee?[employee]:[];
    }
    if(sql.startsWith('INSERT INTO employees')){let row=state.employees.find(row=>row.bitrix24Id===values[0]);if(!row){row={id:100+state.employees.length,bitrix24Id:values[0]};state.employees.push(row);}Object.assign(row,{bitrix24Stage:values[1],availabilityStatus:values[2],syncError:values[5],syncMissCount:0,fullName:values[6],employmentType:values[7],department:values[8],position:values[9],siteId:values[10],active:values[11]});return [];}
    if(sql.startsWith('UPDATE employee_project_assignments')){for(const row of state.assignments)if(row.employeeId===values[0]&&row.active&&(!sql.includes('site_id NOT IN')||!values.slice(1).includes(row.siteId)))Object.assign(row,{active:0,endDate:row.endDate??'today'});return [];}
    if(sql.startsWith('INSERT INTO employee_project_assignments')){if(!state.assignments.some(row=>row.employeeId===values[0]&&row.siteId===values[1]&&row.active))state.assignments.push({employeeId:values[0],siteId:values[1],active:1,endDate:null});return [];}
    if(sql.startsWith('UPDATE employee_profile_versions')){for(const row of state.profiles)if(row.employeeId===values[1]&&!row.validTo)row.validTo=values[0];return [];}
    if(sql.startsWith('INSERT INTO employee_profile_versions')){
      if(sql.includes("'-infinity'")){
        if(!state.profiles.some(row=>row.employeeId===values[0]))state.profiles.push({employeeId:values[0],fullName:values[1],
          employmentType:values[2],department:values[3],position:values[4],stage:values[5],validFrom:'-infinity',validTo:values[6]});
      }else state.profiles.push({employeeId:values[0],fullName:values[1],position:values[4],stage:values[5],validTo:null});
      return [];
    }
    if(sql.startsWith('UPDATE employee_availability_periods')){for(const row of state.periods)if(row.employeeId===values[1]&&!row.validTo)row.validTo=values[0];return [];}
    if(sql.startsWith('INSERT INTO employee_availability_periods')){
      if(sql.includes("'-infinity'")){
        if(!state.periods.some(row=>row.employeeId===values[0]))state.periods.push({employeeId:values[0],status:values[1],validTo:values[2]});
      }else state.periods.push({employeeId:values[0],status:sql.includes("VALUES (?, 'central_office'")?'central_office':values[1],validTo:null});
      return [];
    }
    if(sql.startsWith('INSERT INTO employee_sync_runs'))return [{id:1}];
    if(sql.startsWith('UPDATE employee_sync_runs')||sql.startsWith('INSERT INTO employee_sync_issues'))return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  };const statement={bind(...next){values=next;return statement;},async first(){return structuredClone(execute()[0]??null);},async all(){return {results:structuredClone(execute())};},async run(){
    if(failActiveUpdate&&sql.startsWith('UPDATE employees SET full_name = ?')&&sql.includes('WHERE id = ? AND active = 1 AND bitrix24_id = ?'))return {results:[],meta:{changes:0}};
    const result=execute();return {results:result,meta:{changes:sql.startsWith('UPDATE employees AS employee SET bitrix24_id')||sql.startsWith('UPDATE employees SET full_name = ?')||sql.startsWith('UPDATE employees SET bitrix24_stage = ?, availability_status = ?, active = 0')||sql.startsWith("UPDATE employees SET availability_status = 'central_office'")?result.length:1,last_row_id:result[0]?.id??null}};}};return statement;},
    async batch(statements){return Promise.all(statements.map(statement=>statement.run()));},async readBatch(statements){return Promise.all(statements.map(statement=>statement.all()));},async transaction(callback){const old=structuredClone(state);try{return await callback(db);}catch(error){state=old;throw error;}}};
  const environment={...bitrix,createHash,bitrixReviewUpdateIds,env:{DB:db},projectOverrides:()=>({}),asPositiveInteger:value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null,
    selectBitrixEmployeesForImport:full=>bitrix.selectBitrixEmployeesForImport(full,reviewScope),selectLinkedBitrixEmployeesForReview:(full,ids)=>bitrix.selectLinkedBitrixEmployeesForReview(full,ids,reviewScope),
    bitrixOfficeTransferDirection:(remote,employee)=>bitrix.bitrixOfficeTransferDirection(remote,employee,reviewScope),
    validateEmployeeDirectoryValues:async(...args)=>validations.push(args),fetchBitrixEmployeeSnapshot:async()=>[],process:{env:{BITRIX24_SYNC_ENABLED:'true'}}};
  const compile=(code,names,extra={})=>{const deps={...environment,...extra};const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(deps),`${js};return {${names.join(',')}};`)(...Object.values(deps));};
  const api=compile(reviewCode,['buildBitrixInspection','createBitrixEmployee','updateBitrixEmployee','updateSelectedBitrixEmployees','deleteBitrixEmployee','linkBitrixEmployees']);
  return {api,state:()=>structuredClone(state),queries,writes,validations,setCheck(id,status){state.checks.set(id,{status,details:'Предыдущее предупреждение',fingerprint:`old-${id}`,acknowledgedAt:null,acknowledgedBy:null});},acknowledge(id){Object.assign(state.checks.get(id),{acknowledgedAt:'accepted',acknowledgedBy:99});},sync:async full=>compile(syncCode,['synchronizeBitrixEmployees'],{fetchBitrixEmployeeSnapshot:async()=>full}).synchronizeBitrixEmployees()};
}

test('inspection reconciles only linked terminal cards, persists a dedicated warning and never acknowledges away blacklist',async()=>{
  const ui=fixture();const full=[source(),source('B2')];
  const first=await ui.api.buildBitrixInspection(full);
  assert.deepEqual(first.snapshot.map(row=>row.bitrix24Id),['B1']);assert.equal(first.response.totalDifferences,1);
  assert.equal(first.response.differences[0].kind,'blacklisted_in_bitrix');assert.deepEqual(first.response.updatableEmployeeIds,[1]);assert.deepEqual(first.suggestions,[]);
  assert.equal(ui.state().checks.get(1).status,'blacklisted_in_bitrix');ui.acknowledge(1);
  assert.equal((await ui.api.buildBitrixInspection(full)).response.differences[0].acknowledged,false);
});

test('central office is omitted from checks, suggestions and archived-return notices without changing cards',async()=>{
  const ui=fixture([
    local(1,{fullName:'Связанный офис'}),
    local(2,{fullName:'Сотрудник площадки',department:'ОК'}),
    local(3,{fullName:'Офис в архиве',active:0,availabilityStatus:'dismissed',siteId:null}),
    local(4,{fullName:'Офис без связи',bitrix24Id:null}),
    local(5,{fullName:'Офис с кандидатом в архиве',active:0,siteId:null}),
    local(6,{fullName:'Офис с кандидатом в архиве',bitrix24Id:null}),
  ]);
  ui.setCheck(1,'mismatch');
  const before=ui.state();
  const onSite={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const office={...onSite,subdivisionKeys:['Центр. офис']};
  const snapshot=[
    source('B1',{...office,fullName:'Связанный офис',availabilityStatus:'blacklisted',stageName:'Черный список'}),
    source('B2',{...onSite,fullName:'Сотрудник площадки',department:'ОК'}),
    source('B3',{...office,fullName:'Офис в архиве'}),
    source('B4',{...office,fullName:'Офис без связи'}),
    source('B5',{...office,fullName:'Офис с кандидатом в архиве'}),
    source('B7',{...office,fullName:'Новый сотрудник офиса'}),
  ];
  const {response,suggestions}=await ui.api.buildBitrixInspection(snapshot,{observeArchivedStatuses:true});
  assert.deepEqual([response.sourceReceived,response.compared,response.matched,response.totalDifferences],[1,1,1,0]);
  assert.deepEqual(suggestions,[]);
  assert.deepEqual(response.archiveReturns,[]);
  assert.deepEqual(response.autoLinkOptions,[]);
  assert.deepEqual(ui.state().employees,before.employees);
  assert.deepEqual(ui.state().assignments,before.assignments);
  assert.deepEqual(ui.state().profiles,before.profiles);
  assert.equal(ui.state().checks.has(1),false,'previous warning is no longer shown as if the employee disappeared');
});

test('stale individual and bulk actions cannot change an office employee or add a new office card',async()=>{
  const ui=fixture([local(1,{fullName:'Офис'})]);
  ui.setCheck(1,'dismissed_in_bitrix');
  const before=ui.state();
  const office={subdivisionKeys:['Центр. офис']};
  const remote=[source('B1',{...office,fullName:'Офис',availabilityStatus:'dismissed',stageName:'Увольнения'}),source('B7',{...office,fullName:'Новый офис'})];
  await assert.rejects(ui.api.updateBitrixEmployee(remote,{employeeId:1,bitrix24Id:'B1'}),/Центр\. офис/);
  await assert.rejects(ui.api.deleteBitrixEmployee(remote,{employeeId:1,bitrix24Id:'B1'}),/Центр\. офис/);
  await assert.rejects(ui.api.updateSelectedBitrixEmployees(remote,{employeeIds:[1]},{mayArchiveDismissed:true}),/Центр\. офис/);
  await assert.rejects(ui.api.createBitrixEmployee(remote,{bitrix24Id:'B7',positionId:9,projectSiteId:null}),/Центр\. офис/);
  assert.deepEqual(ui.state(),before);
  assert.deepEqual(ui.writes,[]);
});

test('bulk sync does not change or mark missing either terminal or working central office cards',async()=>{
  const ui=fixture([local(1,{fullName:'Уволенный сотрудник офиса',syncMissCount:2}),local(2,{fullName:'Действующий сотрудник офиса',syncMissCount:2}),local(3,{fullName:'Сотрудник площадки'})]);
  const before=ui.state();
  const office={subdivisionKeys:['Центр. офис']};
  const onSite={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const result=await ui.sync([
    source('B1',{...office,availabilityStatus:'dismissed',stageName:'Увольнения'}),
    source('B2',{...office,...onSite}),
    source('B3',{...onSite,fullName:'Сотрудник площадки'}),
    source('B7',{...office,...onSite,fullName:'Новый офис'}),
  ]);
  assert.equal(result.sourceReceived,1);
  assert.equal(result.received,1);
  assert.deepEqual(ui.state().employees.filter(row=>row.id<3),before.employees.filter(row=>row.id<3));
  assert.deepEqual(ui.state().assignments.filter(row=>row.employeeId<3),before.assignments.filter(row=>row.employeeId<3));
  assert.deepEqual(ui.state().periods.filter(row=>row.employeeId<3),before.periods.filter(row=>row.employeeId<3));
  assert.equal(ui.state().employees.some(row=>row.bitrix24Id==='B7'),false);
});

test('confirmed transfers to the office and back preserve one card, historical profiles and project periods',async()=>{
  const ui=fixture([local()],{initialProfiles:false,reviewScope:{...scope,projectKeys:['QA7','QA8']}});
  const before=ui.state();
  const office=source('B1',{stageId:'OFFICE',stageName:'Объекты и офисы',availabilityStatus:'on_site',
    subdivisionKeys:['Центр. офис'],fullName:'Другое имя в офисе',employmentType:'',department:'',position:''});
  const result=(await ui.api.buildBitrixInspection([office],{observeArchivedStatuses:true})).response;
  const [outbound]=result.differences;
  assert.equal(outbound.kind,'changed');
  assert.equal(outbound.officeTransfer,'to_office');
  assert.match(outbound.officeTransferFingerprint,/^office_transfer:/);
  assert.deepEqual(result.updatableEmployeeIds,[1]);
  assert.deepEqual(result.ignorableEmployeeIds,[]);
  assert.deepEqual(ui.state().employees,before.employees);
  assert.deepEqual(ui.state().assignments,before.assignments);
  assert.deepEqual(ui.state().periods,before.periods);
  assert.ok(ui.writes.every(({sql})=>sql.includes('bitrix24_employee_check_states')),'inspection only changes comparison metadata');

  await assert.rejects(ui.api.updateBitrixEmployee([office],{employeeId:1,bitrix24Id:'B1'}));
  await assert.rejects(ui.api.updateSelectedBitrixEmployees([office],{employeeIds:[1]}));
  const moved=await ui.api.updateBitrixEmployee([office],{employeeId:1,bitrix24Id:'B1',officeTransferFingerprints:{1:outbound.officeTransferFingerprint}});
  assert.equal(moved.updatedEmployee.id,1);
  assert.deepEqual(moved.differences,[],'office staff is hidden from ordinary reviews after applying the transfer');
  const inOffice=ui.state();
  assert.deepEqual(inOffice.employees.map(({id,bitrix24Id,active,availabilityStatus,siteId})=>[id,bitrix24Id,active,availabilityStatus,siteId]),[[1,'B1',0,'central_office',null]]);
  for(const field of ['fullName','employmentType','department','position']) assert.equal(inOffice.employees[0][field],before.employees[0][field]);
  assert.equal(inOffice.assignments.length,1);
  assert.equal(inOffice.assignments[0].active,0);
  assert.ok(inOffice.assignments[0].endDate);
  assert.equal(inOffice.periods.at(-1).status,'central_office');
  assert.equal(inOffice.checks.has(1),false);
  assert.deepEqual(ui.validations,[],'moving to the office does not apply office HR fields');

  const returning=source('B1',{stageId:'SITE',stageName:'На объекте',availabilityStatus:'on_site',subdivisionKeys:['Площадка'],projectKeys:['QA8'],position:'Сварщик'});
  const review=(await ui.api.buildBitrixInspection([returning],{observeArchivedStatuses:true})).response;
  const [inbound]=review.differences;
  assert.equal(inbound.officeTransfer,'to_site');
  assert.notEqual(inbound.officeTransferFingerprint,outbound.officeTransferFingerprint);
  assert.deepEqual(review.updatableEmployeeIds,[1]);
  assert.deepEqual(review.ignorableEmployeeIds,[]);
  assert.deepEqual(review.archiveReturns,[],'this is a project transfer, not a dismissal or rehiring');
  assert.deepEqual(review.autoLinkOptions,[],'the existing Bitrix ID is not a linking candidate');
  assert.deepEqual(ui.state().employees,inOffice.employees);
  assert.deepEqual(ui.state().assignments,inOffice.assignments);

  await assert.rejects(ui.api.updateSelectedBitrixEmployees([returning],{employeeIds:[1]}));
  await assert.rejects(ui.api.updateSelectedBitrixEmployees([returning],{employeeIds:[1],officeTransferFingerprints:{1:outbound.officeTransferFingerprint}}));
  await assert.rejects(ui.api.updateSelectedBitrixEmployees([{...returning,projectKeys:['QA7']}],{employeeIds:[1],officeTransferFingerprints:{1:inbound.officeTransferFingerprint}}));
  assert.deepEqual(ui.state().employees,inOffice.employees,'stale confirmations do not reactivate the card');
  assert.deepEqual(ui.state().assignments,inOffice.assignments);
  const applied=await ui.api.updateSelectedBitrixEmployees([returning],{employeeIds:[1],officeTransferFingerprints:{1:inbound.officeTransferFingerprint}});
  assert.deepEqual(applied.updatedEmployees.map(({id})=>id),[1]);
  assert.deepEqual(applied.failedEmployees,[]);
  assert.deepEqual(applied.differences,[]);

  const after=ui.state();
  assert.deepEqual(after.employees.map(({id,bitrix24Id,active,availabilityStatus,siteId,position})=>[id,bitrix24Id,active,availabilityStatus,siteId,position]),[[1,'B1',1,'on_site',8,'Сварщик']]);
  assert.deepEqual(after.assignments.slice(0,1),inOffice.assignments,'the old project period is not reopened');
  assert.deepEqual(after.assignments.slice(1).map(({employeeId,siteId,active,endDate})=>[employeeId,siteId,active,endDate]),[[1,8,1,null]]);
  assert.deepEqual(after.periods.map(({status})=>status),['on_site','central_office','on_site']);
  assert.ok(after.periods[1].validTo);
  assert.equal(after.profiles.find(row=>row.employeeId===1&&row.validFrom==='-infinity')?.position,'Монтажник');
  assert.equal(after.profiles.at(-1).position,'Сварщик');
  assert.deepEqual(after.reports,before.reports);
  assert.deepEqual(after.marks,before.marks);
});

test('office return stays pending if the remote move is undone, the site is out of scope or bulk sync runs',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'central_office'}),local(2,{fullName:'Другой сотрудник площадки'})]);
  const office=source('B1',{stageId:'OFFICE',stageName:'Объекты и офисы',availabilityStatus:'on_site',subdivisionKeys:['Центр. офис']});
  const returning=source('B1',{stageId:'SITE',stageName:'На объекте',availabilityStatus:'on_site',subdivisionKeys:['Площадка'],projectKeys:['QA7']});
  const other=source('B2',{stageId:'SITE',stageName:'На объекте',availabilityStatus:'on_site',subdivisionKeys:['Площадка'],projectKeys:['QA7'],fullName:'Другой сотрудник площадки'});
  const initial=ui.state();
  const check=(await ui.api.buildBitrixInspection([returning,other])).response;
  const [inbound]=check.differences;
  assert.equal(inbound.officeTransfer,'to_site');
  await assert.rejects(ui.api.updateBitrixEmployee([office,other],{employeeId:1,bitrix24Id:'B1',officeTransferFingerprints:{1:inbound.officeTransferFingerprint}}));
  const outOfScope=(await ui.api.buildBitrixInspection([{...returning,projectKeys:['QA8']},other])).response;
  assert.deepEqual(outOfScope.differences,[]);
  assert.equal(ui.state().checks.has(1),false);
  await ui.sync([returning,other]);
  await ui.sync([other]);
  assert.deepEqual(ui.state().employees[0],initial.employees[0]);
  assert.deepEqual(ui.state().assignments.filter(row=>row.employeeId===1),[]);
  assert.deepEqual(ui.state().periods.filter(row=>row.employeeId===1),initial.periods.filter(row=>row.employeeId===1));
});

test('an office transfer never links to a namesake or creates a second card when the name conflicts',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'central_office'}),local(2,{bitrix24Id:null})]);
  const returning=source('B1',{stageId:'SITE',stageName:'На объекте',availabilityStatus:'on_site',subdivisionKeys:['Площадка'],projectKeys:['QA7']});
  const check=await ui.api.buildBitrixInspection([returning]);
  const [inbound]=check.response.differences;
  assert.equal(inbound.officeTransfer,'to_site');
  assert.deepEqual(check.suggestions,[]);
  assert.deepEqual(check.response.archiveTransferOptions,[]);
  const before=ui.state();
  await assert.rejects(ui.api.updateBitrixEmployee([returning],{employeeId:1,bitrix24Id:'B1',officeTransferFingerprints:{1:inbound.officeTransferFingerprint}}),/дубль/);
  assert.deepEqual(ui.state(),before);
});

test('blacklist apply archives an existing employee without HR fields, preserves history and excludes them from subsequent inspections',async()=>{
  const ui=fixture(),before=ui.state();const full=[source('B1',{fullName:'',employmentType:'',department:'',position:''}),source('B2')];
  const result=await ui.api.updateBitrixEmployee(full,{employeeId:1,bitrix24Id:'B1'});
  assert.equal(result.updatedEmployee.name,'Исходное имя');assert.equal(result.totalDifferences,0);
  assert.equal(result.compared,0);assert.equal(result.matched,0);
  const state=ui.state();assert.equal(state.employees[0].active,0);assert.equal(state.employees[0].siteId,null);assert.equal(state.employees[0].availabilityStatus,'blacklisted');
  for(const field of ['fullName','employmentType','department','position'])assert.equal(state.employees[0][field],before.employees[0][field]);
  assert.equal(state.assignments[0].active,0);assert.equal(state.periods.at(-1).status,'blacklisted');assert.equal(state.checks.size,0);
  assert.deepEqual(state.reports,before.reports);assert.deepEqual(state.marks,before.marks);assert.deepEqual(ui.validations,[]);
  await assert.rejects(ui.api.updateBitrixEmployee(full,{employeeId:1,bitrix24Id:'B1'}),/архив/i);
  const later=await ui.api.buildBitrixInspection([source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']})]);
  assert.deepEqual([later.response.compared,later.response.matched,later.response.totalDifferences],[0,0,0]);assert.deepEqual(later.suggestions,[]);
  assert.deepEqual(later.response.archiveReturns.map(row=>row.bitrix24Id),['B1']);
  assert.match(later.response.archiveReturns[0].details,/отдельного кадрового решения/);
  assert.deepEqual(ui.state(),state);
});

test('legacy duplicate termination requires confirmation and leaves the original archive ID and both histories intact',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null}),local(2,{bitrix24Id:null})],{initialProfiles:false});
  const before=ui.state();
  const remote=[source()];
  const check=await ui.api.buildBitrixInspection(remote,{observeArchivedStatuses:true});
  assert.equal(check.response.compared,0,'the linked archive is not counted');
  assert.deepEqual(check.response.differences.map(row=>[row.kind,row.localEmployeeId]),[['blacklisted_in_bitrix',2]]);
  assert.deepEqual(check.response.legacyTerminalEmployeeIds,[2]);
  assert.deepEqual(ui.state().employees,before.employees,'comparison does not archive either card');
  await assert.rejects(ui.api.updateSelectedBitrixEmployees(remote,{employeeIds:[2]}),/нет права/);
  await assert.rejects(ui.api.updateBitrixEmployee(remote,{employeeId:2,bitrix24Id:'B1'}),/изменилась/);
  const result=await ui.api.updateSelectedBitrixEmployees(remote,{employeeIds:[2]},{mayArchiveDismissed:true});
  assert.deepEqual(result.updatedEmployees.map(row=>row.id),[2]);
  assert.deepEqual(result.differences,[]);
  const after=ui.state();
  assert.deepEqual(after.employees.map(({id,active,bitrix24Id})=>[id,active,bitrix24Id]),[[1,0,'B1'],[2,0,null]]);
  assert.equal(after.employees[1].availabilityStatus,'blacklisted');
  assert.deepEqual(after.reports,before.reports);
  assert.deepEqual(after.marks,before.marks);
  assert.equal(after.profiles.find(row=>row.employeeId===2).validFrom,'-infinity');
  assert.equal(after.assignments[0].active,0);
  const later=await ui.api.buildBitrixInspection([source('B1',{availabilityStatus:'on_site',stageName:'Объекты и офисы',projectKeys:['QA7']})]);
  assert.deepEqual(later.response.archiveReturns.map(row=>row.bitrix24Id),['B1']);
  assert.deepEqual(later.response.differences,[]);
  assert.deepEqual(ui.state().employees,after.employees);
});

test('legacy dismissal cannot apply from a stale review after the source leaves the dismissal stage',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null}),local(2,{bitrix24Id:null})]);
  const dismissed=source('B1',{availabilityStatus:'dismissed',stageName:'Увольнение'});
  await ui.api.buildBitrixInspection([dismissed],{observeArchivedStatuses:true});
  assert.equal(ui.state().checks.get(2)?.status,'dismissed_in_bitrix');
  const returned=source('B1',{availabilityStatus:'on_site',stageName:'Объекты и офисы',projectKeys:['QA7']});
  await assert.rejects(ui.api.updateSelectedBitrixEmployees([returned],{employeeIds:[2]},{mayArchiveDismissed:true}),/Не удалось подтвердить связь/);
  await assert.rejects(ui.api.deleteBitrixEmployee([returned],{employeeId:2,bitrix24Id:'B1'}),/снова найдена/);
  const check=await ui.api.buildBitrixInspection([returned],{observeArchivedStatuses:true});
  assert.deepEqual(check.response.archiveReturns.map(row=>row.bitrix24Id),['B1']);
  assert.equal(ui.state().checks.has(2),false);
  assert.equal(ui.state().employees[1].active,1);
});

test('dismissal still appears for an active employee and archives them without relabelling as deleted',async()=>{
  const dismissed=fixture();const full=[source('B1',{availabilityStatus:'dismissed',stageName:'Увольнения',fullName:''})];
  const before=await dismissed.api.buildBitrixInspection(full);
  assert.equal(before.response.differences[0].kind,'dismissed_in_bitrix');
  const result=await dismissed.api.deleteBitrixEmployee(full,{employeeId:1,bitrix24Id:'B1'});
  assert.equal(result.totalDifferences,0);assert.equal(dismissed.state().employees[0].availabilityStatus,'dismissed');assert.equal(dismissed.state().employees[0].bitrix24Stage,'Увольнения');
});

test('a uniquely linked dismissed or blacklisted archive returning to a named object only raises a read-only notice',async()=>{
  const archived={active:0,siteId:null};
  const dismissed={...archived,availabilityStatus:'dismissed',bitrix24Stage:'Увольнения'};
  const onSite={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:[' Другой объект ', 'Другой объект', ' ']};
  const ui=fixture([
    local(1,{...dismissed,fullName:'Вернулся'}),
    local(2,{bitrix24Id:null,fullName:'Вернулся'}),
    local(3,{...archived,fullName:'Просто архив'}),
    local(4,{...archived,availabilityStatus:'blacklisted',fullName:'Чёрный список'}),
    local(5,{...dismissed,fullName:'Дублированный ID'}),
    local(6,{...dismissed,fullName:'Без объекта'}),
    local(7,{...dismissed,fullName:'Остался уволен'}),
    local(8,{...archived,availabilityStatus:'deleted',fullName:'Удалён из Битрикс24'}),
    local(9,{...dismissed,fullName:'Архив с чёрным списком'}),
  ]);
  ui.setCheck(9,'blacklisted_in_bitrix');
  const before=ui.state();
  const full=[
    source('B1',{...onSite,fullName:'Вернулся'}),
    source('B3',{...onSite,fullName:'Просто архив'}),
    source('B4',{...onSite,fullName:'Чёрный список'}),
    source('B5',{...onSite,fullName:'Дублированный ID'}),
    source('B5',{availabilityStatus:'dismissed',stageName:'Увольнения',fullName:'Дублированный ID'}),
    source('B6',{...onSite,projectKeys:[' '],fullName:'Без объекта'}),
    source('B7',{availabilityStatus:'dismissed',stageName:'Увольнения',fullName:'Остался уволен'}),
    source('B8',{...onSite,fullName:'Удалён из Битрикс24'}),
    source('B9',{...onSite,fullName:'Архив с чёрным списком'}),
  ];
const result=await ui.api.buildBitrixInspection(full,{observeArchivedStatuses:true});
  const {response}=result;
  assert.deepEqual([response.compared,response.matched,response.totalDifferences],[0,0,0]);
  assert.deepEqual(response.differenceCounts,{});
  assert.deepEqual(response.differences,[]);
  assert.deepEqual(response.archiveReturns.map(row=>row.bitrix24Id),['B1','B4','B9']);
  assert.match(response.archiveReturns[0].details,/Объект: «Другой объект»\./);
  assert.deepEqual(response.updatableEmployeeIds,[]);
  assert.deepEqual(response.autoLinkOptions,[]);
  assert.deepEqual(result.suggestions,[]);
  assert.deepEqual(result.snapshot,[]);
  assert.deepEqual(ui.state(),before);
  assert.deepEqual(ui.writes,[]);
});

test('an explicit check silently remembers terminal statuses for a manual archive without writing employee data',async()=>{
  const archived={active:0,siteId:null,availabilityStatus:'out_of_scope'};
  const ui=fixture([
    local(1,{...archived,fullName:'Ранее уволенный'}),
    local(2,{...archived,fullName:'В чёрном списке'}),
    local(3,{bitrix24Id:null,fullName:'Ранее уволенный',department:'Другой отдел'}),
    local(4,{bitrix24Id:null,fullName:'В чёрном списке',department:'Другой отдел'}),
    local(5,{...archived,fullName:'Уже в чёрном списке'}),
  ]);
  ui.setCheck(5,'blacklisted_in_bitrix');
  const before=ui.state();
  const dismissed={availabilityStatus:'dismissed',stageName:'Увольнения'};
  const terminal=[
    source('B1',{...dismissed,fullName:'Ранее уволенный'}),
    source('B2',{fullName:'В чёрном списке'}),
    source('B5',{...dismissed,fullName:'Уже в чёрном списке'}),
  ];
  assert.equal((await ui.api.buildBitrixInspection(terminal)).response.totalDifferences,0);
  assert.deepEqual(ui.state(),before);assert.deepEqual(ui.writes,[]);
  assert.equal((await ui.api.buildBitrixInspection(terminal,{observeArchivedStatuses:true})).response.totalDifferences,0);
  const observed=ui.state();
  assert.equal(observed.checks.get(1).status,'dismissed_in_bitrix');
  assert.equal(observed.checks.get(2).status,'blacklisted_in_bitrix');
  assert.deepEqual(observed.checks.get(5),before.checks.get(5),'dismissal does not clear a cached blacklist');
  assert.deepEqual({...observed,checks:before.checks},before);
  assert.equal(ui.writes.length,1);assert.match(ui.writes[0].sql,/^INSERT INTO bitrix24_employee_check_states/);
  const onSite={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const returned=await ui.api.buildBitrixInspection([
    source('B1',{...onSite,fullName:'Ранее уволенный'}),
    source('B2',{...onSite,fullName:'В чёрном списке'}),
    source('B5',{...onSite,fullName:'Уже в чёрном списке'}),
  ],{observeArchivedStatuses:true});
  assert.deepEqual(returned.response.differences,[]);
  assert.deepEqual(returned.response.archiveReturns.map(row=>row.bitrix24Id),['B1','B2','B5']);
  assert.deepEqual(returned.suggestions,[]);
  assert.deepEqual(ui.state(),observed);assert.equal(ui.writes.length,1);
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

test('archived linked identities are excluded from comparison and only offer eligible active replacements',async()=>{
  const archived={active:0,siteId:null,availabilityStatus:'out_of_scope'};
  const active={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const ui=fixture([local(),local(2,{...archived,fullName:'Архивный дубль'}),local(3,archived),local(4,{...archived,availabilityStatus:'deleted'}),
    local(5,archived),local(6,{bitrix24Id:null,fullName:'Архивный дубль'}),local(7,{fullName:'Действующий сотрудник'}),local(9,{bitrix24Id:null,fullName:'Совпадение без связи'})]);
  ui.setCheck(2,'mismatch');ui.acknowledge(2);ui.setCheck(3,'blacklisted_in_bitrix');
  const before=ui.state();
  const full=[source('B1',active),source('B2',{...active,fullName:'Архивный дубль'}),source('B3'),source('B5',{...active,projectKeys:['OUTSIDE']}),
    source('B7',{...active,fullName:'Действующий сотрудник',position:'Сварщик'}),source('B8',{...active,fullName:'Новый сотрудник'}),
    source('B9',{...active,fullName:'Совпадение без связи'}),source('B10',{...active,projectKeys:['OUTSIDE']})];
  const result=await ui.api.buildBitrixInspection(full);
  assert.deepEqual(result.snapshot.map(row=>row.bitrix24Id),['B1','B7','B8','B9']);
  const {response}=result;
  assert.deepEqual(response.differences.map(row=>[row.bitrix24Id,row.kind]),[['B2','missing_locally'],['B7','changed'],['B8','missing_locally'],['B9','missing_locally']]);
  assert.equal(response.differences[0].archivedLink,true);
  assert.deepEqual(response.differences[0].suggestedEmployeeIds,[6]);assert.equal(response.differences[0].localEmployeeId,undefined);
  assert.deepEqual(response.differenceCounts,{changed:1,missing_locally:3});assert.deepEqual(response.updatableEmployeeIds,[7]);
  assert.deepEqual([response.sourceReceived,response.received,response.excluded,response.compared,response.matched,response.totalDifferences,response.acknowledgedDifferences],[5,4,1,2,1,4,0]);
  assert.deepEqual(response.stages,[['На объекте',4]]);assert.deepEqual(response.projects,[['QA7',4]]);
  assert.deepEqual(response.excludedStages,[['На объекте',1]]);
  assert.deepEqual([response.autoLinkable,response.archiveAutoLinkable,response.activeUnlinked,response.needsReview,response.unmatched],[2,1,2,0,1]);
  assert.deepEqual(response.autoLinkOptions,[{bitrix24Id:'B9',archivedLink:false},{bitrix24Id:'B2',archivedLink:true}]);
  assert.deepEqual(result.suggestions.map(row=>[row.bitrix24Id,row.kind,row.employeeIds]),[['B8','unmatched',[]],['B9','safe',[9]],['B2','safe',[6]]]);
  const after=ui.state();assert.equal(after.checks.get(7).status,'mismatch');after.checks.delete(7);
  assert.deepEqual(after,before);
});

test('explicitly confirmed archive transfer changes only the Bitrix ID and reviews the active project',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'out_of_scope'}),local(2,{bitrix24Id:null,bitrix24Stage:''})]);
  const before=ui.state();
  const remote=source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['Другой объект']});
  const full=[remote];
  const links=[{bitrix24Id:'B1',employeeId:2}];
  const {response}=await ui.api.buildBitrixInspection(full,{observeArchivedStatuses:true});
  assert.deepEqual([response.compared,response.matched,response.archiveAutoLinkable,response.activeUnlinked],[0,0,1,1]);
  assert.match(response.archiveLinkRevision,/^[0-9a-f]{64}$/);
  assert.deepEqual(ui.state(),before,'inspection does not attach the link or edit the employees');
  assert.equal((await ui.api.linkBitrixEmployees(full,undefined)).linked,0,'unconfirmed automatic action skips archive links');
  await assert.rejects(ui.api.linkBitrixEmployees(full,links,{allowArchivedLink:true}),/выполните проверку/i);
  await assert.rejects(ui.api.linkBitrixEmployees([{...remote,position:'Сварщик'}],links,{allowArchivedLink:true,archiveLinkRevision:response.archiveLinkRevision}),/кандидаты.*изменились/i);
  await assert.rejects(ui.api.linkBitrixEmployees(full,[{bitrix24Id:'B1',employeeId:1}],{allowArchivedLink:true,archiveLinkRevision:response.archiveLinkRevision}),/для сопоставления не найден/i);
  assert.deepEqual(ui.state(),before);
  const linked=await ui.api.linkBitrixEmployees(full,links,{allowArchivedLink:true,archiveLinkRevision:response.archiveLinkRevision});
  assert.equal(linked.linked,1);
  assert.deepEqual(linked.archiveRelinks,{B1:{archivedEmployeeId:1,activeEmployeeId:2}});
  assert.deepEqual([linked.compared,linked.matched,linked.activeUnlinked],[1,0,0]);
  assert.deepEqual(linked.differences.map(row=>[row.localEmployeeId,row.kind,row.details]),[[2,'changed','Объект: «QA7» → «Другой объект»']]);
  assert.deepEqual(ui.queries.find(({sql})=>sql.includes('FROM employees WHERE id = ANY(?::integer[]) ORDER BY id FOR UPDATE')).values,[[2,1]]);
  const after=ui.state();
  assert.equal(after.checks.get(2).status,'mismatch');after.checks.delete(2);
  before.employees[0].bitrix24Id=null;before.employees[1].bitrix24Id='B1';
  assert.deepEqual(after,before,'the project, cached stage, profile, availability, reports and timesheets are preserved');
});

test('archive ownership is restored if the guarded attachment fails after releasing the archive link',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'out_of_scope'}),local(2,{bitrix24Id:null})],{failLinkAttach:true});
  const before=ui.state();
  const full=[source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']})];
  const {response:{archiveLinkRevision}}=await ui.api.buildBitrixInspection(full);
  await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{allowArchivedLink:true,archiveLinkRevision}),/изменился во время сопоставления/i);
  assert.ok(ui.writes.some(({sql})=>sql.startsWith('UPDATE employees AS employee SET bitrix24_id = NULL')));
  assert.deepEqual(ui.state(),before);
});

test('bulk exact selection only links the checked pairs, including a confirmed archive pair',async()=>{
  const archived={active:0,siteId:null,availabilityStatus:'out_of_scope'};
  const active={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const ui=fixture([
    local(1,{...archived,fullName:'Первая пара'}),
    local(2,{bitrix24Id:null,fullName:'Первая пара'}),
    local(3,{bitrix24Id:null,fullName:'Новая связь'}),
    local(4,{...archived,fullName:'Не отмеченная пара'}),
    local(5,{bitrix24Id:null,fullName:'Не отмеченная пара'}),
  ]);
  const full=[
    source('B1',{...active,fullName:'Первая пара'}),
    source('B3',{...active,fullName:'Новая связь'}),
    source('B4',{...active,fullName:'Не отмеченная пара'}),
  ];
  const before=ui.state();
  const {response}=await ui.api.buildBitrixInspection(full);
  const ids=['B1','B3','B1'];
  await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{autoLinkBitrixIds:ids}),/подтвердите перенос/i);
  assert.deepEqual(ui.state(),before);
  const result=await ui.api.linkBitrixEmployees(full,undefined,{autoLinkBitrixIds:ids,allowArchivedLink:true,archiveLinkRevision:response.archiveLinkRevision});
  assert.equal(result.linked,2);
  assert.deepEqual(result.archiveRelinks,{B1:{archivedEmployeeId:1,activeEmployeeId:2}});
  assert.deepEqual(result.autoLinkOptions,[{bitrix24Id:'B4',archivedLink:true}]);
  before.employees[0].bitrix24Id=null;
  before.employees[1].bitrix24Id='B1';
  before.employees[2].bitrix24Id='B3';
  assert.deepEqual(ui.state(),before,'no changes to unselected pairs, assignments, profiles, reports or timesheets');
});

test('bulk archive transfers accept unique review pairs with differing HR data and can include exact matches',async()=>{
  const archived={active:0,siteId:null,availabilityStatus:'out_of_scope'};
  const active={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const ui=fixture([
    local(1,{...archived,fullName:'Первая пара'}),
    local(2,{bitrix24Id:null,fullName:'Первая пара'}),
    local(3,{...archived,fullName:'Вторая пара'}),
    local(4,{bitrix24Id:null,fullName:'Вторая пара'}),
    local(5,{...archived,fullName:'Не отмеченная пара'}),
    local(6,{bitrix24Id:null,fullName:'Не отмеченная пара'}),
    local(7,{bitrix24Id:null,fullName:'Точное совпадение'}),
  ]);
  const full=[
    source('B1',{...active,fullName:'Первая пара',position:'Сварщик'}),
    source('B3',{...active,fullName:'Вторая пара',department:'ОГМ'}),
    source('B5',{...active,fullName:'Не отмеченная пара',position:'Мастер'}),
    source('B7',{...active,fullName:'Точное совпадение'}),
  ];
  const before=ui.state();
  const {response}=await ui.api.buildBitrixInspection(full);
  assert.deepEqual(response.archiveTransferOptions,[{bitrix24Id:'B1',employeeId:2},{bitrix24Id:'B3',employeeId:4},{bitrix24Id:'B5',employeeId:6}]);
  assert.deepEqual(response.autoLinkOptions,[{bitrix24Id:'B7',archivedLink:false}]);
  const result=await ui.api.linkBitrixEmployees(full,undefined,{
    autoLinkBitrixIds:['B7'],archiveTransferLinks:response.archiveTransferOptions.slice(0,2),
    allowArchivedLink:true,archiveLinkRevision:response.archiveLinkRevision,
  });
  assert.equal(result.linked,3);
  assert.deepEqual(result.archiveRelinks,{B1:{archivedEmployeeId:1,activeEmployeeId:2},B3:{archivedEmployeeId:3,activeEmployeeId:4}});
  assert.deepEqual(result.archiveTransferOptions,[{bitrix24Id:'B5',employeeId:6}]);
  assert.deepEqual(result.differences.filter(item=>item.kind==='changed').map(item=>item.localEmployeeId),[2,4]);
  const after=ui.state();
  assert.equal(after.checks.get(2).status,'mismatch');after.checks.delete(2);
  assert.equal(after.checks.get(4).status,'mismatch');after.checks.delete(4);
  before.employees[0].bitrix24Id=null;
  before.employees[1].bitrix24Id='B1';
  before.employees[2].bitrix24Id=null;
  before.employees[3].bitrix24Id='B3';
  before.employees[6].bitrix24Id='B7';
  assert.deepEqual(after,before,'only selected links change; profile data, assignments, reports and timesheets are preserved');
});

test('batch archive transfer rejects unconfirmed, malformed, ambiguous and stale pairs before changing any links',async()=>{
  const archived={active:0,siteId:null,availabilityStatus:'out_of_scope'};
  const active={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7'],position:'Сварщик'};
  const ui=fixture([
    local(1,{...archived,fullName:'Единственный сотрудник'}),
    local(2,{bitrix24Id:null,fullName:'Единственный сотрудник'}),
    local(3,{...archived,fullName:'Два кандидата'}),
    local(4,{bitrix24Id:null,fullName:'Два кандидата'}),
    local(5,{bitrix24Id:null,fullName:'Два кандидата'}),
    local(6,{...archived,fullName:'Неизвестная стадия'}),
    local(7,{bitrix24Id:null,fullName:'Неизвестная стадия'}),
    local(8,{bitrix24Id:null,fullName:'Точное совпадение'}),
    local(9,{...archived,fullName:'Две внешние карточки'}),
    local(10,{bitrix24Id:null,fullName:'Две внешние карточки'}),
  ]);
  const full=[
    source('B1',{...active,fullName:'Единственный сотрудник'}),
    source('B3',{...active,fullName:'Два кандидата'}),
    source('B6',{...active,fullName:'Неизвестная стадия',availabilityStatus:'unknown'}),
    source('B8',{...active,fullName:'Точное совпадение',position:'Монтажник'}),
    source('B9',{...active,fullName:'Две внешние карточки'}),
    source('B11',{fullName:'  ДВЕ внешние карточки '}),
  ];
  const before=ui.state();
  const {response}=await ui.api.buildBitrixInspection(full);
  const pair={bitrix24Id:'B1',employeeId:2};
  assert.deepEqual(response.archiveTransferOptions,[pair]);
  assert.deepEqual(response.autoLinkOptions,[{bitrix24Id:'B8',archivedLink:false}]);
  const confirmed={allowArchivedLink:true,archiveLinkRevision:response.archiveLinkRevision};
  await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{archiveTransferLinks:[pair]}),/подтвердите перенос/i);
  await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{allowArchivedLink:true,archiveTransferLinks:[pair]}),/кандидаты.*изменились/i);
  await assert.rejects(ui.api.linkBitrixEmployees(full,[pair],{...confirmed,archiveTransferLinks:[pair]}),/один способ/i);
  for(const archiveTransferLinks of [null,[],[null],[{}],[{...pair,employeeId:'2'}],[{...pair,bitrix24Id:' B1'}]]){
    await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{...confirmed,archiveTransferLinks}),/карточки для переноса/i);
  }
  for(const invalidPair of [{...pair,employeeId:7},{bitrix24Id:'B3',employeeId:4},{bitrix24Id:'B6',employeeId:7},{bitrix24Id:'B9',employeeId:10}]){
    await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{
      ...confirmed,autoLinkBitrixIds:['B8'],archiveTransferLinks:[pair,invalidPair],
    }),/пары для переноса связи изменились/i);
  }
  const refreshed=[{...full[0],position:'Технолог'},...full.slice(1)];
  await assert.rejects(ui.api.linkBitrixEmployees(refreshed,undefined,{...confirmed,archiveTransferLinks:[pair]}),/кандидаты.*изменились/i);
  assert.deepEqual(ui.state(),before);
  assert.deepEqual(ui.writes,[]);
});

test('empty, mixed and stale exact selections do not link any employees',async()=>{
  const active={availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']};
  const ui=fixture([local(1,{bitrix24Id:null,fullName:'Первый сотрудник'}),local(2,{bitrix24Id:null,fullName:'Второй сотрудник'})]);
  const full=[source('B1',{...active,fullName:'Первый сотрудник'}),source('B2',{...active,fullName:'Второй сотрудник'})];
  const before=ui.state();
  for(const autoLinkBitrixIds of [null,[],[1],[' B1']]){
    await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{autoLinkBitrixIds}),/отметьте карточки/i);
  }
  await assert.rejects(ui.api.linkBitrixEmployees(full,[{bitrix24Id:'B1',employeeId:1}],{autoLinkBitrixIds:['B2']}),/один способ/i);
  await assert.rejects(ui.api.linkBitrixEmployees(full,undefined,{autoLinkBitrixIds:['B1','missing']}),/отмеченные совпадения изменились/i);
  const refreshed=[full[0],{...full[1],position:'Сварщик'}];
  await assert.rejects(ui.api.linkBitrixEmployees(refreshed,undefined,{autoLinkBitrixIds:['B1','B2']}),/отмеченные совпадения изменились/i);
  const duplicate=[full[0],{...full[1],bitrix24Id:'B1'}];
  assert.deepEqual((await ui.api.buildBitrixInspection(duplicate)).response.autoLinkOptions,[]);
  await assert.rejects(ui.api.linkBitrixEmployees(duplicate,undefined,{autoLinkBitrixIds:['B1']}),/отмеченные совпадения изменились/i);
  assert.deepEqual(ui.state(),before);
  assert.deepEqual(ui.writes,[]);
});

test('changed remote HR fields invalidate a manual archive confirmation even when candidate IDs do not change',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'out_of_scope'}),local(2,{bitrix24Id:null})]);
  const before=ui.state();
  const remote=source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7'],position:'Сварщик'});
  const first=await ui.api.buildBitrixInspection([remote]);
  const refreshed=[{...remote,position:'Технолог'}];
  const latest=await ui.api.buildBitrixInspection(refreshed);
  assert.deepEqual(first.suggestions.map(({kind,employeeIds})=>[kind,employeeIds]),[['review',[2]]]);
  assert.deepEqual(latest.suggestions,first.suggestions);
  assert.notEqual(latest.response.archiveLinkRevision,first.response.archiveLinkRevision);
  const links=[{bitrix24Id:'B1',employeeId:2}];
  await assert.rejects(ui.api.linkBitrixEmployees(refreshed,links,{allowArchivedLink:true,archiveLinkRevision:first.response.archiveLinkRevision}),/кандидаты.*изменились/i);
  assert.deepEqual(ui.state(),before);assert.deepEqual(ui.writes,[]);
});

test('keep-local acknowledgement survives subsequent checks until the underlying difference changes',async()=>{
  const ui=fixture([local(),local(2,{active:0,siteId:null,availabilityStatus:'out_of_scope'})]);
  const full=[source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['НЗНП','Усть-Луга'],position:'Сварщик'})];
  const first=await ui.api.buildBitrixInspection(full,{observeArchivedStatuses:true});
  assert.deepEqual([first.response.totalDifferences,first.response.acknowledgedDifferences],[1,0]);
  ui.acknowledge(1);ui.setCheck(2,'mismatch');ui.acknowledge(2);
  const previous=ui.state();
  const internal=await ui.api.buildBitrixInspection(full);
  assert.deepEqual([internal.response.totalDifferences,internal.response.acknowledgedDifferences],[0,1]);
  assert.equal(internal.response.differences[0].acknowledged,true);assert.deepEqual(ui.state(),previous);
  const recheck=await ui.api.buildBitrixInspection([{...full[0],projectKeys:[...full[0].projectKeys].reverse()}],{observeArchivedStatuses:true});
  assert.deepEqual([recheck.response.totalDifferences,recheck.response.acknowledgedDifferences],[0,1]);
  assert.deepEqual(ui.state(),previous);
  const changed=await ui.api.buildBitrixInspection([{...full[0],position:'Бригадир'}],{observeArchivedStatuses:true});
  assert.deepEqual([changed.response.totalDifferences,changed.response.acknowledgedDifferences],[1,0]);
  assert.deepEqual(changed.response.updatableEmployeeIds,[1]);assert.deepEqual(changed.response.ignorableEmployeeIds,[1]);
  assert.notEqual(changed.response.warningFingerprints[1],first.response.warningFingerprints[1]);
  assert.equal(ui.state().checks.get(1).acknowledgedAt,null);
  assert.deepEqual(ui.state().checks.get(2),previous.checks.get(2),'archive warning is untouched');
});

test('first link and selective review of 500 staff leaves 400 active, 20 ignored and 15 unresolved without rewriting history',async()=>{
  const ids=Array.from({length:500},(_,index)=>index+1);
  const original=ids.map(id=>local(id,{bitrix24Id:null,bitrix24Stage:'',source:'excel',fullName:`Сотрудник ${id}`,siteId:id<=250?7:8}));
  const initial=original.map(({id,fullName,siteId})=>source(`B${id}`,{fullName,availabilityStatus:'on_site',stageName:'На объекте',projectKeys:[`QA${siteId}`]}));
  const ui=fixture(original,{initialProfiles:false});
  const before=ui.state();
  const first=await ui.api.buildBitrixInspection(initial,{observeArchivedStatuses:true});
  assert.equal(first.response.autoLinkOptions.length,500);
  assert.equal(first.response.compared,0);
  const linked=await ui.api.linkBitrixEmployees(initial,undefined,{autoLinkBitrixIds:first.response.autoLinkOptions.map(item=>item.bitrix24Id)});
  assert.deepEqual([linked.linked,linked.compared,linked.matched],[500,500,500]);
  const full=initial.map((card,index)=>{
    const id=index+1;
    if(id<=50)return {...card,availabilityStatus:'dismissed',stageName:'Увольнения',projectKeys:[]};
    if(id<=100)return {...card,availabilityStatus:'blacklisted',stageName:'Чёрный список',projectKeys:[]};
    if(id<=335)return {...card,position:'Сварщик',projectKeys:id===101?['QA8']:card.projectKeys};
    return card;
  });
  const check=await ui.api.buildBitrixInspection(full,{observeArchivedStatuses:true});
  assert.deepEqual(check.response.differenceCounts,{dismissed_in_bitrix:50,blacklisted_in_bitrix:50,changed:235});
  assert.equal(check.response.updatableEmployeeIds.length,335);
  assert.equal(check.response.dismissalEmployeeIds.length,50);
  assert.equal(check.response.ignorableEmployeeIds.length,285);
  assert.equal(ui.state().employees.filter(row=>row.active===1).length,500,'the check changes no employee');
  for(const id of ids.slice(300,320))ui.acknowledge(id);
  for(const batch of [ids.slice(0,200),ids.slice(200,300)]){
    const result=await ui.api.updateSelectedBitrixEmployees(full,{employeeIds:batch},{mayArchiveDismissed:true});
    assert.equal(result.updatedEmployees.length,batch.length);
    assert.deepEqual(result.failedEmployees,[]);
  }
  const recheck=await ui.api.buildBitrixInspection(full,{observeArchivedStatuses:true});
  assert.deepEqual([recheck.response.compared,recheck.response.matched,recheck.response.totalDifferences,recheck.response.acknowledgedDifferences],[400,365,15,20]);
  assert.deepEqual(recheck.response.differences.filter(row=>!row.acknowledged).map(row=>row.localEmployeeId),ids.slice(320,335));
  assert.deepEqual(recheck.response.archiveReturns,[]);
  const after=ui.state();
  assert.equal(after.employees.filter(row=>row.active===0).length,100);
  assert.equal(after.employees[0].availabilityStatus,'dismissed');
  assert.equal(after.employees[50].availabilityStatus,'blacklisted');
  assert.equal(after.employees[300].position,'Монтажник','ignored employees are not edited');
  assert.deepEqual(after.assignments.filter(row=>row.employeeId===101).map(row=>[row.siteId,row.active]),[[7,0],[8,1]]);
  assert.deepEqual(after.profiles.filter(row=>row.employeeId===101).map(row=>[row.position,Boolean(row.validTo)]),[['Монтажник',true],['Сварщик',false]]);
  assert.deepEqual(after.reports,before.reports);assert.deepEqual(after.marks,before.marks);
  const returned=await ui.api.buildBitrixInspection([{...full[0],availabilityStatus:'intershift',stageName:'МО/О'},...full.slice(1)],{observeArchivedStatuses:true});
  assert.equal(returned.response.compared,400);
  assert.equal(returned.response.totalDifferences,15);
  assert.deepEqual(returned.response.archiveReturns.map(row=>row.bitrix24Id),['B1']);
  assert.match(returned.response.archiveReturns[0].details,/МО\/О/);
  assert.deepEqual(ui.state(),after,'a possible return never restores the local employee');
});

test('stale manual and bulk actions cannot alter archived employees or reuse their Bitrix24 links',async()=>{
  const ui=fixture([local(1,{active:0,siteId:null,availabilityStatus:'out_of_scope'}),local(2,{bitrix24Id:null})]);
  ui.setCheck(1,'blacklisted_in_bitrix');
  const before=ui.state();const active=[source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7']})];
  const dismissed=[source('B1',{availabilityStatus:'dismissed',stageName:'Увольнения'})];
  const identity={employeeId:1,bitrix24Id:'B1'};
  await assert.rejects(ui.api.updateBitrixEmployee(active,identity),/архив/i);
  await assert.rejects(ui.api.updateBitrixEmployee([source()],identity),/архив/i);
  await assert.rejects(ui.api.deleteBitrixEmployee(dismissed,identity),/архив/i);
  await assert.rejects(ui.api.deleteBitrixEmployee([],identity),/уже удалён/i);
  await assert.rejects(ui.api.updateSelectedBitrixEmployees([source()],{employeeIds:[1]}),/активном справочнике/);
  await assert.rejects(ui.api.createBitrixEmployee(active,{bitrix24Id:'B1',positionId:1,projectSiteId:7}),/уже связана/);
  await assert.rejects(ui.api.linkBitrixEmployees(active,[{bitrix24Id:'B1',employeeId:2}]),/карточка Битрикс24/i);
  assert.deepEqual(ui.state(),before);assert.deepEqual(ui.writes,[]);
});

test('ordinary update stops before history writes if the active-card update loses a race',async()=>{
  const ui=fixture([local()],{failActiveUpdate:true});
  const before=ui.state();
  const full=[source('B1',{availabilityStatus:'on_site',stageName:'На объекте',projectKeys:['QA7'],position:'Сварщик'})];
  await assert.rejects(ui.api.updateBitrixEmployee(full,{employeeId:1,bitrix24Id:'B1'}),/уже архивирована/i);
  assert.deepEqual(ui.state(),before);assert.deepEqual(ui.writes,[]);
});
