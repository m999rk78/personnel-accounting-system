import type { DatabaseResult, PostgresDatabase, PostgresStatement } from "../db/client";

/** Keep result slots stable without executing queries for unused/forbidden catalogs. */
export async function readOptionalBatch(database: Pick<PostgresDatabase, "readBatch">, statements: (PostgresStatement | null)[]) {
  const loaded = await database.readBatch(statements.filter((statement): statement is PostgresStatement => statement !== null));
  let index = 0;
  return statements.map((statement): DatabaseResult => statement ? loaded[index++] : {
    results: [], success: true, meta: { changes: 0, last_row_id: null },
  });
}
