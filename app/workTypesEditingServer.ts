import type { PostgresDatabase } from "../db/client";

export type WorkTypeParentInput = { id?: number; clientKey: string; name: string; originalName?: string };
export type WorkTypeChildInput = {
  id?: number;
  clientKey: string;
  name: string;
  parentId: number | null;
  parentKey?: string;
  originalName?: string;
  originalParentId?: number | null;
};
export type WorkTypesSaveInput = { parents: WorkTypeParentInput[]; children: WorkTypeChildInput[] };
export type WorkTypesArchiveInput = { parents: number[]; children: number[] };
export type WorkTypesSaveResult = { parents: Array<{ clientKey: string; id: number }>; children: Array<{ clientKey: string; id: number }> };

type Parent = { id: number; name: string };
type Child = Parent & { parentId: number | null };
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const normalize = (name: string) => name.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");

function validSite(siteId: number) {
  if (!positiveId(siteId)) throw new Error("Укажите действующий проект.");
}

function prepareRows<T extends WorkTypeParentInput>(rows: T[], kind: string): T[] {
  const keys = new Set<string>();
  const ids = new Set<number>();
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Укажите корректные строки: ${kind}.`);
    if (typeof row.clientKey !== "string" || !row.clientKey.trim() || row.clientKey.length > 240 || keys.has(row.clientKey)) throw new Error(`Укажите уникальные ключи строк: ${kind}.`);
    keys.add(row.clientKey);
    if (row.id !== undefined) {
      if (!positiveId(row.id) || ids.has(row.id)) throw new Error(`Укажите корректные записи без повторений: ${kind}.`);
      ids.add(row.id);
    }
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || name.length > 240) throw new Error(`Строка ${index + 1} (${kind}): укажите название до 240 символов.`);
    if (row.originalName !== undefined && typeof row.originalName !== "string") throw new Error("Исходное название строки некорректно. Обновите справочник.");
    return { ...row, name };
  });
}

/** Parent/child changes share one project lock and transaction, including new parent references. */
export async function saveWorkTypesDirectory(db: PostgresDatabase, siteId: number, input: WorkTypesSaveInput): Promise<WorkTypesSaveResult> {
  validSite(siteId);
  if (!input || !Array.isArray(input.parents) || !Array.isArray(input.children) || !input.parents.length && !input.children.length || input.parents.length + input.children.length > 500) throw new Error("Укажите от 1 до 500 строк справочника за один раз.");
  const parentRows = prepareRows(input.parents, "виды работ");
  const childRows = prepareRows(input.children, "подвиды работ");
  const newParentKeys = new Set(parentRows.filter(row => row.id === undefined).map(row => row.clientKey));
  for (const row of childRows) {
    if (row.parentId !== null && !positiveId(row.parentId)) throw new Error("Выберите действующий вид работы из этого проекта.");
    if (row.parentKey !== undefined && (typeof row.parentKey !== "string" || !newParentKeys.has(row.parentKey) || row.parentId !== null)) throw new Error("Новый вид работы не найден среди сохраняемых строк.");
    if (row.originalParentId !== undefined && row.originalParentId !== null && !positiveId(row.originalParentId)) throw new Error("Исходный вид работы некорректен. Обновите справочник.");
  }
  return db.transaction(async transaction => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`work-types:${siteId}`).first();
    const site = await transaction.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    const parents = await transaction.prepare("SELECT id, name FROM main_work_types WHERE site_id = ? AND active = 1 ORDER BY id FOR UPDATE").bind(siteId).all<Parent>();
    const children = await transaction.prepare("SELECT id, name, main_work_type_id AS parentId FROM subwork_types WHERE site_id = ? AND active = 1 ORDER BY id FOR UPDATE").bind(siteId).all<Child>();
    const parentById = new Map(parents.results.map(row => [row.id, row]));
    const childById = new Map(children.results.map(row => [row.id, row]));
    for (const row of parentRows) {
      if (row.id === undefined) continue;
      const existing = parentById.get(row.id);
      if (!existing) throw new Error("Вид работы не найден в выбранном проекте или уже архивирован. Обновите справочник.");
      if (row.originalName !== undefined && row.originalName !== existing.name) throw new Error("Вид работы уже изменён другим пользователем. Обновите справочник и повторите изменения.");
    }
    for (const row of childRows) {
      if (row.parentId !== null && !parentById.has(row.parentId)) throw new Error("Выберите действующий вид работы из этого проекта.");
      if (row.id === undefined) continue;
      const existing = childById.get(row.id);
      if (!existing) throw new Error("Подвид не найден в выбранном проекте или уже архивирован. Обновите справочник.");
      if (row.originalName !== undefined && row.originalName !== existing.name || row.originalParentId !== undefined && row.originalParentId !== existing.parentId) throw new Error("Подвид уже изменён другим пользователем. Обновите справочник и повторите изменения.");
    }

    // Remove the edited rows before checking their final names, so swaps are valid.
    const editedParents = new Set(parentRows.flatMap(row => row.id === undefined ? [] : [row.id]));
    const parentNames = new Set(parents.results.filter(row => !editedParents.has(row.id)).map(row => normalize(row.name)));
    for (const row of parentRows) {
      const key = normalize(row.name);
      if (parentNames.has(key)) throw new Error(`Вид работы «${row.name}» уже есть в справочнике проекта.`);
      parentNames.add(key);
    }
    const editedChildren = new Set(childRows.flatMap(row => row.id === undefined ? [] : [row.id]));
    const childNames = new Set(children.results.filter(row => !editedChildren.has(row.id)).map(row => JSON.stringify([row.parentId, normalize(row.name)])));
    for (const row of childRows) {
      const parent = row.parentKey === undefined ? row.parentId : `new:${row.parentKey}`;
      const key = JSON.stringify([parent, normalize(row.name)]);
      if (childNames.has(key)) throw new Error(`Подвид «${row.name}» уже есть в выбранном виде работы.`);
      childNames.add(key);
    }

    const saved: WorkTypesSaveResult = { parents: [], children: [] };
    const newParentIds = new Map<string, number>();
    for (const row of parentRows) {
      let id = row.id;
      if (id === undefined) {
        const result = await transaction.prepare("INSERT INTO main_work_types (site_id, name) VALUES (?, ?)").bind(siteId, row.name).run();
        id = Number(result.meta.last_row_id);
        if (!positiveId(id)) throw new Error("Не удалось сохранить новый вид работы.");
        newParentIds.set(row.clientKey, id);
      } else {
        const result = await transaction.prepare("UPDATE main_work_types SET name = ? WHERE id = ? AND site_id = ? AND active = 1").bind(row.name, id, siteId).run();
        if (result.meta.changes !== 1) throw new Error("Не удалось сохранить вид работы. Обновите справочник.");
      }
      saved.parents.push({ clientKey: row.clientKey, id });
    }
    for (const row of childRows) {
      const parentId = row.parentKey === undefined ? row.parentId : newParentIds.get(row.parentKey);
      if (parentId === undefined) throw new Error("Не удалось сохранить новый вид работы для подвида.");
      let id = row.id;
      if (id === undefined) {
        const result = await transaction.prepare("INSERT INTO subwork_types (site_id, name, main_work_type_id) VALUES (?, ?, ?)").bind(siteId, row.name, parentId).run();
        id = Number(result.meta.last_row_id);
        if (!positiveId(id)) throw new Error("Не удалось сохранить новый подвид работы.");
      } else {
        const result = await transaction.prepare("UPDATE subwork_types SET name = ?, main_work_type_id = ? WHERE id = ? AND site_id = ? AND active = 1").bind(row.name, parentId, id, siteId).run();
        if (result.meta.changes !== 1) throw new Error("Не удалось сохранить подвид работы. Обновите справочник.");
      }
      saved.children.push({ clientKey: row.clientKey, id });
    }
    return saved;
  });
}

/** Soft archive keeps all report references and cascades each parent to its active children. */
export async function archiveWorkTypesDirectory(db: PostgresDatabase, siteId: number, input: WorkTypesArchiveInput) {
  validSite(siteId);
  if (!input || !Array.isArray(input.parents) || !Array.isArray(input.children) || !input.parents.length && !input.children.length || input.parents.length + input.children.length > 5000) throw new Error("Выберите от 1 до 5000 строк справочника за один раз.");
  if (input.parents.some(id => !positiveId(id)) || input.children.some(id => !positiveId(id))) throw new Error("Укажите корректные строки для архивирования.");
  const parentIds = [...new Set(input.parents)];
  const selectedChildIds = [...new Set(input.children)];
  return db.transaction(async transaction => {
    await transaction.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`work-types:${siteId}`).first();
    const site = await transaction.prepare("SELECT id FROM sites WHERE id = ? AND active = 1 FOR SHARE").bind(siteId).first();
    if (!site) throw new Error("Проект не найден или закрыт.");
    const parents = await transaction.prepare("SELECT id FROM main_work_types WHERE site_id = ? AND active = 1 AND id = ANY(?::integer[]) ORDER BY id FOR UPDATE").bind(siteId, parentIds).all<{ id: number }>();
    if (parents.results.length !== parentIds.length) throw new Error("Один из видов работ не найден в выбранном проекте или уже архивирован. Обновите справочник.");
    const children = await transaction.prepare("SELECT id FROM subwork_types WHERE site_id = ? AND active = 1 AND (id = ANY(?::integer[]) OR main_work_type_id = ANY(?::integer[])) ORDER BY id FOR UPDATE").bind(siteId, selectedChildIds, parentIds).all<{ id: number }>();
    const childIds = children.results.map(row => row.id);
    const foundChildren = new Set(childIds);
    if (selectedChildIds.some(id => !foundChildren.has(id))) throw new Error("Один из подвидов не найден в выбранном проекте или уже архивирован. Обновите справочник.");
    const archivedParents = await transaction.prepare("UPDATE main_work_types SET active = 0 WHERE site_id = ? AND active = 1 AND id = ANY(?::integer[])").bind(siteId, parentIds).run();
    const archivedChildren = await transaction.prepare("UPDATE subwork_types SET active = 0 WHERE site_id = ? AND active = 1 AND id = ANY(?::integer[])").bind(siteId, childIds).run();
    if (archivedParents.meta.changes !== parentIds.length || archivedChildren.meta.changes !== childIds.length) throw new Error("Не удалось архивировать все выбранные строки. Обновите справочник.");
    return { parents: archivedParents.meta.changes, children: archivedChildren.meta.changes, count: archivedParents.meta.changes + archivedChildren.meta.changes };
  });
}
