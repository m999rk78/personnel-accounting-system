export const EMPLOYEE_AVAILABILITY_STATUSES = ["on_site", "unassigned", "transfer", "intershift", "vacation", "sick_leave", "central_office", "dismissed", "blacklisted", "out_of_scope", "deleted", "unknown"] as const;
export type EmployeeAvailabilityStatus = typeof EMPLOYEE_AVAILABILITY_STATUSES[number];
export type BitrixOfficeTransferDirection = "to_office" | "to_site";

export type BitrixEmployeeSnapshot = {
  bitrix24Id: string;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  projectKeys: string[];
  subdivisionKeys?: string[];
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
type FieldDefinition = { title?: string; TITLE?: string; items?: Array<Record<string, unknown>> };

export const BITRIX24_READ_ONLY_METHODS = ["crm.item.fields", "crm.item.list", "crm.status.list"] as const;
const bitrix24ReadOnlyMethods = new Set<string>(BITRIX24_READ_ONLY_METHODS);

export function normalizeBitrixText(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/\s+/g, " ");
}

export function isBitrixCentralOfficeEmployee(employee: Pick<BitrixEmployeeSnapshot, "subdivisionKeys">) {
  return employee.subdivisionKeys?.some(key => /^центр\s*\.\s*офис$/u.test(normalizeBitrixText(key))) ?? false;
}

export function isAvailabilityStatus(value: unknown): value is EmployeeAvailabilityStatus {
  return typeof value === "string" && EMPLOYEE_AVAILABILITY_STATUSES.includes(value as EmployeeAvailabilityStatus);
}

export function classifyBitrixStage(stageId: string, stageName: string, configured: Record<string, EmployeeAvailabilityStatus> = {}): EmployeeAvailabilityStatus {
  const normalizedId = normalizeBitrixText(stageId);
  const normalizedName = normalizeBitrixText(stageName);
  const configuredStatus = configured[normalizedId] ?? configured[normalizedName];
  if (configuredStatus) return configuredStatus;
  if (/^черный список(?:\s|$)/.test(normalizedName)) return "blacklisted";
  if (/уволен|увольнен|увольнени/.test(normalizedName)) return "dismissed";
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
  if (isBitrixCentralOfficeEmployee(employee) || employee.availabilityStatus === "central_office") return false;
  const stages = new Set(scope.stageKeys.map(normalizeBitrixText));
  if (!stages.has(normalizeBitrixText(employee.stageId)) && !stages.has(normalizeBitrixText(employee.stageName))) return false;
  if (employee.availabilityStatus !== "on_site") return true;
  const projects = new Set(scope.projectKeys.map(normalizeBitrixText));
  return employee.projectKeys.some((project) => projects.has(normalizeBitrixText(project)));
}

/** A confirmed office assignment is distinct from dismissal or an ordinary archive. */
export function bitrixOfficeTransferDirection(
  source: BitrixEmployeeSnapshot,
  local: { active: number; availabilityStatus: EmployeeAvailabilityStatus; hasProjectHistory?: boolean },
  scope?: BitrixEmployeeImportScope,
): BitrixOfficeTransferDirection | null {
  if (!source.bitrix24Id.trim()) return null;
  if (isBitrixCentralOfficeEmployee(source)) {
    const workingStage = ["on_site", "unassigned", "transfer", "intershift", "vacation", "sick_leave"].includes(source.availabilityStatus);
    return local.active === 1 && local.hasProjectHistory && workingStage
      && !["central_office", "dismissed", "blacklisted", "deleted"].includes(local.availabilityStatus) ? "to_office" : null;
  }
  if (local.active !== 0 || local.availabilityStatus !== "central_office" || source.availabilityStatus !== "on_site") return null;
  // An empty subdivision or an unresolved enum ID is not evidence of a return.
  if (!source.subdivisionKeys?.some(value => {
    const key = normalizeBitrixText(value);
    return Boolean(key) && !/^\d+$/.test(key);
  })) return null;
  return isBitrixEmployeeInImportScope(source, scope ?? configuredBitrixEmployeeImportScope()) ? "to_site" : null;
}

export function selectBitrixEmployeesForImport(employees: BitrixEmployeeSnapshot[], scope = configuredBitrixEmployeeImportScope()) {
  return employees.filter((employee) => isBitrixEmployeeInImportScope(employee, scope));
}

export function selectLinkedBitrixEmployeesForReview(employees: BitrixEmployeeSnapshot[], linkedBitrixIds: Iterable<string>, scope = configuredBitrixEmployeeImportScope()) {
  const linkedIds = new Set(linkedBitrixIds);
  return employees.filter((employee) => {
    // First-import scope must not hide a later dismissal of an already linked employee.
    // Unlinked former employees are never offered as new hires, even if a terminal stage is allowlisted.
    if (["dismissed", "blacklisted", "deleted"].includes(employee.availabilityStatus)) {
      return linkedIds.has(employee.bitrix24Id) && !isBitrixCentralOfficeEmployee(employee);
    }
    return isBitrixEmployeeInImportScope(employee, scope);
  });
}

export type LocalBitrixEmployeeSnapshot = {
  bitrix24Id: string;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
  bitrix24Stage: string;
  availabilityStatus?: EmployeeAvailabilityStatus;
  active?: number | boolean;
  projectKeys?: string[];
  projectAliases?: string[];
};

export type BitrixEmployeeDifference = {
  kind: "missing_locally" | "changed" | "outside_scope" | "missing_in_bitrix" | "dismissed_in_bitrix" | "blacklisted_in_bitrix" | "incomplete" | "unknown_stage";
  employeeName: string;
  details: string;
  bitrix24Id?: string;
};

export type BitrixLinkLocalEmployee = {
  id: number;
  bitrix24Id: string | null;
  fullName: string;
  employmentType: string;
  department: string;
  position: string;
};

export type BitrixEmployeeLinkSuggestion = {
  bitrix24Id: string;
  employeeName: string;
  kind: "safe" | "review" | "unmatched";
  employeeIds: number[];
};

const comparableFields = [
  ["fullName", "ФИО"],
  ["employmentType", "Тип"],
  ["department", "Отдел"],
  ["position", "Должность"],
] as const;

const availabilityLabels: Record<EmployeeAvailabilityStatus, string> = {
  on_site: "На объекте",
  unassigned: "Не назначен",
  transfer: "Перемещение",
  intershift: "Между вахтами",
  vacation: "Отпуск",
  sick_leave: "Больничный",
  central_office: "Центр. офис",
  dismissed: "Уволен",
  blacklisted: "Чёрный список",
  out_of_scope: "Вне области сверки",
  deleted: "Удалён",
  unknown: "Не определён",
};

function projectsMatch(sourceKeys: string[], localKeys: string[]) {
  const source = new Set(sourceKeys.map(normalizeBitrixText).filter(Boolean));
  const local = new Set(localKeys.map(normalizeBitrixText).filter(Boolean));
  if (!source.size && !local.size) return true;
  return [...source].some((key) => local.has(key));
}

function terminatedEmployeeDifference(employee: BitrixEmployeeSnapshot, name: string): BitrixEmployeeDifference {
  return employee.availabilityStatus === "blacklisted"
    ? { kind: "blacklisted_in_bitrix", employeeName: name, details: `Сотрудник уволен и находится в чёрном списке Битрикс24${employee.stageName ? ` — стадия «${employee.stageName}»` : ""}. Добавление в новые отчёты и повторный приём запрещены. История отчётов сохранится.`, bitrix24Id: employee.bitrix24Id }
    : { kind: "dismissed_in_bitrix", employeeName: name, details: `В Битрикс24 сотрудник отмечен как уволенный${employee.stageName ? ` — стадия «${employee.stageName}»` : ""}.`, bitrix24Id: employee.bitrix24Id };
}

function terminatedEmployeeMatches(source: BitrixEmployeeSnapshot, local: LocalBitrixEmployeeSnapshot) {
  return local.availabilityStatus === source.availabilityStatus && !local.active
    && normalizeBitrixText(local.bitrix24Stage) === normalizeBitrixText(source.stageName);
}

export function compareBitrixEmployees(source: BitrixEmployeeSnapshot[], local: LocalBitrixEmployeeSnapshot[], fullSource = source) {
  // An excluded card is still present upstream; never treat it as missing or out of scope.
  const officeIds = new Set([...source, ...fullSource].filter(isBitrixCentralOfficeEmployee).map(employee => employee.bitrix24Id).filter(Boolean));
  for (const employee of local) if (employee.availabilityStatus === "central_office") officeIds.add(employee.bitrix24Id);
  const reviewSource = source.filter(employee => !officeIds.has(employee.bitrix24Id) && !isBitrixCentralOfficeEmployee(employee));
  const localById = new Map(local.map((employee) => [employee.bitrix24Id, employee]));
  const selectedIds = new Set(reviewSource.map((employee) => employee.bitrix24Id).filter(Boolean));
  const sourceIds = new Set(fullSource.map((employee) => employee.bitrix24Id).filter(Boolean));
  const fullSourceById = new Map(fullSource.map((employee) => [employee.bitrix24Id, employee]));
  const differences: BitrixEmployeeDifference[] = [];
  let compared = reviewSource.length;
  let matched = 0;

  for (const employee of reviewSource) {
    const name = employee.fullName || `ID ${employee.bitrix24Id || "не указан"}`;
    const existing = localById.get(employee.bitrix24Id);
    if (existing?.availabilityStatus === "blacklisted" && (existing.active === 0 || existing.active === false)
      && employee.availabilityStatus !== "blacklisted") {
      // A later source-stage change cannot implicitly rehire an employee from the blacklist.
      matched += 1;
      continue;
    }
    if (["dismissed", "blacklisted", "deleted"].includes(employee.availabilityStatus)) {
      if (!existing) continue;
      // Termination is a status-only reconciliation: incomplete or changed HR fields must not erase the historical profile.
      if (terminatedEmployeeMatches(employee, existing)) matched += 1;
      else differences.push(terminatedEmployeeDifference(employee, existing.fullName || name));
      continue;
    }
    const missingFields = [
      [employee.fullName, "ФИО"],
      [employee.employmentType, "тип"],
      [employee.department, "отдел"],
      [employee.position, "должность"],
    ].filter(([value]) => !value).map(([, label]) => label);
    let hasDifference = false;
    if (missingFields.length) {
      differences.push({ kind: "incomplete", employeeName: name, details: `В Битрикс24 не заполнены: ${missingFields.join(", ")}.`, bitrix24Id: employee.bitrix24Id });
      hasDifference = true;
    }
    if (employee.availabilityStatus === "unknown") {
      differences.push({ kind: "unknown_stage", employeeName: name, details: `Стадия «${employee.stageName || employee.stageId || "не указана"}» не распознана.`, bitrix24Id: employee.bitrix24Id });
      hasDifference = true;
    }
    if (!existing) {
      differences.push({ kind: "missing_locally", employeeName: name, details: "Связанной карточки нет в справочнике системы.", bitrix24Id: employee.bitrix24Id });
      continue;
    }
    const changedFields = comparableFields.flatMap(([field, label]) => {
      const before = existing[field];
      const after = employee[field];
      return normalizeBitrixText(before) === normalizeBitrixText(after) ? [] : [`${label}: «${before || "—"}» → «${after || "—"}»`];
    });
    const currentStatus = isAvailabilityStatus(existing.availabilityStatus) ? existing.availabilityStatus : undefined;
    const currentStage = normalizeBitrixText(existing.bitrix24Stage);
    if (currentStatus && employee.availabilityStatus !== "unknown" && currentStatus !== employee.availabilityStatus) {
      changedFields.push(`Статус: «${availabilityLabels[currentStatus]}» → «${availabilityLabels[employee.availabilityStatus]}»`);
    } else if ((!currentStatus || currentStage) && currentStage !== normalizeBitrixText(employee.stageName)) {
      // A card linked by ID alone has no cached stage yet; compare its actual
      // availability instead of reporting that missing metadata as a change.
      changedFields.push(`Стадия: «${existing.bitrix24Stage || "—"}» → «${employee.stageName || "—"}»`);
    }
    const byProjectName = (left: string, right: string) => left.localeCompare(right, "ru-RU") || (left < right ? -1 : left > right ? 1 : 0);
    const sourceProjects = employee.projectKeys.filter(Boolean).sort(byProjectName);
    const localProjects = existing.projectKeys?.filter(Boolean).sort(byProjectName) ?? [];
    const localProjectAliases = existing.projectAliases?.filter(Boolean) ?? localProjects;
    if (employee.availabilityStatus === "on_site" && !projectsMatch(sourceProjects, localProjectAliases)) {
      changedFields.push(`Объект: «${localProjects.join(", ") || "Без объекта"}» → «${sourceProjects.join(", ") || "Не указан"}»`);
    }
    if (changedFields.length) {
      differences.push({ kind: "changed", employeeName: name, details: changedFields.join("; "), bitrix24Id: employee.bitrix24Id });
      hasDifference = true;
    }
    if (!hasDifference) matched += 1;
  }

  for (const employee of local) {
    if (selectedIds.has(employee.bitrix24Id) || officeIds.has(employee.bitrix24Id)) continue;
    if (employee.availabilityStatus === "blacklisted" && (employee.active === 0 || employee.active === false)) continue;
    const sourceEmployee = fullSourceById.get(employee.bitrix24Id);
    if (sourceEmployee && ["dismissed", "blacklisted", "deleted"].includes(sourceEmployee.availabilityStatus)) {
      compared += 1;
      if (terminatedEmployeeMatches(sourceEmployee, employee)) matched += 1;
      else differences.push(terminatedEmployeeDifference(sourceEmployee, employee.fullName || `ID ${employee.bitrix24Id}`));
      continue;
    }
    differences.push(sourceIds.has(employee.bitrix24Id)
        ? { kind: "outside_scope", employeeName: employee.fullName || `ID ${employee.bitrix24Id}`, details: "Карточка есть в Битрикс24, но больше не входит в выбранные стадии или проекты.", bitrix24Id: employee.bitrix24Id }
        : { kind: "missing_in_bitrix", employeeName: employee.fullName || `ID ${employee.bitrix24Id}`, details: "Связанная карточка больше не найдена в Битрикс24.", bitrix24Id: employee.bitrix24Id });
  }

  return { compared, matched, differences };
}

export function suggestBitrixEmployeeLinks(source: BitrixEmployeeSnapshot[], local: BitrixLinkLocalEmployee[], fullSource = source) {
  const linkedBitrixIds = new Set(local.flatMap((employee) => employee.bitrix24Id ? [employee.bitrix24Id] : []));
  const unlinkedByName = new Map<string, BitrixLinkLocalEmployee[]>();
  const localNameCounts = new Map<string, number>();
  const remoteNameCounts = new Map<string, number>();
  for (const employee of fullSource) {
    const key = normalizeBitrixText(employee.fullName);
    remoteNameCounts.set(key, (remoteNameCounts.get(key) ?? 0) + 1);
  }
  for (const employee of local) {
    const key = normalizeBitrixText(employee.fullName);
    if (!key) continue;
    localNameCounts.set(key, (localNameCounts.get(key) ?? 0) + 1);
    if (employee.bitrix24Id) continue;
    unlinkedByName.set(key, [...(unlinkedByName.get(key) ?? []), employee]);
  }
  const suggestions: BitrixEmployeeLinkSuggestion[] = [];
  for (const employee of source) {
    if (isBitrixCentralOfficeEmployee(employee)) continue;
    if (["dismissed", "blacklisted", "deleted", "central_office"].includes(employee.availabilityStatus)) continue;
    if (!employee.bitrix24Id || linkedBitrixIds.has(employee.bitrix24Id)) continue;
    const name = normalizeBitrixText(employee.fullName);
    const candidates = unlinkedByName.get(name) ?? [];
    const exactCandidates = candidates.filter((candidate) =>
      normalizeBitrixText(candidate.employmentType) === normalizeBitrixText(employee.employmentType)
      && normalizeBitrixText(candidate.department) === normalizeBitrixText(employee.department)
      && normalizeBitrixText(candidate.position) === normalizeBitrixText(employee.position));
    const safe = candidates.length === 1 && exactCandidates.length === 1 && localNameCounts.get(name) === 1 && remoteNameCounts.get(name) === 1
      && employee.availabilityStatus !== "unknown" && [employee.employmentType, employee.department, employee.position].every(value => normalizeBitrixText(value));
    suggestions.push({
      bitrix24Id: employee.bitrix24Id,
      employeeName: employee.fullName || `ID ${employee.bitrix24Id}`,
      kind: safe ? "safe" : candidates.length ? "review" : "unmatched",
      employeeIds: candidates.map((candidate) => candidate.id),
    });
  }
  return suggestions;
}

export function suggestArchivedBitrixEmployeeLinks(
  source: BitrixEmployeeSnapshot[],
  local: (BitrixLinkLocalEmployee & { active: number; availabilityStatus: EmployeeAvailabilityStatus })[],
  fullSource = source,
): BitrixEmployeeLinkSuggestion[] {
  const excludedStatuses = new Set<EmployeeAvailabilityStatus>(["blacklisted", "dismissed", "deleted", "central_office"]);
  const owners = new Map<string, typeof local[number] | null>();
  const activeByName = new Map<string, typeof local>();
  for (const employee of local) {
    const bitrixId = employee.bitrix24Id;
    if (bitrixId) owners.set(bitrixId, owners.has(bitrixId) ? null : employee);
    if (employee.active !== 1) continue;
    const name = normalizeBitrixText(employee.fullName);
    if (!name) continue;
    const namesakes = activeByName.get(name);
    if (namesakes) namesakes.push(employee);
    else activeByName.set(name, [employee]);
  }
  const sourceById = new Map<string, number>();
  const sourceByName = new Map<string, number>();
  for (const employee of fullSource) {
    const { bitrix24Id } = employee;
    const name = normalizeBitrixText(employee.fullName);
    sourceById.set(bitrix24Id, (sourceById.get(bitrix24Id) ?? 0) + 1);
    sourceByName.set(name, (sourceByName.get(name) ?? 0) + 1);
  }

  const identityFields = ["employmentType", "department", "position"] as const;
  return source.flatMap((employee): BitrixEmployeeLinkSuggestion[] => {
    if (isBitrixCentralOfficeEmployee(employee)) return [];
    const { bitrix24Id, availabilityStatus } = employee;
    const name = normalizeBitrixText(employee.fullName);
    if (!bitrix24Id.trim() || !name || sourceById.get(bitrix24Id) !== 1 || excludedStatuses.has(availabilityStatus)) return [];
    const archive = owners.get(bitrix24Id);
    if (!archive || archive.active !== 0 || excludedStatuses.has(archive.availabilityStatus) || normalizeBitrixText(archive.fullName) !== name) return [];

    const namesakes = activeByName.get(name) ?? [];
    const candidates = namesakes.filter(candidate => !candidate.bitrix24Id && !excludedStatuses.has(candidate.availabilityStatus));
    if (!candidates.length) return [];
    const safe = namesakes.length === 1 && sourceByName.get(name) === 1 && availabilityStatus !== "unknown"
      && identityFields.every(field => {
        const expected = normalizeBitrixText(employee[field]);
        return Boolean(expected) && normalizeBitrixText(candidates[0][field]) === expected;
      });

    return [{
      bitrix24Id,
      employeeName: employee.fullName,
      kind: safe ? "safe" : "review",
      employeeIds: candidates.map(candidate => candidate.id),
    }];
  });
}

export type LegacyTerminalBitrixDuplicateObservation = {
  employeeId: number;
  archivedId: number;
  bitrix24Id: string;
  availabilityStatus: "dismissed" | "blacklisted";
  status: "dismissed_in_bitrix" | "blacklisted_in_bitrix";
  details: string;
};

/** Recognize historical imports with a separate, unlinked copy of a linked archived card. */
export function observeLegacyTerminalBitrixDuplicates(
  source: readonly BitrixEmployeeSnapshot[],
  local: readonly (BitrixLinkLocalEmployee & { active: number; availabilityStatus: EmployeeAvailabilityStatus })[],
): LegacyTerminalBitrixDuplicateObservation[] {
  const owners = new Map<string, typeof local[number] | null>();
  const activeByName = new Map<string, typeof local[number] | null>();
  for (const employee of local) {
    const { bitrix24Id } = employee;
    if (bitrix24Id) owners.set(bitrix24Id, owners.has(bitrix24Id) ? null : employee);
    if (employee.active !== 1) continue;
    const name = normalizeBitrixText(employee.fullName);
    if (name) activeByName.set(name, activeByName.has(name) ? null : employee);
  }

  const sourceIdUses = new Map<string, number>();
  const sourceNameUses = new Map<string, number>();
  for (const { bitrix24Id, fullName } of source) {
    const name = normalizeBitrixText(fullName);
    sourceIdUses.set(bitrix24Id, (sourceIdUses.get(bitrix24Id) ?? 0) + 1);
    sourceNameUses.set(name, (sourceNameUses.get(name) ?? 0) + 1);
  }

  const identityFields = ["employmentType", "department", "position"] as const;
  return source.flatMap((employee): LegacyTerminalBitrixDuplicateObservation[] => {
    if (isBitrixCentralOfficeEmployee(employee)) return [];
    const { bitrix24Id, availabilityStatus } = employee;
    if (availabilityStatus !== "dismissed" && availabilityStatus !== "blacklisted") return [];
    const name = normalizeBitrixText(employee.fullName);
    if (!bitrix24Id.trim() || !name || sourceIdUses.get(bitrix24Id) !== 1 || sourceNameUses.get(name) !== 1) return [];
    const archived = owners.get(bitrix24Id);
    const active = activeByName.get(name);
    if (!archived || archived.active !== 0 || ["deleted", "central_office"].includes(archived.availabilityStatus) || normalizeBitrixText(archived.fullName) !== name) return [];
    if (!active || active.bitrix24Id || ["dismissed", "blacklisted", "deleted", "central_office"].includes(active.availabilityStatus)) return [];
    // The remote terminal card can have empty HR fields; verify that the two
    // local cards have the same complete profile instead of comparing names alone.
    if (!identityFields.every(field => {
      const expected = normalizeBitrixText(archived[field]);
      return Boolean(expected) && normalizeBitrixText(active[field]) === expected;
    })) return [];
    const blacklisted = availabilityStatus === "blacklisted";
    return [{
      employeeId: active.id,
      archivedId: archived.id,
      bitrix24Id,
      availabilityStatus,
      status: blacklisted ? "blacklisted_in_bitrix" : "dismissed_in_bitrix",
      details: blacklisted
        ? "Сотрудник в чёрном списке Битрикс24. Связь хранится на архивной карточке с теми же ФИО, типом, отделом и должностью."
        : "Сотрудник уволен в Битрикс24. Связь хранится на архивной карточке с теми же ФИО, типом, отделом и должностью.",
    }];
  });
}

function configuredStageStatuses() {
  const raw = process.env.BITRIX24_STAGE_STATUS_MAP?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("BITRIX24_STAGE_STATUS_MAP должен содержать корректный JSON-объект."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BITRIX24_STAGE_STATUS_MAP должен быть JSON-объектом.");
  const result: Record<string, EmployeeAvailabilityStatus> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isAvailabilityStatus(value) || value === "central_office") throw new Error(`Неизвестный статус доступности «${String(value)}» в BITRIX24_STAGE_STATUS_MAP.`);
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
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause as { code?: string } | undefined : undefined;
    if (cause?.code === "ENOTFOUND") throw new Error("Не удалось найти сервер Битрикс24. Проверьте интернет, DNS и адрес webhook.");
    if (cause?.code === "UND_ERR_CONNECT_TIMEOUT" || (error instanceof Error && /timeout/i.test(`${error.name} ${error.message}`))) {
      throw new Error("Сервер Битрикс24 не ответил вовремя. Проверьте доступность портала и повторите попытку.");
    }
    throw new Error("Не удалось подключиться к Битрикс24. Проверьте интернет и доступность портала.");
  }
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

function findSubdivisionField(definitions: Record<string, FieldDefinition>, useOriginalUfNames: boolean) {
  // This is the existing Bitrix «Подразделение» field, not the configured department or project.
  const camel = "ufCrm5_1702909988069";
  const original = "UF_CRM_5_1702909988069";
  const known = (useOriginalUfNames ? [original, camel] : [camel, original]).find(key => Object.hasOwn(definitions, key));
  if (known) return known;
  const byTitle = Object.entries(definitions).filter(([, field]) =>
    normalizeBitrixText(field?.title ?? field?.TITLE ?? "") === "подразделение");
  return byTitle.length === 1 ? byTitle[0][0] : undefined;
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
  const subdivisionField = findSubdivisionField(definitions, useOriginalUfNames);
  const subdivisionValues = subdivisionField ? enumValues(definitions[subdivisionField]) : undefined;
  const select = [...new Set(["id", "title", "stageId", "categoryId", "updatedTime", ...Object.values(fields), ...(subdivisionField ? [subdivisionField] : [])])];
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
      ...(subdivisionField && subdivisionValues ? { subdivisionKeys: resolveBitrixFieldValues(item[subdivisionField], subdivisionValues) } : {}),
      stageId,
      stageName,
      availabilityStatus: classifyBitrixStage(stageId, stageName, configuredStatuses),
      sourceUpdatedAt: typeof item.updatedTime === "string" && item.updatedTime ? item.updatedTime : null,
    };
  });
}
