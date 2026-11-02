"use client";
import { compatibleSubworkId, workTypeChanges } from "./workTypeHierarchy";

import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GridEquipmentUnit, GridEquipmentEntry, GridOption } from "./AgDataGrids";
import { draftHistoryReducer, type DraftHistory, type DraftHistoryAction } from "./personnelSpreadsheet";
import { pasteEquipmentCells, equipmentCellErrors, equipmentEditableFields, equipmentOptionFields, timestampEquipmentDraft, type EquipmentSpreadsheetDraft as GridDraftRow } from "./equipmentSpreadsheet";
import type { EquipmentReportGridRow } from "./EquipmentReportGrid";
import type { EquipmentReport, EquipmentReportApprovedEntry, EquipmentReportData, EquipmentReportEntrySaveRequest, EquipmentReportDraftRow, EquipmentReportSaveRequest, EquipmentReportTransitionRequest, EquipmentReportRow, EquipmentReportValidationIssue, EquipmentReportValidationRequest, EquipmentReportValidationTarget } from "./equipmentReportTypes";
import { freezeEquipmentReportSessions, mergeEquipmentReportSessions, equipmentReportImportTarget, equipmentReportNewDate, equipmentReportNewKey, equipmentReportSaveIdentity } from "./equipmentReportSessions";
import { defaultPersonnelReportSubmissions as defaultEquipmentReportSubmissions, selectPersonnelReportSubmissions as selectEquipmentReportSubmissions, personnelReportReviewIssue as equipmentReportReviewIssue } from "./personnelReportActions";
import { mergeEquipmentSubmissionIssues, equipmentSubmissionCanSend, equipmentSubmissionCellIssues, equipmentSubmissionToken, type EquipmentSubmissionValidationState } from "./equipmentReportSubmissionValidation";
import { buildEquipmentReportCrew, equipmentReportCrewSource, equipmentReportYesterday } from "./equipmentReportCarryOver";
import { canViewPendingReportsFor, type UserRole } from "./roles";
import { equipmentExcelName } from "./equipmentExcel";
import { openExcelExportPreview } from "./excelExportPreviewStore";
import { ExcelActionsMenu } from "./ExcelActionsMenu";
import { downloadExcelFile, excelFileName } from "./excelFiles";
import { equipmentExcelWorkTypePairs, equipmentReportExcelRows } from "./equipmentReportExcel";
import { CustomSelect } from "./CustomSelect";
import { useWorkspaceTableOrder } from "./TableRowMoves";
import { isUnsavedEquipmentReportOrderId, equipmentReportOrderScope } from "./equipmentReportRowOrder";
import { isReportWorkDate, moveUnsavedReportDay } from "./reportDateChanges";
import "./personnelReport.css";

const ReportGrid = lazy(() => import("./EquipmentReportGrid").then(module => ({ default: module.EquipmentReportGrid })));
const keyOf = (report: EquipmentReport) => String(report.id);
const makeDraft = (seed: Partial<GridDraftRow> = {}): GridDraftRow => {
  const time = new Date().toISOString();
  return { key: crypto.randomUUID(), createdAt: time, updatedAt: time, equipmentId: "", equipmentQuery: "", shiftId: "", zoneId: "", mainWorkTypeId: "", subworkTypeId: "", hours: "", note: "", ...seed };
};
const toDraft = (row: EquipmentReportRow): GridDraftRow => makeDraft({ key: `report-${row.reportId}-${row.id}`, reportRowId: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, equipmentId: String(row.equipmentId ?? ""), equipmentQuery: row.equipmentName, shiftId: String(row.shiftId ?? ""), zoneId: String(row.zoneId ?? ""), mainWorkTypeId: String(row.mainWorkTypeId ?? ""), subworkTypeId: String(row.subworkTypeId ?? ""), hours: String(row.hours ?? ""), note: row.note });
const toApprovedDraft = (row: EquipmentReportRow): GridDraftRow => ({ ...toDraft(row), referenceIds: { equipmentId: row.equipmentId, shiftId: row.shiftId, zoneId: row.zoneId, mainWorkTypeId: row.mainWorkTypeId, subworkTypeId: row.subworkTypeId } });
const toEntryDraft = (entry: EquipmentReportApprovedEntry): GridDraftRow => ({ ...toApprovedDraft({ ...entry, reportId: 0, approvedEntryId: entry.id }), key: `approved-${entry.id}`, reportRowId: undefined });
const entryKey = (entry: EquipmentReportApprovedEntry) => `entry-${entry.id}`;
const displayDate = (date: string) => date.split("-").reverse().join(".");
type SubmissionValidationPlan = { payload: EquipmentReportValidationRequest; token: string; localIssues: EquipmentReportValidationIssue[] };
function ReportDialog({ titleId, children, onClose, busy, className = "" }: { titleId: string; children: ReactNode; onClose: () => void; busy: boolean; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className={`personnel-report-dialog ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}
function toPayload(row: GridDraftRow): EquipmentReportDraftRow {
  const id = (value: string) => value === "" ? null : Number(value);
  return { ...(row.reportRowId ? { id: row.reportRowId } : {}), equipmentId: id(row.equipmentId), shiftId: id(row.shiftId), zoneId: id(row.zoneId), mainWorkTypeId: id(row.mainWorkTypeId), subworkTypeId: id(row.subworkTypeId), hours: id(row.hours), note: row.note };
}

export type EquipmentReportWorkspaceProps = {
  siteId: number; siteName: string; today: string;
  currentUser: { id: number; fullName: string; role: UserRole; canViewPendingReports?: boolean };
  permissions: { create: boolean; update: boolean; delete: boolean };
  units: GridEquipmentUnit[]; shifts: GridOption[]; zones: GridOption[]; mainWorkTypes: GridOption[]; subworkTypes: GridOption[];
  loading: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function EquipmentReportWorkspace(props: EquipmentReportWorkspaceProps) {
  const { siteId, today, currentUser, permissions: grantedPermissions, onDirtyChange } = props;
  const permissions = useMemo(() => currentUser.role === "viewer" ? { create: false, update: false, delete: false } : grantedPermissions, [currentUser.role, grantedPermissions]);
  const showPendingReports = canViewPendingReportsFor(currentUser);
  const rowOrder = useWorkspaceTableOrder();
  const [data, setData] = useState<EquipmentReportData | null>(null);
  type Edits = Record<string, GridDraftRow[]>;
  const [history, dispatchEdits] = useReducer((state: DraftHistory<Edits>, action: DraftHistoryAction<Edits>) => draftHistoryReducer(state, action), { present: {}, past: [], future: [] });
  const edits = history.present;
  const setEdits = useCallback((update: Edits | ((value: Edits) => Edits)) => dispatchEdits({ type: "change", update }), []);
  // Keep the identity and version that the person actually started editing.
  // Loading another period or refreshing must not silently rebase old edits.
  const [sessions, setSessions] = useState<Record<string, EquipmentReport>>({});
  const [entrySessions, setEntrySessions] = useState<Record<string, EquipmentReportApprovedEntry>>({});
  const [requiredReports, setRequiredReports] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [visible, setVisible] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<{ report: EquipmentReport; action: "approve" | "reject" } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendKeys, setSendKeys] = useState<string[]>([]);
  const [sendValidation, setSendValidation] = useState<(EquipmentSubmissionValidationState & { error?: string }) | null>(null);
  const [validationRetry, setValidationRetry] = useState(0);
  const [workflowView, setWorkflowView] = useState<"all" | "draft" | "submitted">("all");
  const [focusedReportKey, setFocusedReportKey] = useState<string | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const [viewsTarget, setViewsTarget] = useState<HTMLElement | null>(null);
  const [comment, setComment] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const carryOverHandled = useRef(new Set<string>());
  const [carryOverNotice, setCarryOverNotice] = useState<{ count: number; skipped: number } | null>(null);
  const dirty = Object.keys(edits).length > 0;
  const locked = busy || importing;
  const checkSubmissionReports = useCallback(async (plan: SubmissionValidationPlan, signal?: AbortSignal) => {
    setSendValidation({ token: plan.token, status: "checking", issues: plan.localIssues });
    try {
      const response = await fetch("/api/equipment-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan.payload), signal });
      const result = await response.json() as { issues?: EquipmentReportValidationIssue[]; error?: string };
      if (signal?.aborted) return false;
      if (!response.ok) throw new Error(result.error ?? "Не удалось проверить выбранные отчёты.");
      if (!Array.isArray(result.issues)) throw new Error("Не удалось получить результат проверки. Повторите проверку.");
      const issues = mergeEquipmentSubmissionIssues(plan.localIssues, result.issues);
      setSendValidation({ token: plan.token, status: issues.length ? "invalid" : "valid", issues });
      return issues.length === 0;
    } catch (failure) {
      if (!signal?.aborted) setSendValidation({ token: plan.token, status: "error", issues: plan.localIssues, error: failure instanceof Error ? failure.message : "Не удалось проверить выбранные отчёты." });
      return false;
    }
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setActionsTarget(document.getElementById("equipment-report-actions"));
      setViewsTarget(document.getElementById("equipment-report-views"));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => { onDirtyChange?.(dirty || importing); return () => onDirtyChange?.(false); }, [dirty, importing, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !importing) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, importing]);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setFetching(true);
    try {
      const params = new URLSearchParams({ siteId: String(siteId), all: "true" });
      const response = await fetch(`/api/equipment-report?${params}`, { cache: "no-store", signal: controller.signal });
      if (response.status === 401) { window.location.replace("/login"); return; }
      const result = await response.json() as EquipmentReportData & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить отчёты.");
      if (!controller.signal.aborted) { setData(result); setError(""); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Ошибка загрузки отчётов.");
    } finally { if (!controller.signal.aborted) setFetching(false); }
  }, [siteId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void load());
    return () => { cancelAnimationFrame(frame); request.current?.abort(); };
  }, [load, permissions.update]);
  const canReview = Boolean(data?.canReview && permissions.update);
  const reports = useMemo(() => mergeEquipmentReportSessions(data?.reports ?? [], sessions, Object.keys(edits)), [data, edits, sessions]);
  const rememberSessions = useCallback((keys: Iterable<string>) => {
    const capturedKeys = [...keys];
    setSessions(current => freezeEquipmentReportSessions(current, reports, capturedKeys));
    setEntrySessions(current => {
      const additions = (data?.entries ?? []).filter(entry => capturedKeys.includes(entryKey(entry)) && !current[entryKey(entry)]);
      return additions.length ? { ...current, ...Object.fromEntries(additions.map(entry => [entryKey(entry), entry])) } : current;
    });
  }, [reports, data]);
  const ownToday = reports.find(report => report.ownerUserId === currentUser.id && report.workDate === today && (report.status === "draft" || report.status === "rejected"));
  const todayAppendIssue = reports.some(report => report.ownerUserId === currentUser.id && report.workDate === today && report.status === "submitted")
    ? "Сегодняшний отчёт на проверке. Для изменения снимите его с проверки во вкладке «На проверке»."
    : ownToday && !permissions.update ? "Нет права изменять уже сохранённый сегодняшний отчёт." : "";
  const newDraftGroups = useMemo(() => Object.entries(edits).flatMap(([key, drafts]) => {
    const workDate = equipmentReportNewDate(key, today);
    return workDate ? [{ key, workDate, drafts }] : [];
  }).sort((left, right) => right.workDate.localeCompare(left.workDate)), [edits, today]);
  const canEdit = useCallback((report: EquipmentReport) => permissions.update && (canReview || (report.status === "draft" || report.status === "rejected") && report.ownerUserId === currentUser.id), [permissions.update, currentUser.id, canReview]);
  useEffect(() => {
    if (!data || fetching || props.loading || currentUser.role !== "foreman" || !permissions.create) return;
    const sessionKey = `${siteId}:${currentUser.id}:${today}`;
    if (carryOverHandled.current.has(sessionKey)) return;
    const frame = requestAnimationFrame(() => {
      const source = equipmentReportCrewSource(data.reports, siteId, currentUser.id, today, data.entries);
      if (!source || newDraftGroups.some(group => group.workDate === today)) { carryOverHandled.current.add(sessionKey); return; }
      const { drafts, skipped } = buildEquipmentReportCrew(source.rows, { ...props, dailyTimesheetMarks: data.availabilityMarks, workDate: today }, () => crypto.randomUUID(), new Date().toISOString());
      if (!drafts.length) {
        if (props.units.length) {
          carryOverHandled.current.add(sessionKey);
          setNotice("Техника из вчерашнего отчёта сейчас недоступна. Добавьте актуальные единицы в сегодняшний черновик.");
        }
        return;
      }
      carryOverHandled.current.add(sessionKey);
      if (drafts.length > 1000) { setError("Во вчерашнем отчёте больше 1000 строк. Добавьте в сегодняшний черновик нужные записи через копирование."); return; }
      const key = equipmentReportNewKey(today);
      setEdits(current => current[key] ? current : { ...current, [key]: drafts });
      setCarryOverNotice({ count: drafts.length, skipped });
    });
    return () => cancelAnimationFrame(frame);
  }, [data, fetching, props, currentUser.role, currentUser.id, permissions.create, siteId, today, newDraftGroups, setEdits]);
  const rows = useMemo<(EquipmentReportGridRow & { draftGroupKey?: string })[]>(() => {
    const staged = reports.flatMap(report => {
      const drafts = edits[keyOf(report)] ?? report.rows.map(report.status === "approved" ? toApprovedDraft : toDraft);
      return drafts.map(draft => {
        const snapshot = report.rows.find(row => `report-${row.reportId}-${row.id}` === draft.key);
        const entry = snapshot ? { ...snapshot, id: snapshot.approvedEntryId ?? snapshot.id, equipmentId: snapshot.equipmentId ?? 0, shiftId: snapshot.shiftId ?? 0, zoneId: snapshot.zoneId ?? 0, mainWorkTypeId: snapshot.mainWorkTypeId ?? 0, subworkTypeId: snapshot.subworkTypeId ?? 0, hours: snapshot.hours ?? 0, revision: report.revision, responsibleUserId: report.ownerUserId, responsibleUserName: report.ownerName } : undefined;
        return { rowKey: draft.key, workDate: report.workDate, createdAt: draft.createdAt ?? report.createdAt, updatedAt: draft.updatedAt ?? report.updatedAt, rowOrder: snapshot?.rowOrder, status: report.status, draft, entry, dateEditable: canEdit(report), dateScopeLabel: drafts.length > 1 ? `Весь отчёт · строк: ${drafts.length}` : undefined, editable: canEdit(report) && !locked, proposalId: report.id, responsibleUserName: report.ownerName, responsibleUserId: report.ownerUserId, reviewNote: report.reviewComment };
      });
    });
    const fresh = newDraftGroups.flatMap(group => group.drafts.map(draft => ({ rowKey: draft.key, draftGroupKey: group.key, workDate: group.workDate, createdAt: draft.createdAt, updatedAt: draft.updatedAt, status: "draft" as const, draft, dateEditable: permissions.create, dateScopeLabel: group.drafts.length > 1 ? `Весь отчёт · строк: ${group.drafts.length}` : undefined, editable: permissions.create && !locked, responsibleUserName: currentUser.fullName, responsibleUserId: currentUser.id })));
    const entries = new Map((data?.entries ?? []).map(entry => [entryKey(entry), entry]));
    for (const key of Object.keys(edits)) if (entrySessions[key]) entries.set(key, entrySessions[key]);
    const approved = [...entries.values()].filter(entry => !entry.orderReportId || !reports.some(report => report.id === entry.orderReportId)).map(entry => {
      const key = entryKey(entry);
      const draft = edits[key]?.[0] ?? toEntryDraft(entry);
      return { rowKey: draft.key, draftGroupKey: key, workDate: entry.workDate, createdAt: draft.createdAt, updatedAt: draft.updatedAt, rowOrder: entry.rowOrder, status: "approved" as const,
        entry: { ...entry, responsibleUserName: entry.responsibleUserName ?? "" } as GridEquipmentEntry, draft: canReview ? draft : undefined,
        dateEditable: canReview && !entry.orderReportId, editable: canReview && !locked && !entry.orderReportId, removable: false, responsibleUserName: entry.responsibleUserName ?? "", responsibleUserId: entry.responsibleUserId };
    });
    return [...fresh, ...staged, ...approved];
  }, [data, reports, edits, entrySessions, canReview, newDraftGroups, canEdit, locked, permissions.create, currentUser.fullName, currentUser.id]);
  const ownerByRow = useMemo(() => new Map(rows.filter(row => row.draft).map(row => [row.rowKey, row.proposalId ? String(row.proposalId) : row.draftGroupKey!])), [rows]);
  const patchDraft = useCallback((key: string, changes: Partial<GridDraftRow>) => {
    const owner = ownerByRow.get(key);
    if (!owner) return;
    setError("");
    setNotice("");
    rememberSessions([owner]);
    setEdits(current => {
      const source = current[owner] ?? rows.filter(row => ownerByRow.get(row.rowKey) === owner).flatMap(row => row.draft ? [row.draft] : []);
      const next = source.map(row => {
        if (row.key !== key) return row;
        const linkedChanges = workTypeChanges(row, changes, props.subworkTypes);
        const inputValues = { ...row.inputValues, ...changes.inputValues };
        if (changes.mainWorkTypeId !== undefined && changes.mainWorkTypeId !== row.mainWorkTypeId) delete inputValues.subwork;
        if (!changes.inputValues) {
          if (changes.equipmentId !== undefined) delete inputValues.equipment;
          if (changes.hours !== undefined) delete inputValues.hours;
          for (const [field, config] of Object.entries(equipmentOptionFields)) if (changes[config.draft] !== undefined) delete inputValues[field as keyof typeof inputValues];
        }
        return timestampEquipmentDraft(row, { ...row, ...linkedChanges, inputValues: changes.inputValues ?? inputValues });
      });
      return next.every((row, index) => row === source[index]) ? current : { ...current, [owner]: next };
    });
  }, [ownerByRow, rows, setEdits, rememberSessions, props.subworkTypes]);
  const applyRange = useCallback((batch: Parameters<import("./EquipmentReportGrid").EquipmentReportGridProps["onApplyRange"]>[0]) => {
    if (locked || props.loading || fetching || !batch.rows.length) return false;
    const start = rows.find(row => row.rowKey === batch.rows[0].rowKey);
    if (batch.source === "paste" && (!start?.editable || !start.draft)) { setError("Начните вставку с ячейки отчёта, который вам разрешено редактировать."); return false; }
    const rowMap = new Map(rows.map(row => [row.rowKey, row]));
    const plan: { owner: string; draft: GridDraftRow; values: Record<string, string>; append: boolean }[] = [];
    for (const item of batch.rows) {
      const values = Object.fromEntries(Object.entries(item.values).filter(([field]) => equipmentEditableFields.includes(field as typeof equipmentEditableFields[number])));
      if (!Object.keys(values).length) continue;
      const row = item.rowKey ? rowMap.get(item.rowKey) : undefined;
      if (row?.editable && row.draft) {
        if (row.draft.lockedEquipment) delete values.equipment;
        if (Object.keys(values).length) plan.push({ owner: ownerByRow.get(row.rowKey)!, draft: row.draft, values, append: false });
      } else if (batch.source === "paste" && start) {
        if (ownerByRow.get(start.rowKey)?.startsWith("entry-")) { setError("Для новых строк используйте «Добавить строку». В старых подтверждённых записях можно исправлять существующие ячейки."); return false; }
        if (!permissions.create) { setError("Для вставки дополнительных строк необходимо право добавления."); return false; }
        plan.push({ owner: ownerByRow.get(start.rowKey)!, draft: makeDraft(), values, append: true });
      }
    }
    if (!plan.length) return false;
    for (const owner of new Set(plan.map(item => item.owner))) {
      const count = rows.filter(row => ownerByRow.get(row.rowKey) === owner).length + plan.filter(item => item.owner === owner && item.append).length;
      if (count > 1000) { setError("В одном отчёте можно сохранить не более 1000 строк. Уменьшите вставляемый диапазон."); return false; }
    }
    rememberSessions(new Set(plan.map(item => item.owner)));
    setEdits(current => {
      const next = { ...current };
      for (const owner of new Set(plan.map(item => item.owner))) {
        const source = current[owner] ?? rows.filter(row => ownerByRow.get(row.rowKey) === owner).flatMap(row => row.draft ? [row.draft] : []);
        const patches = new Map(plan.filter(item => item.owner === owner && !item.append).map(item => [item.draft.key, item.values]));
        next[owner] = [...source.map(draft => patches.has(draft.key) ? timestampEquipmentDraft(draft, pasteEquipmentCells(draft, patches.get(draft.key)!, props)) : draft), ...plan.filter(item => item.owner === owner && item.append).map(item => pasteEquipmentCells(item.draft, item.values, props))];
      }
      return next;
    });
    setError("");
    const invalid = plan.reduce((count, item) => count + Object.keys(equipmentCellErrors(pasteEquipmentCells(item.draft, item.values, props), props)).length, 0);
    setNotice(invalid ? `Диапазон вставлен. Проверьте красные ячейки: ${invalid}. Введённые значения сохранены в таблице.` : `Изменено строк: ${plan.length}${plan.some(item => item.append) ? ` · добавлено новых: ${plan.filter(item => item.append).length}` : ""}.`);
    return true;
  }, [locked, props, fetching, rows, ownerByRow, permissions.create, setEdits, rememberSessions]);
  const appendOnDate = (drafts: GridDraftRow[], workDate = today) => {
    if (!permissions.create || locked || fetching || props.loading) return;
    try {
      if (!isReportWorkDate(workDate)) throw new Error("Выберите корректную дату новых строк.");
      const submitted = reports.some(report => report.siteId === siteId && report.ownerUserId === currentUser.id && report.workDate === workDate && report.status === "submitted");
      // A local row can be dated before saving even when today's report is already under review.
      const key = submitted ? equipmentReportNewKey(workDate) : equipmentReportImportTarget(reports, sessions, siteId, currentUser.id, workDate);
      const report = reports.find(item => keyOf(item) === key);
      if (report && !canEdit(report)) throw new Error("Нет права изменять отчёт на выбранную дату.");
      if ((edits[key] ?? report?.rows ?? []).length + drafts.length > 1000) throw new Error("В одном отчёте можно сохранить не более 1000 строк. Выберите меньше записей.");
      rememberSessions([key]);
      setEdits(current => ({ ...current, [key]: [...drafts, ...(current[key] ?? report?.rows.map(toDraft) ?? [])] }));
      setError("");
      setNotice(submitted ? "На эту дату отчёт уже на проверке. Выберите другую дату в новой строке." : drafts.length > 1 ? `Добавлено строк: ${drafts.length}.` : "");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось добавить строки."); }
  };
  const copyRows = (source: EquipmentReportGridRow[]) => {
    if (!source.length) { setError("Выберите строки прошлых дней для копирования."); return; }
    const available = (options: GridOption[], value: string) => options.some(option => String(option.id) === value) ? value : "";
    if (todayAppendIssue) { setError(todayAppendIssue); return; }
    appendOnDate(source.map(row => {
      const entry = row.entry;
      const seed = row.draft ?? (entry ? { equipmentId: String(entry.equipmentId), equipmentQuery: equipmentExcelName(entry), shiftId: String(entry.shiftId), zoneId: String(entry.zoneId), mainWorkTypeId: String(entry.mainWorkTypeId), subworkTypeId: String(entry.subworkTypeId), hours: String(entry.hours), note: entry.note } : {});
      const time = new Date().toISOString();
      return makeDraft({ ...seed, key: crypto.randomUUID(), reportRowId: undefined, referenceIds: undefined, lockedEquipment: false, createdAt: time, updatedAt: time, equipmentId: props.units.some(unit => String(unit.id) === seed.equipmentId) ? seed.equipmentId : "", shiftId: available(props.shifts, seed.shiftId ?? ""), zoneId: available(props.zones, seed.zoneId ?? ""), mainWorkTypeId: available(props.mainWorkTypes, seed.mainWorkTypeId ?? ""), subworkTypeId: compatibleSubworkId(props.subworkTypes, available(props.mainWorkTypes, seed.mainWorkTypeId ?? ""), seed.subworkTypeId) });
    }));
  };
  const removeDrafts = (keys: string[]) => {
    const remove = new Set(keys.filter(key => !ownerByRow.get(key)?.startsWith("entry-")));
    rememberSessions(new Set(rows.filter(row => remove.has(row.rowKey) && row.editable && row.draft).map(row => ownerByRow.get(row.rowKey)!)));
    setEdits(current => {
      const next = { ...current };
      for (const owner of new Set(rows.filter(row => remove.has(row.rowKey) && row.editable && row.draft).map(row => ownerByRow.get(row.rowKey)!))) next[owner] = (current[owner] ?? rows.filter(row => ownerByRow.get(row.rowKey) === owner).flatMap(row => row.draft ? [row.draft] : [])).filter(draft => !remove.has(draft.key));
      return next;
    });
    setSelected([]);
  };
  async function changeReportDate(row: EquipmentReportGridRow, workDate: string) {
    if (!row.editable || locked || fetching || props.loading) throw new Error("Подождите завершения текущего действия.");
    if (!isReportWorkDate(workDate)) throw new Error("Укажите корректную дату.");
    const sourceKey = ownerByRow.get(row.rowKey);
    if (!sourceKey) throw new Error("Не найден исходный отчёт. Обновите таблицу.");
    const sourceReport = reports.find(item => keyOf(item) === sourceKey);
    const sourceEntry = sourceKey.startsWith("entry-") ? data?.entries.find(item => entryKey(item) === sourceKey) : undefined;
    const target = { key: sourceKey, workDate: row.workDate,
      kind: sourceReport ? "report" : sourceEntry ? "entry" : "new", approved: row.status === "approved",
      id: sourceReport?.id ?? sourceEntry?.id, revision: sourceReport?.revision ?? sourceEntry?.revision };
    if (workDate === target.workDate) return;
    if (target.kind === "new") {
      const key = equipmentReportImportTarget(reports, sessions, siteId, currentUser.id, workDate);
      const report = reports.find(item => keyOf(item) === key);
      if (report && !canEdit(report)) throw new Error("Нет права изменять отчёт на выбранную дату.");
      const next = moveUnsavedReportDay(edits, target.key, key, report?.rows.map(toDraft));
      rememberSessions([key]);
      setEdits(next);
      setFocusedReportKey(null); setSelected([]); setRequiredReports([]);
      setNotice(`Дата черновика изменена на ${displayDate(workDate)}. Сохраните изменения.`);
      return;
    }
    if (edits[target.key]) throw new Error("Сначала сохраните изменения этого отчёта, затем измените его дату.");
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/equipment-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target.kind === "entry"
        ? { action: "change-entry-date", entryId: target.id, revision: target.revision, siteId, workDate }
        : { action: "change-date", reportId: target.id, revision: target.revision, workDate }) });
      const result = await response.json() as { report?: EquipmentReport; entry?: EquipmentReportApprovedEntry; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось изменить дату.");
      // Keep unrelated edits, but discard undo states containing the report's old identity.
      dispatchEdits({ type: "reset", value: edits });
      setSessions(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== target.key)));
      setEntrySessions(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== target.key)));
      setData(current => current ? { ...current,
        reports: current.reports.map(report => report.id === result.report?.id ? result.report : report),
        entries: current.entries.map(entry => {
          if (entry.id === result.entry?.id) return result.entry;
          const row = result.report?.rows.find(row => row.approvedEntryId === entry.id);
          return row ? { ...entry, workDate, revision: row.approvedEntryRevision ?? entry.revision } : entry;
        }) } : current);
      setFocusedReportKey(null); setSelected([]); setRequiredReports([]);
      await load();
      setNotice(`Дата изменена на ${displayDate(workDate)}.${target.approved ? " Часы в табеле обновлены." : ""}`);
    } catch (failure) {
      // A virtualized row may leave the screen before the request completes.
      setError(failure instanceof Error ? failure.message : "Не удалось изменить дату.");
      throw failure;
    } finally { setBusy(false); }
  }
  async function mutate(payload: EquipmentReportSaveRequest | EquipmentReportTransitionRequest) {
    const response = await fetch("/api/equipment-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json() as { report: EquipmentReport; error?: string; code?: string; details?: unknown };
    if (!response.ok) throw Object.assign(new Error(result.error ?? "Не удалось сохранить отчёт."), { code: result.code, details: result.details });
    return result.report;
  }
  async function saveEditor(key: string) {
    const drafts = edits[key];
    if (key.startsWith("entry-")) {
      const entry = entrySessions[key];
      if (!entry || drafts.length !== 1) throw new Error("Не найдена исходная версия записи. Отмените изменения и откройте отчёт заново.");
      const payload: EquipmentReportEntrySaveRequest = { action: "save-approved-entry", entryId: entry.id, revision: entry.revision, siteId: entry.siteId, workDate: entry.workDate, row: toPayload(drafts[0]) };
      const response = await fetch("/api/equipment-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string; code?: string };
      if (!response.ok) throw Object.assign(new Error(result.error ?? "Не удалось исправить подтверждённую запись."), { code: result.code });
      return null;
    }
    const report = await mutate({ action: "save", ...equipmentReportSaveIdentity(key, sessions, siteId, today), rows: drafts.map(draft => ({ ...toPayload(draft), approvedEntryRevision: sessions[key]?.rows.find(row => row.id === draft.reportRowId)?.approvedEntryRevision })) });
    if (rowOrder?.scope === equipmentReportOrderScope && rowOrder.hasSavedOrder) {
      const aliases = Object.fromEntries(drafts.flatMap((draft, index) => {
        const oldId = `${report.workDate}/${draft.key}`;
        const saved = report.rows[index];
        return saved && isUnsavedEquipmentReportOrderId(oldId) && rowOrder.ids.includes(oldId) ? [[oldId, `${report.workDate}/report-${report.id}-${saved.id}`]] : [];
      }));
      if (Object.keys(aliases).length) await rowOrder.remap(aliases);
    }
    return report;
  }
  async function saveDrafts(selectedKeys?: string[], saveOnlyKeys?: string[]) {
    if (locked || fetching || props.loading) return false;
    const submit = selectedKeys !== undefined;
    let targets: typeof submissionItems = [];
    try { if (submit) targets = selectEquipmentReportSubmissions(submissionItems, selectedKeys); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Выберите отчёты для отправки."); return false; }
    const targetKeys = new Set(targets.map(item => item.key));
    const saveKeys = Object.keys(edits).filter(key => submit ? targetKeys.has(key) : !saveOnlyKeys || saveOnlyKeys.includes(key));
    const validateKeys = submit ? targetKeys : new Set(saveKeys);
    const completeKeys = new Set([...validateKeys].filter(key => submit || key.startsWith("entry-") || reports.some(report => keyOf(report) === key && (report.status === "submitted" || report.status === "approved"))));
    setRequiredReports([...completeKeys]);
    const invalid = rows.filter(row => row.draft && validateKeys.has(ownerByRow.get(row.rowKey) ?? "")).flatMap(row => Object.entries(equipmentCellErrors(row.draft!, { ...props, dailyTimesheetMarks: data?.availabilityMarks }, completeKeys.has(ownerByRow.get(row.rowKey) ?? ""), row.workDate)).map(([field, message]) => ({ date: row.workDate, name: row.draft!.equipmentQuery || "Новая строка", field, message })));
    if (!submit && invalid.length) { setError(`Изменения не сохранены. Исправьте ячейки с ошибками (${invalid.length}). За ${displayDate(invalid[0].date)}, ${invalid[0].name}: ${invalid[0].message}`); return false; }
    setBusy(true); setError(""); setNotice("");
    let sent = 0;
    let activeDate = "";
    let activeKey = "";
    try {
      // Recheck immediately before the first write: another foreman may have
      // changed approved hours since the dialog's automatic read-only check.
      if (submit && !await checkSubmissionReports(submissionValidationPlan(targets))) return false;
      const saved = new Map<string, EquipmentReport>();
      const remainingEdits = { ...edits };
      for (const key of saveKeys) {
        activeKey = key;
        activeDate = targets.find(item => item.key === key)?.workDate ?? equipmentReportNewDate(key, today) ?? reports.find(report => keyOf(report) === key)?.workDate ?? entrySessions[key]?.workDate ?? "";
        const report = await saveEditor(key); if (report) saved.set(key, report);
        if (submit && report) setSendKeys(current => current.map(candidate => candidate === key ? keyOf(report) : candidate));
        delete remainingEdits[key];
        dispatchEdits({ type: "reset", value: { ...remainingEdits } });
        setSessions(current => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== key)));
        setEntrySessions(current => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== key)));
      }
      if (submit) {
        for (const item of targets) {
          activeDate = item.workDate;
          const report = saved.get(item.key) ?? item.report;
          if (!report) throw new Error("Не удалось найти сохранённый черновик.");
          activeKey = keyOf(report);
          await mutate({ action: "submit", reportId: report.id, revision: report.revision });
          sent++;
        }
        setSendOpen(false); setSendKeys([]); setRequiredReports([]);
        setNotice(`Отправлено на проверку: ${sent}. Даты: ${[...new Set(targets.map(item => displayDate(item.workDate)))].join(", ")}. Часы попадут в табель после подтверждения инженером.`);
        setWorkflowView("submitted"); setFocusedReportKey(null); setSelected([]);
      } else {
        const correctedApproved = saveKeys.some(key => key.startsWith("entry-") || reports.some(report => keyOf(report) === key && report.status === "approved"));
        setNotice(correctedApproved ? "Исправления сохранены. Подтверждённые отчёты и часы в табеле обновлены." : "Изменения сохранены. Статусы отчётов сохранены; часы попадут в табель после подтверждения.");
      }
      await load();
      return true;
    } catch (failure) {
      await load();
      if (submit) {
        const details = failure && typeof failure === "object" && "details" in failure ? failure.details as { issues?: EquipmentReportValidationIssue[] } | undefined : undefined;
        const plan = submissionValidationPlan(targets);
        if (Array.isArray(details?.issues) && details.issues.length) setSendValidation({ token: plan.token, status: "invalid", issues: details.issues.map(issue => ({ ...issue, key: activeKey, workDate: activeDate })) });
        else setSendValidation({ token: plan.token, status: "error", issues: plan.localIssues, error: failure instanceof Error ? failure.message : "Не удалось отправить отчёт. Повторите проверку." });
      }
      setError(`${sent ? `Уже отправлено отчётов: ${sent}. ` : ""}${activeDate ? `За ${displayDate(activeDate)}: ` : ""}${failure instanceof Error ? failure.message : "Не удалось сохранить отчёт."}`);
      return false;
    } finally { setBusy(false); }
  }
  async function transition(report: EquipmentReport, action: "approve" | "reject" | "reopen", reviewComment = "") {
    if (locked || fetching || props.loading) return;
    const issue = equipmentReportReviewIssue(report.id, Object.keys(edits));
    if (issue) { setError(issue); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await mutate({ action, reportId: report.id, revision: report.revision, comment: reviewComment });
      setReview(null); setComment(""); setFocusedReportKey(null); setSelected([]);
      setNotice(action === "approve" ? "Отчёт подтверждён. Часы включены в отчёты и табель." : action === "reject" ? "Отчёт возвращён прорабу на доработку." : "Отчёт снят с проверки: его можно редактировать.");
      await load();
      if (action === "reopen") { setWorkflowView("draft"); setFocusedReportKey(keyOf(report)); }
    } catch (failure) {
      await load();
      if (failure instanceof Error && "code" in failure && ["STALE_REPORT", "INVALID_TRANSITION", "REPORT_LOCKED"].includes(String(failure.code))) setReview(null);
      setError(failure instanceof Error ? failure.message : "Не удалось изменить статус отчёта.");
    }
    finally { setBusy(false); }
  }
  async function importExcel(file: File) {
    if (locked || fetching || props.loading || !permissions.create) return;
    setImporting(true); setError(""); setNotice("");
    try {
      const { parseEquipmentEntriesXlsx } = await import("./placementXlsx");
      const imported = await parseEquipmentEntriesXlsx(file);
      if (!imported.length) throw new Error("В файле нет строк отчёта.");
      const byDate = new Map<string, GridDraftRow[]>();
      for (const row of imported) {
        const draft = pasteEquipmentCells(makeDraft(), { equipment: row.equipmentName, shift: row.shiftName, zone: row.zoneName, mainWork: row.mainWorkTypeName, subwork: row.subworkTypeName, hours: row.hours, note: row.note }, props);
        const group = byDate.get(row.workDate) ?? [];
        group.push(draft);
        byDate.set(row.workDate, group);
      }
      // Resolve every day before changing anything. A locked day or oversized
      // group must not leave a partially imported workbook behind.
      const groups = [...byDate].map(([workDate, drafts]) => {
        let key = equipmentReportImportTarget(reports, sessions, siteId, currentUser.id, workDate);
        const existing = reports.find(report => keyOf(report) === key);
        if (existing && !canEdit(existing)) throw new Error(`Нет права изменять черновик за ${displayDate(workDate)}.`);
        if (equipmentReportNewDate(key, today)) key = newDraftGroups.find(group => group.workDate === workDate)?.key ?? key;
        const previous = edits[key] ?? existing?.rows.map(toDraft) ?? [];
        if (previous.length + drafts.length > 1000) throw new Error(`За ${displayDate(workDate)} получится больше 1000 строк. Уменьшите объём импорта за этот день.`);
        return { key, workDate, drafts, previous };
      });
      rememberSessions(groups.map(group => group.key));
      setEdits(current => {
        const next = { ...current };
        for (const group of groups) next[group.key] = [...group.drafts, ...(current[group.key] ?? group.previous)];
        return next;
      });
      setRequiredReports([]);
      setWorkflowView("draft"); setFocusedReportKey(null); setSelected([]); setVisible(null);
      const dates = [...byDate.keys()].sort();
      const range = dates.length === 1 ? displayDate(dates[0]) : `${displayDate(dates[0])}–${displayDate(dates[dates.length - 1])}`;
      setNotice(`Импортировано строк: ${imported.length} · дней: ${dates.length} (${range}). Проверьте данные и сохраните черновики.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось прочитать Excel."); }
    finally { setImporting(false); if (importInput.current) importInput.current.value = ""; }
  }
  async function downloadTemplate() {
    if (props.loading || !permissions.create) return;
    setError("");
    try {
      const { createEquipmentPlacementTemplateXlsx } = await import("./placementXlsx");
      const names = (options: GridOption[]) => options.map(option => option.name);
      const blob = createEquipmentPlacementTemplateXlsx(props.siteName, today, { equipmentNames: props.units.map(equipmentExcelName), shifts: names(props.shifts), zones: names(props.zones), mainWorkTypes: names(props.mainWorkTypes), subworkTypes: names(props.subworkTypes), workTypePairs: equipmentExcelWorkTypePairs(props.mainWorkTypes, props.subworkTypes) });
      downloadExcelFile(blob, excelFileName("Шаблон отчёта техники", [props.siteName, today]));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось скачать шаблон отчёта техники."); }
  }
  function exportExcel() {
    if (!data || fetching || locked) return;
    setError("");
    try {
      const approved = equipmentReportExcelRows(displayedRows, visible, selected, Object.keys(edits));
      const dates = [...new Set(approved.map(entry => entry.workDate))].sort();
      const range = dates.length === 1 ? dates[0] : `${dates[0]}–${dates.at(-1)}`;
      const headers = ["Дата", "Уникальное наименование единицы", "Тип", "Марка", "Модель", "ГРЗ / Инв. №", "Организация", "Прораб", "Смена", "Зона", "Вид работы", "Подвид работы", "Часы", "Примечание"];
      const values = approved.map(entry => [entry.workDate, equipmentExcelName(entry), entry.equipmentType, entry.brand, entry.model, entry.registrationNumber, entry.organization, entry.responsibleUserName ?? "", entry.shiftName, entry.zoneName, entry.mainWorkTypeName, entry.subworkTypeName, entry.hours, entry.note]);
      openExcelExportPreview({ version: 1, title: "Подтверждённые отчёты техники", description: `${props.siteName} · ${range} · строк: ${values.length}`, fileName: excelFileName("Отчёт техники", [props.siteName, range]), headers, rows: values, workbook: { kind: "table", sheetName: "Отчёты техники", workbookTitle: `Отчёт техники — ${props.siteName}`, rows: values } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось открыть предпросмотр Excel."); }
  }
  const reportItems = useMemo(() => [
    ...reports.filter(report => report.status !== "approved").map(report => {
      const drafts = edits[keyOf(report)] ?? report.rows.map(toDraft);
      return { key: keyOf(report), workDate: report.workDate, ownerUserId: report.ownerUserId, ownerName: report.ownerName, status: report.status, report: report as EquipmentReport | undefined, rowCount: drafts.length, hours: drafts.reduce((sum, row) => sum + (Number(row.hours) || 0), 0), invalidRows: drafts.filter(row => Object.keys(equipmentCellErrors(row, { ...props, dailyTimesheetMarks: data?.availabilityMarks }, true, report.workDate)).length > 0).length, canSend: (report.status === "draft" || report.status === "rejected") && canEdit(report), unsaved: Boolean(edits[keyOf(report)]) };
    }),
    ...newDraftGroups.map(group => ({ key: group.key, workDate: group.workDate, ownerUserId: currentUser.id, ownerName: currentUser.fullName, status: "draft" as const, report: undefined as EquipmentReport | undefined, rowCount: group.drafts.length, hours: group.drafts.reduce((sum, row) => sum + (Number(row.hours) || 0), 0), invalidRows: group.drafts.filter(row => Object.keys(equipmentCellErrors(row, { ...props, dailyTimesheetMarks: data?.availabilityMarks }, true, group.workDate)).length > 0).length, canSend: permissions.create, unsaved: true })),
  ].filter(item => item.rowCount > 0).sort((left, right) => right.workDate.localeCompare(left.workDate) || left.ownerName.localeCompare(right.ownerName, "ru")), [reports, edits, props, data?.availabilityMarks, newDraftGroups, currentUser.id, currentUser.fullName, canEdit, permissions.create]);
  const submissionItems = reportItems.filter(item => item.canSend);
  const reviewItems = reportItems.filter(item => item.status === "submitted");
  const draftItems = reportItems.filter(item => item.status === "draft" || item.status === "rejected");
  const activeReview = workflowView === "submitted" ? reviewItems.find(item => item.key === focusedReportKey) ?? reviewItems[0] : undefined;
  const focusedKey = activeReview?.key ?? focusedReportKey;
  const focusedItem = reportItems.find(item => item.key === focusedKey);
  const displayedRows = rows.filter(row => (workflowView === "all" || workflowView === "draft" ? workflowView === "all" || row.status === "draft" || row.status === "rejected" : row.status === workflowView) && (!focusedKey || (row.proposalId ? String(row.proposalId) : row.draftGroupKey) === focusedKey));
  const requiredRowKeys = rows.filter(row => requiredReports.includes(ownerByRow.get(row.rowKey) ?? "")).map(row => row.rowKey);
  const changeWorkflow = (view: typeof workflowView, key: string | null = null) => { setWorkflowView(view); setFocusedReportKey(key); setSelected([]); };
  const openSend = (keys?: string[]) => { const chosen = keys ?? defaultEquipmentReportSubmissions(submissionItems, currentUser.id); setSendKeys(chosen); setRequiredReports(chosen); setSendValidation(null); setError(""); setSendOpen(true); };
  const showReport = (item: typeof reportItems[number]) => { changeWorkflow(item.status === "submitted" ? "submitted" : "draft", item.key); setSendOpen(false); };
  const beginReview = (report: EquipmentReport, action: "approve" | "reject") => {
    const issue = equipmentReportReviewIssue(report.id, Object.keys(edits));
    if (issue) { setError(issue); return; }
    setError(""); setComment(""); setReview({ report, action });
  };
  const submittedCount = reviewItems.length;
  const selectedSubmissions = sendOpen ? submissionItems.filter(item => sendKeys.includes(item.key)) : [];
  function submissionValidationPlan(items: readonly { key: string; workDate: string; report?: EquipmentReport }[]): SubmissionValidationPlan {
    const groups = items.map(item => ({ key: item.key, workDate: item.workDate, drafts: edits[item.key] ?? item.report?.rows.map(toDraft) ?? [] }));
    const targets: EquipmentReportValidationTarget[] = items.map((item, index) => ({
      key: item.key, workDate: item.workDate,
      ...(item.report ? { reportId: item.report.id, revision: item.report.revision } : {}),
      rows: groups[index].drafts.map(draft => ({ ...toPayload(draft), approvedEntryRevision: item.report?.rows.find(row => row.id === draft.reportRowId)?.approvedEntryRevision })),
    }));
    const localIssues = equipmentSubmissionCellIssues(groups, { ...props, dailyTimesheetMarks: data?.availabilityMarks });
    return { payload: { action: "validate-submissions" as const, siteId, reports: targets }, localIssues,
      token: equipmentSubmissionToken(siteId, { targets, groups, localIssues }) };
  }
  const sendPlan = submissionValidationPlan(selectedSubmissions);
  // Depend on values rather than freshly constructed arrays: a validation
  // response must not trigger another identical request on every render.
  const serializedSendPlan = JSON.stringify(sendPlan);
  useEffect(() => {
    const plan = JSON.parse(serializedSendPlan) as SubmissionValidationPlan;
    if (!sendOpen || busy || fetching || props.loading || !plan.payload.reports.length) return;
    const controller = new AbortController();
    const frame = requestAnimationFrame(() => void checkSubmissionReports(plan, controller.signal));
    return () => { cancelAnimationFrame(frame); controller.abort(); };
  }, [sendOpen, busy, fetching, props.loading, serializedSendPlan, checkSubmissionReports, validationRetry]);
  const sendIssues = sendValidation?.token === sendPlan.token ? mergeEquipmentSubmissionIssues(sendPlan.localIssues, sendValidation.issues) : sendPlan.localIssues;
  const checkingSubmission = selectedSubmissions.length > 0 && (sendValidation?.token !== sendPlan.token || sendValidation.status === "checking");
  const sendCheckError = sendValidation?.token === sendPlan.token ? sendValidation.error : undefined;
  const canSendSelected = equipmentSubmissionCanSend(sendPlan.token, sendValidation, selectedSubmissions.length > 0) && sendIssues.length === 0;
  const selectedSubmissionRows = selectedSubmissions.reduce((sum, item) => sum + item.rowCount, 0);
  const selectedSubmissionHours = selectedSubmissions.reduce((sum, item) => sum + item.hours, 0);
  const workflowControls = <div className="personnel-report-workflow-bar">
    <div className="personnel-report-views" role="group" aria-label="Показать отчёты">
      <button type="button" aria-pressed={workflowView === "all"} onClick={() => changeWorkflow("all")}>Все записи</button>
      {showPendingReports && <button type="button" aria-pressed={workflowView === "draft"} onClick={() => changeWorkflow("draft")}>Черновики <span>{draftItems.length}</span></button>}
      {showPendingReports && <button type="button" className={submittedCount ? "has-pending" : ""} aria-pressed={workflowView === "submitted"} onClick={() => changeWorkflow("submitted")}>На проверке <span>{submittedCount}</span></button>}
    </div>
    {dirty && <span className="personnel-report-dirty-caption"><i aria-hidden="true" />Есть несохранённые изменения</span>}
  </div>;
  const headerActions = <div className="personnel-report-header-actions">
    <ExcelActionsMenu actions={[
      { label: "Экспорт подтверждённых", onSelect: exportExcel, disabled: !data || fetching || locked },
      ...(permissions.create ? [
        { label: importing ? "Импортируем…" : "Импорт в черновик", onSelect: () => importInput.current?.click(), disabled: locked || props.loading || fetching },
        { label: "Скачать шаблон", onSelect: downloadTemplate, disabled: props.loading },
      ] : []),
    ]} />
    <button type="button" className="personnel-report-refresh" aria-label="Обновить отчёты" title="Обновить отчёты" disabled={fetching || locked} onClick={() => void load()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 19.6 10M4.4 14A8 8 0 0 0 17.9 17.9" /></svg></button>
  </div>;
  const footerActions = <div className="toolbar-actions personnel-report-editor-actions">
    {permissions.create && <button className="add-row-button" type="button" disabled={locked || props.loading || fetching} onClick={() => { changeWorkflow("draft"); appendOnDate([makeDraft()]); }}>Добавить строку</button>}
    {(permissions.create || permissions.update) && <>
      <button className="secondary-button" type="button" disabled={!dirty || locked} onClick={() => void saveDrafts()}>{importing ? "Импортируем…" : busy ? "Сохраняем…" : "Сохранить изменения"}{dirty && !locked && <span className="personnel-report-unsaved-dot" aria-label="Есть несохранённые изменения" />}</button>
      {!(canReview && workflowView === "submitted") && <button className="save-edits-button" type="button" disabled={locked || fetching || props.loading || !submissionItems.length} aria-haspopup="dialog" onClick={() => openSend()}>Отправить на проверку…</button>}
    </>}
    {(dirty || history.past.length > 0 || history.future.length > 0) && <button className="personnel-report-discard" aria-label="Отменить изменения" title="Отменить изменения" type="button" disabled={locked} onClick={() => { dispatchEdits({ type: "reset", value: {} }); setSessions({}); setEntrySessions({}); setSelected([]); setRequiredReports([]); }}>Отменить</button>}
  </div>;
  return <section className="personnel-report-workspace equipment-report-workspace">
    {actionsTarget ? createPortal(headerActions, actionsTarget) : headerActions}
    {permissions.create && <input ref={importInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importExcel(file); }} />}
    {error && <div className="message error personnel-report-error" role="alert"><span>{error}</span><button type="button" aria-label="Закрыть сообщение об ошибке" onClick={() => setError("")}>×</button></div>}
    {notice && <div className="personnel-report-toast" role="status"><span>{notice}</span><button type="button" aria-label="Закрыть уведомление" onClick={() => setNotice("")}>×</button></div>}
    {viewsTarget ? createPortal(workflowControls, viewsTarget) : workflowControls}
    {carryOverNotice && rows.some(row => row.workDate === today && row.draft?.carriedFromPreviousDay) && <div className="personnel-report-carry-notice" role="status"><span><strong>Ваша техника на сегодня</strong> Из отчёта за {displayDate(equipmentReportYesterday(today))} перенесено строк: {carryOverNotice.count}. Проверьте технику, работы и часы перед отправкой.{carryOverNotice.skipped > 0 && ` Не перенесено строк: ${carryOverNotice.skipped} — техника снята с проекта или недоступна по табелю.`}</span><button type="button" aria-label="Закрыть подсказку о технике" onClick={() => setCarryOverNotice(null)}>×</button></div>}
    {activeReview?.report && <section className="personnel-report-review-focus" aria-label={canReview ? "Проверка отчёта" : "Отчёт на проверке"}>
      <div className="personnel-report-review-focus-title"><span className="personnel-report-step" aria-hidden="true">✓</span><div><strong>{canReview ? "Проверка отчёта" : "Отчёт на проверке"}</strong><p>{canReview ? "Выберите прораба и дату. Можно исправить данные прямо в таблице и сохранить перед подтверждением." : currentUser.role === "viewer" ? "Выберите прораба и дату для просмотра отчёта." : "Выберите отчёт по дате. Свой отчёт можно снять с проверки и вернуть в черновики."}</p></div><span className="personnel-report-status submitted">На проверке: {submittedCount}</span></div>
      <div className="personnel-report-review-focus-controls">
        <CustomSelect ariaLabel={canReview ? "Отчёт для проверки" : "Отчёт на проверке"} value={activeReview.key} onChange={key => changeWorkflow("submitted", key)} options={reviewItems.map(item => ({ value: item.key, label: `${displayDate(item.workDate)} · ${item.ownerName} · строк: ${item.rowCount} · ${item.hours} ч` }))} />
        <div className="toolbar-actions">{canReview && <>{edits[activeReview.key] && <button type="button" className="secondary-button" disabled={locked || fetching} onClick={() => void saveDrafts(undefined, [activeReview.key])}>Сохранить исправления</button>}<button type="button" className="save-edits-button" disabled={locked || fetching || Boolean(equipmentReportReviewIssue(activeReview.report.id, Object.keys(edits)))} onClick={() => beginReview(activeReview.report!, "approve")}>Подтвердить отчёт</button><button type="button" className="secondary-button" disabled={locked || fetching || Boolean(equipmentReportReviewIssue(activeReview.report.id, Object.keys(edits)))} onClick={() => beginReview(activeReview.report!, "reject")}>Вернуть на доработку</button></>}{permissions.update && activeReview.ownerUserId === currentUser.id && <button type="button" className="secondary-button" disabled={locked || fetching || Boolean(equipmentReportReviewIssue(activeReview.report.id, Object.keys(edits)))} onClick={() => void transition(activeReview.report!, "reopen")}>Снять с проверки</button>}</div>
      </div>
      <p className="personnel-report-review-scope">В таблице только этот отчёт. Строк: {activeReview.rowCount} · {activeReview.hours} ч.{canReview && " Проверяется целиком, отдельно от других прорабов и дат."}</p>
      {equipmentReportReviewIssue(activeReview.report.id, Object.keys(edits)) && <p className="personnel-report-dialog-error">{equipmentReportReviewIssue(activeReview.report.id, Object.keys(edits))}</p>}
    </section>}
    {!activeReview && focusedItem && <div className="personnel-report-focused-caption"><span><strong>{displayDate(focusedItem.workDate)} · {focusedItem.ownerName}</strong> · строк: {focusedItem.rowCount} · {focusedItem.hours} ч{focusedItem.report?.reviewComment && <small className="personnel-report-return-comment">Комментарий инженера: {focusedItem.report.reviewComment}</small>}</span><button type="button" onClick={() => changeWorkflow(workflowView)}>Показать все даты</button></div>}
    <Suspense fallback={<p role="status">Загружаем таблицу…</p>}><ReportGrid rows={displayedRows} selectionScope={workflowView} today={today} loading={props.loading || fetching || importing} canCreate={permissions.create && !locked && !todayAppendIssue} canReview={canReview} units={props.units} shifts={props.shifts} zones={props.zones} mainWorkTypes={props.mainWorkTypes} subworkTypes={props.subworkTypes} dailyTimesheetMarks={data?.availabilityMarks} onChangeDate={changeReportDate} onPatchDraft={patchDraft} onApplyRange={applyRange} requiredRowKeys={requiredRowKeys} emptyMessage={workflowView === "submitted" ? "Нет отчётов на проверке" : workflowView === "draft" ? "Нет черновиков" : "За выбранный период отчётов пока нет"} history={{ undo: () => { if (!locked) dispatchEdits({ type: "undo" }); }, redo: () => { if (!locked) dispatchEdits({ type: "redo" }); }, canUndo: !locked && history.past.length > 0, canRedo: !locked && history.future.length > 0 }} onSelectionChange={setSelected} onCopyRows={copyRows} onRemoveDraft={permissions.delete ? removeDrafts : undefined} onValidationError={setError} onVisibleRowsChange={setVisible} footerActions={footerActions} /></Suspense>
    {sendOpen && <ReportDialog titleId="personnel-send-title" onClose={() => setSendOpen(false)} busy={locked} className="personnel-report-send-modal">
      <header className="personnel-report-dialog-heading"><div><h2 id="personnel-send-title">Отправить отчёты на проверку</h2><p>Выберите даты. Сначала сохраним изменения, затем отправим выбранные отчёты инженеру.</p></div><button type="button" className="personnel-report-dialog-close" aria-label="Закрыть отправку отчётов" disabled={locked} onClick={() => setSendOpen(false)}>×</button></header>
      <div className="personnel-report-send-select"><label><input type="checkbox" aria-label="Выбрать все отчёты для отправки" checked={submissionItems.length > 0 && selectedSubmissions.length === submissionItems.length} disabled={locked || !submissionItems.length} onChange={event => setSendKeys(event.target.checked ? submissionItems.map(item => item.key) : [])} />Выбрать все даты</label><span>{selectedSubmissions.length} отч. · {selectedSubmissionRows} строк · {selectedSubmissionHours} ч</span></div>
      <div className="personnel-report-send-list">
        {!submissionItems.length && <p className="personnel-report-empty">Нет черновиков для отправки.</p>}
        {submissionItems.map(item => { const issues = sendIssues.filter(issue => issue.key === item.key); const invalidCount = Math.max(item.invalidRows, issues.length); return <div className={`personnel-report-send-row${sendKeys.includes(item.key) ? " selected" : ""}`} key={item.key}>
          <label><input type="checkbox" aria-label={`Отправить ${displayDate(item.workDate)}, ${item.ownerName}`} checked={sendKeys.includes(item.key)} disabled={locked} onChange={event => setSendKeys(current => event.target.checked ? [...new Set([...current, item.key])] : current.filter(key => key !== item.key))} /><span><strong>{displayDate(item.workDate)}</strong><small>{item.ownerName}</small></span></label>
          <div className="personnel-report-send-metrics"><strong>Строк: {item.rowCount} · {item.hours} ч</strong><small className={invalidCount ? "invalid" : "complete"}>{invalidCount ? `Ошибок: ${invalidCount}` : "Все строки заполнены"}</small></div>
          <button type="button" className="secondary-button" disabled={locked} onClick={() => showReport(item)}>{invalidCount ? "Исправить" : "Посмотреть"}</button>
        </div>; })}
      </div>
      {checkingSubmission && <p className="personnel-report-validation-status" role="status">Проверяем все выбранные отчёты…</p>}
      {sendIssues.length > 0 && <section className="personnel-report-validation-errors" aria-label="Ошибки выбранных отчётов" role="alert"><strong>Исправьте ошибки перед отправкой ({sendIssues.length})</strong><ul>{sendIssues.map((issue, index) => <li key={`${issue.key}:${issue.equipmentId ?? ""}:${issue.rowNumbers?.join(",") ?? ""}:${issue.code}:${index}`}><div><strong>{displayDate(issue.workDate)}{issue.equipmentName ? ` · ${issue.equipmentName}` : ""}</strong>{issue.rowNumbers?.length ? <span>Строки: {issue.rowNumbers.join(", ")}</span> : null}</div><p>{issue.message}</p></li>)}</ul></section>}
      {sendCheckError && <p className="personnel-report-dialog-error" role="alert">{sendCheckError}</p>}
      {error && !sendIssues.length && <p className="personnel-report-dialog-error" role="alert">{error}</p>}
      <footer className="personnel-report-dialog-footer personnel-report-send-footer"><div className="toolbar-actions">{(sendCheckError || sendIssues.length > 0) && <button type="button" className="secondary-button" disabled={locked || checkingSubmission} onClick={() => { setError(""); setValidationRetry(value => value + 1); }}>Проверить снова</button>}<button type="button" className="secondary-button" disabled={locked} onClick={() => setSendOpen(false)}>Отмена</button><button type="button" className="save-edits-button" disabled={locked || fetching || props.loading || !canSendSelected} onClick={() => void saveDrafts(selectedSubmissions.map(item => item.key))}>{busy ? "Отправляем…" : `Отправить на проверку (${selectedSubmissions.length})`}</button></div></footer>
    </ReportDialog>}
    {review && <ReportDialog titleId="personnel-review-title" onClose={() => setReview(null)} busy={locked} className="personnel-report-review-modal">
      <header className="personnel-report-dialog-heading"><h2 id="personnel-review-title">{review.action === "approve" ? "Подтверждение отчёта" : "Возврат на доработку"}</h2><button type="button" className="personnel-report-dialog-close" aria-label="Закрыть подтверждение" disabled={locked} onClick={() => setReview(null)}>×</button></header>
      <div className="personnel-report-confirm-summary"><strong>{displayDate(review.report.workDate)}</strong><span>{review.report.ownerName}</span><span>Строк: {review.report.rows.length} · {review.report.rows.reduce((sum, row) => sum + (row.hours ?? 0), 0)} ч</span></div><p>{review.action === "approve" ? "Подтвердится весь отчёт этого прораба за указанную дату. Все его строки попадут в учёт и табель." : "Прораб увидит комментарий и сможет исправить черновик перед повторной отправкой."}</p><label>{review.action === "reject" ? "Что нужно исправить — обязательно" : "Комментарий инженера — необязательно"}<textarea placeholder={review.action === "reject" ? "Опишите, какие данные нужно исправить" : "При необходимости оставьте комментарий"} aria-label="Комментарий инженера" value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} /></label>
      {error && <p className="personnel-report-dialog-error" role="alert">{error}</p>}
      <div className="toolbar-actions"><button className="secondary-button" type="button" disabled={locked} onClick={() => setReview(null)}>Отмена</button><button className="save-edits-button" type="button" disabled={locked || Boolean(equipmentReportReviewIssue(review.report.id, Object.keys(edits))) || (review.action === "reject" && !comment.trim())} onClick={() => void transition(review.report, review.action, comment)}>{review.action === "approve" ? "Подтвердить и включить в табель" : "Вернуть прорабу"}</button></div>
    </ReportDialog>}
  </section>;
}
