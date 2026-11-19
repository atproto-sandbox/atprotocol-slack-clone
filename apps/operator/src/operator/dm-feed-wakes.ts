import { randomBytes } from "node:crypto";
import { parseDmSpaceUri } from "@flock/protocol/keys";

// Process-local, ephemeral DM wake tracker. Zero DM rows are ever persisted to SQLite.
// Carries a 3-character boot epoch (`[a-z][0-9a-z]{2}`) so clients holding pre-restart (or legacy decimal) cursors
// receive `reset: [dmSpace]` immediately on their first poll after an operator restart, while SQLite-backed workspace
// and channel cursors continue seamlessly across restarts.

export const MAX_TRACKED_DM_SPACES = 50_000;
/** 36^4 - 1: keeps base36 sequence <= 4 chars so `<epoch>.<dbBase36>.<dmBase36>` always fits within 16 chars. */
export const MAX_DM_SEQ_PER_EPOCH = 36 ** 4 - 1;

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export type DmCursor = { epoch: string; seq: number };
export type DmWakeAnswer = {
  epoch: string;
  head: number;
  changed: Array<{ space: string; seq: number }>;
  reset: string[];
};

function generateBootEpoch(previous?: string): string {
  while (true) {
    const bytes = randomBytes(3);
    const candidate = `${ALPHA[bytes[0]! % ALPHA.length]}${BASE36[bytes[1]! % BASE36.length]}${BASE36[bytes[2]! % BASE36.length]}`;
    if (candidate !== previous) return candidate;
  }
}

let bootEpoch = generateBootEpoch();
let dmHead = 0;
let evictedFloor = 0;
const newestBySpace = new Map<string, number>();
const wakeListeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of [...wakeListeners]) listener();
}

export function onDmWake(listener: () => void): () => void {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

export function currentDmWakeHead(): { epoch: string; head: number } {
  return { epoch: bootEpoch, head: dmHead };
}

/** Records an ephemeral in-memory wake for a DM space (`dm.inbox` or `dm.conversation`). Never touches SQLite. */
export function recordDmSpaceWake(space: string): void {
  if (!parseDmSpaceUri(space)) return;
  if (dmHead >= MAX_DM_SEQ_PER_EPOCH) {
    bootEpoch = generateBootEpoch(bootEpoch);
    dmHead = 0;
    evictedFloor = 0;
    newestBySpace.clear();
  }
  dmHead += 1;
  // Maintain Map insertion order as LRU so active DM spaces stay resident when evicting past MAX_TRACKED_DM_SPACES.
  newestBySpace.delete(space);
  newestBySpace.set(space, dmHead);
  while (newestBySpace.size > MAX_TRACKED_DM_SPACES) {
    const oldest = newestBySpace.entries().next();
    if (oldest.done) break;
    const [oldestSpace, oldestSeq] = oldest.value;
    newestBySpace.delete(oldestSpace);
    if (oldestSeq > evictedFloor) evictedFloor = oldestSeq;
  }
  notifyListeners();
}

export function readDmWakes(follow: ReadonlyArray<{ space: string; cursor: DmCursor | null }>): DmWakeAnswer {
  const answer: DmWakeAnswer = { epoch: bootEpoch, head: dmHead, changed: [], reset: [] };
  for (const { space, cursor } of follow) {
    if (!cursor || cursor.epoch !== bootEpoch || cursor.seq > dmHead || cursor.seq < 0) {
      answer.reset.push(space);
      continue;
    }
    const newest = newestBySpace.get(space) ?? 0;
    if (newest > cursor.seq) {
      answer.changed.push({ space, seq: newest });
    } else if (newest === 0 && cursor.seq < evictedFloor) {
      answer.reset.push(space);
    }
  }
  return answer;
}

/** Simulates an operator process restart for unit tests (rotates `bootEpoch` and clears in-memory DM state). */
export function resetDmFeedWakesForTests(options?: { maxSpaces?: number }): void {
  void options;
  bootEpoch = generateBootEpoch(bootEpoch);
  dmHead = 0;
  evictedFloor = 0;
  newestBySpace.clear();
  notifyListeners();
}
