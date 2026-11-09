"use client";

import { ExcelActionsMenu, type ExcelMenuAction } from "./ExcelActionsMenu";
import "./employeeSpreadsheetFooter.css";

export type AdminGridSelectionAction = { key: string; label: string; className?: string; disabled?: boolean; title?: string; onClick: () => void };
export type AdminGridAdditionalAddAction = { key: string; label: string; disabled?: boolean; onClick: () => void };

export function AdminGridFooter({ addLabel, countLabel, count, deletingCount, deletingLabel, editorOpen, editingExisting = false, pendingCount = 0, saving = false, allowMultiple = false, canCreate = true, addDisabled = false, canUpdate = true, canDelete = true, editSelectionLabel, bulkEditSelectionLabel, cancelEditingLabel = "Отменить редактирование", uniformActions = false, compact = false, selectedDraftCount = 0, selectionActions = [], editingActions = [], additionalAddActions = [], onAdd, onDelete, onRemoveSelectedDrafts, onEditSelection, onBulkEditSelection, onClearSelection, onCancelEditing, onSave }: { addLabel: string; countLabel: string; count: number; deletingCount: number; deletingLabel: string; editorOpen: boolean; editingExisting?: boolean; pendingCount?: number; saving?: boolean; allowMultiple?: boolean; canCreate?: boolean; addDisabled?: boolean; canUpdate?: boolean; canDelete?: boolean; editSelectionLabel?: string; bulkEditSelectionLabel?: string; cancelEditingLabel?: string; uniformActions?: boolean; compact?: boolean; selectedDraftCount?: number; selectionActions?: AdminGridSelectionAction[]; editingActions?: AdminGridSelectionAction[]; additionalAddActions?: AdminGridAdditionalAddAction[]; onAdd: () => void; onDelete: () => void; onRemoveSelectedDrafts?: () => void; onEditSelection?: () => void; onBulkEditSelection?: () => void; onClearSelection?: () => void; onCancelEditing?: () => void; onSave?: () => void }) {
  const showAdd = canCreate && !editorOpen && !editingExisting && deletingCount === 0;
  const canSave = editingExisting ? canUpdate : canCreate;
  if (compact) {
    const selectionDisabled = saving || editorOpen;
    const actions: ExcelMenuAction[] = [
      ...(canUpdate && onEditSelection ? [{ label: editSelectionLabel ?? "Редактировать", onSelect: onEditSelection, disabled: selectionDisabled }] : []),
      ...(canUpdate && onBulkEditSelection ? [{ label: bulkEditSelectionLabel ?? "Массовое редактирование", onSelect: onBulkEditSelection, disabled: selectionDisabled }] : []),
      ...selectionActions.map(action => ({ label: action.label, onSelect: action.onClick, disabled: selectionDisabled || action.disabled })),
      ...(canDelete ? [{ label: deletingLabel, onSelect: onDelete, disabled: selectionDisabled }] : []),
    ];
    return <div className="table-edit-footer employee-table-footer admin-grid-footer employee-spreadsheet-footer">
      <div className="employee-spreadsheet-footer-summary" aria-live="polite">
        <span>{countLabel}: <strong>{count}</strong></span>
        {deletingCount > 0 && <span>Выбрано: <strong>{deletingCount}</strong></span>}
        {selectedDraftCount > 0 && <span>Новых строк выбрано: <strong>{selectedDraftCount}</strong></span>}
        {pendingCount > 0 && <span>Изменено: <strong>{pendingCount}</strong></span>}
      </div>
      <div className="employee-spreadsheet-footer-actions">
        {canCreate && <button type="button" className="employee-spreadsheet-footer-button" onClick={onAdd} disabled={saving || addDisabled || !allowMultiple && (editorOpen || editingExisting)}>{addLabel}</button>}
        {canCreate && additionalAddActions.map(action => <button type="button" key={action.key} className="employee-spreadsheet-footer-button" onClick={action.onClick} disabled={saving || addDisabled || !allowMultiple && (editorOpen || editingExisting) || action.disabled}>{action.label}</button>)}
        {onSave && (canCreate || canUpdate) && <button type="button" className="employee-spreadsheet-footer-button" onClick={onSave} disabled={saving || pendingCount === 0 || !canSave}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button>}
        {pendingCount > 0 && editingActions.map(action => <button type="button" key={action.key} className="employee-spreadsheet-footer-button" onClick={action.onClick} disabled={saving || action.disabled} title={action.title}>{action.label}</button>)}
        {pendingCount > 0 && onCancelEditing && <button type="button" className="employee-spreadsheet-footer-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}
        {deletingCount > 0 && actions.length > 0 && <ExcelActionsMenu label="Действия" ariaLabel="Действия с выбранными строками" actions={actions} />}
        {selectedDraftCount > 0 && canCreate && onRemoveSelectedDrafts && <button type="button" className="employee-spreadsheet-footer-button" onClick={onRemoveSelectedDrafts} disabled={saving} title="Убрать выбранные новые строки, которые ещё не сохранены в системе">Убрать новые строки ({selectedDraftCount})</button>}
        {(deletingCount > 0 || selectedDraftCount > 0) && onClearSelection && <button type="button" className="employee-spreadsheet-footer-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>}
      </div>
    </div>;
  }
  if (uniformActions) return <div className="table-edit-footer employee-table-footer admin-grid-footer uniform-footer-actions">
    {deletingCount > 0 && <div className="employee-selection-bar">
      <div className="employee-selection-summary"><span aria-hidden="true">✓</span><span>Выбрано: <strong>{deletingCount}</strong></span></div>
      <div className="employee-selection-actions">
        {canUpdate && onEditSelection && <button type="button" className="employee-action-button employee-action-primary" onClick={onEditSelection} disabled={saving}>{editSelectionLabel ?? "Редактировать"}</button>}
        {canUpdate && onBulkEditSelection && <button type="button" className="employee-action-button bulk-edit-selection-button" onClick={onBulkEditSelection} disabled={saving}>{bulkEditSelectionLabel ?? "Массовое редактирование"}</button>}
        {selectionActions.map((action) => <button type="button" key={action.key} className={`employee-action-button ${action.className ?? ""}`.trim()} onClick={action.onClick} disabled={saving || action.disabled} title={action.title}>{action.label}</button>)}
        {canDelete && <button type="button" className="employee-action-button employee-action-danger" onClick={onDelete} disabled={saving}>{deletingLabel}</button>}
        {onClearSelection && <button type="button" className="employee-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Снять выделение</button>}
      </div>
    </div>}
    {pendingCount > 0 && <div className="employee-editing-bar">
      <div className="employee-editing-summary"><span aria-hidden="true">✎</span><span>Редактируется: <strong>{pendingCount}</strong></span></div>
      <div className="employee-selection-actions">
        {editingActions.map((action) => <button type="button" key={action.key} className={`employee-action-button ${action.className ?? ""}`.trim()} onClick={action.onClick} disabled={saving || action.disabled} title={action.title}>{action.label}</button>)}
        {onCancelEditing && <button type="button" className="employee-action-button cancel-editing-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}
        {canSave && onSave && <button type="button" className="employee-action-button employee-save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : "Сохранить изменения"}</button>}
      </div>
    </div>}
    {!editorOpen && deletingCount === 0 && <div className="employee-footer-base">
      {showAdd && (additionalAddActions.length > 0 ? <div className="employee-footer-add-actions">
        <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>
        {additionalAddActions.map((action) => <button type="button" key={action.key} className="secondary-button footer-action-button employee-add-button" onClick={action.onClick} disabled={action.disabled}>{action.label}</button>)}
      </div> : <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>)}
      <span className="employee-total-count">{countLabel}: <strong>{count}</strong></span>
    </div>}
  </div>;
  return <div className="table-edit-footer employee-table-footer admin-grid-footer employee-spreadsheet-footer">
    <div className="employee-spreadsheet-footer-summary" aria-live="polite">
      <span>{countLabel}: <strong>{count}</strong></span>
      {deletingCount > 0 && <span>Выбрано: <strong>{deletingCount}</strong></span>}
      {pendingCount > 0 && <span>Изменено: <strong>{pendingCount}</strong></span>}
    </div>
    <div className="employee-spreadsheet-footer-actions">
      {showAdd && <button type="button" className="secondary-button footer-action-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>}
      {deletingCount > 0 && <div className="selection-actions">
        {canUpdate && onEditSelection && <button type="button" className="save-edits-button" onClick={onEditSelection} disabled={saving}>{`${editSelectionLabel ?? "Редактировать"} (${deletingCount})`}</button>}
        {canUpdate && onBulkEditSelection && <button type="button" className="save-edits-button" onClick={onBulkEditSelection} disabled={saving}>{`${bulkEditSelectionLabel ?? "Массовое редактирование"} (${deletingCount})`}</button>}
        {selectionActions.map(action => <button type="button" key={action.key} className={action.className ?? "save-edits-button"} onClick={action.onClick} disabled={saving || action.disabled} title={action.title}>{action.label}</button>)}
        {canDelete && <button type="button" className="delete-rows-button" onClick={onDelete} disabled={saving}>{`${deletingLabel} (${deletingCount})`}</button>}
        {onClearSelection && <button type="button" className="secondary-button footer-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Отменить выделение</button>}
      </div>}
      {pendingCount > 0 && onCancelEditing && <button type="button" className="secondary-button footer-action-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}
      {pendingCount > 0 && canSave && onSave && <button type="button" className="save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : `Сохранить (${pendingCount})`}</button>}
    </div>
  </div>;
}
