export type TimesheetSaveJob<T> = {
  key: string;
  label: string;
  value: string;
  save: () => Promise<T>;
};

export type TimesheetCellSaveState = {
  state: "saving" | "saved" | "error";
  label: string;
  value: string;
  error?: string;
};

export type TimesheetSaveFailure = { key: string; label: string; value: string; error: string };
export type TimesheetBatchSaveStatus = {
  total: number;
  saved: number;
  failed: number;
  pending: number;
  failures: TimesheetSaveFailure[];
};
export type TimesheetSavedJob<T> = { job: TimesheetSaveJob<T>; value: T };
export type TimesheetSavedResult<T> = TimesheetSavedJob<T>;
export type TimesheetFailedJob<T> = { job: TimesheetSaveJob<T>; error: string };
export type TimesheetBatchSaveOutcome<T> = {
  saved: TimesheetSavedJob<T>[];
  failed: TimesheetFailedJob<T>[];
  cancelled: boolean;
};
export type TimesheetBatchSaveSnapshot = { busy: boolean; status: TimesheetBatchSaveStatus | null };
type Entry<T> = TimesheetCellSaveState & { job: TimesheetSaveJob<T> };

type TimesheetBatchSaveCallbacks<T> = {
  onSaved?: (results: TimesheetSavedJob<T>[], retry: boolean) => void;
  onStart?: () => void;
  onFinish?: () => void;
};
type TimesheetBatchSaveOptions<T> = TimesheetBatchSaveCallbacks<T> & {
  scopeKey?: string;
  concurrency?: number;
};

/** Jobs capture stable entity IDs and dates; display row positions never identify a retry. */
export function createTimesheetBatchSave<T>(options: TimesheetBatchSaveOptions<T> = {}) {
  const entries = new Map<string, Entry<T>>();
  const listeners = new Set<() => void>();
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)));
  let snapshot: TimesheetBatchSaveSnapshot = { busy: false, status: null };
  let active = true;
  let generation = 0;
  let busyOperation: object | null = null;
  let callbacks: TimesheetBatchSaveCallbacks<T> = options;

  function publish() {
    const values = [...entries.values()];
    const failures = values.filter(entry => entry.state === "error").map(entry => ({
      key: entry.job.key, label: entry.label, value: entry.value, error: entry.error ?? "Не удалось сохранить ячейку.",
    }));
    snapshot = {
      busy: busyOperation !== null,
      status: values.length ? {
        total: values.length,
        saved: values.filter(entry => entry.state === "saved").length,
        failed: failures.length,
        pending: values.filter(entry => entry.state === "saving").length,
        failures,
      } : null,
    };
    listeners.forEach(listener => listener());
  }

  async function attempt(jobs: TimesheetSaveJob<T>[], retry: boolean): Promise<TimesheetBatchSaveOutcome<T>> {
    if (busyOperation) throw new Error("Дождитесь завершения сохранения ячеек.");
    if (!active) return { saved: [], failed: [], cancelled: true };
    const uniqueJobs = [...new Map(jobs.map(job => [job.key, job])).values()];
    if (!uniqueJobs.length) return { saved: [], failed: [], cancelled: false };
    const operation = {};
    const operationGeneration = generation;
    busyOperation = operation;
    // A new paste replaces its own targets and keeps unresolved failures elsewhere.
    if (!retry) for (const [key, entry] of entries) if (entry.state !== "error") entries.delete(key);
    const targets = uniqueJobs.map(job => {
      const entry: Entry<T> = { job, label: job.label, value: job.value, state: "saving" };
      entries.set(job.key, entry);
      return entry;
    });
    const outcome: TimesheetBatchSaveOutcome<T> = { saved: [], failed: [], cancelled: false };
    const isCurrent = () => active && operationGeneration === generation && busyOperation === operation;
    let cursor = 0;
    publish();
    try {
      callbacks.onStart?.();
      async function worker() {
        while (isCurrent() && cursor < targets.length) {
          const entry = targets[cursor++];
          if (entries.get(entry.job.key) !== entry) continue;
          try {
            const value = await entry.job.save();
            if (!isCurrent() || entries.get(entry.job.key) !== entry) continue;
            entry.state = "saved";
            outcome.saved.push({ job: entry.job, value });
          } catch (error) {
            if (!isCurrent() || entries.get(entry.job.key) !== entry) continue;
            entry.state = "error";
            entry.error = error instanceof Error ? error.message : "Не удалось сохранить ячейку. Повторите попытку.";
            outcome.failed.push({ job: entry.job, error: entry.error });
          }
          if (isCurrent()) publish();
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
      outcome.cancelled = !isCurrent();
      if (!outcome.cancelled && outcome.saved.length) callbacks.onSaved?.(outcome.saved, retry);
      return outcome;
    } finally {
      // An old scope completing must not unlock a newer attempt.
      if (busyOperation === operation) {
        busyOperation = null;
        publish();
      }
      callbacks.onFinish?.();
    }
  }

  return {
    scopeKey: options.scopeKey,
    setCallbacks(next: TimesheetBatchSaveCallbacks<T>) { callbacks = next; },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getCellState(key: string): TimesheetCellSaveState | undefined {
      const entry = entries.get(key);
      return entry && { state: entry.state, label: entry.label, value: entry.value, ...(entry.error ? { error: entry.error } : {}) };
    },
    run: (jobs: TimesheetSaveJob<T>[]) => attempt(jobs, false),
    retry: () => attempt([...entries.values()].filter(entry => entry.state === "error").map(entry => entry.job), true),
    clearCell(key: string) { if (entries.delete(key)) publish(); },
    dismiss() {
      if (busyOperation || [...entries.values()].some(entry => entry.state === "error")) return;
      entries.clear();
      publish();
    },
    activate() { active = true; },
    deactivate() {
      active = false;
      generation++;
      busyOperation = null;
      entries.clear();
      publish();
    },
  };
}
