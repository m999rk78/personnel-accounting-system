"use client";

import { CustomSelect } from "../CustomSelect";
import { BitrixReviewEmployeeList } from "../BitrixReviewEmployeeList";
import type { useBitrixReview } from "./useBitrixReview";
import type { BitrixCheckDifference, DataSet, Site } from "./types";

const BITRIX_DIFFERENCE_LABELS: Record<BitrixCheckDifference["kind"], string> = {
  missing_locally: "Не найден в справочнике",
  changed: "Данные отличаются",
  outside_scope: "Вне выбранных стадий",
  missing_in_bitrix: "Нет в Битрикс24",
  dismissed_in_bitrix: "Уволен в Битрикс24",
  archived_returned_to_site: "Снова на объекте в Битрикс24",
  blacklisted_in_bitrix: "Чёрный список в Битрикс24",
  incomplete: "Не заполнены поля",
  unknown_stage: "Неизвестная стадия",
};

const BITRIX_DIFFERENCE_SUMMARY_LABELS: Record<BitrixCheckDifference["kind"], string> = {
  missing_locally: "Без связи с Битрикс24",
  changed: "Отличаются данные",
  outside_scope: "Вне выбранного контура",
  missing_in_bitrix: "Нет в Битрикс24",
  dismissed_in_bitrix: "Уволены",
  archived_returned_to_site: "Вернулись на объект в Битрикс24",
  blacklisted_in_bitrix: "Чёрный список в Битрикс24",
  incomplete: "Неполные карточки",
  unknown_stage: "Неизвестная стадия",
};

export function BitrixReviewDialogs({ review, data, visibleSites, mayInspectBitrix24, mayCreateEmployees, mayUpdateEmployees, mayDeleteEmployees, error }: {
  review: ReturnType<typeof useBitrixReview>;
  data: DataSet | null;
  visibleSites: Site[];
  mayInspectBitrix24: boolean;
  mayCreateEmployees: boolean;
  mayUpdateEmployees: boolean;
  mayDeleteEmployees: boolean;
  error: string;
}) {
  const { linkingBitrix24, bitrixCheckResult, setBitrixCheckResult, setSelectedBitrixDifferenceIndex, bitrixReviewSelectedIds, setBitrixReviewSelectedIds, bitrixLinkSelectedIds, setBitrixLinkSelectedIds, bitrixLinkEligibleIds, bitrixLinkSelectedCount, bitrixSelectionMode, setBitrixSelectionMode, bitrixReviewProgress, bitrixReviewUpdatedCount, bitrixReviewNotice, setBitrixManualLinks, bitrixEmployeeCreateDraft, setBitrixEmployeeCreateDraft, bitrixEmployeeCreateError, setBitrixEmployeeCreateError, creatingBitrixEmployee, bitrixEmployeeAction, setBitrixEmployeeAction, processingBitrixEmployee, bitrixAvailableEmployeeOptions, linkBitrix24Employees, openBitrixEmployeeCreate, createBitrix24Employee, applyBitrixEmployeeAction, acknowledgeBitrixDifference, acknowledgeBitrixReviewSelection, updateBitrixReviewSelection, selectedBitrixDifferenceSafeIndex, selectedBitrixDifference, bitrixReviewUpdateIdsForAll, bitrixReviewSelectedCount, bitrixReviewSelectableIds, bitrixReviewSelectionCount, bitrixReviewIgnoreSelectedCount, bitrixReviewBlacklistSelectedCount, selectedBitrixEmployeeId, canLinkSelectedBitrixEmployee, canCreateSelectedBitrixEmployee, canUpdateSelectedBitrixEmployee, canDeleteSelectedBitrixEmployee, canAcknowledgeSelectedBitrixEmployee, selectedBitrixDifferenceDetails } = review;
  const canSelectForUpdate = mayUpdateEmployees && bitrixReviewSelectableIds.length > 0;
  const canSelectForLink = mayUpdateEmployees && bitrixLinkEligibleIds.length > 0;
  const canSwitchSelection = canSelectForLink && canSelectForUpdate;
  const isLinkMode = canSelectForLink && !bitrixReviewProgress && (!canSelectForUpdate || bitrixSelectionMode === "link");
  const archiveLinkIds = new Set(review.bitrixLinkArchiveIds);
  const archiveOnly = bitrixLinkSelectedCount
    ? review.bitrixLinkSelectedArchiveCount === bitrixLinkSelectedCount
    : bitrixLinkEligibleIds.length === archiveLinkIds.size;
  const selectionBusy = processingBitrixEmployee || linkingBitrix24 || creatingBitrixEmployee;
  const unresolved = bitrixCheckResult?.differences.filter(item => !item.acknowledged) ?? [];
  const toOfficeCount = unresolved.filter(item => item.officeTransfer === "to_office").length;
  const toSiteCount = unresolved.filter(item => item.officeTransfer === "to_site").length;
  const officeTransferCount = toOfficeCount + toSiteCount;
  const pendingOfficeTransfer = bitrixEmployeeAction?.difference.officeTransfer;
  const missingLinks = bitrixCheckResult?.differenceCounts?.missing_locally ?? unresolved.filter(item => item.kind === "missing_locally").length;
  const linkedDifferences = unresolved.length === bitrixCheckResult?.totalDifferences
    ? unresolved.filter(item => item.localEmployeeId).length
    : Math.max(0, (bitrixCheckResult?.totalDifferences ?? 0) - missingLinks);
  const reviewInstruction = isLinkMode ? "Отметьте карточки для сопоставления или переноса связи."
    : canSelectForUpdate ? officeTransferCount ? "Отметьте нужные карточки, чтобы подтвердить переводы или применить другие изменения."
      : "Отметьте сотрудников, чтобы обновить данные или проигнорировать различия."
      : "Нажмите на имя сотрудника, чтобы посмотреть подробности.";
  const getDifferenceLabel = (item: BitrixCheckDifference) => item.officeTransfer
    ? item.officeTransfer === "to_office" ? "Перевод в центральный офис" : "Перевод на объект"
    : item.archivedLink
    ? item.bitrix24Id && archiveLinkIds.has(item.bitrix24Id) ? "Можно перенести связь" : "Нужна ручная проверка пары"
    : item.kind === "missing_locally" && item.suggestedEmployeeIds?.length
    ? "Есть кандидаты для сопоставления"
    : BITRIX_DIFFERENCE_LABELS[item.kind];
  return <>
    {mayInspectBitrix24 && bitrixCheckResult && <div className="bitrix-check-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !linkingBitrix24 && !creatingBitrixEmployee && !processingBitrixEmployee && !bitrixEmployeeCreateDraft && !bitrixEmployeeAction) setBitrixCheckResult(null); }}><section className={`bitrix-check-dialog ${bitrixCheckResult.status}`} role="dialog" aria-modal="true" aria-labelledby="bitrix-check-title">
      <div className="bitrix-check-heading"><span className="bitrix-check-icon" aria-hidden="true">{bitrixCheckResult.status === "ok" ? "✓" : "!"}</span><div><small>{bitrixReviewUpdatedCount ? "ДАННЫЕ ОБНОВЛЕНЫ" : bitrixCheckResult.linked ? "СОПОСТАВЛЕНИЕ ЗАВЕРШЕНО" : "ДАННЫЕ НЕ ИЗМЕНЕНЫ"}</small><h2 id="bitrix-check-title">{bitrixCheckResult.status === "ok" ? "Всё в порядке" : "Нужно проверить сотрудников"}</h2><p>{bitrixCheckResult.linked ? `Связано сотрудников: ${bitrixCheckResult.linked}.` : bitrixCheckResult.status === "ok" ? "Активных расхождений с Битрикс24 нет." : reviewInstruction}</p>{Number.isSafeInteger(bitrixCheckResult.compared) && <p>Действующих связанных карточек в сверке: {bitrixCheckResult.compared}. Архив не учитывается в обычной сверке.{typeof bitrixCheckResult.activeUnlinked === "number" && ` Действующих без связи: ${bitrixCheckResult.activeUnlinked}.`}</p>}</div><button type="button" className="bitrix-check-close" aria-label="Закрыть результат проверки" onClick={() => setBitrixCheckResult(null)} disabled={linkingBitrix24 || creatingBitrixEmployee || processingBitrixEmployee || Boolean(bitrixEmployeeCreateDraft) || Boolean(bitrixEmployeeAction)}>×</button></div>
      <div className="bitrix-check-summary">
        <div className="matched"><span>Совпали связанные карточки</span><strong>{bitrixCheckResult.matched}</strong></div>
        <div className="attention"><span>Нерешённые расхождения</span><strong>{linkedDifferences}</strong></div>
        {missingLinks > 0 && <div className="linkage"><span>Нужно сопоставить или добавить</span><strong>{missingLinks}</strong></div>}
        {Boolean(bitrixCheckResult.acknowledgedDifferences) && <div className="accepted"><span>Проигнорированы различия</span><strong>{bitrixCheckResult.acknowledgedDifferences}</strong></div>}
      </div>
      {(bitrixCheckResult.differenceCounts || officeTransferCount > 0) && <div className="bitrix-check-breakdown">
        {(Object.entries(bitrixCheckResult.differenceCounts ?? {}) as [BitrixCheckDifference["kind"], number][]).flatMap(([kind, total]) => {
          const count = kind === "changed" ? total - officeTransferCount : total;
          return count > 0 && kind !== "missing_locally" ? [<span className={kind} key={kind}>{BITRIX_DIFFERENCE_SUMMARY_LABELS[kind]}: <strong>{count}</strong></span>] : [];
        })}
        {toOfficeCount > 0 && <span className="changed">Переводы в центральный офис: <strong>{toOfficeCount}</strong></span>}
        {toSiteCount > 0 && <span className="changed">Переводы на объект: <strong>{toSiteCount}</strong></span>}
      </div>}
      {mayUpdateEmployees && (canSwitchSelection || !isLinkMode && (canSelectForUpdate || bitrixReviewProgress)) && <div className="bitrix-review-selection-bar">
        <div className="bitrix-review-selection-copy">
          <strong>{isLinkMode ? `Доступно для сопоставления: ${bitrixLinkEligibleIds.length}` : bitrixReviewProgress ? `Обработано: ${bitrixReviewProgress.done} / ${bitrixReviewProgress.total}` : `Выбрано сотрудников: ${bitrixReviewSelectionCount}`}</strong>
          <span>{isLinkMode ? "Сопоставление меняет только связь с Битрикс24." : bitrixReviewBlacklistSelectedCount ? "Записи чёрного списка нельзя игнорировать." : officeTransferCount ? "Переводы применяются только после подтверждения. История сохранится." : "Уволенные при обновлении уйдут в архив. История сохранится."}</span>
        </div>
        <div className="bitrix-review-selection-actions">
          {canSwitchSelection && <div className="bitrix-review-selection-mode" role="group" aria-label="Действие для отмеченных карточек">
            <button type="button" aria-pressed={isLinkMode} disabled={selectionBusy} onClick={() => setBitrixSelectionMode("link")}>Сопоставление</button>
            <button type="button" aria-pressed={!isLinkMode} disabled={selectionBusy} onClick={() => setBitrixSelectionMode("update")}>Обновление</button>
          </div>}
          {!isLinkMode && <>
            <button type="button" disabled={!bitrixReviewSelectionCount || selectionBusy} onClick={() => setBitrixReviewSelectedIds([])}>Снять выбор</button>
            <button type="button" disabled={!bitrixReviewIgnoreSelectedCount || selectionBusy} onClick={() => void acknowledgeBitrixReviewSelection()}>{bitrixReviewProgress?.action === "ignore" ? "Игнорируем…" : `Игнорировать различия (${bitrixReviewIgnoreSelectedCount})`}</button>
            {(bitrixReviewUpdateIdsForAll.length > 0 || bitrixReviewProgress?.action === "update") && <button type="button" className="bitrix-review-bulk-update" disabled={!bitrixReviewSelectedCount || selectionBusy} onClick={() => void updateBitrixReviewSelection()}>{bitrixReviewProgress?.action === "update" ? "Обновляем…" : `Обновить из Битрикс24 (${bitrixReviewSelectedCount})`}</button>}
          </>}
        </div>
      </div>}
      {bitrixReviewNotice && <div className="bitrix-review-notice" role="status">{bitrixReviewNotice}</div>}
      {selectedBitrixDifference && <div className="bitrix-review-layout">
        <BitrixReviewEmployeeList differences={bitrixCheckResult.differences} total={bitrixCheckResult.totalDifferences} linkSelection={isLinkMode ? { eligibleIds: bitrixLinkEligibleIds, archiveIds: review.bitrixLinkArchiveIds, selectedIds: bitrixLinkSelectedIds, onSelect: setBitrixLinkSelectedIds } : undefined} updateIds={bitrixReviewSelectableIds} applyIds={bitrixReviewUpdateIdsForAll} selectedIds={bitrixReviewSelectedIds} activeIndex={selectedBitrixDifferenceSafeIndex} canUpdate={mayUpdateEmployees} busy={processingBitrixEmployee || linkingBitrix24 || creatingBitrixEmployee} getLabel={item => getDifferenceLabel(item as BitrixCheckDifference)} onSelect={setBitrixReviewSelectedIds} onActiveChange={setSelectedBitrixDifferenceIndex} />
        <section className={`bitrix-review-detail ${selectedBitrixDifference.kind}${selectedBitrixDifference.acknowledged ? " acknowledged" : ""}`}><div className="bitrix-review-detail-heading"><div><span>Выбранный сотрудник</span><h3>{selectedBitrixDifference.employeeName}</h3></div><em>{selectedBitrixDifference.acknowledged ? "Различия проигнорированы" : getDifferenceLabel(selectedBitrixDifference)}</em></div><div className="bitrix-review-reason"><span>Что обнаружено</span><p>{selectedBitrixDifferenceDetails}</p>{selectedBitrixDifference.kind === "blacklisted_in_bitrix" && <p>Стадии «Увольнения» и «Чёрный список» означают увольнение. «Чёрный список» также исключает повторный приём. При применении статуса сотрудник будет перенесён в архив; история отчётов и табелей сохранится.</p>}</div>{canLinkSelectedBitrixEmployee && <div className="bitrix-review-link"><span>{selectedBitrixDifference.archivedLink ? "Связать с действующей карточкой" : "Сопоставить с существующим"}</span><div className="bitrix-manual-link"><CustomSelect searchable className="bitrix-manual-select" value={selectedBitrixEmployeeId} ariaLabel={`Сотрудник системы для ${selectedBitrixDifference.employeeName}`} onChange={(employeeId) => setBitrixManualLinks((current) => ({ ...current, [selectedBitrixDifference.bitrix24Id!]: employeeId }))} options={bitrixAvailableEmployeeOptions} /><button type="button" disabled={!selectedBitrixEmployeeId || linkingBitrix24 || creatingBitrixEmployee || processingBitrixEmployee} onClick={() => void linkBitrix24Employees([{ bitrix24Id: selectedBitrixDifference.bitrix24Id!, employeeId: Number(selectedBitrixEmployeeId) }])}>{linkingBitrix24 ? "Сопоставляем…" : selectedBitrixDifference.archivedLink ? "Перенести связь" : "Сопоставить"}</button></div></div>}<div className="bitrix-review-detail-actions"><div>{canCreateSelectedBitrixEmployee && <button type="button" className="bitrix-add-employee-button" onClick={() => openBitrixEmployeeCreate(selectedBitrixDifference)} disabled={linkingBitrix24 || creatingBitrixEmployee || processingBitrixEmployee}>Добавить сотрудника</button>}{canUpdateSelectedBitrixEmployee && <button type="button" className="bitrix-update-employee-button" onClick={() => setBitrixEmployeeAction({ kind: "update", difference: selectedBitrixDifference })} disabled={processingBitrixEmployee}>{selectedBitrixDifference.officeTransfer ? "Подтвердить перевод" : selectedBitrixDifference.kind === "blacklisted_in_bitrix" ? "Архивировать" : "Обновить из Битрикс24"}</button>}{canDeleteSelectedBitrixEmployee && <button type="button" className="bitrix-delete-employee-button" onClick={() => setBitrixEmployeeAction({ kind: "delete", difference: selectedBitrixDifference })} disabled={processingBitrixEmployee}>Перенести в архив</button>}</div>{canAcknowledgeSelectedBitrixEmployee && <button type="button" className="bitrix-acknowledge-button" title="Скрыть расхождение, пока оно не изменится" onClick={() => void acknowledgeBitrixDifference(selectedBitrixDifference)} disabled={processingBitrixEmployee}>Оставить как есть</button>}</div></section>
      </div>}
      {Boolean(bitrixCheckResult.archiveReturns?.length) && <details className="bitrix-review-notice" style={{ maxHeight: 130, overflowY: "auto" }}>
        <summary>Изменились стадии архивных карточек ({bitrixCheckResult.archiveReturns?.length})</summary>
        <p>Эти сотрудники вышли со стадии увольнения или чёрного списка в Битрикс24. Карточки остаются в архиве и не входят в сверку действующих сотрудников.</p>
        <ul>{bitrixCheckResult.archiveReturns?.map(item => <li key={item.bitrix24Id}><strong>{item.employeeName}</strong> — {item.details}</li>)}</ul>
      </details>}
      {error && <div className="bitrix-link-error" role="alert">{error}</div>}
      <div className="bitrix-check-footer"><span>{isLinkMode ? `Выбрано для ${archiveOnly ? "переноса связи" : "сопоставления"}: ${bitrixLinkSelectedCount} из ${bitrixLinkEligibleIds.length}` : bitrixCheckResult.totalDifferences ? "Изменения применяются только после выбора действия." : "Проверка завершена."}</span><div>{isLinkMode && <button type="button" className="bitrix-auto-link-button" onClick={() => void linkBitrix24Employees()} disabled={selectionBusy || !bitrixLinkSelectedCount}>{linkingBitrix24 ? "Сопоставляем…" : `${archiveOnly ? "Перенести связь" : "Сопоставить выбранных"} (${bitrixLinkSelectedCount})`}</button>}<button type="button" onClick={() => setBitrixCheckResult(null)} disabled={linkingBitrix24 || creatingBitrixEmployee || processingBitrixEmployee || Boolean(bitrixEmployeeCreateDraft) || Boolean(bitrixEmployeeAction)}>Закрыть</button></div></div>
    </section></div>}
    {mayInspectBitrix24 && mayCreateEmployees && bitrixEmployeeCreateDraft && <div className="confirmation-backdrop bitrix-employee-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creatingBitrixEmployee) setBitrixEmployeeCreateDraft(null); }}><form className="bitrix-employee-create-dialog" role="dialog" aria-modal="true" aria-labelledby="bitrix-employee-create-title" onSubmit={(event) => void createBitrix24Employee(event)}>
      <div className="bitrix-employee-create-heading"><div><small>НОВАЯ КАРТОЧКА СОТРУДНИКА</small><h2 id="bitrix-employee-create-title">Добавить из Битрикс24</h2><p>ФИО и связь с Битрикс24 заполнятся автоматически. Выберите данные, которые будут использоваться в нашей системе.</p></div><button type="button" className="bulk-edit-close" aria-label="Закрыть добавление сотрудника" onClick={() => setBitrixEmployeeCreateDraft(null)} disabled={creatingBitrixEmployee}>×</button></div>
      <div className="bitrix-employee-source-card"><span>Сотрудник</span><strong>{bitrixEmployeeCreateDraft.fullName}</strong><p>{[bitrixEmployeeCreateDraft.sourceEmploymentType, bitrixEmployeeCreateDraft.sourceDepartment, bitrixEmployeeCreateDraft.sourcePosition].filter(Boolean).join(" · ") || "Кадровые данные в Битрикс24 не заполнены полностью"}</p></div>
      <div className="bitrix-employee-create-fields">
        <div><span>Должность в системе</span><CustomSelect searchable value={bitrixEmployeeCreateDraft.positionId} ariaLabel="Должность нового сотрудника" onChange={(positionId) => { setBitrixEmployeeCreateDraft((current) => current ? { ...current, positionId } : current); setBitrixEmployeeCreateError(""); }} options={[{ value: "", label: "Выберите должность" }, ...(data?.positionCatalog ?? []).map((position) => ({ value: String(position.id), label: `${position.employmentType} · ${position.department} · ${position.position}` }))]} /></div>
        <div><span>Объект</span><CustomSelect searchable value={bitrixEmployeeCreateDraft.projectSiteId} ariaLabel="Объект нового сотрудника" onChange={(projectSiteId) => { setBitrixEmployeeCreateDraft((current) => current ? { ...current, projectSiteId } : current); setBitrixEmployeeCreateError(""); }} options={[{ value: "", label: "Выберите объект" }, { value: "__unassigned__", label: "Без объекта" }, ...visibleSites.map((site) => ({ value: String(site.id), label: site.name }))]} /></div>
      </div>
      {bitrixEmployeeCreateDraft.sourceProjectKeys.length > 0 && <p className="bitrix-employee-project-hint">В карточке Битрикс24: {bitrixEmployeeCreateDraft.sourceProjectKeys.join(", ")}</p>}
      {bitrixEmployeeCreateError && <div className="bulk-edit-error" role="alert">{bitrixEmployeeCreateError}</div>}
      <div className="bitrix-employee-create-actions"><button type="button" className="secondary-button" onClick={() => setBitrixEmployeeCreateDraft(null)} disabled={creatingBitrixEmployee}>Отмена</button><button type="submit" className="save-edits-button" disabled={creatingBitrixEmployee || !bitrixEmployeeCreateDraft.positionId || !bitrixEmployeeCreateDraft.projectSiteId}>{creatingBitrixEmployee ? "Добавляем…" : "Добавить сотрудника"}</button></div>
    </form></div>}
    {mayInspectBitrix24 && (bitrixEmployeeAction?.kind === "delete" ? mayDeleteEmployees : mayUpdateEmployees) && bitrixEmployeeAction && <div className="confirmation-backdrop bitrix-employee-action-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !processingBitrixEmployee) setBitrixEmployeeAction(null); }}><section className="confirmation-dialog bitrix-employee-action-dialog" role="dialog" aria-modal="true" aria-labelledby="bitrix-employee-action-title">
      <h2 id="bitrix-employee-action-title">{pendingOfficeTransfer ? pendingOfficeTransfer === "to_office" ? "Подтвердить перевод в центральный офис?" : "Подтвердить перевод на объект?" : bitrixEmployeeAction.kind === "update" ? bitrixEmployeeAction.difference.kind === "blacklisted_in_bitrix" ? "Архивировать сотрудника?" : "Применить изменения из Битрикс24?" : "Перенести сотрудника в архив?"}</h2>
      <strong>{bitrixEmployeeAction.difference.employeeName}</strong>
      <p>{pendingOfficeTransfer
        ? `${bitrixEmployeeAction.difference.details} ${pendingOfficeTransfer === "to_office" ? "Карточка исчезнет из действующих списков площадки, а связь с Битрикс24 сохранится." : "На объект вернётся та же карточка, без создания дубля."} Ранее заполненные отчёты и табели останутся без изменений.`
        : bitrixEmployeeAction.kind === "update" ? bitrixEmployeeAction.difference.kind === "blacklisted_in_bitrix" ? "Будет применён статус «Чёрный список» из Битрикс24. Сотрудник будет перенесён в архив и исключён из действующих проектов. Повторный приём не разрешён. Ранее заполненные отчёты и табели сохранятся без изменений." : bitrixEmployeeAction.difference.details : `${bitrixEmployeeAction.difference.details} Карточка будет перенесена в архив и исключена из действующих проектов. Отчёты и табели сохранятся без изменений.`}</p>
      <div><button type="button" className="secondary-button" onClick={() => setBitrixEmployeeAction(null)} disabled={processingBitrixEmployee}>Отмена</button><button type="button" className={bitrixEmployeeAction.kind === "delete" ? "delete-rows-button" : "save-edits-button"} onClick={() => void applyBitrixEmployeeAction()} disabled={processingBitrixEmployee}>{processingBitrixEmployee ? "Выполняем…" : pendingOfficeTransfer ? "Подтвердить перевод" : bitrixEmployeeAction.kind === "update" ? bitrixEmployeeAction.difference.kind === "blacklisted_in_bitrix" ? "Архивировать" : "Применить изменения" : "Перенести в архив"}</button></div>
    </section></div>}
  </>;
}
