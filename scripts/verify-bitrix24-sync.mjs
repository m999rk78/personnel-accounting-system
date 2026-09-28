import pg from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not configured");
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const employees = await client.query(`
      SELECT availability_status, active, COUNT(*)::int AS count
      FROM employees
      WHERE source = 'bitrix24'
      GROUP BY availability_status, active
      ORDER BY availability_status, active DESC
    `);
  const assignments = await client.query(`
      SELECT s.name AS site, COUNT(*)::int AS count
      FROM employee_project_assignments epa
      JOIN employees e ON e.id = epa.employee_id
      JOIN sites s ON s.id = epa.site_id
      WHERE e.source = 'bitrix24' AND epa.active = 1
      GROUP BY s.name
      ORDER BY s.name
    `);
  const reportEligible = await client.query(`
      SELECT s.name AS site, COUNT(*)::int AS count
      FROM employee_project_assignments epa
      JOIN employees e ON e.id = epa.employee_id
      JOIN sites s ON s.id = epa.site_id
      WHERE e.source = 'bitrix24'
        AND e.active = 1
        AND e.sync_error IS NULL
        AND e.availability_status = 'on_site'
        AND epa.active = 1
      GROUP BY s.name
      ORDER BY s.name
    `);
  const checks = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE sync_error IS NOT NULL)::int AS sync_errors,
        COUNT(*) FILTER (
          WHERE availability_status IN ('intershift', 'transfer')
            AND EXISTS (
              SELECT 1
              FROM employee_project_assignments epa
              WHERE epa.employee_id = employees.id AND epa.active = 1
            )
        )::int AS unavailable_with_preserved_assignment,
        COUNT(*)::int AS total
      FROM employees
      WHERE source = 'bitrix24'
    `);
  const lastRun = await client.query(`
      SELECT status, summary::jsonb AS summary, completed_at
      FROM employee_sync_runs
      ORDER BY id DESC
      LIMIT 1
    `);

  console.log(JSON.stringify({
    employeesByStatus: employees.rows,
    activeAssignments: assignments.rows,
    reportEligibleBySite: reportEligible.rows,
    checks: checks.rows[0],
    lastRun: lastRun.rows[0],
  }, null, 2));
} finally {
  await client.end();
}
