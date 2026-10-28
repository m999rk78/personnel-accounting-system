/** One editing session owns its draft until Enter/blur, or discards it on Escape. */
export function createCellTextEditSession(initialValue: string) {
  let finished = false;
  return {
    commit(value: string): string | undefined {
      if (finished) return undefined;
      finished = true;
      return value === initialValue ? undefined : value;
    },
    cancel() { finished = true; },
  };
}
