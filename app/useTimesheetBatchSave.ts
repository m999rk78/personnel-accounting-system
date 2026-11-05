"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createTimesheetBatchSave, type TimesheetSavedJob } from "./timesheetBatchSave";

export function useTimesheetBatchSave<T>({ scopeKey, onSaved, onStart, onFinish }: {
  scopeKey: string;
  onSaved: (results: TimesheetSavedJob<T>[], retry: boolean) => void;
  onStart?: () => void;
  onFinish?: () => void;
}) {
  const controller = useMemo(() => createTimesheetBatchSave<T>({ scopeKey }), [scopeKey]);
  useLayoutEffect(() => { controller.setCallbacks({ onSaved, onStart, onFinish }); });
  useLayoutEffect(() => {
    controller.activate();
    return () => controller.deactivate();
  }, [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return {
    ...controller,
    ...snapshot,
    hasFailures: Boolean(snapshot.status?.failed),
  };
}
