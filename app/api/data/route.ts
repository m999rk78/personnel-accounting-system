import { env } from "cloudflare:workers";

type EntryPayload = {
  id?: number;
  siteId?: number;
  workDate?: string;
  employeeId?: number;
  shiftId?: number;
  zoneId?: number;
  mainWorkTypeId?: number;
  subworkTypeId?: number;
  note?: string;
  masterId?: number;
  hours?: number;
};

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bitrix24_id TEXT UNIQUE,
    full_name TEXT NOT NULL,
    position TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'excel',
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS main_work_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS subwork_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS placement_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    work_date TEXT NOT NULL,
    employee_id INTEGER NOT NULL,
    shift_id INTEGER NOT NULL,
    zone_id INTEGER NOT NULL,
    main_work_type_id INTEGER NOT NULL,
    subwork_type_id INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    master_id INTEGER NOT NULL,
    hours INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 10),
    position_snapshot TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'demo-user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_site_date ON placement_entries(site_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_employee_date ON placement_entries(employee_id, work_date)`,
];

async function initializeDatabase() {
  const db = env.DB;
  await db.batch(TABLE_STATEMENTS.map((statement) => db.prepare(statement)));

  const siteCount = await db.prepare("SELECT COUNT(*) AS count FROM sites").first<{ count: number }>();
  if ((siteCount?.count ?? 0) > 0) return;

  const today = new Date().toISOString().slice(0, 10);
  await db.batch([
    db.prepare("INSERT INTO sites (id, name, code) VALUES (1, ?, ?)").bind("ГПЗ — Установка 2", "GPZ-U2"),
    db.prepare("INSERT INTO sites (id, name, code) VALUES (2, ?, ?)").bind("Площадка Северная", "NORTH"),
    db.prepare("INSERT INTO employees (id, full_name, position) VALUES (1, ?, ?)").bind("Иванов Сергей Петрович", "Монтажник технологических трубопроводов"),
    db.prepare("INSERT INTO employees (id, full_name, position) VALUES (2, ?, ?)").bind("Абдуллаев Рустам Каримович", "Электрогазосварщик"),
    db.prepare("INSERT INTO employees (id, full_name, position) VALUES (3, ?, ?)").bind("Петров Алексей Николаевич", "Стропальщик"),
    db.prepare("INSERT INTO employees (id, full_name, position) VALUES (4, ?, ?)").bind("Саидов Джамшед Махмудович", "Монтажник металлоконструкций"),
    db.prepare("INSERT INTO employees (id, full_name, position) VALUES (5, ?, ?)").bind("Ким Андрей Викторович", "Мастер строительно-монтажных работ"),
    db.prepare("INSERT INTO employees (id, full_name, position) VALUES (6, ?, ?)").bind("Смирнов Николай Олегович", "Подсобный рабочий"),
    db.prepare("INSERT INTO shifts (id, site_id, name) VALUES (1, 1, 'день'), (2, 1, 'ночь'), (3, 1, 'пересменка'), (4, 2, 'день'), (5, 2, 'ночь')"),
    db.prepare("INSERT INTO zones (id, site_id, name) VALUES (1, 1, 'G4-C1810BX0'), (2, 1, 'G3-B1110BX0'), (3, 1, 'G1-B6710RX0'), (4, 1, 'отсутствует'), (5, 2, 'Секция A'), (6, 2, 'Секция B')"),
    db.prepare("INSERT INTO main_work_types (id, site_id, name) VALUES (1, 1, 'Трубопроводы /// Монтаж'), (2, 1, 'Трубопроводы /// Сварка'), (3, 1, 'Металлоконструкции /// Эстакады'), (4, 1, 'Вспомогательные и прочие работы'), (5, 2, 'Монтаж оборудования'), (6, 2, 'Подготовительные работы')"),
    db.prepare("INSERT INTO subwork_types (id, site_id, name) VALUES (1, 1, 'Вспомогательные или прочие работы'), (2, 1, 'Погрузо-разгрузка, сортировка, склад'), (3, 1, 'Подготовка к сварочным работам'), (4, 1, 'Подкрасочные работы'), (5, 2, 'Сортировка материала'), (6, 2, 'Дополнительные работы')"),
    db.prepare("INSERT INTO masters (id, site_id, name) VALUES (1, 1, 'Ниязметов Анвар Аминбаевич'), (2, 1, 'Мурзаев Алишер'), (3, 1, 'Раджабов Султонназир'), (4, 2, 'Кузнецов Артём Игоревич'), (5, 2, 'Орлов Максим Павлович')"),
    db.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (1, ?, 1, 1, 1, 1, 1, '', 1, 6, ?)`)
      .bind(today, "Монтажник технологических трубопроводов"),
    db.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (1, ?, 1, 1, 2, 4, 2, 'Перемещение материала', 2, 4, ?)`)
      .bind(today, "Монтажник технологических трубопроводов"),
    db.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (1, ?, 2, 1, 1, 2, 3, '', 1, 10, ?)`)
      .bind(today, "Электрогазосварщик"),
  ]);
  await db.prepare("PRAGMA optimize").run();
}

function asPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function validatePayload(payload: EntryPayload, excludedId?: number) {
  const siteId = asPositiveInteger(payload.siteId);
  const employeeId = asPositiveInteger(payload.employeeId);
  const shiftId = asPositiveInteger(payload.shiftId);
  const zoneId = asPositiveInteger(payload.zoneId);
  const mainWorkTypeId = asPositiveInteger(payload.mainWorkTypeId);
  const subworkTypeId = asPositiveInteger(payload.subworkTypeId);
  const masterId = asPositiveInteger(payload.masterId);
  const hours = asPositiveInteger(payload.hours);

  if (!siteId || !employeeId || !shiftId || !zoneId || !mainWorkTypeId || !subworkTypeId || !masterId || !hours || !validDate(payload.workDate)) {
    throw new Error("Заполните все обязательные поля строки.");
  }
  if (hours < 1 || hours > 10) throw new Error("Количество часов должно быть от 1 до 10.");

  const employee = await env.DB.prepare("SELECT position FROM employees WHERE id = ? AND active = 1")
    .bind(employeeId).first<{ position: string }>();
  if (!employee?.position) throw new Error("У выбранного сотрудника не заполнена должность.");

  const refs = await env.DB.batch([
    env.DB.prepare("SELECT id FROM shifts WHERE id = ? AND site_id = ? AND active = 1").bind(shiftId, siteId),
    env.DB.prepare("SELECT id FROM zones WHERE id = ? AND site_id = ? AND active = 1").bind(zoneId, siteId),
    env.DB.prepare("SELECT id FROM main_work_types WHERE id = ? AND site_id = ? AND active = 1").bind(mainWorkTypeId, siteId),
    env.DB.prepare("SELECT id FROM subwork_types WHERE id = ? AND site_id = ? AND active = 1").bind(subworkTypeId, siteId),
    env.DB.prepare("SELECT id FROM masters WHERE id = ? AND site_id = ? AND active = 1").bind(masterId, siteId),
  ]);
  if (refs.some((result) => result.results.length === 0)) throw new Error("Одно из значений не относится к выбранному объекту.");

  const excluded = excludedId ? "AND id <> ?" : "";
  const statement = env.DB.prepare(`SELECT COALESCE(SUM(hours), 0) AS used FROM placement_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL ${excluded}`);
  const total = excludedId
    ? await statement.bind(employeeId, payload.workDate, excludedId).first<{ used: number }>()
    : await statement.bind(employeeId, payload.workDate).first<{ used: number }>();
  const used = Number(total?.used ?? 0);
  if (used + hours > 10) throw new Error(`У сотрудника уже учтено ${used} ч. После сохранения получится ${used + hours} ч., максимум — 10.`);

  return { siteId, employeeId, shiftId, zoneId, mainWorkTypeId, subworkTypeId, masterId, hours, workDate: payload.workDate, note: payload.note?.trim() ?? "", position: employee.position };
}

export async function GET(request: Request) {
  try {
    await initializeDatabase();
    const url = new URL(request.url);
    const siteId = asPositiveInteger(url.searchParams.get("siteId")) ?? 1;
    const workDate = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const [sites, employees, shifts, zones, mainWorkTypes, subworkTypes, masters, entries] = await env.DB.batch([
      env.DB.prepare("SELECT id, name, code, timezone FROM sites WHERE active = 1 ORDER BY id"),
      env.DB.prepare("SELECT id, full_name AS fullName, position, source FROM employees WHERE active = 1 ORDER BY full_name"),
      env.DB.prepare("SELECT id, name FROM shifts WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM zones WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM main_work_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM subwork_types WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare("SELECT id, name FROM masters WHERE active = 1 AND site_id = ? ORDER BY id").bind(siteId),
      env.DB.prepare(`SELECT pe.id, pe.site_id AS siteId, pe.work_date AS workDate, pe.employee_id AS employeeId,
        pe.shift_id AS shiftId, pe.zone_id AS zoneId, pe.main_work_type_id AS mainWorkTypeId,
        pe.subwork_type_id AS subworkTypeId, pe.note, pe.master_id AS masterId, pe.hours,
        pe.position_snapshot AS positionSnapshot, e.full_name AS employeeName, s.name AS shiftName,
        z.name AS zoneName, mw.name AS mainWorkTypeName, sw.name AS subworkTypeName, m.name AS masterName
        FROM placement_entries pe
        JOIN employees e ON e.id = pe.employee_id
        JOIN shifts s ON s.id = pe.shift_id
        JOIN zones z ON z.id = pe.zone_id
        JOIN main_work_types mw ON mw.id = pe.main_work_type_id
        JOIN subwork_types sw ON sw.id = pe.subwork_type_id
        JOIN masters m ON m.id = pe.master_id
        WHERE pe.site_id = ? AND pe.work_date = ? AND pe.deleted_at IS NULL
        ORDER BY e.full_name, pe.created_at, pe.id`).bind(siteId, workDate),
    ]);
    return Response.json({ sites: sites.results, employees: employees.results, shifts: shifts.results, zones: zones.results, mainWorkTypes: mainWorkTypes.results, subworkTypes: subworkTypes.results, masters: masters.results, entries: entries.results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось загрузить данные." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await initializeDatabase();
    const payload = (await request.json()) as EntryPayload;
    const data = await validatePayload(payload);
    const result = await env.DB.prepare(`INSERT INTO placement_entries
      (site_id, work_date, employee_id, shift_id, zone_id, main_work_type_id, subwork_type_id, note, master_id, hours, position_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position).run();
    return Response.json({ id: result.meta.last_row_id }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить строку." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    await initializeDatabase();
    const payload = (await request.json()) as EntryPayload;
    const id = asPositiveInteger(payload.id);
    if (!id) throw new Error("Не указана строка для изменения.");
    const data = await validatePayload(payload, id);
    await env.DB.prepare(`UPDATE placement_entries SET site_id = ?, work_date = ?, employee_id = ?, shift_id = ?, zone_id = ?,
      main_work_type_id = ?, subwork_type_id = ?, note = ?, master_id = ?, hours = ?, position_snapshot = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL`)
      .bind(data.siteId, data.workDate, data.employeeId, data.shiftId, data.zoneId, data.mainWorkTypeId, data.subworkTypeId, data.note, data.masterId, data.hours, data.position, id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось изменить строку." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    await initializeDatabase();
    const id = asPositiveInteger(new URL(request.url).searchParams.get("id"));
    if (!id) throw new Error("Не указана строка для удаления.");
    await env.DB.prepare("UPDATE placement_entries SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось удалить строку." }, { status: 400 });
  }
}
