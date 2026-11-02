"use client";

import { useEffect, useRef } from "react";
import type { BitrixReviewDifference } from "./bitrixReviewSelection";
import "./bitrixReviewBulk.css";

export function BitrixReviewEmployeeList({ differences, total, updateIds, selectedIds, activeIndex, canUpdate, busy, getLabel, onSelect, onActiveChange }: {
  differences: readonly BitrixReviewDifference[]; total: number; updateIds: readonly number[]; selectedIds: readonly number[];
  activeIndex: number; canUpdate: boolean; busy: boolean; getLabel: (item: BitrixReviewDifference) => string;
  onSelect: (ids: number[]) => void; onActiveChange: (index: number) => void;
}) {
  const all = useRef<HTMLInputElement>(null);
  const selected = new Set(selectedIds);
  const eligible = new Set(updateIds);
  const count = updateIds.filter(id => selected.has(id)).length;
  const allSelected = updateIds.length > 0 && count === updateIds.length;
  useEffect(() => { if (all.current) all.current.indeterminate = count > 0 && !allSelected; }, [count, allSelected]);
  return <aside className="bitrix-review-list" aria-label="Сотрудники с расхождениями">
    <div className="bitrix-review-list-heading">
      {canUpdate && <label className="bitrix-review-select-all" title="Выбрать всех сотрудников с расхождениями, доступных для обновления, включая строки за пределами списка">
        <input ref={all} type="checkbox" aria-label="Выбрать всех для обновления из Битрикс24" checked={allSelected} disabled={busy || !updateIds.length} onChange={event => onSelect(event.target.checked ? [...updateIds] : [])}/><strong>Сотрудники</strong>
      </label>}
      {!canUpdate && <strong>Сотрудники</strong>}<span>{total}</span>
    </div>
    <div className="bitrix-review-items" role="list" aria-label="Список сотрудников проверки">
      {differences.map((item, index) => {
        const id = item.localEmployeeId;
        const selectable = Boolean(id && eligible.has(id) && !item.acknowledged && item.kind === "changed");
        const reason = selectable ? "Обновить данные этой карточки" : item.acknowledged ? "Предупреждение уже подтверждено" : item.kind === "missing_locally" ? "Сотрудника нужно добавить отдельно" : "Для этого расхождения выберите отдельное действие справа";
        return <div role="listitem" className={`bitrix-review-row${index === activeIndex ? " active" : ""}${id && selected.has(id) ? " checked" : ""}`} key={`${item.kind}-${item.bitrix24Id ?? item.employeeName}-${index}`}>
          {canUpdate && <label className="bitrix-review-row-check" title={reason}><input type="checkbox" aria-label={`Обновить из Битрикс24: ${item.employeeName}`} checked={selectable && selected.has(id!)} disabled={busy || !selectable} onChange={event => onSelect(event.target.checked ? [...new Set([...selectedIds, id!])] : selectedIds.filter(value => value !== id))}/></label>}
          <button type="button" aria-pressed={index === activeIndex} className={`${item.kind}${index === activeIndex ? " selected" : ""}${item.acknowledged ? " acknowledged" : ""}`} onClick={() => onActiveChange(index)}><strong>{item.employeeName}</strong><span>{item.acknowledged ? "Подтверждено" : getLabel(item)}</span></button>
        </div>;
      })}
    </div>
    {total > differences.length && <small>Показаны первые {differences.length} из {total}. «Выбрать всех» охватывает весь результат проверки.</small>}
  </aside>;
}
