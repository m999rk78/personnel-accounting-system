import assert from "node:assert/strict";
import test from "node:test";
import { pastedUserRole, userProjectAccessValid, userProjectLabel, userRoleChanges, userVisibleProjects } from "../app/userAccessModel.ts";

const sites = [{ id: 7, name: "Северный объект" }, { id: 8, name: "Южный объект" }];

test("viewer role starts with explicit project selection and never inherits all-project administration", () => {
  const result = userRoleChanges("viewer", "7", {mode:"all",siteIds:[]});
  assert.equal(result.role,"viewer");
  assert.deepEqual(result.projectAccess,{mode:"selected",siteIds:[]});
  assert.equal(result.canViewPendingReports,false);
  assert.deepEqual(userRoleChanges("superadmin","7").projectAccess,{mode:"all",siteIds:[]});
  assert.deepEqual(userRoleChanges("engineer","",{mode:"selected",siteIds:[7,8]}).projectAccess,{mode:"selected",siteIds:[7,8]});
});

test("role paste recognizes viewing and rejects the removed admin role", () => {
  for (const value of ["Просмотр","Наблюдатель","viewer"]) assert.equal(pastedUserRole(value),"viewer");
  for (const value of ["Админ","Администратор","admin"]) assert.equal(pastedUserRole(value),null);
  for (const value of ["Супер-админ","Супер администратор","superadmin"]) assert.equal(pastedUserRole(value),"superadmin");
  assert.equal(pastedUserRole("Инженер"),"engineer");
  assert.equal(pastedUserRole("Прораб"),"foreman");
});

test("project labels show role-independent selected projects and explicit no access", () => {
  assert.equal(userProjectLabel("engineer",null,sites),"Все проекты");
  assert.equal(userProjectLabel("viewer",null,sites),"Нет доступа к проектам");
  assert.equal(userProjectLabel("engineer",null,sites,{mode:"selected",siteIds:[7,8]}),"Северный объект, Южный объект");
  assert.equal(userProjectLabel("foreman",7,sites),"Северный объект");
  assert.equal(userProjectLabel("viewer",null,sites,{mode:"all",siteIds:[]}),"Все проекты");
});

test("cached navigation is narrowed or closed by the explicit user project list", () => {
  assert.deepEqual(userVisibleProjects({role:"engineer",assignedSiteId:null},sites),sites);
  for (const role of ["engineer","foreman","viewer"]) {
    assert.deepEqual(userVisibleProjects({role,assignedSiteId:7,projectAccess:{mode:"selected",siteIds:[8]}},sites),[sites[1]]);
    assert.deepEqual(userVisibleProjects({role,assignedSiteId:7,projectAccess:{mode:"selected",siteIds:[]}},sites),[]);
    assert.deepEqual(userVisibleProjects({role,assignedSiteId:null,projectAccess:{mode:"all",siteIds:[]}},sites),sites);
  }
});

test("creation validates visible selected project IDs but access settings can explicitly close all projects", () => {
  assert.equal(userProjectAccessValid({mode:"selected",siteIds:[7,8]},sites),true);
  assert.equal(userProjectAccessValid({mode:"selected",siteIds:[9]},sites),false);
  assert.equal(userProjectAccessValid({mode:"selected",siteIds:[]},sites),false);
  assert.equal(userProjectAccessValid({mode:"selected",siteIds:[]},sites,true),true);
  assert.equal(userProjectAccessValid({mode:"all",siteIds:[]},sites),true);
});
