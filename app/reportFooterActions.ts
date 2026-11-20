type ReportFooterRow = { rowKey: string; proposalId?: number; draftGroupKey?: string };

/** Save the reports shown in this view; keep edits in other tabs untouched. */
export function reportFooterSaveScope(rows: readonly ReportFooterRow[], editedKeys: Iterable<string>, pendingRowKey?: string | null) {
  const owners = new Set(rows.flatMap(row => {
    const key = row.proposalId ? String(row.proposalId) : row.draftGroupKey;
    return key ? [key] : [];
  }));
  const saveKeys = [...new Set(editedKeys)].filter(key => owners.has(key));
  return { saveKeys, hasChanges: saveKeys.length > 0 || Boolean(pendingRowKey && rows.some(row => row.rowKey === pendingRowKey)) };
}
