"use client";

import { useEffect, useRef, useState } from "react";
import type { BitrixReviewDifference } from "./bitrixReviewSelection";
import "./bitrixReviewBulk.css";

const BITRIX_REVIEW_PAGE_SIZE = 100;

export function BitrixReviewEmployeeList({ differences, total, updateIds, applyIds = updateIds, selectedIds, activeIndex, canUpdate, busy, getLabel, onSelect, onActiveChange, linkSelection }: {
  differences: readonly BitrixReviewDifference[]; total: number; updateIds: readonly number[]; selectedIds: readonly number[];
  applyIds?: readonly number[];
  activeIndex: number; canUpdate: boolean; busy: boolean; getLabel: (item: BitrixReviewDifference) => string;
  onSelect: (ids: number[]) => void; onActiveChange: (index: number) => void;
  linkSelection?: { eligibleIds: readonly string[]; selectedIds: readonly string[]; archiveIds?: readonly string[]; onSelect: (ids: string[]) => void };
}) {
  const all = useRef<HTMLInputElement>(null);
  const [visibleCount, setVisibleCount] = useState(BITRIX_REVIEW_PAGE_SIZE);
  const shownCount = Math.min(differences.length, Math.max(visibleCount, activeIndex + 1));
  const eligibleIds = linkSelection?.eligibleIds ?? updateIds;
  const selected = new Set<string | number>(linkSelection?.selectedIds ?? selectedIds);
  const eligible = new Set<string | number>(eligibleIds);
  const archiveLinks = new Set(linkSelection?.archiveIds);
  const includesArchiveLinks = linkSelection?.eligibleIds.some(id => archiveLinks.has(id));
  const applyEligible = new Set(applyIds);
  const includesIgnoreOnly = updateIds.some(id => !applyEligible.has(id));
  const showSelection = canUpdate && eligibleIds.length > 0;
  const count = [...eligible].filter(id => selected.has(id)).length;
  const allSelected = eligible.size > 0 && count === eligible.size;
  const selectAll = (checked: boolean) => {
    if (linkSelection) linkSelection.onSelect(checked ? [...new Set(linkSelection.eligibleIds)] : []);
    else onSelect(checked ? [...updateIds] : []);
  };
  useEffect(() => { if (all.current) all.current.indeterminate = count > 0 && !allSelected; }, [count, allSelected, showSelection]);
  return <aside className="bitrix-review-list" aria-label="Сотрудники с расхождениями">
    <div className="bitrix-review-list-heading">
      {showSelection ? <label className="bitrix-review-select-all" title={linkSelection
        ? includesArchiveLinks
          ? "Выбрать все точные совпадения и связи из архива с одним однозначным кандидатом, включая строки за пределами списка"
          : "Выбрать все точные совпадения, включая строки за пределами видимого списка"
        : "Выбрать всех сотрудников с расхождениями, включая строки за пределами списка"}>
        <input ref={all} type="checkbox" aria-label={linkSelection ? "Выбрать всех для сопоставления с Битрикс24" : includesIgnoreOnly ? "Выбрать всех с различиями" : "Выбрать всех для обновления из Битрикс24"} checked={allSelected} disabled={busy} onChange={event => selectAll(event.target.checked)}/><strong>Сотрудники</strong>
      </label> : <strong>Сотрудники</strong>}<span>{total}</span>
    </div>
    <div className="bitrix-review-items" role="list" aria-label="Список сотрудников проверки">
      {differences.slice(0, shownCount).map((item, index) => {
        const id = linkSelection ? item.bitrix24Id : item.localEmployeeId;
        const isArchiveLink = typeof id === "string" && archiveLinks.has(id);
        const isTerminal = item.kind === "blacklisted_in_bitrix" || item.kind === "dismissed_in_bitrix";
        const canApply = typeof id === "number" && applyEligible.has(id);
        const selectable = showSelection && id !== undefined && eligible.has(id) && !item.acknowledged
          && (linkSelection ? item.kind === "missing_locally" : item.kind !== "missing_locally" && item.kind !== "archived_returned_to_site");
        const checked = selectable && selected.has(id);
        const title = linkSelection ? (isArchiveLink ? "Выбрать для переноса связи из архива" : "Выбрать для сопоставления")
          : !canApply ? "Выбрать, чтобы проигнорировать различие" : isTerminal ? "Выбрать для переноса в архив" : "Выбрать для обновления или игнорирования";
        const actionLabel = linkSelection ? (isArchiveLink ? "Перенести связь из архива" : "Сопоставить с Битрикс24")
          : !canApply ? "Игнорировать различие" : isTerminal ? "Архивировать по данным Битрикс24" : "Обновить из Битрикс24";
        const selectRow = (nextChecked: boolean) => {
          if (linkSelection && typeof id === "string") {
            linkSelection.onSelect(nextChecked ? [...new Set([...linkSelection.selectedIds, id])] : linkSelection.selectedIds.filter(value => value !== id));
          } else if (typeof id === "number") {
            onSelect(nextChecked ? [...new Set([...selectedIds, id])] : selectedIds.filter(value => value !== id));
          }
        };
        return <div role="listitem" className={`bitrix-review-row${index === activeIndex ? " active" : ""}${checked ? " checked" : ""}`} key={`${item.kind}-${item.bitrix24Id ?? item.employeeName}-${index}`}>
          {selectable ? <label className="bitrix-review-row-check" title={title}><input type="checkbox" aria-label={`${actionLabel}: ${item.employeeName}`} checked={checked} disabled={busy} onChange={event => selectRow(event.target.checked)}/></label> : showSelection && <span className="bitrix-review-row-spacer" aria-hidden="true" />}
          <button type="button" aria-pressed={index === activeIndex} className={`${item.kind}${index === activeIndex ? " selected" : ""}${item.acknowledged ? " acknowledged" : ""}`} onClick={() => onActiveChange(index)}><strong>{item.employeeName}</strong><span>{item.acknowledged ? "Различия проигнорированы" : getLabel(item)}</span></button>
        </div>;
      })}
    </div>
    {shownCount < Math.max(total, differences.length) && <div className="bitrix-review-list-footer">
      <small>Показано {shownCount} из {Math.max(total, differences.length)}.</small>
      {shownCount < differences.length && <button type="button" onClick={() => setVisibleCount(shownCount + BITRIX_REVIEW_PAGE_SIZE)}>Показать ещё {Math.min(BITRIX_REVIEW_PAGE_SIZE, differences.length - shownCount)}</button>}
    </div>}
  </aside>;
}
