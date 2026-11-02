type PageWindow = Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout">;
type PageDocument = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;

/** Coalesce page-return events and wait for the user's current edit to finish. */
export function createIdlePageRefresh({ pageWindow, pageDocument, isBusy, refresh }: {
  pageWindow: PageWindow;
  pageDocument: PageDocument;
  isBusy: () => boolean;
  refresh: () => Promise<void>;
}) {
  let pending = false;
  let active = false;
  let disposed = false;
  let wasHidden = pageDocument.visibilityState === "hidden";
  let timer: number | undefined;
  const visible = () => pageDocument.visibilityState !== "hidden";
  const flush = () => {
    if (disposed || !pending || active || timer !== undefined || !visible() || isBusy()) return;
    timer = pageWindow.setTimeout(() => {
      timer = undefined;
      if (disposed || !pending || active || !visible() || isBusy()) return;
      pending = false;
      active = true;
      // The caller handles errors. Always release the slot, including a thrown
      // callback, so a later return to the page can try again.
      void Promise.resolve().then(refresh).catch(() => {}).finally(() => {
        active = false;
        flush();
      });
    }, 0);
  };
  const request = () => { if (!disposed) { pending = true; flush(); } };
  const focus = () => { if (visible() && !active) request(); };
  const visibility = () => {
    if (!visible()) { wasHidden = true; return; }
    // A real hide/return during an outstanding GET needs a fresh snapshot;
    // the second focus event from the same return does not.
    if (wasHidden) { wasHidden = false; request(); }
    else focus();
  };
  pageWindow.addEventListener("focus", focus);
  pageDocument.addEventListener("visibilitychange", visibility);
  return {
    request,
    flush,
    dispose() {
      disposed = true;
      if (timer !== undefined) pageWindow.clearTimeout(timer);
      pageWindow.removeEventListener("focus", focus);
      pageDocument.removeEventListener("visibilitychange", visibility);
    },
  };
}
