import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SelectionCopyTarget } from "./selection-copy-target";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgGridProvider } from "ag-grid-react";
import { TableOrderProvider } from "../../app/TableRowMoves";
import { moveRowBlock, reconcileRowOrder } from "../../app/tableRowOrder";
import { isWorkTypesOrderId } from "../../app/workTypesRowOrder";
import { WorkTypesDirectory } from "../../app/WorkTypesDirectory";
import type { WorkTypeOption } from "../../app/workTypeHierarchy";
import type { WorkTypeChildInput, WorkTypeParentInput, WorkTypesSaveResult } from "../../app/workTypesEditingServer";
import "../../app/globals.css";

type Sample = "sample" | "large" | "empty";
const parentNames = ["Вспомогательные работы", "Земляные работы", "Монтаж металлоконструкций", "Бетонные работы", "Сварка технологических трубопроводов", "Монтаж оборудования", "Электромонтажные работы", "Подготовительные монтажные работы", "Погрузочно-разгрузочные работы", "Отделочные работы", "Дорожные работы", "Благоустройство территории"];
const childNames = ["Перевозка персонала", "Уборка территории и подготовка площадки к проведению строительно-монтажных работ", "Перемещение материалов между зонами строительства", "Погрузка и разгрузка строительных материалов", "Подготовка оборудования к выполнению работ", "Монтаж запорной арматуры", "Подготовка к гидравлическим испытаниям"];
const longName = "Уборка территории и подготовка строительной площадки, перемещение оборудования и материалов между рабочими зонами, вывоз отходов после выполнения монтажных работ, подготовка временных подъездных путей и организация безопасного прохода.";

function makeData(sample: Sample) {
  if (sample === "empty") return { parents: [] as WorkTypeOption[], children: [] as WorkTypeOption[] };
  const parentCount = sample === "large" ? 500 : 12;
  const assignedCount = sample === "large" ? 49_995 : 80;
  const parents: WorkTypeOption[] = Array.from({ length: parentCount }, (_, index) => ({ id: index + 1, name: `${parentNames[index % parentNames.length]}${index >= parentNames.length ? ` — участок ${index + 1}` : ""}` }));
  const children: WorkTypeOption[] = Array.from({ length: assignedCount }, (_, index) => ({
    id: index + 1_001,
    name: index === 1 ? longName : index < 2 ? childNames[index] : `${childNames[index % childNames.length]} — операция ${index + 1}`,
    mainWorkTypeId: index < 7 ? 1 : index % (parentCount - 2) + 1,
  }));
  children.push(...Array.from({ length: 5 }, (_, index) => ({ id: assignedCount + index + 1_001, name: ["Погрузка и разгрузка материалов", "Расчистка временных проездов", "Доставка инструмента к месту работ", "Разборка временных ограждений", "Вывоз строительного мусора"][index], mainWorkTypeId: index === 4 ? 999_999 : null })));
  return { parents, children };
}

// Isolated UI fixture: known APIs change browser memory; all other requests are blocked.
let { parents, children } = makeData("sample");
let nextId = 100_000;
let savedRowOrder: string[] = [];
let hasSavedOrder = false;
type DirectoryMutation = { directoryId?: number; name?: string; mainWorkTypeId?: number | null };
function saveItem(isParent: boolean, mutation: DirectoryMutation): number {
  const id = mutation.directoryId ?? nextId++;
  const list = isParent ? parents : children;
  const previous = list.find(item => item.id === id);
  const item: WorkTypeOption = { id, name: mutation.name ?? previous?.name ?? "", ...(isParent ? {} : { mainWorkTypeId: mutation.mainWorkTypeId === undefined ? previous?.mainWorkTypeId ?? null : mutation.mainWorkTypeId }) };
  const updated = previous ? list.map(row => row.id === id ? item : row) : [...list, item];
  if (isParent) parents = updated; else children = updated;
  return id;
}
const normalizeName = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
function prepareRows<T extends WorkTypeParentInput>(rows: T[], kind: string): T[] {
  const keys = new Set<string>();
  const ids = new Set<number>();
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Укажите строки справочника.");
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
function saveWorkTypes(parentInput: WorkTypeParentInput[], childInput: WorkTypeChildInput[]): WorkTypesSaveResult {
  if (!parentInput.length && !childInput.length || parentInput.length + childInput.length > 500) throw new Error("Укажите от 1 до 500 строк справочника за один раз.");
  const parentRows = prepareRows(parentInput, "виды работ");
  const childRows = prepareRows(childInput, "подвиды работ");
  const newParentKeys = new Set(parentRows.filter(row => row.id === undefined).map(row => row.clientKey));
  for (const row of parentRows) {
    if (row.id === undefined) continue;
    const existing = parents.find(item => item.id === row.id);
    if (!existing) throw new Error("Вид работы не найден в выбранном проекте или уже архивирован. Обновите справочник.");
    if (row.originalName !== undefined && row.originalName !== existing.name) throw new Error("Вид работы уже изменён другим пользователем. Обновите справочник и повторите изменения.");
  }
  for (const row of childRows) {
    if (row.parentId !== null && (!positiveId(row.parentId) || !parents.some(parent => parent.id === row.parentId))) throw new Error("Выберите действующий вид работы из этого проекта.");
    if (row.parentKey !== undefined && (typeof row.parentKey !== "string" || !newParentKeys.has(row.parentKey) || row.parentId !== null)) throw new Error("Новый вид работы не найден среди сохраняемых строк.");
    if (row.originalParentId !== undefined && row.originalParentId !== null && !positiveId(row.originalParentId)) throw new Error("Исходный вид работы некорректен. Обновите справочник.");
    if (row.id === undefined) continue;
    const existing = children.find(item => item.id === row.id);
    if (!existing) throw new Error("Подвид не найден в выбранном проекте или уже архивирован. Обновите справочник.");
    if (row.originalName !== undefined && row.originalName !== existing.name || row.originalParentId !== undefined && row.originalParentId !== (existing.mainWorkTypeId ?? null)) throw new Error("Подвид уже изменён другим пользователем. Обновите справочник и повторите изменения.");
  }
  const editedParents = new Set(parentRows.map(row => row.id));
  const parentNames = new Set(parents.filter(row => !editedParents.has(row.id)).map(row => normalizeName(row.name)));
  for (const row of parentRows) {
    const name = normalizeName(row.name);
    if (parentNames.has(name)) throw new Error(`Вид работы «${row.name}» уже есть в справочнике проекта.`);
    parentNames.add(name);
  }
  const editedChildren = new Set(childRows.map(row => row.id));
  const childNames = new Set(children.filter(row => !editedChildren.has(row.id)).map(row => JSON.stringify([row.mainWorkTypeId ?? null, normalizeName(row.name)])));
  for (const row of childRows) {
    const name = JSON.stringify([row.parentKey === undefined ? row.parentId : `new:${row.parentKey}`, normalizeName(row.name)]);
    if (childNames.has(name)) throw new Error(`Подвид «${row.name}» уже есть в выбранном виде работы.`);
    childNames.add(name);
  }
  // Validate the complete batch before changing memory, matching the API transaction.
  const saved: WorkTypesSaveResult = { parents: [], children: [] };
  const newParentIds = new Map<string, number>();
  for (const row of parentRows) {
    const id = saveItem(true, { directoryId: row.id, name: row.name });
    if (row.id === undefined) newParentIds.set(row.clientKey, id);
    saved.parents.push({ clientKey: row.clientKey, id });
  }
  for (const row of childRows) {
    const parentId = row.parentKey === undefined ? row.parentId : newParentIds.get(row.parentKey)!;
    const id = saveItem(false, { directoryId: row.id, name: row.name, mainWorkTypeId: parentId });
    saved.children.push({ clientKey: row.clientKey, id });
  }
  return saved;
}
window.fetch = async (input, init) => {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Укажите данные справочника работ.");
    if (url.pathname === "/api/table-order") {
      const available = [...parents.map(parent => `parent-${parent.id}`), ...children.map(child => `child-${child.id}`)];
      savedRowOrder = reconcileRowOrder(available, savedRowOrder);
      if (method === "POST") {
        if (!Array.isArray(body.movingIds) || body.movingIds.some((id: unknown) => !isWorkTypesOrderId(id) || !available.includes(id))) return Response.json({ error: "Выберите существующие строки." }, { status: 400 });
        savedRowOrder = moveRowBlock(savedRowOrder, body);
        hasSavedOrder = true;
      }
      return Response.json({ ids: savedRowOrder, canWrite: true, hasSavedOrder });
    }
    if (url.pathname === "/api/work-types" && method === "POST" && body.action === "save") {
      if (!Array.isArray(body.parents) || !Array.isArray(body.children)) throw new Error("Укажите строки справочника.");
      return Response.json(saveWorkTypes(body.parents, body.children));
    }
    if (url.pathname === "/api/work-types" && method === "POST" && body.action === "archive") {
      if (!Array.isArray(body.parents) || !Array.isArray(body.children) || !body.parents.length && !body.children.length || body.parents.length + body.children.length > 5000) throw new Error("Выберите от 1 до 5000 строк справочника за один раз.");
      if (body.parents.some((id: unknown) => !positiveId(id)) || body.children.some((id: unknown) => !positiveId(id))) throw new Error("Укажите корректные строки для архивирования.");
      const parentIds = new Set<number>(body.parents);
      const selectedChildIds = new Set<number>(body.children);
      if ([...parentIds].some(id => !parents.some(parent => parent.id === id))) throw new Error("Один из видов работ не найден в выбранном проекте или уже архивирован. Обновите справочник.");
      if ([...selectedChildIds].some(id => !children.some(child => child.id === id))) throw new Error("Один из подвидов не найден в выбранном проекте или уже архивирован. Обновите справочник.");
      const archivedChildren = children.filter(child => selectedChildIds.has(child.id) || child.mainWorkTypeId != null && parentIds.has(child.mainWorkTypeId));
      const childIds = new Set(archivedChildren.map(child => child.id));
      parents = parents.filter(parent => !parentIds.has(parent.id));
      children = children.filter(child => !childIds.has(child.id));
      return Response.json({ parents: parentIds.size, children: childIds.size, count: parentIds.size + childIds.size });
    }
    if (url.pathname === "/api/data") {
      if (method === "GET") return Response.json({ mainWorkTypes: parents, subworkTypes: children });
      const isParent = (body.entity ?? url.searchParams.get("kind")) === "mainWorkType";
      if (method === "DELETE") {
        const id = Number(url.searchParams.get("id"));
        if (isParent) { parents = parents.filter(item => item.id !== id); children = children.filter(item => item.mainWorkTypeId !== id); }
        else children = children.filter(item => item.id !== id);
        return Response.json({ ok: true });
      }
      if (body.action === "save-directory-items" && Array.isArray(body.directories)) {
        const ids = body.directories.map((row: DirectoryMutation) => saveItem(isParent, row));
        return Response.json({ count: ids.length, ids });
      }
      if (body.action === "create-directory" || body.action === "update-directory") return Response.json({ id: saveItem(isParent, body) });
      return Response.json({ error: "Неизвестное действие на тестовом стенде." }, { status: 400 });
    }
    if (url.pathname === "/api/work-types" && method === "POST" && body.action === "assign") {
      const ids = new Set(body.ids as number[]);
      children = children.map(child => ids.has(child.id) ? { ...child, mainWorkTypeId: body.mainWorkTypeId } : child);
      return Response.json({ count: ids.size });
    }
    if (url.pathname === "/api/work-types" && method === "POST" && Array.isArray(body.entries)) {
      const entries = body.entries as { name: string; subworkName: string }[];
      for (const entry of entries) {
        if (!entry || typeof entry.name !== "string" || typeof entry.subworkName !== "string") throw new Error("Укажите строки справочника.");
        let parent = parents.find(item => normalizeName(item.name) === normalizeName(entry.name));
        if (!parent && entry.name.trim()) {
          const id = saveItem(true, { name: entry.name.trim() });
          parent = parents.find(item => item.id === id);
        }
        if (!entry.subworkName.trim()) continue;
        const child = children.find(item => normalizeName(item.name) === normalizeName(entry.subworkName) && (item.mainWorkTypeId ?? null) === (parent?.id ?? null));
        saveItem(false, { directoryId: child?.id, name: entry.subworkName.trim(), mainWorkTypeId: parent?.id ?? null });
      }
      return Response.json({ count: entries.length });
    }
    return Response.json({ error: `Запрос ${method} ${url.pathname} не поддерживается на изолированном стенде.` }, { status: 404 });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Некорректный запрос на изолированном стенде." }, { status: 400 });
  }
};

const shellStyles = `
  .work-types-fixture-shell { height:100vh; min-height:0; display:grid; grid-template-columns:224px minmax(0,1fr); overflow:hidden; }
  .work-types-fixture-sidebar { height:100vh; min-height:0; display:flex; flex-direction:column; gap:25px; padding:24px 14px 14px; background:#18181b; color:#f4f4f5; }
  .work-types-fixture-brand { display:flex; align-items:center; gap:9px; font-size:15px; font-weight:750; }
  .work-types-fixture-brand span { width:29px; height:29px; display:grid; place-items:center; border-radius:8px; background:#e9a23b; color:#18181b; font-size:17px; }
  .work-types-fixture-project { display:grid; gap:5px; padding:12px; border:1px solid #3f3f46; border-radius:8px; font-size:12px; }
  .work-types-fixture-project small { color:#a1a1aa; font-size:10px; }
  .work-types-fixture-sidebar nav { display:grid; gap:5px; font-size:12px; }
  .work-types-fixture-sidebar nav span { padding:10px 12px; border-radius:6px; }
  .work-types-fixture-sidebar nav .active { background:#303034; color:#f8c067; }
  .work-types-fixture-account { margin-top:auto; display:grid; gap:5px; padding:12px; border:1px solid #3f3f46; border-radius:8px; font-size:11px; }
  .work-types-fixture-account small { color:#a1a1aa; font-size:10px; }
  .work-types-fixture-shell > .page-content { min-width:0; }
  .work-types-fixture-controls { display:flex; align-items:center; gap:8px; color:#71717a; font-size:10px; }
  .work-types-fixture-controls select { max-width:230px; min-height:28px; padding:3px 7px; border:1px solid #e4e4e7; border-radius:6px; background:#fafafa; color:#52525b; font-size:10px; }
  @media(max-width:900px) { .work-types-fixture-shell { grid-template-columns:188px minmax(0,1fr); } .work-types-fixture-sidebar { padding-inline:10px; } }
  @media(max-width:680px) { .work-types-fixture-shell { display:block; } .work-types-fixture-sidebar { display:none; } .work-types-fixture-shell .page-heading { gap:8px; padding-bottom:10px; } .work-types-fixture-controls { justify-content:space-between; } }
`;

function Fixture() {
  const [sample, setSample] = useState<Sample>("sample");
  const [data, setData] = useState({ parents, children });
  return <AgGridProvider modules={[AllEnterpriseModule]}><style>{shellStyles}</style><div className="work-types-fixture-shell">
    <aside className="work-types-fixture-sidebar" aria-label="Меню приложения">
      <div className="work-types-fixture-brand"><span aria-hidden="true">П</span>Учёт персонала</div>
      <div className="work-types-fixture-project"><strong>Учебный проект</strong><small>Строительство производственного комплекса</small></div>
      <nav aria-label="Разделы"><span>Техника</span><span>Персонал</span><span>Справочники</span><span>Настройки</span><span className="active" aria-current="page">Настройки проекта</span></nav>
      <div className="work-types-fixture-account"><strong>Аванесов Марк Давидович</strong><small>Супер-админ</small></div>
    </aside>
    <main className="page-content table-workspace-page work-types-workspace-page">
      <SelectionCopyTarget />
      <header className="page-heading"><div><h1>Виды и подвиды работ</h1><p>Учебный проект</p></div><label className="work-types-fixture-controls">Тестовые данные<select aria-label="Тестовые данные" value={sample} onChange={event => {
        const value = event.target.value as Sample;
        ({ parents, children } = makeData(value)); nextId = 100_000; savedRowOrder = []; hasSavedOrder = false;
        setSample(value); setData({ parents, children });
      }}><option value="sample">12 видов · 85 подвидов</option><option value="large">500 видов · 50 000 подвидов</option><option value="empty">Пустой справочник</option></select></label></header>
      <TableOrderProvider key={sample} scope="directory-work-types" siteId={1}><WorkTypesDirectory key={sample} siteId={1} projectName="Учебный проект" mainWorkTypes={data.parents} subworkTypes={data.children} canCreate canUpdate canDelete onBack={() => {}} onRefresh={async () => setData({ parents, children })} /></TableOrderProvider>
    </main>
  </div></AgGridProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
