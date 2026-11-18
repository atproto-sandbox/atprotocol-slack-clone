import assert from "node:assert/strict";
import test from "node:test";
import { advanceRenotifyState, DM_RENOTIFY_BACKOFF_MS, isRenotifyDue } from "./backoff";

test("the schedule is 1 minute, 10 minutes, 1 hour, then 1 day", () => {
  assert.deepEqual(DM_RENOTIFY_BACKOFF_MS, [60_000, 600_000, 3_600_000, 86_400_000]);
});

test("isRenotifyDue waits out each interval before firing", () => {
  const sentAt = 1_000_000;
  const state = { attempts: 0, lastAttemptAt: sentAt };
  assert.equal(isRenotifyDue(state, sentAt), false);
  assert.equal(isRenotifyDue(state, sentAt + 59_999), false);
  assert.equal(isRenotifyDue(state, sentAt + 60_000), true);
});

test("advanceRenotifyState moves to the next interval anchored at the retry time", () => {
  const first = { attempts: 0, lastAttemptAt: 0 };
  const retriedAt = 60_000;
  const second = advanceRenotifyState(first, retriedAt);
  assert.deepEqual(second, { attempts: 1, lastAttemptAt: retriedAt });
  assert.equal(isRenotifyDue(second, retriedAt + 599_999), false);
  assert.equal(isRenotifyDue(second, retriedAt + 600_000), true);
});

test("the schedule stops after the last interval: no fifth attempt", () => {
  let state = { attempts: 0, lastAttemptAt: 0 };
  for (let attempt = 0; attempt < DM_RENOTIFY_BACKOFF_MS.length; attempt += 1) {
    state = advanceRenotifyState(state, state.lastAttemptAt + DM_RENOTIFY_BACKOFF_MS[attempt]!);
  }
  assert.equal(state.attempts, DM_RENOTIFY_BACKOFF_MS.length);
  assert.equal(isRenotifyDue(state, Number.MAX_SAFE_INTEGER), false, "the backoff schedule stops retrying forever once exhausted");
});
