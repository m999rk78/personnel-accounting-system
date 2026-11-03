"use client";

import { useCallback, useEffect, useRef } from "react";
import { AccessRightsView } from "./AccessRightsView";
import { useConfirmationDialog } from "./useConfirmationDialog";
import "./usersRights.css";

export function UserPermissionsDialog({ userId, onClose, onDirtyChange, onBusyChange }: {
  userId: number; onClose: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const dirty = useRef(false), busy = useRef(false);
  const { confirm, dialog } = useConfirmationDialog();
  const handleDirty = useCallback((value: boolean) => { dirty.current = value; onDirtyChange(value); }, [onDirtyChange]);
  const handleBusy = useCallback((value: boolean) => { busy.current = value; onBusyChange(value); }, [onBusyChange]);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function close() {
    if (busy.current) return;
    if (dirty.current && !await confirm({ title: "Закрыть без сохранения?", description: "Индивидуальные права пользователя ещё не сохранены.", confirmLabel: "Закрыть без сохранения" })) return;
    onClose();
  }
  return <dialog ref={ref} className="user-permissions-dialog" aria-labelledby="user-permissions-title" onCancel={event => { event.preventDefault(); void close(); }}>
    <h2 id="user-permissions-title">Индивидуальные права</h2>
    <AccessRightsView embedded initialUserId={userId} onBack={onClose} onDirtyChange={handleDirty} onBusyChange={handleBusy} />
    {dialog}
  </dialog>;
}
