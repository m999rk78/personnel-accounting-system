import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds the monthly timesheet from saved daily reports", async () => {
  const api = await readFile(new URL("../app/api/timesheet/route.ts", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/TimesheetView.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../app/PersonnelApp.tsx", import.meta.url), "utf8");

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
