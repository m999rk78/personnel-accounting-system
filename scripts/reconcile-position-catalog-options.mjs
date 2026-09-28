import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE personnel_options SET active = 0 WHERE kind = 'employmentType' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND employment_type = personnel_options.name)");
  await client.query("UPDATE personnel_options SET active = 0 WHERE kind = 'department' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND department = personnel_options.name)");
  await client.query("UPDATE personnel_options SET active = 0 WHERE kind = 'position' AND active = 1 AND NOT EXISTS (SELECT 1 FROM position_catalog WHERE active = 1 AND position = personnel_options.name)");
  await client.query("INSERT INTO personnel_options (kind, name) SELECT DISTINCT 'employmentType', employment_type FROM position_catalog WHERE employment_type <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'employmentType' AND name = position_catalog.employment_type AND active = 1)");
  await client.query("INSERT INTO personnel_options (kind, name) SELECT DISTINCT 'department', department FROM position_catalog WHERE department <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'department' AND name = position_catalog.department AND active = 1)");
  await client.query("INSERT INTO personnel_options (kind, name) SELECT DISTINCT 'position', position FROM position_catalog WHERE position <> '' AND active = 1 AND NOT EXISTS (SELECT 1 FROM personnel_options WHERE kind = 'position' AND name = position_catalog.position AND active = 1)");
  const result = await client.query("SELECT kind, COUNT(*)::int AS count FROM personnel_options WHERE active = 1 AND kind IN ('employmentType', 'department', 'position') GROUP BY kind ORDER BY kind");
  await client.query("COMMIT");
  console.log(JSON.stringify({ ok: true, optionCounts: result.rows }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
