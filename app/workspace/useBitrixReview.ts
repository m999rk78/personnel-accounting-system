"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type FormEvent } from "react";
import { bitrixReviewUpdateBatches, bitrixReviewUpdateIds } from "../bitrixReviewSelection";
import { formatBitrix24Cooldown, remainingBitrix24Cooldown } from "../bitrix24Cooldown";
import type { ConfirmationOptions } from "../useConfirmationDialog";
import type { BitrixCheckDifference, BitrixCheckResult, BitrixEmployeeCreateDraft, DataSet, Employee, EmployeeDraft, Site, View } from "./types";
import { normalize } from "./model";

type BitrixReviewOptions = {
  data: DataSet | null;
  view: View;
  visibleEmployees: Employee[];
  visibleSites: Site[];
  selectedEmployeeRows: Employee[];
  employeeDrafts: EmployeeDraft[];
  employeeFullRowEditIds: number[];
  mayCreateEmployees: boolean;
  mayDeleteEmployees: boolean;
  mayInspectBitrix24: boolean;
  mayUpdateEmployees: boolean;
  loadData: () => Promise<void>;
  requireSavedExcelRows: (pending: number) => boolean;
  setEmployeePendingDeletes: Dispatch<SetStateAction<number[]>>;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
  confirm: (options: ConfirmationOptions) => Promise<boolean>;
};

export function useBitrixReview({
  data,
  view,
  visibleEmployees,
  visibleSites,
  selectedEmployeeRows,
  employeeDrafts,
  employeeFullRowEditIds,
  mayCreateEmployees,
  mayDeleteEmployees,
  mayInspectBitrix24,
  mayUpdateEmployees,
  loadData,
  requireSavedExcelRows,
  setEmployeePendingDeletes,
  setError,
  setNotice,
  confirm,
}: BitrixReviewOptions) {
  const [syncingBitrix24, setSyncingBitrix24] = useState(false);
  const [linkingBitrix24, setLinkingBitrix24] = useState(false);
  const [bitrix24Clock, setBitrix24Clock] = useState(() => Date.now());
  const [bitrixCheckResult, setBitrixCheckResult] = useState<BitrixCheckResult | null>(null);
  const [selectedBitrixDifferenceIndex, setSelectedBitrixDifferenceIndex] = useState(0);
  const [bitrixReviewSelectedIds, setBitrixReviewSelectedIds] = useState<number[]>([]);
  const [bitrixLinkSelectedIds, setBitrixLinkSelectedIds] = useState<string[]>([]);
  const [bitrixSelectionMode, setBitrixSelectionMode] = useState<"link" | "update">("link");
  const [bitrixReviewProgress, setBitrixReviewProgress] = useState<{ action: "update" | "ignore"; done: number; total: number; } | null>(null);
  const [bitrixReviewUpdatedCount, setBitrixReviewUpdatedCount] = useState(0);
  const [bitrixReviewNotice, setBitrixReviewNotice] = useState("");
  const bitrixBulkRunning = useRef(false);
  const bitrixLinkRunning = useRef(false);

  useEffect(() => {
    if (!bitrixReviewProgress) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [bitrixReviewProgress]);

  const [bitrixManualLinks, setBitrixManualLinks] = useState<Record<string, string>>({});
  const [bitrixEmployeeCreateDraft, setBitrixEmployeeCreateDraft] = useState<BitrixEmployeeCreateDraft | null>(null);
  const [bitrixEmployeeCreateError, setBitrixEmployeeCreateError] = useState("");
  const [creatingBitrixEmployee, setCreatingBitrixEmployee] = useState(false);
  const [bitrixEmployeeAction, setBitrixEmployeeAction] = useState<{ kind: "update" | "delete"; difference: BitrixCheckDifference; } | null>(null);
  const [processingBitrixEmployee, setProcessingBitrixEmployee] = useState(false);
  const officeTransfersById = useMemo(() => new Map((bitrixCheckResult?.differences ?? []).flatMap(difference =>
    difference.officeTransfer && difference.localEmployeeId ? [[difference.localEmployeeId, difference] as const] : [])), [bitrixCheckResult?.differences]);
  const selectedBitrixUpdatableEmployees = useMemo(() => selectedEmployeeRows.filter((employee) =>
    (["mismatch", "blacklisted_in_bitrix"].includes(employee.bitrixCheckStatus ?? "") || (mayDeleteEmployees && employee.bitrixCheckStatus === "dismissed_in_bitrix"))
    && !employee.bitrixCheckAcknowledged && Boolean(employee.bitrix24Id) && !employee.bitrixCheckOfficeTransfer
    && !officeTransfersById.has(employee.id)), [mayDeleteEmployees, officeTransfersById, selectedEmployeeRows]);

  const selectedBitrixWarningEmployees = useMemo(() => selectedEmployeeRows.filter((employee) => Boolean(employee.bitrixCheckStatus)
    && employee.bitrixCheckStatus !== "blacklisted_in_bitrix" && !employee.bitrixCheckAcknowledged && !employee.bitrixCheckOfficeTransfer
    && !officeTransfersById.has(employee.id)), [officeTransfersById, selectedEmployeeRows]);

  const allBitrixEmployeeOptions = useMemo(() => [{ value: "", label: "Выберите сотрудника" }, ...visibleEmployees.filter((employee) => !employee.bitrix24Id).map((employee) => ({
    value: String(employee.id),
    label: `${employee.fullName} · ${employee.employmentType} / ${employee.department} / ${employee.position}`,
  }))], [visibleEmployees]);

  const inspectBitrix24Remaining = remainingBitrix24Cooldown(data?.bitrix24Cooldowns?.inspect.nextAllowedAt, bitrix24Clock);
  const inspectBitrix24Title = inspectBitrix24Remaining > 0
    ? `Повторная проверка будет доступна через ${formatBitrix24Cooldown(inspectBitrix24Remaining)}.`
    : "Сравнивает связанные карточки с Битрикс24 без изменения справочника.";

  useEffect(() => {
    if (!mayInspectBitrix24 || view !== "employees") return;
    const refreshTimeout = window.setTimeout(() => setBitrix24Clock(Date.now()), 0);
    const interval = window.setInterval(() => setBitrix24Clock(Date.now()), 60_000);
    const deadlines = [data?.bitrix24Cooldowns?.inspect.nextAllowedAt]
      .flatMap((value) => value ? [new Date(value).getTime()] : []).filter((value) => Number.isFinite(value) && value > Date.now());
    const timeout = deadlines.length
      ? window.setTimeout(() => setBitrix24Clock(Date.now()), Math.min(...deadlines.map((deadline) => deadline - Date.now())) + 50)
      : undefined;
    return () => { window.clearTimeout(refreshTimeout); window.clearInterval(interval); if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [data?.bitrix24Cooldowns?.inspect.nextAllowedAt, mayInspectBitrix24, view]);

  function showBitrixCheckResult(result: BitrixCheckResult) {
    setBitrixCheckResult(result);
    setSelectedBitrixDifferenceIndex(0);
    setBitrixReviewSelectedIds([]);
    setBitrixLinkSelectedIds([]);
    setBitrixSelectionMode(result.differences.some(difference => difference.officeTransfer) ? "update" : "link");
    setBitrixReviewUpdatedCount(0);
    setBitrixReviewNotice("");
    setBitrixEmployeeCreateDraft(null);
    setBitrixEmployeeCreateError("");
    setBitrixManualLinks(Object.fromEntries(result.differences.flatMap((difference) =>
      difference.kind === "missing_locally" && difference.bitrix24Id && difference.suggestedEmployeeIds?.length === 1
        ? [[difference.bitrix24Id, String(difference.suggestedEmployeeIds[0])]]
        : [])));
  }

  async function inspectBitrix24Connection() {
    if (!mayInspectBitrix24) return;
    setSyncingBitrix24(true); setBitrixCheckResult(null); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "inspect-bitrix24" }) });
      const result = await response.json() as BitrixCheckResult & { error?: string; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось проверить подключение к Битрикс24.");
      await loadData();
      showBitrixCheckResult(result);
    } catch (inspectError) {
      const message = inspectError instanceof Error ? inspectError.message : "Не удалось проверить подключение к Битрикс24.";
      await loadData();
      setError(message);
    } finally { setSyncingBitrix24(false); }
  }

  async function linkBitrix24Employees(links?: Array<{ bitrix24Id: string; employeeId: number; }>) {
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !bitrixCheckResult || bitrixLinkRunning.current
      || creatingBitrixEmployee || processingBitrixEmployee || bitrixBulkRunning.current) return;
    const manualLink = links?.[0];
    if (links && links.length !== 1) return;
    if (!manualLink && !bitrixLinkSelectedCount) return;
    const difference = manualLink && bitrixCheckResult.differences.find(item => item.kind === "missing_locally" && item.bitrix24Id === manualLink.bitrix24Id);
    if (manualLink && !difference) return;
    const activeTarget = manualLink && visibleEmployees.find(employee => employee.id === manualLink.employeeId && !employee.bitrix24Id);
    if (manualLink && !activeTarget) return;
    if (difference?.archivedLink && (!manualLink || !difference.suggestedEmployeeIds?.includes(manualLink.employeeId))) return;
    if (!requireSavedExcelRows(employeeDrafts.length + employeeFullRowEditIds.length)) return;
    const selectedArchiveLinks = manualLink ? Number(Boolean(difference?.archivedLink)) : bitrixLinkSelectedArchiveCount;
    const allowArchivedLink = selectedArchiveLinks > 0;
    const archiveOnly = manualLink ? Boolean(difference?.archivedLink) : selectedArchiveLinks === bitrixLinkSelectedCount;
    const archiveLinkRevision = bitrixCheckResult.archiveLinkRevision;
    if (allowArchivedLink && !archiveLinkRevision) {
      setError("Перед переносом связи выполните проверку с Битрикс24 ещё раз.");
      return;
    }
    bitrixLinkRunning.current = true;
    setLinkingBitrix24(true);
    try {
      if (allowArchivedLink && !await confirm({
        title: manualLink ? "Перенести связь на действующую карточку?" : archiveOnly ? "Перенести связи на действующие карточки?" : "Сопоставить карточки с Битрикс24?",
        description: (manualLink && difference && activeTarget
          ? `Связь Битрикс24 для «${difference.employeeName}» будет перенесена с архивной карточки на действующую: «${activeTarget.fullName}».\nВ Битрикс24: ${[difference.sourceEmploymentType, difference.sourceDepartment, difference.sourcePosition].filter(Boolean).join(" · ") || "кадровые поля не заполнены"}.\nВ нашей системе: ${[activeTarget.employmentType, activeTarget.department, activeTarget.position].filter(Boolean).join(" · ") || "кадровые поля не заполнены"}.`
          : `Выбрано для сопоставления: ${bitrixLinkSelectedCount}. Из них связей, которые будут перенесены с архивных карточек на действующие: ${selectedArchiveLinks}.${
            selectedArchiveTransfers.length ? `\nУ ${selectedArchiveTransfers.length} карточек найден единственный кандидат по ФИО, но кадровые данные могут отличаться. Подтвердите, что это те же сотрудники.` : ""
          }`)
          + " Кадровые данные, назначенные объекты, отчёты и табели останутся без изменений.",
        confirmLabel: archiveOnly ? "Перенести связь" : "Сопоставить карточки",
        cancelLabel: "Отмена",
      })) return;
      setError(""); setNotice("");
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: "link-bitrix24-employees",
        ...(manualLink ? { links } : {
          ...(selectedAutoLinks.length ? { autoLinkBitrixIds: selectedAutoLinks.map(option => option.bitrix24Id) } : {}),
          ...(selectedArchiveTransfers.length ? { archiveTransferLinks: selectedArchiveTransfers } : {}),
        }),
        ...(allowArchivedLink ? { allowArchivedLink, archiveLinkRevision } : {}),
      }) });
      const result = await response.json() as BitrixCheckResult & { error?: string; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сопоставить сотрудников с Битрикс24.");
      await loadData();
      showBitrixCheckResult(result);
      if (result.linked) setNotice(`Сопоставлено сотрудников с Битрикс24: ${result.linked}.`);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "Не удалось сопоставить сотрудников с Битрикс24.");
    } finally { bitrixLinkRunning.current = false; setLinkingBitrix24(false); }
  }

  function openBitrixEmployeeCreate(difference: BitrixCheckDifference) {
    if (!mayInspectBitrix24 || !mayCreateEmployees || difference.kind !== "missing_locally" || !difference.bitrix24Id
      || difference.archivedLink || difference.suggestedEmployeeIds?.length) return;
    const position = data?.positionCatalog.find((option) =>
      normalize(option.employmentType) === normalize(difference.sourceEmploymentType ?? "")
      && normalize(option.department) === normalize(difference.sourceDepartment ?? "")
      && normalize(option.position) === normalize(difference.sourcePosition ?? ""));
    const projectKeys = difference.sourceProjectKeys ?? [];
    const matchedSites = visibleSites.filter((site) => projectKeys.some((key) =>
      normalize(key) === normalize(site.name) || normalize(key) === normalize(site.code)));
    setBitrixEmployeeCreateDraft({
      bitrix24Id: difference.bitrix24Id,
      fullName: difference.employeeName,
      positionId: position ? String(position.id) : "",
      projectSiteId: matchedSites.length === 1 ? String(matchedSites[0].id) : projectKeys.length ? "" : "__unassigned__",
      sourceEmploymentType: difference.sourceEmploymentType ?? "",
      sourceDepartment: difference.sourceDepartment ?? "",
      sourcePosition: difference.sourcePosition ?? "",
      sourceProjectKeys: projectKeys,
    });
    setBitrixEmployeeCreateError("");
  }

  async function createBitrix24Employee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mayInspectBitrix24 || !bitrixEmployeeCreateDraft) return;
    if (!bitrixEmployeeCreateDraft.positionId || !bitrixEmployeeCreateDraft.projectSiteId) {
      setBitrixEmployeeCreateError("Выберите должность и объект. Если объект ещё не назначен, выберите «Без объекта».");
      return;
    }
    setCreatingBitrixEmployee(true); setBitrixEmployeeCreateError(""); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-bitrix24-employee",
          bitrix24Id: bitrixEmployeeCreateDraft.bitrix24Id,
          positionId: Number(bitrixEmployeeCreateDraft.positionId),
          projectSiteId: bitrixEmployeeCreateDraft.projectSiteId === "__unassigned__" ? null : Number(bitrixEmployeeCreateDraft.projectSiteId),
        }),
      });
      const result = await response.json() as BitrixCheckResult & { error?: string; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось добавить сотрудника из Битрикс24.");
      await loadData();
      showBitrixCheckResult(result);
      setNotice(`Сотрудник «${result.createdEmployee?.name ?? bitrixEmployeeCreateDraft.fullName}» добавлен и связан с Битрикс24.`);
    } catch (createError) {
      setBitrixEmployeeCreateError(createError instanceof Error ? createError.message : "Не удалось добавить сотрудника из Битрикс24.");
    } finally { setCreatingBitrixEmployee(false); }
  }

  async function applyBitrixEmployeeAction() {
    if (!mayInspectBitrix24 || !bitrixEmployeeAction) return;
    const { kind, difference } = bitrixEmployeeAction;
    const { localEmployeeId, bitrix24Id } = difference;
    if (!localEmployeeId || !bitrix24Id) return;
    const officeTransferFingerprint = difference.officeTransfer ? difference.officeTransferFingerprint : undefined;
    const currentTransfer = officeTransfersById.get(localEmployeeId);
    if ((difference.officeTransfer || currentTransfer) && (!officeTransferFingerprint
      || currentTransfer?.officeTransferFingerprint !== officeTransferFingerprint)) return;
    if (kind === "update"
      ? !mayUpdateEmployees || !["changed", "blacklisted_in_bitrix"].includes(difference.kind)
        || !bitrixCheckResult || !bitrixReviewUpdateIds(bitrixCheckResult).includes(localEmployeeId)
      : !mayDeleteEmployees || !["missing_in_bitrix", "dismissed_in_bitrix"].includes(difference.kind)) return;
    if (officeTransferFingerprint && !requireSavedExcelRows(employeeDrafts.length + employeeFullRowEditIds.length)) return;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: kind === "update" ? "update-bitrix24-employee" : "delete-bitrix24-employee",
          employeeId: localEmployeeId,
          bitrix24Id,
          ...(officeTransferFingerprint ? { officeTransferFingerprints: { [localEmployeeId]: officeTransferFingerprint } } : {}),
        }),
      });
      const result = await response.json() as BitrixCheckResult & { error?: string; };
      if (!response.ok) throw new Error(result.error ?? (kind === "update" ? "Не удалось обновить сотрудника." : "Не удалось удалить сотрудника."));
      await loadData();
      showBitrixCheckResult(result);
      setNotice(kind === "update"
        ? difference.officeTransfer
          ? `Перевод сотрудника «${result.updatedEmployee?.name ?? difference.employeeName}» ${difference.officeTransfer === "to_office" ? "в центральный офис" : "на объект"} подтверждён. История отчётов и табелей сохранена.`
          : difference.kind === "blacklisted_in_bitrix"
          ? `Сотрудник «${result.updatedEmployee?.name ?? difference.employeeName}» перенесён в архив со статусом «Чёрный список». История отчётов и табелей сохранена.`
          : `Данные сотрудника «${result.updatedEmployee?.name ?? difference.employeeName}» обновлены из Битрикс24.`
        : `Карточка сотрудника «${result.deletedEmployee?.name ?? difference.employeeName}» перенесена в архив. История отчётов и табелей сохранена.`);
      setBitrixEmployeeAction(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не удалось выполнить действие с сотрудником.");
      setBitrixEmployeeAction(null);
    } finally { setProcessingBitrixEmployee(false); }
  }

  function selectedWarningFingerprints(employeeIds: readonly number[]) {
    const fingerprints = bitrixCheckResult?.warningFingerprints;
    return fingerprints && Object.fromEntries(employeeIds.flatMap(id => fingerprints[id] === undefined ? [] : [[id, fingerprints[id]]]));
  }

  function markBitrixDifferencesIgnored(employeeIds: readonly number[]) {
    const ignored = new Set(employeeIds);
    if (!ignored.size) return;
    setBitrixCheckResult(current => {
      if (!current) return current;
      const differenceCounts = current.differenceCounts ? { ...current.differenceCounts } : undefined;
      let newlyIgnored = 0;
      const differences = current.differences.map(item => {
        if (!item.localEmployeeId || !ignored.has(item.localEmployeeId) || item.acknowledged || !canAcknowledgeDifference(item)) return item;
        newlyIgnored++;
        if (differenceCounts) differenceCounts[item.kind] = Math.max(0, (differenceCounts[item.kind] ?? 0) - 1);
        return { ...item, acknowledged: true };
      });
      const totalDifferences = Math.max(0, current.totalDifferences - newlyIgnored);
      const requiredActionIds = new Set(differences.filter(item => item.kind === "blacklisted_in_bitrix" || item.officeTransfer).map(item => item.localEmployeeId));
      return {
        ...current,
        status: totalDifferences ? "mismatch" : "ok",
        totalDifferences,
        differenceCounts,
        updatableEmployeeIds: bitrixReviewUpdateIds(current).filter(id => !ignored.has(id) || requiredActionIds.has(id)),
        ignorableEmployeeIds: current.ignorableEmployeeIds?.filter(id => !ignored.has(id)),
        acknowledgedDifferences: (current.acknowledgedDifferences ?? 0) + newlyIgnored,
        differences: [...differences.filter(item => !item.acknowledged), ...differences.filter(item => item.acknowledged)],
      };
    });
    setSelectedBitrixDifferenceIndex(0);
    setBitrixReviewSelectedIds(current => current.filter(id => !ignored.has(id)));
  }

  async function acknowledgeBitrixDifference(difference: BitrixCheckDifference) {
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !difference.localEmployeeId || difference.acknowledged
      || !canAcknowledgeDifference(difference) || officeTransfersById.has(difference.localEmployeeId)
      || processingBitrixEmployee || bitrixBulkRunning.current || bitrixLinkRunning.current) return;
    const employeeId = difference.localEmployeeId;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge-bitrix24-difference", employeeId, warningFingerprints: selectedWarningFingerprints([employeeId]) }),
      });
      const result = await response.json() as { error?: string; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось проигнорировать различие.");
      markBitrixDifferencesIgnored([employeeId]);
      await loadData();
      setNotice(`Данные сотрудника «${difference.employeeName}» оставлены как есть. Расхождение скрыто, пока оно не изменится.`);
    } catch (acknowledgeError) {
      setError(acknowledgeError instanceof Error ? acknowledgeError.message : "Не удалось проигнорировать различие.");
    } finally { setProcessingBitrixEmployee(false); }
  }

  async function updateSelectedEmployeesFromBitrix() {
    const employeeIds = selectedBitrixUpdatableEmployees.map((employee) => employee.id);
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !employeeIds.length) return;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
      const blacklistCount = selectedBitrixUpdatableEmployees.filter(employee => employee.bitrixCheckStatus === "blacklisted_in_bitrix").length;
      const dismissalCount = selectedBitrixUpdatableEmployees.filter(employee => employee.bitrixCheckStatus === "dismissed_in_bitrix").length;
      const archiveCounts = [dismissalCount && `«Увольнения»: ${dismissalCount}`, blacklistCount && `«Чёрный список»: ${blacklistCount}`].filter(Boolean).join(", ");
      if (archiveCounts && !await confirm({ title: "Обновить выбранных сотрудников?", description: `Сотрудники будут перенесены в архив (${archiveCounts}). История отчётов и табелей сохранится. Остальные выбранные сотрудники будут обновлены по своим карточкам Битрикс24.`, confirmLabel: "Применить изменения", cancelLabel: "Отмена" })) return;
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-selected-bitrix24-employees", employeeIds }),
      });
      const result = await response.json() as {
        error?: string;
        updatedEmployees?: Array<{ id: number; name: string; }>;
        failedEmployees?: Array<{ id: number; name: string; error: string; }>;
      };
      if (!response.ok) throw new Error(result.error ?? "Не удалось актуализировать выбранных сотрудников.");
      await loadData();
      const updatedCount = result.updatedEmployees?.length ?? 0;
      const failures = result.failedEmployees ?? [];
      const failedIds = new Set(failures.map((employee) => employee.id));
      setEmployeePendingDeletes((current) => current.filter((id) => failedIds.has(id)));
      if (updatedCount) setNotice(`Данные ${updatedCount} ${updatedCount === 1 ? "сотрудника актуализированы" : "сотрудников актуализированы"} из Битрикс24.`);
      if (failures.length) setError(`Не удалось актуализировать: ${failures.slice(0, 3).map((employee) => `${employee.name} — ${employee.error}`).join("; ")}${failures.length > 3 ? `; ещё ${failures.length - 3}` : ""}`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Не удалось актуализировать выбранных сотрудников.");
    } finally { setProcessingBitrixEmployee(false); }
  }

  async function updateBitrixReviewSelection() {
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !bitrixCheckResult || processingBitrixEmployee || bitrixBulkRunning.current
      || bitrixLinkRunning.current || creatingBitrixEmployee) return;
    const employeeIds = bitrixReviewSelectedIds.filter(id => bitrixReviewEligibleIds.has(id));
    if (!employeeIds.length || !requireSavedExcelRows(employeeDrafts.length + employeeFullRowEditIds.length)) return;
    bitrixBulkRunning.current = true;
    let started = false;
    let failureMessage = "";
    let updatedCount = 0;
    const failures: Array<{ id: number; name: string; error: string; }> = [];
    try {
      const dismissedCount = employeeIds.filter(id => dismissalIds.has(id)).length;
      const blacklistCount = employeeIds.filter(id => blacklistIds.has(id)).length;
      const archiveNote = dismissedCount || blacklistCount ? ` В архив будут перенесены сотрудники со статусами «Увольнения» (${dismissedCount}) и «Чёрный список» (${blacklistCount}).` : "";
      const toOffice = employeeIds.filter(id => officeTransfersById.get(id)?.officeTransfer === "to_office").length;
      const toSite = employeeIds.filter(id => officeTransfersById.get(id)?.officeTransfer === "to_site").length;
      const officeOnly = toOffice + toSite === employeeIds.length;
      const transferNote = [toOffice && `На площадке перестанут отображаться переведённые в центральный офис: ${toOffice}.`,
        toSite && `На объект вернутся существующие карточки: ${toSite}.`].filter(Boolean).join(" ");
      if (!await confirm({ title: officeOnly ? "Подтвердить переводы сотрудников?" : "Обновить выбранных сотрудников?", description: `Сотрудников: ${employeeIds.length}.${officeOnly ? "" : " Каждый будет обновлён по своей связанной карточке Битрикс24."}${archiveNote}${transferNote ? ` ${transferNote}` : ""} Ранее заполненные отчёты и табели сохранят историю.\n\nКарточки не добавляются и не удаляются.`, confirmLabel: `${officeOnly ? "Подтвердить переводы" : "Обновить выбранных"} (${employeeIds.length})`, cancelLabel: "Отмена" })) return;
      started = true;
      setProcessingBitrixEmployee(true); setError(""); setNotice(""); setBitrixReviewNotice("");
      setBitrixReviewProgress({ action: "update", done: 0, total: employeeIds.length });
      for (const batch of bitrixReviewUpdateBatches(employeeIds)) {
        const fingerprints = batch.flatMap(id => {
          const value = officeTransfersById.get(id)?.officeTransferFingerprint;
          return value ? [[id, value] as const] : [];
        });
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action: "update-selected-bitrix24-employees", employeeIds: batch,
          ...(fingerprints.length ? { officeTransferFingerprints: Object.fromEntries(fingerprints) } : {}),
        }) });
        const result = await response.json() as BitrixCheckResult & { error?: string; updatedEmployees?: Array<{ id: number; name: string; }>; failedEmployees?: Array<{ id: number; name: string; error: string; }>; };
        if (!response.ok) throw new Error(result.error ?? "Не удалось обновить выбранных сотрудников.");
        const updatedIds = new Set((result.updatedEmployees ?? []).map(employee => employee.id));
        updatedCount += updatedIds.size;
        failures.push(...result.failedEmployees ?? []);
        setBitrixCheckResult(result);
        setSelectedBitrixDifferenceIndex(0);
        setBitrixReviewSelectedIds(current => current.filter(id => !updatedIds.has(id)));
        setBitrixReviewUpdatedCount(updatedCount);
        setBitrixReviewProgress(current => current ? { ...current, done: current.done + batch.length } : current);
      }
      if (failures.length) failureMessage = `Не обновлены: ${failures.slice(0, 3).map(employee => `${employee.name} — ${employee.error}`).join("; ")}${failures.length > 3 ? `; ещё ${failures.length - 3}` : ""}. Эти сотрудники остались выбранными для повторной попытки.`;
    } catch (updateError) {
      failureMessage = `${updateError instanceof Error ? updateError.message : "Не удалось обновить выбранных сотрудников."} Необработанные сотрудники остались выбранными. При неопределённом результате выполните проверку заново.`;
    } finally {
      if (started) {
        await loadData();
        if (updatedCount) setBitrixReviewNotice(`Обновлено сотрудников: ${updatedCount}. У каждого применены данные его карточки Битрикс24. История отчётов и табелей сохранена.`);
        if (failureMessage) setError(failureMessage);
        setBitrixReviewProgress(null);
        setProcessingBitrixEmployee(false);
      }
      bitrixBulkRunning.current = false;
    }
  }

  async function acknowledgeBitrixReviewSelection() {
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !bitrixCheckResult || processingBitrixEmployee || bitrixBulkRunning.current
      || bitrixLinkRunning.current || creatingBitrixEmployee || !bitrixReviewIgnoreSelectedIds.length) return;
    const employeeIds = bitrixReviewIgnoreSelectedIds;
    bitrixBulkRunning.current = true;
    setProcessingBitrixEmployee(true); setError(""); setNotice(""); setBitrixReviewNotice("");
    setBitrixReviewProgress({ action: "ignore", done: 0, total: employeeIds.length });
    const ignoredIds = new Set<number>();
    let failureMessage = "";
    try {
      for (const batch of bitrixReviewUpdateBatches(employeeIds)) {
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action: "acknowledge-selected-bitrix24-differences",
          employeeIds: batch,
          warningFingerprints: selectedWarningFingerprints(batch),
        }) });
        const result = await response.json() as { error?: string; employeeIds?: number[]; };
        if (!response.ok) throw new Error(result.error ?? "Не удалось проигнорировать выбранные различия.");
        const batchIds = new Set(batch);
        const acknowledged = (result.employeeIds ?? []).filter(id => batchIds.has(id));
        acknowledged.forEach(id => ignoredIds.add(id));
        markBitrixDifferencesIgnored(acknowledged);
        setBitrixReviewProgress(current => current ? { ...current, done: current.done + batch.length } : current);
      }
    } catch (acknowledgeError) {
      failureMessage = acknowledgeError instanceof Error ? acknowledgeError.message : "Не удалось проигнорировать выбранные различия.";
    } finally {
      try {
        if (ignoredIds.size) {
          setBitrixReviewNotice(`Данные оставлены как есть у сотрудников: ${ignoredIds.size}. Эти различия не будут подсвечиваться, пока не изменятся.`);
          await loadData();
        }
        if (ignoredIds.size < employeeIds.length) {
          setError([failureMessage, `Не удалось проигнорировать различия у сотрудников: ${employeeIds.length - ignoredIds.size}. Неподтверждённые различия остались в списке.`].filter(Boolean).join(" "));
        }
      } finally {
        setBitrixReviewProgress(null);
        setProcessingBitrixEmployee(false);
        bitrixBulkRunning.current = false;
      }
    }
  }

  async function acknowledgeSelectedBitrixWarnings() {
    const employeeIds = selectedBitrixWarningEmployees.map((employee) => employee.id);
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !employeeIds.length) return;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge-selected-bitrix24-differences", employeeIds }),
      });
      const result = await response.json() as { error?: string; acknowledgedCount?: number; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось подтвердить выбранные предупреждения.");
      await loadData();
      setEmployeePendingDeletes([]);
      const count = result.acknowledgedCount ?? employeeIds.length;
      setNotice(`Скрыто расхождений: ${count}. Они появятся снова, только если изменятся.`);
    } catch (acknowledgeError) {
      setError(acknowledgeError instanceof Error ? acknowledgeError.message : "Не удалось подтвердить выбранные предупреждения.");
    } finally { setProcessingBitrixEmployee(false); }
  }

  const selectedBitrixDifferenceSafeIndex = bitrixCheckResult
    ? Math.min(selectedBitrixDifferenceIndex, Math.max(0, bitrixCheckResult.differences.length - 1))
    : 0;

  const selectedBitrixDifference = bitrixCheckResult?.status === "mismatch"
    ? bitrixCheckResult.differences[selectedBitrixDifferenceSafeIndex]
    : undefined;

  const dismissalIds = new Set([...(bitrixCheckResult?.dismissalEmployeeIds ?? []), ...(bitrixCheckResult?.differences ?? []).flatMap(item =>
    item.kind === "dismissed_in_bitrix" && item.localEmployeeId ? [item.localEmployeeId] : [])]);
  const legacyTerminalIds = new Set(bitrixCheckResult?.legacyTerminalEmployeeIds ?? []);
  const bitrixReviewUpdateIdsForAll = bitrixCheckResult ? bitrixReviewUpdateIds(bitrixCheckResult)
    .filter(id => (mayDeleteEmployees || !dismissalIds.has(id) && !legacyTerminalIds.has(id))
      && (!officeTransfersById.has(id) || Boolean(officeTransfersById.get(id)?.officeTransferFingerprint))) : [];
  const bitrixReviewEligibleIds = new Set(bitrixReviewUpdateIdsForAll);
  const bitrixReviewSelectedCount = bitrixReviewSelectedIds.filter(id => bitrixReviewEligibleIds.has(id)).length;
  const blacklistIds = new Set((bitrixCheckResult?.differences ?? []).flatMap(item => item.kind === "blacklisted_in_bitrix" && item.localEmployeeId ? [item.localEmployeeId] : []));
  const ignorableIds = new Set((bitrixCheckResult?.ignorableEmployeeIds ?? (bitrixCheckResult?.differences ?? []).flatMap(item =>
    item.localEmployeeId && !item.acknowledged && canAcknowledgeDifference(item) ? [item.localEmployeeId] : []))
    .filter(id => Number.isSafeInteger(id) && id > 0 && !blacklistIds.has(id) && !officeTransfersById.has(id)));
  const bitrixReviewSelectableIds = [...new Set([...bitrixReviewUpdateIdsForAll, ...ignorableIds])];
  const bitrixReviewSelectionCount = bitrixReviewSelectedIds.filter(id => bitrixReviewEligibleIds.has(id) || ignorableIds.has(id)).length;
  const bitrixReviewIgnoreSelectedIds = bitrixReviewSelectedIds.filter(id => ignorableIds.has(id));
  const bitrixReviewBlacklistSelectedCount = bitrixReviewSelectedIds.filter(id => blacklistIds.has(id)).length;
  const bitrixAutoLinkOptions = (bitrixCheckResult?.autoLinkOptions ?? []).filter(option => !option.archivedLink || bitrixCheckResult?.archiveLinkRevision);
  const autoLinkIds = new Set(bitrixAutoLinkOptions.map(option => option.bitrix24Id));
  const archiveTransferOptions = bitrixCheckResult?.archiveLinkRevision
    ? (bitrixCheckResult.archiveTransferOptions ?? []).filter(option => !autoLinkIds.has(option.bitrix24Id)) : [];
  const bitrixLinkArchiveIds = [...bitrixAutoLinkOptions.filter(option => option.archivedLink).map(option => option.bitrix24Id),
    ...archiveTransferOptions.map(option => option.bitrix24Id)];
  const bitrixLinkEligibleIds = [...autoLinkIds, ...archiveTransferOptions.map(option => option.bitrix24Id)];
  const bitrixLinkSelectedSet = new Set(bitrixLinkSelectedIds);
  const selectedAutoLinks = bitrixAutoLinkOptions.filter(option => bitrixLinkSelectedSet.has(option.bitrix24Id));
  const selectedArchiveTransfers = archiveTransferOptions.filter(option => bitrixLinkSelectedSet.has(option.bitrix24Id));
  const bitrixLinkSelectedCount = selectedAutoLinks.length + selectedArchiveTransfers.length;
  const bitrixLinkSelectedArchiveCount = selectedAutoLinks.filter(option => option.archivedLink).length + selectedArchiveTransfers.length;
  const bitrixAvailableEmployeeOptions = selectedBitrixDifference?.archivedLink
    ? allBitrixEmployeeOptions.filter(option => !option.value || selectedBitrixDifference.suggestedEmployeeIds?.includes(Number(option.value)))
    : allBitrixEmployeeOptions;
  const preferredBitrixEmployeeId = selectedBitrixDifference?.bitrix24Id
    ? bitrixManualLinks[selectedBitrixDifference.bitrix24Id] ?? ""
    : "";
  const selectedBitrixEmployeeId = bitrixAvailableEmployeeOptions.some(option => option.value === preferredBitrixEmployeeId) ? preferredBitrixEmployeeId : "";

  const canLinkSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayUpdateEmployees && selectedBitrixDifference?.kind === "missing_locally" && selectedBitrixDifference.bitrix24Id
    && (!selectedBitrixDifference.archivedLink || bitrixCheckResult?.archiveLinkRevision && bitrixAvailableEmployeeOptions.length > 1));
  const canCreateSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayCreateEmployees && selectedBitrixDifference?.kind === "missing_locally" && selectedBitrixDifference.bitrix24Id && !selectedBitrixDifference.archivedLink && !selectedBitrixDifference.suggestedEmployeeIds?.length);
  const canUpdateSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayUpdateEmployees && selectedBitrixDifference && ["changed", "blacklisted_in_bitrix"].includes(selectedBitrixDifference.kind) && selectedBitrixDifference.localEmployeeId && bitrixReviewEligibleIds.has(selectedBitrixDifference.localEmployeeId) && selectedBitrixDifference.bitrix24Id);
  const canDeleteSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayDeleteEmployees && selectedBitrixDifference && ["missing_in_bitrix", "dismissed_in_bitrix"].includes(selectedBitrixDifference.kind) && selectedBitrixDifference.localEmployeeId && selectedBitrixDifference.bitrix24Id);
  function canAcknowledgeDifference(difference: BitrixCheckDifference) {
    const { kind } = difference;
    return !difference.officeTransfer && kind !== "missing_locally" && kind !== "blacklisted_in_bitrix" && kind !== "archived_returned_to_site";
  }
  const canAcknowledgeSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayUpdateEmployees && selectedBitrixDifference?.localEmployeeId
    && canAcknowledgeDifference(selectedBitrixDifference) && !officeTransfersById.has(selectedBitrixDifference.localEmployeeId) && !selectedBitrixDifference.acknowledged);
  const selectedBitrixDifferenceDetails = selectedBitrixDifference?.kind === "missing_locally" && !selectedBitrixDifference.suggestedEmployeeIds?.length
    ? "В нашем справочнике не найдено подходящей карточки."
    : selectedBitrixDifference?.details ?? "";

  return {
    syncingBitrix24,
    linkingBitrix24,
    bitrixCheckResult,
    setBitrixCheckResult,
    setSelectedBitrixDifferenceIndex,
    bitrixReviewSelectedIds,
    setBitrixReviewSelectedIds,
    bitrixLinkSelectedIds,
    setBitrixLinkSelectedIds,
    bitrixLinkEligibleIds,
    bitrixLinkArchiveIds,
    bitrixLinkSelectedCount,
    bitrixLinkSelectedArchiveCount,
    bitrixSelectionMode,
    setBitrixSelectionMode,
    bitrixReviewProgress,
    bitrixReviewUpdatedCount,
    bitrixReviewNotice,
    bitrixBulkRunning,
    setBitrixManualLinks,
    bitrixEmployeeCreateDraft,
    setBitrixEmployeeCreateDraft,
    bitrixEmployeeCreateError,
    setBitrixEmployeeCreateError,
    creatingBitrixEmployee,
    bitrixEmployeeAction,
    setBitrixEmployeeAction,
    processingBitrixEmployee,
    selectedBitrixUpdatableEmployees,
    selectedBitrixWarningEmployees,
    bitrixAvailableEmployeeOptions,
    inspectBitrix24Remaining,
    inspectBitrix24Title,
    inspectBitrix24Connection,
    linkBitrix24Employees,
    openBitrixEmployeeCreate,
    createBitrix24Employee,
    applyBitrixEmployeeAction,
    acknowledgeBitrixDifference,
    updateSelectedEmployeesFromBitrix,
    updateBitrixReviewSelection,
    acknowledgeBitrixReviewSelection,
    acknowledgeSelectedBitrixWarnings,
    selectedBitrixDifferenceSafeIndex,
    selectedBitrixDifference,
    bitrixReviewUpdateIdsForAll,
    bitrixReviewSelectedCount,
    bitrixReviewSelectableIds,
    bitrixReviewSelectionCount,
    bitrixReviewIgnoreSelectedCount: bitrixReviewIgnoreSelectedIds.length,
    bitrixReviewBlacklistSelectedCount,
    selectedBitrixEmployeeId,
    canLinkSelectedBitrixEmployee,
    canCreateSelectedBitrixEmployee,
    canUpdateSelectedBitrixEmployee,
    canDeleteSelectedBitrixEmployee,
    canAcknowledgeSelectedBitrixEmployee,
    selectedBitrixDifferenceDetails,
  };
}
