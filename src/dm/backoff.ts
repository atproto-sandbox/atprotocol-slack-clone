/** §3.3 step 7: re-notify a pending DM request on this schedule, then stop. */
export const DM_RENOTIFY_BACKOFF_MS: readonly number[] = [
  60_000, // 1 minute
  10 * 60_000, // 10 minutes
  60 * 60_000, // 1 hour
  24 * 60 * 60_000, // 1 day
];

export type DmRenotifyState = { attempts: number; lastAttemptAt: number };

/** True once `DM_RENOTIFY_BACKOFF_MS[attempts]` has elapsed since the last attempt. False forever past the last scheduled attempt. */
export function isRenotifyDue(state: DmRenotifyState, now: number): boolean {
  if (state.attempts >= DM_RENOTIFY_BACKOFF_MS.length) return false;
  return now >= state.lastAttemptAt + DM_RENOTIFY_BACKOFF_MS[state.attempts]!;
}

export function advanceRenotifyState(state: DmRenotifyState, now: number): DmRenotifyState {
  return { attempts: state.attempts + 1, lastAttemptAt: now };
}
