"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MaintenanceView } from "./MaintenanceView";
import { createMaintenanceClient, MAINTENANCE_READY_EVENT, type MaintenanceSnapshot } from "./maintenanceClient";

export function MaintenanceBoundary({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MaintenanceSnapshot>({ kind: null, checking: false });
  const client = useRef<ReturnType<typeof createMaintenanceClient> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const controller = createMaintenanceClient({
      request: (input, init) => originalFetch.call(window, input, init),
      origin: window.location.origin,
      onChange: setState,
      onReady: () => window.dispatchEvent(new Event(MAINTENANCE_READY_EVENT)),
    });
    client.current = controller;
    window.fetch = controller.fetch;
    const probe = () => { if (document.visibilityState !== "hidden") void controller.check(); };
    const offline = () => controller.unavailable();
    const timer = window.setInterval(probe, 5000);
    window.addEventListener("focus", probe);
    window.addEventListener("online", probe);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", probe);
    void controller.check();
    return () => {
      controller.stop();
      window.clearInterval(timer);
      window.removeEventListener("focus", probe);
      window.removeEventListener("online", probe);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", probe);
      if (window.fetch === controller.fetch) window.fetch = originalFetch;
      if (client.current === controller) client.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (state.kind && !element.open) element.showModal();
    else if (!state.kind && element.open) element.close();
  }, [state.kind]);

  return <>
    {children}
    <dialog ref={dialog} className="maintenance-dialog" aria-label="Технические работы" aria-modal="true"
      onCancel={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()}>
      {state.kind && <MaintenanceView kind={state.kind} checking={state.checking} onRetry={() => void client.current?.check()} />}
    </dialog>
  </>;
}
