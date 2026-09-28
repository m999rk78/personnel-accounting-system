import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds the monthly timesheet from saved daily reports", async () => {
  const api = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle-postgres/0007_timesheet_marks.sql", import.meta.url), "utf8");
  const cleanupMigration = await readFile(new URL("../drizzle-postgres/0008_position_catalog_cleanup.sql", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const startup = await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
  const migrationRunner = await readFile(new URL("../scripts/apply-postgres-migrations.mjs", import.meta.url), "utf8");
  const yandexPostgres = await readFile(new URL("../scripts/yandex-postgres.mjs", import.meta.url), "utf8");

  assert.match(api, /getAuthUser\(request\)/);
  assert.match(api, /authUser\.role === "foreman"/);
  assert.match(api, /pe\.work_date >= \? AND pe\.work_date < \?/);
  assert.match(api, /SUM\(pe\.hours\)::int AS hours/);
  assert.match(api, /GROUP BY pe\.employee_id, pe\.work_date/);
  assert.match(api, /pe\.deleted_at IS NULL/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS timesheet_marks/);
  assert.match(api, /TIMESHEET_CODES/);
  assert.match(api, /assertSameOrigin\(request\)/);
  assert.match(api, /authUser\.role === "foreman"/);
  assert.match(api, /ON CONFLICT \(site_id, employee_id, work_date\) DO UPDATE/);
  assert.match(api, /hours BETWEEN 1 AND 10/);
  assert.match(api, /marks: marksResult\.results/);
  assert.doesNotMatch(api, /availability_status = 'on_site'/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS "timesheet_marks"/);
  assert.match(migration, /ALTER COLUMN "work_date" TYPE date/);
  assert.match(migration, /timesheet_hours_range/);
  assert.match(migration, /timesheet_value_required/);
  assert.match(migration, /idx_timesheet_marks_unique_day/);

  assert.match(cleanupMigration, /UPDATE "position_catalog"/);
  assert.match(cleanupMigration, /SET "active" = 0/);
  assert.doesNotMatch(cleanupMigration, /UPDATE "employees"/);
  assert.match(cleanupMigration, /'ОПР', 'УСР', 'Стропальщик'/);

  assert.match(dockerfile, /CMD \["node", "scripts\/start-production\.mjs"\]/);
  assert.match(dockerfile, /node_modules\/drizzle-orm/);
  assert.match(startup, /apply-postgres-migrations\.mjs/);
  assert.match(startup, /server\.js/);
  assert.match(migrationRunner, /pg_advisory_lock/);
  assert.match(migrationRunner, /pg_advisory_unlock/);
  assert.match(yandexPostgres, /rc1b-p176vla5mhlldu1a\.mdb\.yandexcloud\.net/);
  assert.match(yandexPostgres, /cloud-system-yums-personnel/);

  assert.match(view, /Табель учёта рабочего времени/);
  assert.match(view, /Расчётный месяц/);
  assert.match(view, /Заполнено дней/);
  assert.match(view, /Итого по дням/);
  assert.match(view, /сохранённых отчётов рабочих/);
  assert.match(view, /CustomSelect/);
  assert.match(view, /reconciliation\.mismatchedCells > 0/);
  assert.match(view, /Обнаружены расхождения/);
  assert.match(view, /Посмотреть расхождения/);
  assert.match(view, /showFirstMismatch/);
  assert.doesNotMatch(view, /Сверка с ежедневными отчётами/);
  assert.doesNotMatch(view, /По мастерам/);
  assert.doesNotMatch(view, /По зонам/);
  assert.match(view, /Двойной клик — изменить ячейку/);
  assert.match(view, /Вернуть данные отчёта/);
  assert.match(view, /TIMESHEET_CODES/);
  assert.match(view, /Ручная отметка хранится отдельно/);

  assert.match(app, /view === "timesheet"/);
  assert.match(app, /<TimesheetView/);
  assert.match(app, /timesheet-navigation/);
  assert.match(app, /Месячный табель/);
});
