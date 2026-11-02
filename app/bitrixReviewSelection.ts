export type BitrixReviewDifference = {
  kind: string;
  employeeName: string;
  localEmployeeId?: number;
  bitrix24Id?: string;
  acknowledged?: boolean;
};

export function bitrixReviewUpdateIds(result: { differences: readonly BitrixReviewDifference[]; updatableEmployeeIds?: readonly number[] }): number[] {
  // The server supplies IDs for the whole inspection, not only its 100-row preview.
  const ids = result.updatableEmployeeIds ?? result.differences.flatMap(item =>
    item.kind === "changed" && !item.acknowledged && item.bitrix24Id && item.localEmployeeId ? [item.localEmployeeId] : []);
  return [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))];
}

export function bitrixReviewUpdateBatches(employeeIds: readonly number[]): number[][] {
  const ids = [...new Set(employeeIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  const batches: number[][] = [];
  for (let offset = 0; offset < ids.length; offset += 200) batches.push(ids.slice(offset, offset + 200));
  return batches;
}
