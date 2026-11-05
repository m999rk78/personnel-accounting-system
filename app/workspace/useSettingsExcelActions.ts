import type { RefObject } from "react";
import { notifyTableImportOrder } from "../TableRowMoves";
import { downloadExcelFile as download, excelFileName, excelRowsInOrder } from "../excelFiles";
import { SETTINGS_EXCEL_HEADERS, blankExcelRows, employeesFromExcelNames } from "../settingsExcel";
import { WORK_TYPES_EXCEL_HEADERS, WORK_TYPES_EXCEL_SHEET, WORK_TYPES_EXCEL_WIDTHS, workTypesTemplateRows } from "../workTypesExcel";
import { openExcelExportPreview } from "../excelExportPreviewStore";
import { userProjectLabel, userRoleLabel } from "../userAccessModel";
import { directoryExcelHeader, normalize, safeFilePart } from "./model";
import type { AppUser, DataSet, DirectoryEntity, DirectoryFocus, Employee, Option, PositionRecord, Site } from "./types";

const loadPlacementXlsx = () => import("../placementXlsx");

type SettingsExcelContext = {
  data: DataSet | null; siteId: number; activeSite: Site | undefined; mayUseGlobalImports: boolean;
  rows: { employees: Employee[]; positions: PositionRecord[]; projectEmployees: Employee[]; sites: Site[]; users: AppUser[]; directoryItems: Option[]; };
  pending: { employees: number; positions: number; projectEmployees: number; directory: number; sites: number; users: number; };
  order: { employees: number[] | null; positions: number[] | null; reference: RefObject<Map<string, number[]>>; };
  directory: { focus: DirectoryFocus; group: { entity: DirectoryEntity; title: string; items: Option[]; } | undefined; title: string; };
  inputs: { employees: RefObject<HTMLInputElement | null>; positions: RefObject<HTMLInputElement | null>; projectEmployees: RefObject<HTMLInputElement | null>; directory: RefObject<HTMLInputElement | null>; };
  loadData: () => Promise<void>; setError: (value: string) => void; setNotice: (value: string) => void; setImporting: (value: boolean) => void;
};

export function useSettingsExcelActions({
  data,
  siteId,
  activeSite,
  mayUseGlobalImports,
  rows,
  pending,
  order,
  directory,
  inputs,
  loadData,
  setError,
  setNotice,
  setImporting,
}: SettingsExcelContext) {
  const { employees: visibleEmployees, positions: visiblePositions, projectEmployees: visibleProjectEmployees, sites: visibleSites, users: visibleUsers, directoryItems: visibleDirectoryItems } = rows;
  const { employees: employeeVisibleIds, positions: positionVisibleIds, reference: referenceExportOrder } = order;
  const { focus: directoryFocus, group: activeDirectoryGroup, title: focusedDirectoryTitle } = directory;
  const { employees: employeeFileInput, positions: positionFileInput, projectEmployees: projectEmployeeFileInput, directory: projectDirectoryFileInput } = inputs;
  function requireSavedExcelRows(pending: number) {
    if (!pending) return true;
    setError("Сначала сохраните или отмените изменения в таблице, затем повторите действие с Excel.");
    return false;
  }

  function openSettingsExportPreview(options: { title: string; description: string; fileName: string; sheetName: string; workbookTitle: string; headers: string[]; rows: (string | number)[][]; }) {
    setError("");
    try {
      if (!options.rows.length) throw new Error("Нет строк для экспорта с текущими фильтрами.");
      openExcelExportPreview({
        version: 1,
        title: options.title,
        description: options.description,
        fileName: excelFileName(options.fileName),
        headers: options.headers,
        rows: options.rows,
        workbook: { kind: "table", sheetName: options.sheetName, workbookTitle: options.workbookTitle, rows: options.rows },
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Не удалось открыть предпросмотр Excel.");
    }
  }

  function exportEmployees() {
    if (!data || !requireSavedExcelRows(pending.employees)) return;
    const employees = excelRowsInOrder(visibleEmployees, employeeVisibleIds);
    const headers = ["ФИО", "Тип", "Отдел", "Должность", "Проект"];
    const rows = employees.map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position, employee.projectCodes ?? employee.siteName ?? "Без объекта"]);
    openSettingsExportPreview({ title: "Сотрудники", description: `Строк в выгрузке: ${rows.length}`, fileName: "Сотрудники.xlsx", sheetName: "Сотрудники", workbookTitle: "Список сотрудников", headers, rows });
  }

  function exportPositions() {
    if (!data || !requireSavedExcelRows(pending.positions)) return;
    const positions = excelRowsInOrder(visiblePositions, positionVisibleIds);
    const headers = ["Тип", "Отдел", "Должность"];
    const rows = positions.map((position) => [position.employmentType, position.department, position.position]);
    openSettingsExportPreview({ title: "Должности", description: `Строк в выгрузке: ${rows.length}`, fileName: "Список_должностей.xlsx", sheetName: "Должности", workbookTitle: "Список должностей", headers, rows });
  }

  async function importEmployees(file: File) {
    if (!mayUseGlobalImports) return;
    setImporting(true); setError(""); setNotice("");
    try {
      if (!requireSavedExcelRows(pending.employees)) return;
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, SETTINGS_EXCEL_HEADERS.employees);
      if (!rows.length) throw new Error("В файле нет заполненных сотрудников.");
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-employees", employees: rows.map((row) => ({ fullName: row["ФИО"], employmentType: row["Тип"], department: row["Отдел"], position: row["Должность"], projectCode: row["Проект"] })) }) });
      const result = await response.json() as { error?: string; count?: number; unassigned?: number; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать сотрудников.");
      const imported = result.count ?? rows.length;
      setNotice(`Импортировано сотрудников: ${imported}${result.unassigned ? ` · без объекта: ${result.unassigned}` : ""}. Сохранён порядок Excel.`); await loadData();
      notifyTableImportOrder("employees", siteId);
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать сотрудников."); }
    finally { setImporting(false); if (employeeFileInput.current) employeeFileInput.current.value = ""; }
  }

  async function importPositions(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      if (!requireSavedExcelRows(pending.positions)) return;
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, SETTINGS_EXCEL_HEADERS.positions);
      if (!rows.length) throw new Error("В файле нет заполненных должностей.");
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-positions", positions: rows.map((row) => ({ employmentType: row["Тип"], department: row["Отдел"], position: row["Должность"] })) }) });
      const result = await response.json() as { error?: string; count?: number; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать должности.");
      setNotice(`Импортировано должностей: ${result.count ?? rows.length}`); await loadData();
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать должности."); }
    finally { setImporting(false); if (positionFileInput.current) positionFileInput.current.value = ""; }
  }

  function exportProjectEmployees() {
    if (!data || !requireSavedExcelRows(pending.projectEmployees)) return;
    const projectName = activeSite?.name ?? "Проект";
    const headers = ["ФИО", "Тип", "Отдел", "Должность"];
    const rows = excelRowsInOrder(visibleProjectEmployees, referenceExportOrder.current.get(`projectEmployees:${siteId}`) ?? null).map((employee) => [employee.fullName, employee.employmentType, employee.department, employee.position]);
    openSettingsExportPreview({ title: "Сотрудники проекта", description: `${projectName} · строк в выгрузке: ${rows.length}`, fileName: excelFileName("Сотрудники проекта", [projectName]), sheetName: "Сотрудники проекта", workbookTitle: `Сотрудники проекта — ${projectName}`, headers, rows });
  }

  async function downloadSettingsTemplate(kind: keyof typeof SETTINGS_EXCEL_HEADERS) {
    if (kind === "employees" && !mayUseGlobalImports) return;
    setError("");
    try {
      const { createTableXlsx } = await loadPlacementXlsx();
      const title = kind === "employees" ? "Сотрудники" : kind === "positions" ? "Должности" : kind === "projectEmployees" ? "Сотрудники проекта" : kind === "master" ? "Мастера" : "Зоны";
      const project = kind === "employees" || kind === "positions" ? undefined : activeSite?.name ?? "Проект";
      const headers = SETTINGS_EXCEL_HEADERS[kind];
      download(createTableXlsx(title, `Шаблон: ${title}${project ? ` — ${project}` : ""}`, headers, blankExcelRows(headers.length)), excelFileName(`Шаблон ${title.toLocaleLowerCase("ru-RU")}`, [project]));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось скачать шаблон Excel."); }
  }

  async function importProjectEmployees(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      if (!requireSavedExcelRows(pending.projectEmployees)) return;
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, ["ФИО"]);
      const uniqueNames = [...new Map(rows.map((row) => [normalize(row["ФИО"]), row["ФИО"].trim()])).values()].filter(Boolean);
      if (!uniqueNames.length) throw new Error("В файле нет заполненных сотрудников.");
      const employees = employeesFromExcelNames(uniqueNames, data?.employees ?? []);
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-project-employees", siteId, employeeIds: employees.map(employee => employee.id) }) });
      const result = await response.json() as { error?: string; count?: number; skipped?: number; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать сотрудников проекта.");
      setNotice(result.count ? `Импортировано сотрудников в проект: ${result.count}${result.skipped ? ` · уже были в проекте: ${result.skipped}` : ""}` : "Все сотрудники из файла уже добавлены в проект");
      await loadData();
      notifyTableImportOrder("project-personnel", siteId);
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать сотрудников проекта."); }
    finally { setImporting(false); if (projectEmployeeFileInput.current) projectEmployeeFileInput.current.value = ""; }
  }

  function exportProjectDirectory() {
    if (!activeDirectoryGroup || !requireSavedExcelRows(pending.directory)) return;
    const projectName = activeSite?.name ?? "Проект";
    if (activeDirectoryGroup.entity === "master") {
      const employeesByName = new Map((data?.placementEmployees ?? []).map((employee) => [normalize(employee.fullName), employee]));
      const headers = ["ФИО", "Тип", "Отдел", "Должность"];
      const rows = excelRowsInOrder(visibleDirectoryItems, referenceExportOrder.current.get(`directory:${siteId}:${directoryFocus}`) ?? null).map((item) => { const employee = employeesByName.get(normalize(item.name)); return [item.name, employee?.employmentType ?? "", employee?.department ?? "", employee?.position ?? ""]; });
      openSettingsExportPreview({ title: "Мастера", description: `${projectName} · строк в выгрузке: ${rows.length}`, fileName: `Мастера_${safeFilePart(projectName)}.xlsx`, sheetName: "Мастера", workbookTitle: `Мастера — ${projectName}`, headers, rows });
      return;
    }
    const header = directoryExcelHeader(activeDirectoryGroup.entity);
    const rows = excelRowsInOrder(visibleDirectoryItems, referenceExportOrder.current.get(`directory:${siteId}:${directoryFocus}`) ?? null).map((item) => [item.name]);
    openSettingsExportPreview({ title: focusedDirectoryTitle, description: `${projectName} · строк в выгрузке: ${rows.length}`, fileName: `${safeFilePart(focusedDirectoryTitle)}_${safeFilePart(projectName)}.xlsx`, sheetName: focusedDirectoryTitle, workbookTitle: `${focusedDirectoryTitle} — ${projectName}`, headers: [header], rows });
  }

  function exportProjects() {
    if (!requireSavedExcelRows(pending.sites)) return;
    const headers = ["Проект", "Код", "Часовой пояс"];
    const rows = excelRowsInOrder(visibleSites, null).map((site) => [site.name, site.code, site.timezone]);
    openSettingsExportPreview({ title: "Проекты", description: `Строк в выгрузке: ${rows.length}`, fileName: "Проекты.xlsx", sheetName: "Проекты", workbookTitle: "Список проектов", headers, rows });
  }

  function exportUsers() {
    if (!requireSavedExcelRows(pending.users)) return;
    const headers = ["ФИО", "Email", "Роль", "Проект", "Статус"];
    const rows = excelRowsInOrder(visibleUsers, null).map((user) => [user.fullName, user.email, userRoleLabel(user), userProjectLabel(user.role, user.assignedSiteId, visibleSites, user.projectAccess, user.projectAccessLimitedToViewer), user.status === "invited" ? "Приглашён" : "Активен"]);
    openSettingsExportPreview({ title: "Пользователи системы", description: `Строк в выгрузке: ${rows.length}`, fileName: "Пользователи_системы.xlsx", sheetName: "Пользователи", workbookTitle: "Пользователи системы", headers, rows });
  }

  async function downloadProjectDirectoryTemplate() {
    if (!activeDirectoryGroup) return;
    // Legacy links must never fall back to the old one-column work-type template.
    if (activeDirectoryGroup.entity === "mainWorkType" || activeDirectoryGroup.entity === "subworkType") {
      setError("");
      try {
        const { createTableXlsx } = await loadPlacementXlsx();
        download(createTableXlsx(WORK_TYPES_EXCEL_SHEET, `Шаблон: Виды и подвиды работ — ${activeSite?.name ?? "Проект"}`, WORK_TYPES_EXCEL_HEADERS, workTypesTemplateRows(), WORK_TYPES_EXCEL_WIDTHS), excelFileName("Шаблон видов и подвидов работ", [activeSite?.name]));
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось скачать шаблон Excel."); }
      return;
    }
    if (activeDirectoryGroup.entity === "zone" || activeDirectoryGroup.entity === "master") await downloadSettingsTemplate(activeDirectoryGroup.entity);
  }

  async function importProjectDirectory(file: File) {
    if (!activeDirectoryGroup) return;
    setImporting(true); setError(""); setNotice("");
    try {
      if (!requireSavedExcelRows(pending.directory)) return;
      const header = directoryExcelHeader(activeDirectoryGroup.entity);
      const { parseTableXlsx } = await loadPlacementXlsx();
      const rows = await parseTableXlsx(file, [header]);
      const names = [...new Map(rows.map((row) => [normalize(row[header]), row[header].trim()])).values()].filter(Boolean);
      if (!names.length) throw new Error("В файле нет заполненных значений.");
      if (activeDirectoryGroup.entity !== "zone" && activeDirectoryGroup.entity !== "master") throw new Error("Для видов и подвидов работ используйте объединённый справочник и шаблон с двумя колонками.");
      const employees = activeDirectoryGroup.entity === "master" ? employeesFromExcelNames(names, data?.placementEmployees ?? []) : [];
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-project-directory", entity: activeDirectoryGroup.entity, siteId, ...(activeDirectoryGroup.entity === "master" ? { employeeIds: employees.map(employee => employee.id) } : { names }) }) });
      const result = await response.json() as { error?: string; count?: number; skipped?: number; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось импортировать справочник.");
      setNotice(result.count ? `Импортировано значений: ${result.count}${result.skipped ? ` · уже существовали: ${result.skipped}` : ""}` : "Все значения из файла уже есть в справочнике");
      await loadData();
    } catch (importError) { setError(importError instanceof Error ? importError.message : "Не удалось импортировать справочник."); }
    finally { setImporting(false); if (projectDirectoryFileInput.current) projectDirectoryFileInput.current.value = ""; }
  }

  return {
    requireSavedExcelRows,
    exportEmployees,
    exportPositions,
    importEmployees,
    importPositions,
    exportProjectEmployees,
    downloadSettingsTemplate,
    importProjectEmployees,
    exportProjectDirectory,
    exportProjects,
    exportUsers,
    downloadProjectDirectoryTemplate,
    importProjectDirectory,
  };
}
