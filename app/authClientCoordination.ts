export const AUTH_MUTATION_START_EVENT = "personnel-auth-mutation-start";
export const AUTH_MUTATION_END_EVENT = "personnel-auth-mutation-end";

let activeMutations = 0;

export function isAuthMutationInProgress() {
  return activeMutations > 0;
}

/** Cancel this window's status requests before a mutation changes its session cookie. */
export function beginAuthMutation() {
  activeMutations++;
  if (activeMutations === 1 && typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_MUTATION_START_EVENT));
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeMutations--;
    if (!activeMutations && typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_MUTATION_END_EVENT));
  };
}
