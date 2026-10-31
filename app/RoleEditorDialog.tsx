"use client";

import { useEffect, useRef, useState } from "react";
import { PermissionMatrix } from "./PermissionMatrix";
import { emptyPermissionSet, normalizePermissionSet, permissionSetsEqual, rolePermissionTemplate, type PermissionAction, type PermissionResource, type PermissionSet } from "./permissionModel";
import type { CustomRole } from "./customRoles";
import "./customRoles.css";

export function RoleEditorDialog({ onClose, onCreated, previewRole }: {
  onClose: () => void;
  onCreated: (role: CustomRole) => void;
  previewRole?: CustomRole;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(previewRole?.name ?? "");
  const [permissions, setPermissions] = useState<PermissionSet>(() => normalizePermissionSet(previewRole?.permissions ?? emptyPermissionSet()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const readOnly = Boolean(previewRole);
  const dirty = !readOnly && (name.length > 0 || !permissionSetsEqual(permissions, emptyPermissionSet()));

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => { dialog?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  function requestClose() {
    if (saving || dirty && !window.confirm("Роль ещё не сохранена. Закрыть окно и отменить изменения?")) return;
    onClose();
  }

  function patchPermission(resource: PermissionResource, action: PermissionAction, enabled: boolean) {
    setPermissions(current => {
      const next = normalizePermissionSet(current);
      next[resource][action] = enabled;
      if (action !== "view" && enabled) next[resource].view = true;
      if (action === "view" && !enabled) next[resource] = { view: false, create: false, update: false, delete: false };
      return normalizePermissionSet(next);
    });
    setError("");
  }

  async function save() {
    if (saving || readOnly || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/roles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), permissions }) });
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
  return <dialog ref={dialogRef} className="role-editor-dialog" aria-labelledby="role-editor-title" aria-describedby="role-editor-description" onCancel={event => { event.preventDefault(); requestClose(); }} onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <header className="role-editor-heading">
        <div><h2 id="role-editor-title">{readOnly ? previewRole?.name : "Добавить роль"}</h2><p id="role-editor-description">{readOnly ? "Разрешения этой роли. Назначить её можно в настройках пользователя." : "Укажите название и отметьте, что смогут делать пользователи с этой ролью."}</p></div>
        <button type="button" className="role-editor-close" aria-label="Закрыть окно роли" disabled={saving} onClick={requestClose}>×</button>
      </header>
      <div className="role-editor-body">
        {!readOnly && <label className="role-editor-name"><span>Название роли</span><input ref={nameRef} value={name} onChange={event => { setName(event.target.value); setError(""); }} maxLength={80} required disabled={saving} placeholder="Например, Руководитель проекта" autoComplete="off" /></label>}
        <div className="role-editor-tools"><p>Доступ к проектам настраивается отдельно у каждого пользователя.</p>{!readOnly && <div><button type="button" disabled={saving} onClick={() => { setPermissions(rolePermissionTemplate("viewer")); setError(""); }}>Только просмотр</button><button type="button" disabled={saving} onClick={() => { setPermissions(emptyPermissionSet()); setError(""); }}>Сбросить права</button></div>}</div>
        {(permissions.workers_report.update || permissions.equipment_report.update) && <p className="role-editor-review-hint">Редактирование отчётов также позволяет проверять и подтверждать отчёты пользователей в доступных проектах.</p>}
        {error && <div className="role-editor-error" role="alert">{error}</div>}
        <PermissionMatrix label={readOnly ? `Права роли: ${previewRole?.name}` : "Права новой роли"} value={permissions} disabled={saving || readOnly} onChange={readOnly ? undefined : patchPermission} />
      </div>
      <footer className="role-editor-footer"><span>{readOnly ? "Изменения пользователей не затрагивают шаблон роли." : "После сохранения роль появится в списке ролей пользователей."}</span><div><button type="button" className="back-button" disabled={saving} onClick={requestClose}>{readOnly ? "Закрыть" : "Отмена"}</button>{!readOnly && <button type="submit" className="primary-button" disabled={saving || !name.trim()}>{saving ? "Сохраняем…" : "Сохранить роль"}</button>}</div></footer>
    </form>
  </dialog>;
}
