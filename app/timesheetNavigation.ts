type TimesheetCellCoordinates = { rowIndex: number; columnIndex: number };

/** Losing clipboard selection outside the table must not discard an input buffer. */
export function timesheetEditorCellChanged(editor: TimesheetCellCoordinates, activeCell: TimesheetCellCoordinates | null): boolean {
  return activeCell !== null && (activeCell.rowIndex !== editor.rowIndex || activeCell.columnIndex !== editor.columnIndex);
}

export async function requestTimesheetMonthChange({ currentMonth, nextMonth, busy, hasPendingEditor, confirmDiscard, commit }: {
  currentMonth: string;
  nextMonth: string;
  busy: boolean;
  hasPendingEditor: boolean;
  confirmDiscard: () => Promise<boolean>;
  commit: (month: string) => void;
}): Promise<boolean> {
  if (busy || nextMonth === currentMonth) return false;
  if (hasPendingEditor && !await confirmDiscard()) return false;
  commit(nextMonth);
  return true;
}
