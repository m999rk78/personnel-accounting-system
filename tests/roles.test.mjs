import assert from "node:assert/strict";
import test from "node:test";

import {
  canAccessGeneralSettings,
  canAccessTimesheets,
  canEditGlobalEmployees,
  canEditGlobalReferences,
  canEditProjectSettings,
  canInspectBitrix24,
  canManageBitrix24,
  canViewAllProjects,
} from "../app/roles.ts";

test("foremen only manage today's report for their assigned project in the API and view project settings", () => {
  assert.equal(canAccessGeneralSettings("foreman"), false);
  assert.equal(canViewAllProjects("foreman"), false);
  assert.equal(canEditProjectSettings("foreman"), false);
  assert.equal(canEditGlobalEmployees("foreman"), false);
  assert.equal(canEditGlobalReferences("foreman"), false);
  assert.equal(canManageBitrix24("foreman"), false);
  assert.equal(canInspectBitrix24("foreman"), false);
  assert.equal(canAccessTimesheets("foreman"), false);
});

test("engineers manage employees and project settings but only view global references", () => {
  assert.equal(canAccessGeneralSettings("engineer"), true);
  assert.equal(canViewAllProjects("engineer"), true);
  assert.equal(canEditProjectSettings("engineer"), true);
  assert.equal(canEditGlobalEmployees("engineer"), true);
  assert.equal(canEditGlobalReferences("engineer"), false);
  assert.equal(canManageBitrix24("engineer"), false);
  assert.equal(canInspectBitrix24("engineer"), true);
  assert.equal(canAccessTimesheets("engineer"), true);
});

test("super-admins have full access", () => {
  assert.equal(canAccessGeneralSettings("superadmin"), true);
  assert.equal(canViewAllProjects("superadmin"), true);
  assert.equal(canEditProjectSettings("superadmin"), true);
  assert.equal(canEditGlobalEmployees("superadmin"), true);
  assert.equal(canEditGlobalReferences("superadmin"), true);
  assert.equal(canManageBitrix24("superadmin"), true);
  assert.equal(canInspectBitrix24("superadmin"), true);
  assert.equal(canAccessTimesheets("superadmin"), true);
});
