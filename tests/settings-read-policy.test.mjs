import assert from "node:assert/strict";
import test from "node:test";
import { normalizePermissionSet, rolePermissionTemplate } from "../app/permissionModel.ts";
import { settingsReadPolicy } from "../app/settingsReadPolicy.ts";
import { readOptionalBatch } from "../app/readOptionalBatch.ts";

test("settings screens do not fetch unrelated company-wide catalogs", () => {
  const permissions = rolePermissionTemplate("superadmin");
  for (const section of ["employees", "positions", "users", "projects", "projectEmployees", "directories"]) {
    const policy = settingsReadPolicy(permissions, section);
    assert.equal(policy.allowed, true);
    assert.equal(policy.sync, section === "employees");
    assert.equal(policy.directories, section === "directories");
    assert.equal(policy.users, section === "users");
    assert.equal(policy.projectStats, section === "projects");
    assert.equal(policy.projectEmployees, ["projectEmployees", "directories"].includes(section));
    assert.equal(policy.positions, ["positions", "employees"].includes(section));
    assert.equal(policy.employees, ["employees", "projectEmployees"].includes(section));
  }
  assert.equal(settingsReadPolicy(permissions, "unknown").allowed, false);
});

test("catalog selection never grants access through a different settings section", () => {
  const permissions = normalizePermissionSet({ project_employees: { view: true, create: true } });
  assert.equal(settingsReadPolicy(permissions, "employees").allowed, false);
  assert.equal(settingsReadPolicy(permissions, "projectEmployees").employees, true, "adding existing staff needs the available employee catalog");
  const readOnly = normalizePermissionSet({ project_employees: { view: true } });
  const policy = settingsReadPolicy(readOnly, "projectEmployees");
  assert.equal(policy.employees, false);
  assert.equal(policy.projectEmployees, true);
  assert.equal(policy.users, false);
  assert.equal(policy.positions, false);
});

test("employee editors retain dependent position choices without exposing positions as a page", () => {
  const permissions = normalizePermissionSet({ employees: { view: true, update: true } });
  assert.equal(settingsReadPolicy(permissions, "employees").positions, true);
  assert.equal(settingsReadPolicy(permissions, "positions").allowed, false);
  assert.equal(settingsReadPolicy(normalizePermissionSet({ employees: { view: true } }), "employees").positions, false);
});

test("older clients keep their permitted catalogs when section is absent", () => {
  const policy = settingsReadPolicy(rolePermissionTemplate("superadmin"), null);
  assert.ok(Object.values(policy).every(Boolean));
  assert.equal(settingsReadPolicy(normalizePermissionSet({ workers_report: { view: true } }), null).allowed, false);
});

test("optional batch executes only selected SQL and preserves empty result slots", async () => {
  const statements = [{ id: 1 }, { id: 2 }];
  const calls = [];
  const db = { async readBatch(selected) { calls.push(selected); return selected.map(item => ({ results: [item], success: true, meta: { changes: 1, last_row_id: null } })); } };
  const results = await readOptionalBatch(db, [null, statements[0], null, statements[1]]);
  assert.deepEqual(calls, [statements]);
  assert.deepEqual(results.map(result => result.results), [[], [{ id: 1 }], [], [{ id: 2 }]]);
  await readOptionalBatch(db, [null]);
  assert.deepEqual(calls[1], []);
});
