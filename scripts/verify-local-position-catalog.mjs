import { readFile } from "node:fs/promises";
import pg from "pg";

const normalize = (value) => String(value ?? "").trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const key = (row) => [row.employmentType, row.department, row.position].map(normalize).join("\u0000");
const label = (row) => `${row.employmentType} | ${row.department} | ${row.position}`;

const expectedPath = process.argv[2];
if (!expectedPath) throw new Error("Передайте путь к JSON-каталогу должностей.");
const expectedRows = JSON.parse(await readFile(expectedPath, "utf8"));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const [catalogResult, optionsResult] = await Promise.all([
    pool.query(`SELECT employment_type AS "employmentType", department, position FROM position_catalog WHERE active = 1 ORDER BY employment_type, department, position`),
    pool.query(`SELECT kind, COUNT(*)::int AS count FROM personnel_options WHERE active = 1 GROUP BY kind ORDER BY kind`),
  ]);
  const expected = new Map(expectedRows.map((row) => [key(row), row]));
  const actual = new Map(catalogResult.rows.map((row) => [key(row), row]));
  const missing = [...expected].filter(([rowKey]) => !actual.has(rowKey)).map(([, row]) => label(row));
  const extra = [...actual].filter(([rowKey]) => !expected.has(rowKey)).map(([, row]) => label(row));
  console.log(JSON.stringify({
    ok: true,
    expectedRows: expectedRows.length,
    activeCatalogRows: catalogResult.rows.length,
    uniqueActiveCatalogRows: actual.size,
    missingCount: missing.length,
    extraCount: extra.length,
    missing,
    extra,
    optionCounts: optionsResult.rows,
  }, null, 2));
} finally {
  await pool.end();
}
