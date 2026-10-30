import type { PostgresDatabase } from "../db/client";

export const PROJECT_MASTER_POSITIONS = [
  "Мастер участка строительных конструкций",
  "Мастер участка технологических трубопроводов",
] as const;

export const normalizeProjectMasterText = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const positions = new Set(PROJECT_MASTER_POSITIONS.map(normalizeProjectMasterText));
export const isProjectMasterPosition = (position: string) => positions.has(normalizeProjectMasterText(position));

type Employee = { id: number; fullName: string; position: string };
type Master = { id: number; name: string; active: number; employeeId: number | null };
type MasterUpdate = { id: number; employeeId: number; name: string; active: number };

/** Employees are already scoped to active assignments; manual legacy masters stay untouched. */
export function planProjectMasters(employees: readonly Employee[], masters: readonly Master[]) {
  const eligible = employees.filter(employee => employee.fullName.trim() && isProjectMasterPosition(employee.position));
  const byEmployee = new Map(eligible.map(employee => [employee.id, employee]));
  const linked = new Set(masters.flatMap(master => master.employeeId == null ? [] : [master.employeeId]));
  const employeeNames = new Map<string, number>();
  for (const employee of employees) {
    const name = normalizeProjectMasterText(employee.fullName);
    employeeNames.set(name, (employeeNames.get(name) ?? 0) + 1);
  }
  const legacy = new Map<string, Master[]>();
  for (const master of masters) if (master.employeeId == null) {
    const name = normalizeProjectMasterText(master.name);
    legacy.set(name, [...(legacy.get(name) ?? []), master]);
  }
  const updates: MasterUpdate[] = [];
  const inserts: Array<{ employeeId: number; name: string }> = [];
  for (const master of masters) {
    if (master.employeeId == null) continue;
    const employee = byEmployee.get(master.employeeId);
    const active = employee ? 1 : 0;
    const name = employee ? employee.fullName.trim() : master.name;
    if (master.active !== active || master.name !== name) updates.push({ id: master.id, employeeId: master.employeeId, name, active });
  }
  for (const employee of byEmployee.values()) {
    if (linked.has(employee.id)) continue;
    const key = normalizeProjectMasterText(employee.fullName);
    const candidates = legacy.get(key) ?? [];
    if (employeeNames.get(key) === 1 && candidates.length === 1) {
      updates.push({ id: candidates[0].id, employeeId: employee.id, name: employee.fullName.trim(), active: 1 });
    } else inserts.push({ employeeId: employee.id, name: employee.fullName.trim() });
  }
  return { updates, inserts };
}

type Database = Pick<PostgresDatabase, "prepare" | "transaction">;
const schemaTasks = new WeakMap<Database, Promise<void>>();

export async function ensureProjectMastersSchema(db: Database) {
  let task = schemaTasks.get(db);
  if (!task) {
    task = (async () => {
      await db.prepare("ALTER TABLE masters ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id)").run();
      await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_masters_project_employee ON masters(site_id, employee_id) WHERE employee_id IS NOT NULL").run();
    })().catch(error => { schemaTasks.delete(db); throw error; });
    schemaTasks.set(db, task);
  }
  await task;
}

/** Reconcile before returning a project catalog, regardless of how its employees were changed. */
export async function syncProjectMasters(database: Database, siteId: number) {
  if (!Number.isSafeInteger(siteId) || siteId < 1) throw new Error("Укажите действующий проект мастеров.");
  await ensureProjectMastersSchema(database);
  return database.transaction(async db => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`project-masters:${siteId}`).first();
    const employees = await db.prepare(`SELECT e.id, e.full_name AS fullName, e.position FROM employees e
      JOIN employee_project_assignments assignment ON assignment.employee_id = e.id AND assignment.site_id = ? AND assignment.active = 1
      JOIN sites project ON project.id = assignment.site_id AND project.active = 1
      WHERE e.active = 1 ORDER BY e.id FOR SHARE OF e, assignment, project`).bind(siteId).all<Employee>();
    const masters = await db.prepare("SELECT id, name, active, employee_id AS employeeId FROM masters WHERE site_id = ? ORDER BY id FOR UPDATE").bind(siteId).all<Master>();
    const plan = planProjectMasters(employees.results, masters.results);
    const before = new Map(masters.results.map(master => [master.id, master]));
    const renamed = plan.updates.filter(update => before.get(update.id)?.name !== update.name).map(update => update.id);
    if (renamed.length) {
      // Fill only missing historical snapshots while the old directory name is still available.
      await db.prepare(`UPDATE placement_entries entry SET master_name_snapshot = master.name FROM masters master
        WHERE entry.master_id = master.id AND master.id = ANY(?::integer[]) AND entry.master_name_snapshot = ''`).bind(renamed).run();
      const reports = await db.prepare("SELECT to_regclass('personnel_report_rows') IS NOT NULL AS present").first<{ present: boolean }>();
      if (reports?.present) await db.prepare(`UPDATE personnel_report_rows row SET master_name_snapshot = master.name FROM masters master
        WHERE row.master_id = master.id AND master.id = ANY(?::integer[]) AND row.master_name_snapshot = ''`).bind(renamed).run();
    }
    for (const update of plan.updates) await db.prepare("UPDATE masters SET employee_id = ?, name = ?, active = ? WHERE id = ? AND site_id = ?")
      .bind(update.employeeId, update.name, update.active, update.id, siteId).run();
    for (const insert of plan.inserts) await db.prepare("INSERT INTO masters (site_id, employee_id, name) VALUES (?, ?, ?)")
      .bind(siteId, insert.employeeId, insert.name).run();
    return { added: plan.inserts.length, updated: plan.updates.length };
  });
}
