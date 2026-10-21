// A superseded read must never replace data for the newly selected project/date.
export function createLatestRequest() {
  let controller: AbortController | undefined;
  return {
    start() {
      controller?.abort();
      controller = new AbortController();
      return controller.signal;
    },
    cancel() { controller?.abort(); },
  };
}
