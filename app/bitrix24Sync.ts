export const EMPLOYEE_AVAILABILITY_STATUSES = ["on_site", "unassigned", "transfer", "intershift", "vacation", "sick_leave", "dismissed", "out_of_scope", "deleted", "unknown"] as const;
export type EmployeeAvailabilityStatus = typeof EMPLOYEE_AVAILABILITY_STATUSES[number];

export type BitrixEmployeeSnapshot = {
  bitrix24Id: string;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  projectKeys: string[];
  stageId: string;
  stageName: string;
  availabilityStatus: EmployeeAvailabilityStatus;
  sourceUpdatedAt: string | null;
};

export type BitrixEmployeeImportScope = {
  stageKeys: string[];
  projectKeys: string[];
};

type BitrixPayload = { result?: unknown; next?: number; error?: string; error_description?: string };
type BitrixItem = Record<string, unknown> & { id?: number | string; title?: string; stageId?: string; categoryId?: number | string; updatedTime?: string };
type FieldDefinition = { items?: Array<Record<string, unknown>> };

export const BITRIX24_READ_ONLY_METHODS = ["crm.item.fields", "crm.item.list", "crm.status.list"] as const;
const bitrix24ReadOnlyMethods = new Set<string>(BITRIX24_READ_ONLY_METHODS);

export function normalizeBitrixText(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
}

export function isAvailabilityStatus(value: unknown): value is EmployeeAvailabilityStatus {
  return typeof value === "string" && EMPLOYEE_AVAILABILITY_STATUSES.includes(value as EmployeeAvailabilityStatus);
}

export function classifyBitrixStage(stageId: string, stageName: string, configured: Record<string, EmployeeAvailabilityStatus> = {}): EmployeeAvailabilityStatus {
  const normalizedId = normalizeBitrixText(stageId);
  const normalizedName = normalizeBitrixText(stageName);
  const configuredStatus = configured[normalizedId] ?? configured[normalizedName];
  if (configuredStatus) return configuredStatus;
  if (/уволен|увольнен|увольнение/.test(normalizedName)) return "dismissed";
  if (/перемещ/.test(normalizedName)) return "transfer";
  if (/^мо\s*\/\s*о$|межобъект|ожидани.*объект|без объект/.test(normalizedName)) return "intershift";
  if (/межвахт/.test(normalizedName)) return "intershift";
  if (/отпуск/.test(normalizedName)) return "vacation";
  if (/больнич|нетрудоспособ/.test(normalizedName)) return "sick_leave";
  if (/объект|офис/.test(normalizedName)) return "on_site";
  return "unknown";
}

function configuredStringArray(variableName: string) {
  const raw = process.env[variableName]?.trim();
  if (!raw) throw new Error(`${variableName} не настроен.`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${variableName} должен содержать корректный JSON-массив.`); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${variableName} должен содержать непустой JSON-массив строк.`);
  }
  return parsed.map((value) => value.trim());
}

export function configuredBitrixEmployeeImportScope(): BitrixEmployeeImportScope {
  return {
    stageKeys: configuredStringArray("BITRIX24_INCLUDED_STAGES"),
    projectKeys: configuredStringArray("BITRIX24_INCLUDED_PROJECTS"),
  };
}

export function isBitrixEmployeeInImportScope(employee: BitrixEmployeeSnapshot, scope: BitrixEmployeeImportScope) {
  const stages = new Set(scope.stageKeys.map(normalizeBitrixText));
  if (!stages.has(normalizeBitrixText(employee.stageId)) && !stages.has(normalizeBitrixText(employee.stageName))) return false;
  if (employee.availabilityStatus !== "on_site") return true;
  const projects = new Set(scope.projectKeys.map(normalizeBitrixText));
  return employee.projectKeys.some((project) => projects.has(normalizeBitrixText(project)));
}

export function selectBitrixEmployeesForImport(employees: BitrixEmployeeSnapshot[], scope = configuredBitrixEmployeeImportScope()) {
  return employees.filter((employee) => isBitrixEmployeeInImportScope(employee, scope));
}

export type LocalBitrixEmployeeSnapshot = {
  bitrix24Id: string;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  bitrix24Stage: string;
};

export type BitrixEmployeeDifference = {
  kind: "missing_locally" | "changed" | "outside_scope" | "missing_in_bitrix" | "incomplete" | "unknown_stage";
  employeeName: string;
  details: string;
};

const comparableFields = [
  ["fullName", "ФИО"],
  ["employmentType", "тип"],
  ["department", "отдел"],
  ["position", "должность"],
  ["bitrix24Stage", "стадия"],
] as const;

export function compareBitrixEmployees(source: BitrixEmployeeSnapshot[], local: LocalBitrixEmployeeSnapshot[], fullSource = source) {
  const localById = new Map(local.map((employee) => [employee.bitrix24Id, employee]));
  const selectedIds = new Set(source.map((employee) => employee.bitrix24Id).filter(Boolean));
  const sourceIds = new Set(fullSource.map((employee) => employee.bitrix24Id).filter(Boolean));
  const differences: BitrixEmployeeDifference[] = [];
  let matched = 0;

  for (const employee of source) {
    const name = employee.fullName || `ID ${employee.bitrix24Id || "не указан"}`;
    const missingFields = [
      [employee.fullName, "ФИО"],
      [employee.employmentType, "тип"],
      [employee.department, "отдел"],
      [employee.position, "должность"],
    ].filter(([value]) => !value).map(([, label]) => label);
    let hasDifference = false;
    if (missingFields.length) {
      differences.push({ kind: "incomplete", employeeName: name, details: `В Битрикс24 не заполнены: ${missingFields.join(", ")}.` });
      hasDifference = true;
    }
    if (employee.availabilityStatus === "unknown") {
      differences.push({ kind: "unknown_stage", employeeName: name, details: `Стадия «${employee.stageName || employee.stageId || "не указана"}» не распознана.` });
      hasDifference = true;
    }
    const existing = localById.get(employee.bitrix24Id);
    if (!existing) {
      differences.push({ kind: "missing_locally", employeeName: name, details: "Связанной карточки нет в справочнике системы." });
      continue;
    }
    const sourceComparable = { ...employee, bitrix24Stage: employee.stageName };
    const changedFields = comparableFields.flatMap(([field, label]) => {
      const before = existing[field];
      const after = sourceComparable[field];
      return normalizeBitrixText(before) === normalizeBitrixText(after) ? [] : [`${label}: «${before || "—"}» → «${after || "—"}»`];
    });
    if (changedFields.length) {
      differences.push({ kind: "changed", employeeName: name, details: changedFields.join("; ") });
      hasDifference = true;
    }
    if (!hasDifference) matched += 1;
  }

  for (const employee of local) {
    if (selectedIds.has(employee.bitrix24Id)) continue;
    differences.push(sourceIds.has(employee.bitrix24Id)
      ? { kind: "outside_scope", employeeName: employee.fullName || `ID ${employee.bitrix24Id}`, details: "Карточка есть в Битрикс24, но больше не входит в выбранные стадии или проекты." }
      : { kind: "missing_in_bitrix", employeeName: employee.fullName || `ID ${employee.bitrix24Id}`, details: "Связанная карточка больше не найдена в Битрикс24." });
  }

  return { compared: source.length, matched, differences };
}

function configuredStageStatuses() {
  const raw = process.env.BITRIX24_STAGE_STATUS_MAP?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("BITRIX24_STAGE_STATUS_MAP должен содержать корректный JSON-объект."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BITRIX24_STAGE_STATUS_MAP должен быть JSON-объектом.");
  const result: Record<string, EmployeeAvailabilityStatus> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isAvailabilityStatus(value)) throw new Error(`Неизвестный статус доступности «${String(value)}» в BITRIX24_STAGE_STATUS_MAP.`);
    result[normalizeBitrixText(key)] = value;
  }
  return result;
}

function webhookUrl() {
  const value = process.env.BITRIX24_WEBHOOK_URL?.trim();
  if (!value) throw new Error("Интеграция с Битрикс24 не настроена: задайте BITRIX24_WEBHOOK_URL.");
  let url: URL;
  try { url = new URL(value.endsWith("/") ? value : `${value}/`); } catch { throw new Error("BITRIX24_WEBHOOK_URL содержит некорректный адрес."); }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("В production BITRIX24_WEBHOOK_URL должен использовать HTTPS.");
  return url;
}

async function callBitrix(method: string, params: Record<string, unknown>) {
  if (!bitrix24ReadOnlyMethods.has(method)) throw new Error(`Метод Битрикс24 «${method}» заблокирован политикой интеграции только для чтения.`);
  const endpoint = new URL(`${method}.json`, webhookUrl());
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  const payload = await response.json() as BitrixPayload;
  if (!response.ok || payload.error) throw new Error(`Битрикс24: ${payload.error_description ?? payload.error ?? `HTTP ${response.status}`}`);
  return payload;
}

function fieldMap() {
  const map = {
    fullName: process.env.BITRIX24_EMPLOYEE_NAME_FIELD?.trim() || "title",
    employmentType: process.env.BITRIX24_EMPLOYEE_TYPE_FIELD?.trim() || "",
    department: process.env.BITRIX24_EMPLOYEE_DEPARTMENT_FIELD?.trim() || "",
    position: process.env.BITRIX24_EMPLOYEE_POSITION_FIELD?.trim() || "",
    project: process.env.BITRIX24_EMPLOYEE_PROJECT_FIELD?.trim() || "",
  };
  const missing = Object.entries(map).filter(([key, value]) => key !== "fullName" && !value).map(([key]) => key);
  if (missing.length) throw new Error(`Не настроены поля Битрикс24: ${missing.join(", ")}.`);
  return map;
}

function unwrapFields(result: unknown) {
  if (!result || typeof result !== "object") return {} as Record<string, FieldDefinition>;
  const record = result as Record<string, unknown>;
  const fields = record.fields;
  return fields && typeof fields === "object" && !Array.isArray(fields) ? fields as Record<string, FieldDefinition> : record as Record<string, FieldDefinition>;
}

function enumValues(definition: FieldDefinition | undefined) {
  const values = new Map<string, string>();
  for (const item of definition?.items ?? []) {
    const id = item.ID ?? item.id ?? item.VALUE_ID ?? item.valueId;
    const label = item.VALUE ?? item.value ?? item.NAME ?? item.name;
    if (id !== undefined && label !== undefined) values.set(String(id), String(label).trim());
  }
  return values;
}

function flattenValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenValue);
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return flattenValue(record.VALUE ?? record.value ?? record.ID ?? record.id);
  }
  return [String(value).trim()].filter(Boolean);
}

export function resolveBitrixFieldValues(value: unknown, enums: Map<string, string>) {
  return flattenValue(value)
    .flatMap((item) => {
      const label = enums.get(item);
      if (label) return [label];
      // Bitrix24 returns numeric zero for an empty enum field in some cards.
      // It is not a real enum value and must not be treated as a project ID.
      return item === "0" && enums.size > 0 ? [] : [item];
    })
    .filter(Boolean);
}

function resultRecord(result: unknown) {
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

async function listItems(entityTypeId: number, select: string[], useOriginalUfNames: boolean) {
  const items: BitrixItem[] = [];
  let start = 0;
  for (;;) {
    const payload = await callBitrix("crm.item.list", { entityTypeId, select, order: { id: "ASC" }, start, useOriginalUfNames: useOriginalUfNames ? "Y" : "N" });
    const result = resultRecord(payload.result);
    const page = Array.isArray(result.items) ? result.items as BitrixItem[] : [];
    items.push(...page);
    const next = typeof payload.next === "number" ? payload.next : typeof result.next === "number" ? result.next : null;
    if (next === null) break;
    if (next <= start) throw new Error("Битрикс24 вернул некорректный указатель следующей страницы.");
    start = next;
  }
  return items;
}

async function stageNames(entityTypeId: number, categoryIds: number[]) {
  const names = new Map<string, string>();
  for (const categoryId of categoryIds) {
    const payload = await callBitrix("crm.status.list", { filter: { ENTITY_ID: `DYNAMIC_${entityTypeId}_STAGE_${categoryId}` }, order: { SORT: "ASC" } });
    const statuses = Array.isArray(payload.result) ? payload.result as Array<Record<string, unknown>> : [];
    for (const status of statuses) {
      const id = status.STATUS_ID ?? status.statusId;
      const name = status.NAME ?? status.name;
      if (id !== undefined && name !== undefined) names.set(String(id), String(name).trim());
    }
  }
  return names;
}

export async function fetchBitrixEmployeeSnapshot(): Promise<BitrixEmployeeSnapshot[]> {
  const entityTypeId = Number(process.env.BITRIX24_EMPLOYEE_ENTITY_TYPE_ID ?? 182);
  if (!Number.isInteger(entityTypeId) || entityTypeId < 128) throw new Error("BITRIX24_EMPLOYEE_ENTITY_TYPE_ID должен содержать ID смарт-процесса.");
  const fields = fieldMap();
  const useOriginalUfNames = Object.values(fields).some((field) => field.startsWith("UF_"));
  const fieldPayload = await callBitrix("crm.item.fields", { entityTypeId, useOriginalUfNames: useOriginalUfNames ? "Y" : "N" });
  const definitions = unwrapFields(fieldPayload.result);
  const select = [...new Set(["id", "title", "stageId", "categoryId", "updatedTime", ...Object.values(fields)])];
  const items = await listItems(entityTypeId, select, useOriginalUfNames);
  const categories = [...new Set(items.map((item) => Number(item.categoryId)).filter((value) => Number.isInteger(value) && value >= 0))];
  const stages = await stageNames(entityTypeId, categories.length ? categories : [0]);
  const configuredStatuses = configuredStageStatuses();
  const valueMaps = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, enumValues(definitions[field])])) as Record<keyof typeof fields, Map<string, string>>;

  return items.map((item) => {
    const bitrix24Id = String(item.id ?? "").trim();
    const stageId = String(item.stageId ?? "").trim();
    const stageName = stages.get(stageId) ?? stageId;
    return {
      bitrix24Id,
      fullName: resolveBitrixFieldValues(item[fields.fullName], valueMaps.fullName)[0] ?? String(item.title ?? "").trim(),
      employmentType: resolveBitrixFieldValues(item[fields.employmentType], valueMaps.employmentType)[0] ?? "",
      department: resolveBitrixFieldValues(item[fields.department], valueMaps.department)[0] ?? "",
      position: resolveBitrixFieldValues(item[fields.position], valueMaps.position)[0] ?? "",
      projectKeys: resolveBitrixFieldValues(item[fields.project], valueMaps.project),
      stageId,
      stageName,
      availabilityStatus: classifyBitrixStage(stageId, stageName, configuredStatuses),
      sourceUpdatedAt: typeof item.updatedTime === "string" && item.updatedTime ? item.updatedTime : null,
    };
  });
}
