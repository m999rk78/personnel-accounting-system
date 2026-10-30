import type { PostgresDatabase } from "../db/client";

export type SubworkDirectoryInput = { directoryId?: number; name?: string; mainWorkTypeId?: number | null };
const normalize = (name: string) => name.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

/** Assign by stable ids; catalog names are read from the database and never rewritten. */
export async function assignWorkTypeChildren(db: PostgresDatabase, siteId: number, mainWorkTypeId: number, ids: number[]): Promise<number> {
  if (!Number.isSafeInteger(siteId) || siteId <= 0) throw new Error("Укажите действующий проект.");
  if (!Number.isSafeInteger(mainWorkTypeId) || mainWorkTypeId <= 0) throw new Error("Выберите вид работы.");
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Error("Выберите от 1 до 500 подвидов работ за один раз.");
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new Error("Укажите корректные подвиды без повторяющихся записей.");
  return db.transaction(async transaction => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`work-types:${siteId}`).first();
    const site = await transaction.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    const parent = await transaction.prepare("SELECT id FROM main_work_types WHERE id = ? AND site_id = ? AND active = 1 FOR SHARE").bind(mainWorkTypeId, siteId).first();
    if (!parent) throw new Error("Выберите действующий вид работы из этого проекта.");
    const selected = await transaction.prepare("SELECT id, name FROM subwork_types WHERE site_id = ? AND active = 1 AND id = ANY(?::integer[]) ORDER BY id FOR UPDATE").bind(siteId, ids).all<{ id: number; name: string }>();
    if (selected.results.length !== ids.length) throw new Error("Один из подвидов не найден в выбранном проекте или уже архивирован. Обновите справочник и повторите выбор.");
    const target = await transaction.prepare("SELECT name FROM subwork_types WHERE site_id = ? AND main_work_type_id = ? AND active = 1 AND id <> ALL(?::integer[]) ORDER BY id FOR UPDATE").bind(siteId, mainWorkTypeId, ids).all<{ name: string }>();
    const occupied = new Set(target.results.map(child => normalize(child.name)));
    for (const child of selected.results) {
      const key = normalize(child.name);
      if (occupied.has(key)) throw new Error(`Подвид «${child.name}» повторяется среди выбранных записей или уже есть в выбранном виде работы. Измените выбор или название подвида.`);
      occupied.add(key);
    }
    const result = await transaction.prepare("UPDATE subwork_types SET main_work_type_id = ? WHERE site_id = ? AND active = 1 AND id = ANY(?::integer[])").bind(mainWorkTypeId, siteId, ids).run();
    if (result.meta.changes !== ids.length) throw new Error("Не удалось назначить вид всем выбранным подвидам. Обновите справочник и повторите попытку.");
    return result.meta.changes;
  });
}

/** One transaction prevents partial classification and locks parents against archival. */
export async function saveSubworkDirectory(db: PostgresDatabase, siteId: number, rows: SubworkDirectoryInput[]) {
  if (!Number.isSafeInteger(siteId) || siteId <= 0 || !rows.length || rows.length > 500) throw new Error("Укажите проект и от 1 до 500 подвидов работ.");
  return db.transaction(async transaction => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`work-types:${siteId}`).first();
    const parents = await transaction.prepare("SELECT id FROM main_work_types WHERE site_id = ? AND active = 1 FOR SHARE").bind(siteId).all<{ id: number }>();
    const parentIds = new Set(parents.results.map(parent => parent.id));
    const children = await transaction.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE site_id = ? AND active = 1 FOR UPDATE").bind(siteId).all<{ id: number; name: string; mainWorkTypeId: number | null }>();
    const existing = new Set(children.results.map(child => child.id));
    const edited = rows.flatMap(row => row.directoryId ? [row.directoryId] : []);
    if (new Set(edited).size !== edited.length || edited.some(id => !Number.isSafeInteger(id) || !existing.has(id))) throw new Error("Подвид не найден в выбранном проекте или указан повторно.");
    const occupied = new Set(children.results.filter(child => !edited.includes(child.id)).map(child => `${child.mainWorkTypeId}/${normalize(child.name)}`));
    const prepared = rows.map((row, index) => {
      const name = row.name?.trim() ?? "";
      const parentId = row.mainWorkTypeId;
      if (!name || name.length > 240) throw new Error(`Строка ${index + 1}: укажите название до 240 символов.`);
      if (!parentId || !parentIds.has(parentId)) throw new Error(`Строка ${index + 1}: выберите действующий вид работы из этого проекта.`);
      const key = `${parentId}/${normalize(name)}`;
      if (occupied.has(key)) throw new Error(`Подвид «${name}» уже есть в выбранном виде работы.`);
      occupied.add(key);
      return { ...row, name, parentId };
    });
    const ids: number[] = [];
    for (const row of prepared) {
      if (row.directoryId) {
        await transaction.prepare("UPDATE subwork_types SET name = ?, main_work_type_id = ? WHERE id = ? AND site_id = ? AND active = 1").bind(row.name, row.parentId, row.directoryId, siteId).run();
        ids.push(row.directoryId);
      } else {
        const result = await transaction.prepare("INSERT INTO subwork_types (site_id, name, main_work_type_id) VALUES (?, ?, ?)").bind(siteId, row.name, row.parentId).run();
        ids.push(Number(result.meta.last_row_id));
      }
    }
    return ids;
  });
}

export async function importWorkTypeDirectory(db: PostgresDatabase, siteId: number, entries: Array<{ name: string; subworkName: string }>) {
  if (!Number.isSafeInteger(siteId) || siteId <= 0 || !Array.isArray(entries) || !entries.length || entries.length > 5000) throw new Error("Укажите проект и от 1 до 5000 строк.");
  const rows = entries.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Строка ${index + 1}: укажите вид и подвид работы.`);
    if (row.name != null && typeof row.name !== "string" || row.subworkName != null && typeof row.subworkName !== "string") throw new Error(`Строка ${index + 1}: названия вида и подвида должны быть текстом.`);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const subworkName = typeof row.subworkName === "string" ? row.subworkName.trim() : "";
    if ((!name && !subworkName) || name.length > 240 || subworkName.length > 240) throw new Error(`Строка ${index + 1}: заполните вид работы; названия должны быть до 240 символов.`);
    return { name, subworkName, rowNumber: index + 1 };
  });
  await db.transaction(async transaction => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`work-types:${siteId}`).first();
    const site = await transaction.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    const parents = await transaction.prepare("SELECT id, name FROM main_work_types WHERE site_id = ? AND active = 1 FOR UPDATE").bind(siteId).all<{ id: number; name: string }>();
    const children = await transaction.prepare("SELECT id, name, main_work_type_id AS mainWorkTypeId FROM subwork_types WHERE site_id = ? AND active = 1 FOR UPDATE").bind(siteId).all<{ id: number; name: string; mainWorkTypeId: number | null }>();
    const activeParents = new Set(parents.results.map(parent => parent.id));
    const parentMap = new Map<string, number>();
    for (const parent of parents.results) {
      const key = normalize(parent.name);
      if (parentMap.has(key)) throw new Error(`Название вида «${parent.name}» неоднозначно. Сначала исправьте дубликаты в справочнике.`);
      parentMap.set(key, parent.id);
    }
    const pairs = new Map<string, number>();
    const unassignedByName = new Map<string, typeof children.results>();
    const displayedUnassignedByName = new Map<string, typeof children.results>();
    for (const child of children.results) {
      const name = normalize(child.name);
      if (child.mainWorkTypeId !== null) {
        const key = `${child.mainWorkTypeId}/${name}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      } else {
        const matches = unassignedByName.get(name) ?? [];
        matches.push(child); unassignedByName.set(name, matches);
      }
      // The table also displays children of archived/missing parents as «Без вида».
      // Their exported blank parent must round-trip without clearing historical IDs.
      if (child.mainWorkTypeId === null || !activeParents.has(child.mainWorkTypeId)) {
        const matches = displayedUnassignedByName.get(name) ?? [];
        matches.push(child); displayedUnassignedByName.set(name, matches);
      }
    }
    for (const row of rows) if (!row.name) {
      const matches = displayedUnassignedByName.get(normalize(row.subworkName)) ?? [];
      if (matches.length > 1) throw new Error(`Строка ${row.rowNumber}: подвид «${row.subworkName}» без вида неоднозначен. Сначала исправьте дубликаты в справочнике.`);
      if (!matches.length) throw new Error(`Строка ${row.rowNumber}: заполните вид работы для подвида «${row.subworkName}». Новый подвид нельзя создать без вида работы.`);
    }
    // Preserve exported legacy unassigned rows as no-ops. New children always need a parent.
    // A nullable legacy child can be claimed once; equal names under other parents are separate children.
    const claimed = new Set<number>();
    for (const row of rows) {
      if (!row.name) continue;
      let parentId = parentMap.get(normalize(row.name));
      if (!parentId) {
        const result = await transaction.prepare("INSERT INTO main_work_types (site_id, name) VALUES (?, ?)").bind(siteId, row.name).run();
        parentId = Number(result.meta.last_row_id);
        if (!Number.isSafeInteger(parentId) || parentId <= 0) throw new Error(`Не удалось добавить вид «${row.name}». Изменения импорта отменены.`);
        parentMap.set(normalize(row.name), parentId);
      }
      if (!row.subworkName) continue;
      const key = `${parentId}/${normalize(row.subworkName)}`;
      const existingPairs = pairs.get(key) ?? 0;
      if (existingPairs > 1) throw new Error(`Подвид «${row.subworkName}» неоднозначен в виде «${row.name}». Сначала исправьте дубликаты в справочнике.`);
      if (existingPairs === 1) continue;
      const unassigned = (unassignedByName.get(normalize(row.subworkName)) ?? []).filter(child => !claimed.has(child.id));
      if (unassigned.length > 1) throw new Error(`Подвид «${row.subworkName}» неоднозначен. Назначьте вид вручную в разделе «Без вида».`);
      if (unassigned.length === 1) {
        const result = await transaction.prepare("UPDATE subwork_types SET main_work_type_id = ? WHERE id = ? AND site_id = ? AND main_work_type_id IS NULL AND active = 1").bind(parentId, unassigned[0].id, siteId).run();
        if (result.meta.changes !== 1) throw new Error(`Не удалось назначить вид подвиду «${row.subworkName}». Изменения импорта отменены.`);
        claimed.add(unassigned[0].id);
      } else await transaction.prepare("INSERT INTO subwork_types (site_id, name, main_work_type_id) VALUES (?, ?, ?)").bind(siteId, row.subworkName, parentId).run();
      pairs.set(key, 1);
    }
  });
  return rows.length;
}
