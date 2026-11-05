"use client";

import type { TimesheetBatchSaveStatus } from "./timesheetBatchSave";
import "./timesheetSaveStatus.css";

export function TimesheetSaveStatus({ status, busy, retryDisabled = false, onRetry, onDismiss }: {
  status: TimesheetBatchSaveStatus | null;
  busy: boolean;
  retryDisabled?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (!status) return null;
  return <section className={`timesheet-save-status${status.failed ? " has-errors" : ""}`} aria-label="Сохранение ячеек табеля" aria-busy={busy}>
    <div className="timesheet-save-status-main">
      <span className="timesheet-save-status-icon" aria-hidden="true">{busy ? "…" : status.failed ? "!" : "✓"}</span>
      <div className="timesheet-save-status-copy" role="status" aria-live="polite" aria-atomic="true">
        <strong>{busy ? "Сохраняем ячейки…" : `Сохранено ячеек: ${status.saved} из ${status.total}`}</strong>
        <span>{busy ? `Сохранено: ${status.saved} · Осталось: ${status.pending}` : status.failed ? `Не подтверждено сохранение: ${status.failed}. Повторите только эти ячейки.` : "Все изменения сохранены."}</span>
      </div>
      <div className="timesheet-save-status-actions">
        {status.failed > 0 && <button type="button" className="timesheet-save-retry" disabled={busy || retryDisabled} onClick={onRetry}>Повторить сохранение ({status.failed})</button>}
        {!busy && !status.failed && <button type="button" className="timesheet-save-dismiss" onClick={onDismiss} aria-label="Скрыть результат сохранения">×</button>}
      </div>
    </div>
    {status.failed > 0 && <details className="timesheet-save-failures">
      <summary>Показать ячейки с ошибками ({status.failed})</summary>
      <ul className="timesheet-save-failure-list">{status.failures.map(failure => <li key={failure.key}>
        <strong>{failure.label}</strong><span>Значение: {failure.value || "очистить ячейку"}</span><span>{failure.error}</span>
      </li>)}</ul>
    </details>}
  </section>;
}
