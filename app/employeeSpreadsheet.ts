import type { GridEmployee, GridEmployeeDraft, GridOption } from "./AgDataGrids";

export type EmployeeSpreadsheetRow = {
  rowKey: string;
  employee?: GridEmployee;
  draft?: GridEmployeeDraft;
};

export type EmployeeSpreadsheetReferences = {
  employmentTypes: GridOption[];
  departments: GridOption[];
  positions: GridOption[];
  sites: GridOption[];
  positionCatalog?: { employmentType: string; department: string; position: string }[];
  requiredSiteId?: number | readonly number[];
};

const fields = ["fullName", "employmentType", "department", "position", "siteName"] as const;
const labels = { fullName: "ФИО", employmentType: "Тип", department: "Отдел", position: "Должность", siteName: "Проект" };
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
const unassignedSites = new Set(["", "без объекта", "не назначен", "не назначена", "без проекта", "—", "-"]);

function optionLookup(options: GridOption[]) {
  const names = new Map<string, GridOption | null>();
  const ids = new Map<string, GridOption | null>();
  for (const option of options) {
    const name = normalize(option.name);
    const id = String(option.id);
    names.set(name, names.has(name) ? null : option);
    ids.set(id, ids.has(id) ? null : option);
  }
  return (value: string): GridOption | undefined => {
    const name = normalize(value);
    return (names.has(name) ? names.get(name) : ids.get(value.trim())) ?? undefined;
  };
}

function defaultProject(references: EmployeeSpreadsheetReferences) {
  const scope = references.requiredSiteId;
  if (typeof scope === "number") return String(scope);
  return scope?.length === 1 ? String(scope[0]) : "";
}

function blankDraft(key: string, references: EmployeeSpreadsheetReferences): GridEmployeeDraft {
  return { key, fullName: "", employmentType: "", department: "", position: "", projectSiteId: defaultProject(references) };
}

function employeeDraft(employee: GridEmployee): GridEmployeeDraft {
  return {
    key: `employee-${employee.id}`, id: employee.id, fullName: employee.fullName,
    employmentType: employee.employmentType, department: employee.department,
    position: employee.position, projectSiteId: employee.siteId == null ? "" : String(employee.siteId),
  };
}

/** Apply one clipboard/edit operation as an immutable snapshot, or reject the entire operation. */
export function applyEmployeeSpreadsheetBatch({ rows, drafts, references, canCreate, canUpdate, newKey }: {
  rows: { row?: EmployeeSpreadsheetRow; values: Record<string, string> }[];
  drafts: GridEmployeeDraft[];
  references: EmployeeSpreadsheetReferences;
  canCreate: boolean;
  canUpdate: boolean;
  newKey: () => string;
}): { drafts: GridEmployeeDraft[]; editedIds: number[] } {
  if (rows.length > 1000) throw new Error("За один раз можно изменить не более 1000 строк. Разделите вставку на несколько частей.");

  const errors: string[] = [];
  const options = {
    employmentType: optionLookup(references.employmentTypes), department: optionLookup(references.departments),
    position: optionLookup(references.positions), siteName: optionLookup(references.sites),
  };
  const catalogByPosition = new Map<string, NonNullable<EmployeeSpreadsheetReferences["positionCatalog"]>>();
  for (const item of references.positionCatalog ?? []) {
    const position = normalize(item.position);
    const existing = catalogByPosition.get(position);
    if (existing) existing.push(item);
    else catalogByPosition.set(position, [item]);
  }
  const next = [...drafts];
  const byKey = new Map(drafts.map(draft => [draft.key, draft]));
  const createdKeys = new Set<string>();
  const editedIds = new Set<number>();
  const newSlots = drafts.filter(draft => !draft.id);
  const firstRow = rows[0]?.row;
  const firstDraft = firstRow?.draft
    ? byKey.get(firstRow.draft.key)
    : firstRow && !firstRow.employee ? byKey.get(firstRow.rowKey) : undefined;
  const newSlotStart = firstDraft && !firstDraft.id ? newSlots.findIndex(draft => draft.key === firstDraft.key) : -1;
  let provisionalSequence = 0;

  const createDraft = () => {
    let key: string;
    do { key = `\u0000employee-spreadsheet-${provisionalSequence++}`; } while (byKey.has(key));
    createdKeys.add(key);
    return blankDraft(key, references);
  };
  const updateDraft = (draft: GridEmployeeDraft) => {
    const index = next.findIndex(candidate => candidate.key === draft.key);
    if (index < 0) next.push(draft);
    else next[index] = draft;
    byKey.set(draft.key, draft);
  };

  rows.forEach(({ row, values }, index) => {
    if (!fields.some(field => values[field] !== undefined)) return;
    const error = (message: string) => errors.push(`Строка ${index + 1}: ${message}`);
    let draft: GridEmployeeDraft | undefined;

    // A paste beginning in an unsaved row must never spill into saved employees.
    if (newSlotStart >= 0) {
      const slot = newSlots[newSlotStart + index];
      draft = slot ? byKey.get(slot.key) : createDraft();
    } else if (row?.draft) {
      draft = byKey.get(row.draft.key);
      if (!draft) { error("черновик больше не существует. Обновите таблицу и повторите действие."); return; }
    } else if (row?.employee) {
      draft = byKey.get(`employee-${row.employee.id}`)
        ?? next.find(candidate => candidate.id === row.employee!.id)
        ?? employeeDraft(row.employee);
    } else if (row) {
      draft = byKey.get(row.rowKey);
      if (!draft) { error("не удалось найти сотрудника для редактирования."); return; }
    } else {
      draft = createDraft();
    }
    if (!draft) return;
    if (draft.id ? !canUpdate : !canCreate) error(draft.id ? "нет права редактировать сотрудников." : "нет права добавлять сотрудников.");

    const changed = { ...draft };
    if (values.fullName !== undefined) changed.fullName = values.fullName.trim();
    let validPosition = true;
    for (const field of ["employmentType", "department", "position"] as const) {
      if (values[field] === undefined) continue;
      const raw = values[field].trim();
      const option = raw ? options[field](raw) : undefined;
      if (raw && !option) {
        error(`значение «${raw}» не найдено или неоднозначно в столбце «${labels[field]}». Выберите значение из списка.`);
        if (field === "position") validPosition = false;
      }
      else changed[field] = option?.name ?? "";
    }
    if (values.position !== undefined && changed.position && validPosition) {
      const catalog = catalogByPosition.get(normalize(changed.position));
      const matching = catalog?.find(item =>
        (values.employmentType === undefined || normalize(item.employmentType) === normalize(changed.employmentType))
        && (values.department === undefined || normalize(item.department) === normalize(changed.department))) ?? catalog?.[0];
      if (matching) {
        if (values.employmentType === undefined) changed.employmentType = matching.employmentType;
        if (values.department === undefined) changed.department = matching.department;
      }
    }
    if (values.siteName !== undefined) {
      const raw = values.siteName.trim();
      const unassigned = unassignedSites.has(normalize(raw));
      const site = unassigned ? undefined : options.siteName(raw);
      if (!unassigned && !site) error(`значение «${raw}» не найдено или неоднозначно в столбце «${labels.siteName}». Выберите существующий проект.`);
      else changed.projectSiteId = site ? String(site.id) : "";
    }
    if (references.requiredSiteId !== undefined) {
      const allowed = typeof references.requiredSiteId === "number" ? [references.requiredSiteId] : references.requiredSiteId;
      if (!changed.projectSiteId || !allowed.includes(Number(changed.projectSiteId))) error("в столбце «Проект» должен быть один из разрешённых проектов; оставить его пустым нельзя.");
    }
    updateDraft(changed);
    if (changed.id) editedIds.add(changed.id);
  });

  if (errors.length) throw new Error(errors.join("\n"));

  // Allocate real row keys only once all rows and permissions have passed validation.
  const usedKeys = new Set(next.filter(draft => !createdKeys.has(draft.key)).map(draft => draft.key));
  const result = next.map(draft => {
    if (!createdKeys.has(draft.key)) return draft;
    const key = newKey();
    if (!key || usedKeys.has(key)) throw new Error("Не удалось создать уникальный ключ новой строки. Повторите действие.");
    usedKeys.add(key);
    return { ...draft, key };
  });
  return { drafts: result, editedIds: [...editedIds] };
}

/** Discard selected unsaved rows without touching edits of existing employees. */
export function removeNewEmployeeDrafts(drafts: GridEmployeeDraft[], selectedKeys: readonly string[]): { drafts: GridEmployeeDraft[]; removedKeys: string[] } {
  const selected = new Set(selectedKeys);
  const removed = new Set<string>();
  const remaining = drafts.filter(draft => {
    if (draft.id !== undefined || !selected.has(draft.key)) return true;
    removed.add(draft.key);
    return false;
  });
  return { drafts: removed.size ? remaining : drafts, removedKeys: [...removed] };
}
