import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessGeneralSettings, canAccessTimesheets, canEditGlobalEmployees, canEditGlobalReferences, canEditProjectSettings, canInspectBitrix24, canManageBitrix24, canViewAllProjects, canAccessProject, isUserRole, effectiveProjectAccess } from '../app/roles.ts';

test('only foreman, engineer, viewer and superadmin remain selectable roles', () => {
  for (const role of ['foreman','engineer','viewer','superadmin']) assert.equal(isUserRole(role),true);
  for (const role of ['admin','office','administrator','unknown']) assert.equal(isUserRole(role),false);
});
test('legacy foremen keep their assigned project until explicit access is configured', () => {
  const actor={role:'foreman',assignedSiteId:7};
  assert.equal(canAccessGeneralSettings('foreman'),false);
  assert.equal(canEditProjectSettings('foreman'),false);
  assert.equal(canAccessTimesheets('foreman'),false);
  assert.equal(canAccessProject(actor,7),true);
  assert.equal(canAccessProject(actor,8),false);
  assert.equal(canAccessProject({...actor,assignedSiteId:null},7),false);
});
test('engineers recover their previous working role and all-project default', () => {
  assert.equal(canViewAllProjects('engineer'),true);
  assert.equal(canAccessProject({role:'engineer',assignedSiteId:7},8),true);
  assert.equal(canEditGlobalEmployees('engineer'),true);
  assert.equal(canEditProjectSettings('engineer'),true);
  assert.equal(canInspectBitrix24('engineer'),true);
  assert.equal(canEditGlobalReferences('engineer'),false);
  assert.equal(canManageBitrix24('engineer'),false);
});
test('explicit project grants are independent of role and legacy assignment', () => {
  for (const role of ['foreman','engineer','viewer']) {
    const actor={role,assignedSiteId:99,projectAccess:{mode:'selected',siteIds:[7,8]}};
    assert.equal(canAccessProject(actor,7),true);
    assert.equal(canAccessProject(actor,8),true);
    assert.equal(canAccessProject(actor,99),false);
    assert.equal(canAccessProject({...actor,projectAccess:{mode:'selected',siteIds:[]}},7),false);
    assert.equal(canAccessProject({...actor,projectAccess:{mode:'all',siteIds:[]}},99),true);
  }
  assert.equal(canAccessProject({role:'unknown',assignedSiteId:7},7),false);
});
test('viewer starts with no project grants and no editing role capabilities', () => {
  assert.deepEqual(effectiveProjectAccess({role:'viewer'}),{mode:'selected',siteIds:[]});
  assert.equal(canAccessProject({role:'viewer',assignedSiteId:7},7),false);
  assert.equal(canAccessTimesheets('viewer'),true);
  assert.equal(canEditGlobalEmployees('viewer'),false);
  assert.equal(canEditProjectSettings('viewer'),false);
});
test('superadmin keeps all projects including when a stale selected list is supplied', () => {
  assert.equal(canAccessProject({role:'superadmin',projectAccess:{mode:'selected',siteIds:[]}},7),true);
  assert.equal(canEditGlobalReferences('superadmin'),true);
  assert.equal(canManageBitrix24('superadmin'),true);
  assert.equal(canAccessProject({role:'superadmin'},0),false);
});
