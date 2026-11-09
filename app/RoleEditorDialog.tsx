"use client";

import { useEffect, useRef, useState } from "react";
import { PermissionMatrix } from "./PermissionMatrix";
import { emptyPermissionSet, normalizePermissionSet, patchPermissionSet, permissionSetsEqual, rolePermissionTemplate, type PermissionAction, type PermissionResource, type PermissionSet } from "./permissionModel";
import type { CustomRole } from "./customRoles";
import { useConfirmationDialog } from "./useConfirmationDialog";
import "./customRoles.css";

export function RoleEditorDialog({ onClose, onCreated, previewRole, editable = false }: {
  onClose: () => void;
  onCreated: (role: CustomRole) => void;
  previewRole?: CustomRole;
  editable?: boolean;
}) {
  const { confirm, dialog: confirmationDialog } = useConfirmationDialog();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(previewRole?.name ?? "");
  const [permissions, setPermissions] = useState<PermissionSet>(() => normalizePermissionSet(previewRole?.permissions ?? emptyPermissionSet()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const readOnly = Boolean(previewRole) && !editable;
  const dirty = !readOnly && (name !== (previewRole?.name ?? "") || !permissionSetsEqual(permissions, previewRole?.permissions ?? emptyPermissionSet()));

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    nameRef.current?.focus({ preventScroll: true });
    return () => { dialog?.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  async function requestClose() {
    if (saving || dirty && !await confirm({ title: "Закрыть без сохранения?", description: "Роль ещё не сохранена. Если закрыть окно, название и выбранные права будут потеряны.", confirmLabel: "Закрыть без сохранения", cancelLabel: "Продолжить настройку" })) return;
    onClose();
  }

  function patchPermission(resource: PermissionResource, action: PermissionAction, enabled: boolean) {
    setPermissions(current => patchPermissionSet(current, resource, action, enabled));
    setError("");
  }

  async function save() {
    if (saving || readOnly || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/roles", { method: previewRole ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(previewRole ? { roleId: previewRole.id, revision: previewRole.revision } : {}), name: name.trim(), permissions }) });
      const payload = await response.json() as { role?: CustomRole; error?: string };
      if (!response.ok || !payload.role) throw new Error(payload.error ?? "Не удалось сохранить роль.");
      onCreated(payload.role);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить роль.");
      setSaving(false);
    }
  }

  // The native modal provides keyboard focus/cancel; pointer dismissal only handles its backdrop.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <dialog ref={dialogRef} className="role-editor-dialog" aria-labelledby="role-editor-title" onCancel={event => { event.preventDefault(); requestClose(); }} onMouseDown={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void requestClose(); } }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <header className="role-editor-heading">
        <div><h2 id="role-editor-title">{readOnly ? previewRole?.name : previewRole ? "Редактировать роль" : "Добавить роль"}</h2></div>
        <button type="button" className="role-editor-close" aria-label="Закрыть окно роли" disabled={saving} onClick={requestClose}>×</button>
      </header>
      {error && <div className="role-editor-error" role="alert">{error}</div>}
      <div className="role-editor-body">
        {!readOnly && <label className="role-editor-name"><span>Название роли</span><input ref={nameRef} value={name} onChange={event => { setName(event.target.value); setError(""); }} maxLength={80} required disabled={saving} placeholder="Например, Руководитель проекта" autoComplete="off" /></label>}
        {!readOnly && <div className="role-editor-tools"><div><button type="button" disabled={saving} onClick={() => { setPermissions(rolePermissionTemplate("viewer")); setError(""); }}>Только просмотр</button><button type="button" disabled={saving} onClick={() => { setPermissions(rolePermissionTemplate("superadmin")); setError(""); }}>Полный доступ</button><button type="button" disabled={saving} onClick={() => { setPermissions(emptyPermissionSet()); setError(""); }}>Сбросить права</button></div></div>}
        {editable && previewRole && <p className="role-editor-review-hint">Обновится шаблон роли. Индивидуальные настройки пользователей сохранятся.</p>}
        <PermissionMatrix compact label={previewRole ? `Права роли: ${previewRole.name}` : "Права новой роли"} value={permissions} disabled={saving || readOnly} onChange={readOnly ? undefined : patchPermission} />
      </div>
      <footer className="role-editor-footer"><span>{readOnly ? "Только просмотр" : dirty ? "Не сохранено" : ""}</span><div><button type="button" className="back-button" disabled={saving} onClick={requestClose}>{readOnly ? "Закрыть" : "Отмена"}</button>{!readOnly && <button type="submit" className="primary-button" disabled={saving || !name.trim() || Boolean(previewRole && !dirty)}>{saving ? "Сохраняем…" : "Сохранить роль"}</button>}</div></footer>
    </form>
    {confirmationDialog}
  </dialog>;
}
