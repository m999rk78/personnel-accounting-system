"use client";

export type AdminGridSelectionAction = { key: string; label: string; className?: string; disabled?: boolean; title?: string; onClick: () => void };
export type AdminGridAdditionalAddAction = { key: string; label: string; disabled?: boolean; onClick: () => void };

export function AdminGridFooter({ addLabel, countLabel, count, deletingCount, deletingLabel, editorOpen, editingExisting = false, pendingCount = 0, saving = false, allowMultiple = false, canCreate = true, canUpdate = true, canDelete = true, editSelectionLabel, bulkEditSelectionLabel, cancelEditingLabel = "Отменить редактирование", uniformActions = false, selectionActions = [], editingActions = [], additionalAddActions = [], onAdd, onDelete, onEditSelection, onBulkEditSelection, onClearSelection, onCancelEditing, onSave }: { addLabel: string; countLabel: string; count: number; deletingCount: number; deletingLabel: string; editorOpen: boolean; editingExisting?: boolean; pendingCount?: number; saving?: boolean; allowMultiple?: boolean; canCreate?: boolean; canUpdate?: boolean; canDelete?: boolean; editSelectionLabel?: string; bulkEditSelectionLabel?: string; cancelEditingLabel?: string; uniformActions?: boolean; selectionActions?: AdminGridSelectionAction[]; editingActions?: AdminGridSelectionAction[]; additionalAddActions?: AdminGridAdditionalAddAction[]; onAdd: () => void; onDelete: () => void; onEditSelection?: () => void; onBulkEditSelection?: () => void; onClearSelection?: () => void; onCancelEditing?: () => void; onSave?: () => void }) {
  const showAdd = canCreate && !editorOpen && !editingExisting && deletingCount === 0;
  const canSave = editingExisting ? canUpdate : canCreate;
  if (uniformActions) return <div className="table-edit-footer employee-table-footer uniform-footer-actions">
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
      {showAdd && (additionalAddActions.length > 0 ? <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>
        {additionalAddActions.map((action) => <button type="button" key={action.key} className="secondary-button footer-action-button employee-add-button" onClick={action.onClick} disabled={action.disabled}>{action.label}</button>)}
      </div> : <button type="button" className="secondary-button footer-action-button employee-add-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>)}
      <span className="employee-total-count">{countLabel}: <strong>{count}</strong></span>
    </div>}
  </div>;
  return <div className="table-edit-footer employee-table-footer">{showAdd && <button type="button" className="secondary-button footer-action-button" onClick={onAdd} disabled={!allowMultiple && editorOpen}>{addLabel}</button>}<div>{deletingCount > 0 && <div className="selection-actions">{canUpdate && onEditSelection && <button type="button" className="save-edits-button" onClick={onEditSelection} disabled={saving}>{`${editSelectionLabel ?? "Редактировать"} (${deletingCount})`}</button>}{canUpdate && onBulkEditSelection && <button type="button" className="save-edits-button" onClick={onBulkEditSelection} disabled={saving}>{`${bulkEditSelectionLabel ?? "Массовое редактирование"} (${deletingCount})`}</button>}{selectionActions.map((action) => <button type="button" key={action.key} className={action.className ?? "save-edits-button"} onClick={action.onClick} disabled={saving || action.disabled} title={action.title}>{action.label}</button>)}{canDelete && <button type="button" className="delete-rows-button" onClick={onDelete} disabled={saving}>{`${deletingLabel} (${deletingCount})`}</button>}{onClearSelection && <button type="button" className="secondary-button footer-action-button clear-selection-button" onClick={onClearSelection} disabled={saving}>Отменить выделение</button>}</div>}{!editorOpen && deletingCount === 0 && <span>{countLabel}: <strong>{count}</strong></span>}{pendingCount > 0 && onCancelEditing && <button type="button" className="secondary-button footer-action-button" onClick={onCancelEditing} disabled={saving}>{cancelEditingLabel}</button>}{pendingCount > 0 && canSave && onSave && <button type="button" className="save-button" onClick={onSave} disabled={saving}>{saving ? "Сохраняем…" : `Сохранить (${pendingCount})`}</button>}</div></div>;
}
