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
  const [bitrixReviewProgress, setBitrixReviewProgress] = useState<{ done: number; total: number; } | null>(null);
  const [bitrixReviewUpdatedCount, setBitrixReviewUpdatedCount] = useState(0);
  const [bitrixReviewNotice, setBitrixReviewNotice] = useState("");
  const bitrixBulkRunning = useRef(false);

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
  const selectedBitrixUpdatableEmployees = useMemo(() => selectedEmployeeRows.filter((employee) => employee.bitrixCheckStatus === "mismatch"
    && !employee.bitrixCheckAcknowledged && Boolean(employee.bitrix24Id)), [selectedEmployeeRows]);

  const selectedBitrixWarningEmployees = useMemo(() => selectedEmployeeRows.filter((employee) => Boolean(employee.bitrixCheckStatus)
    && !employee.bitrixCheckAcknowledged), [selectedEmployeeRows]);

  const bitrixAvailableEmployeeOptions = useMemo(() => [{ value: "", label: "Выберите сотрудника" }, ...visibleEmployees.filter((employee) => !employee.bitrix24Id).map((employee) => ({
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
    if (!mayInspectBitrix24) return;
    setLinkingBitrix24(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link-bitrix24-employees", ...(links ? { links } : {}) }) });
      const result = await response.json() as BitrixCheckResult & { error?: string; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось сопоставить сотрудников с Битрикс24.");
      await loadData();
      showBitrixCheckResult(result);
      if (result.linked) setNotice(`Сопоставлено сотрудников с Битрикс24: ${result.linked}.`);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "Не удалось сопоставить сотрудников с Битрикс24.");
    } finally { setLinkingBitrix24(false); }
  }

  function openBitrixEmployeeCreate(difference: BitrixCheckDifference) {
    if (!mayInspectBitrix24 || !difference.bitrix24Id) return;
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
    if (!mayInspectBitrix24 || !bitrixEmployeeAction?.difference.localEmployeeId || !bitrixEmployeeAction.difference.bitrix24Id) return;
    const { kind, difference } = bitrixEmployeeAction;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: kind === "update" ? "update-bitrix24-employee" : "delete-bitrix24-employee",
          employeeId: difference.localEmployeeId,
          bitrix24Id: difference.bitrix24Id,
        }),
      });
      const result = await response.json() as BitrixCheckResult & { error?: string; };
      if (!response.ok) throw new Error(result.error ?? (kind === "update" ? "Не удалось обновить сотрудника." : "Не удалось удалить сотрудника."));
      await loadData();
      showBitrixCheckResult(result);
      setNotice(kind === "update"
        ? `Данные сотрудника «${result.updatedEmployee?.name ?? difference.employeeName}» обновлены из Битрикс24.`
        : `Сотрудник «${result.deletedEmployee?.name ?? difference.employeeName}» удалён из активного справочника. История отчётов сохранена.`);
      setBitrixEmployeeAction(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не удалось выполнить действие с сотрудником.");
      setBitrixEmployeeAction(null);
    } finally { setProcessingBitrixEmployee(false); }
  }

  async function acknowledgeBitrixDifference(difference: BitrixCheckDifference) {
    if (!mayInspectBitrix24 || !difference.localEmployeeId) return;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge-bitrix24-difference", employeeId: difference.localEmployeeId }),
      });
      const result = await response.json() as { error?: string; };
      if (!response.ok) throw new Error(result.error ?? "Не удалось подтвердить предупреждение.");
      setBitrixCheckResult((current) => {
        if (!current) return current;
        const acknowledgedItems = current.differences.filter((item) => item.localEmployeeId === difference.localEmployeeId && !item.acknowledged);
        const totalDifferences = Math.max(0, current.totalDifferences - acknowledgedItems.length);
        const differenceCounts = current.differenceCounts ? { ...current.differenceCounts } : undefined;
        acknowledgedItems.forEach((item) => {
          if (!differenceCounts) return;
          differenceCounts[item.kind] = Math.max(0, (differenceCounts[item.kind] ?? 0) - 1);
        });
        return {
          ...current,
          status: totalDifferences ? "mismatch" : "ok",
          totalDifferences,
          differenceCounts,
          updatableEmployeeIds: bitrixReviewUpdateIds(current).filter(id => id !== difference.localEmployeeId),
          acknowledgedDifferences: (current.acknowledgedDifferences ?? 0) + acknowledgedItems.length,
          differences: current.differences.map((item) => item.localEmployeeId === difference.localEmployeeId ? { ...item, acknowledged: true } : item),
        };
      });
      setBitrixReviewSelectedIds(current => current.filter(id => id !== difference.localEmployeeId));
      await loadData();
      setNotice(`Предупреждение по сотруднику «${difference.employeeName}» подтверждено.`);
    } catch (acknowledgeError) {
      setError(acknowledgeError instanceof Error ? acknowledgeError.message : "Не удалось подтвердить предупреждение.");
    } finally { setProcessingBitrixEmployee(false); }
  }

  async function updateSelectedEmployeesFromBitrix() {
    const employeeIds = selectedBitrixUpdatableEmployees.map((employee) => employee.id);
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !employeeIds.length) return;
    setProcessingBitrixEmployee(true); setError(""); setNotice("");
    try {
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
    if (!mayInspectBitrix24 || !mayUpdateEmployees || !bitrixCheckResult || processingBitrixEmployee || bitrixBulkRunning.current) return;
    const eligible = new Set(bitrixReviewUpdateIds(bitrixCheckResult));
    const employeeIds = bitrixReviewSelectedIds.filter(id => eligible.has(id));
    if (!employeeIds.length || !requireSavedExcelRows(employeeDrafts.length + employeeFullRowEditIds.length)) return;
    bitrixBulkRunning.current = true;
    let started = false;
    let failureMessage = "";
    let updatedCount = 0;
    const failures: Array<{ id: number; name: string; error: string; }> = [];
    try {
      if (!await confirm({ title: "Обновить выбранных сотрудников?", description: `Сотрудников: ${employeeIds.length}. Каждый будет обновлён по своей связанной карточке Битрикс24. Ранее заполненные отчёты и табели сохранят историю.\n\nНовые, уволенные и отсутствующие в Битрикс24 сотрудники не добавляются и не удаляются этим действием.`, confirmLabel: `Обновить выбранных (${employeeIds.length})`, cancelLabel: "Отмена" })) return;
      started = true;
      setProcessingBitrixEmployee(true); setError(""); setNotice(""); setBitrixReviewNotice("");
      setBitrixReviewProgress({ done: 0, total: employeeIds.length });
      for (const batch of bitrixReviewUpdateBatches(employeeIds)) {
        const response = await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update-selected-bitrix24-employees", employeeIds: batch }) });
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
        if (updatedCount) setBitrixReviewNotice(`Обновлено сотрудников: ${updatedCount}. У каждого применены данные его карточки Битрикс24.`);
        if (failureMessage) setError(failureMessage);
        setBitrixReviewProgress(null);
        setProcessingBitrixEmployee(false);
      }
      bitrixBulkRunning.current = false;
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
      setNotice(`Подтверждено предупреждений: ${count}. Эти расхождения отмечены как допустимые.`);
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

  const bitrixReviewUpdateIdsForAll = bitrixCheckResult ? bitrixReviewUpdateIds(bitrixCheckResult) : [];
  const bitrixReviewEligibleIds = new Set(bitrixReviewUpdateIdsForAll);
  const bitrixReviewSelectedCount = bitrixReviewSelectedIds.filter(id => bitrixReviewEligibleIds.has(id)).length;
  const selectedBitrixEmployeeId = selectedBitrixDifference?.bitrix24Id
    ? bitrixManualLinks[selectedBitrixDifference.bitrix24Id] ?? ""
    : "";

  const canLinkSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayUpdateEmployees && bitrixCheckResult?.autoLinkable === 0 && selectedBitrixDifference?.kind === "missing_locally" && selectedBitrixDifference.bitrix24Id);
  const canCreateSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayCreateEmployees && selectedBitrixDifference?.kind === "missing_locally" && selectedBitrixDifference.bitrix24Id && !selectedBitrixDifference.suggestedEmployeeIds?.length);
  const canUpdateSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayUpdateEmployees && selectedBitrixDifference?.kind === "changed" && selectedBitrixDifference.localEmployeeId && selectedBitrixDifference.bitrix24Id);
  const canDeleteSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayDeleteEmployees && selectedBitrixDifference && ["missing_in_bitrix", "dismissed_in_bitrix"].includes(selectedBitrixDifference.kind) && selectedBitrixDifference.localEmployeeId && selectedBitrixDifference.bitrix24Id);
  const canAcknowledgeSelectedBitrixEmployee = Boolean(mayInspectBitrix24 && mayUpdateEmployees && selectedBitrixDifference?.localEmployeeId && selectedBitrixDifference.kind !== "missing_locally" && !selectedBitrixDifference.acknowledged);
  const selectedBitrixDifferenceDetails = selectedBitrixDifference?.kind === "missing_locally"
    ? selectedBitrixDifference.suggestedEmployeeIds?.length ? "Выберите подходящего сотрудника из справочника." : "Такого сотрудника нет в справочнике нашей системы."
    : selectedBitrixDifference?.details ?? "";

  return {
    syncingBitrix24,
    linkingBitrix24,
    bitrixCheckResult,
    setBitrixCheckResult,
    setSelectedBitrixDifferenceIndex,
    bitrixReviewSelectedIds,
    setBitrixReviewSelectedIds,
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
    acknowledgeSelectedBitrixWarnings,
    selectedBitrixDifferenceSafeIndex,
    selectedBitrixDifference,
    bitrixReviewUpdateIdsForAll,
    bitrixReviewSelectedCount,
    selectedBitrixEmployeeId,
    canLinkSelectedBitrixEmployee,
    canCreateSelectedBitrixEmployee,
    canUpdateSelectedBitrixEmployee,
    canDeleteSelectedBitrixEmployee,
    canAcknowledgeSelectedBitrixEmployee,
    selectedBitrixDifferenceDetails,
  };
}
