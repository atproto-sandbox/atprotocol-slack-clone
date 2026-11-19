import { parseDmSpaceUri } from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import { currentDmWakeHead, ensureDmWakeReady, onDmWake, readDmWakes, type DmCursor } from "./dm-feed-wakes";
import { mayFollow } from "./member-access";
import { onSpaceNotice, readNotices } from "./notices";

/** Spaces one `getChanges` call may follow. */
export const MAX_FOLLOWED_SPACES = 200;
/** How long a call waits for a change before answering that nothing changed. */
export const HOLD_MS = 25_000;
const POLL_MS = 1_000;
const MAX_CURSOR_LENGTH = 16;

const DECIMAL_CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const EPOCH_CURSOR_PATTERN = /^([a-z][0-9a-z]{2})\.(0|[1-9a-z][0-9a-z]*)\.(0|[1-9a-z][0-9a-z]*)$/;

export type Follow = {
  space: string;
  after: number;
  dmCursor?: DmCursor | null;
};

export type ChangesAnswer = {
  head: string;
  changed: Array<{ space: string; cursor: string }>;
  denied: string[];
  reset: string[];
};

export class FeedRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "FeedRequestError";
  }
}

export function formatFeedCursor(epoch: string, dbSeq: number, dmSeq: number): string {
  return `${epoch}.${dbSeq.toString(36)}.${dmSeq.toString(36)}`;
}

export function parseCursorString(raw: unknown): { after: number; dmCursor: DmCursor | null } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    throw new FeedRequestError("Each followed space needs its cursor.");
  }
  if (DECIMAL_CURSOR_PATTERN.test(raw)) {
    const num = Number(raw);
    if (!Number.isSafeInteger(num)) {
      throw new FeedRequestError("Each followed space needs its cursor.");
    }
    return { after: num, dmCursor: null };
  }
  const match = EPOCH_CURSOR_PATTERN.exec(raw);
  if (!match) {
    throw new FeedRequestError("Each followed space needs its cursor.");
  }
  const [, epoch, dbPart, dmPart] = match;
  const dbAfter = Number.parseInt(dbPart!, 36);
  const dmSeq = Number.parseInt(dmPart!, 36);
  if (!Number.isSafeInteger(dbAfter) || !Number.isSafeInteger(dmSeq)) {
    throw new FeedRequestError("Each followed space needs its cursor.");
  }
  return { after: dbAfter, dmCursor: { epoch: epoch!, seq: dmSeq } };
}

/** The `follow` list of a `getChanges` call: at most 200 entries, each a space and the cursor it was last synced at. */
export function parseFollow(input: unknown): Follow[] {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some((key) => key !== "follow")) {
    throw new FeedRequestError("The request takes exactly one field, follow.");
  }
  const { follow } = input as { follow?: unknown };
  if (!Array.isArray(follow)) throw new FeedRequestError("follow must be a list of spaces with their cursors.");
  if (follow.length > MAX_FOLLOWED_SPACES) throw new FeedRequestError(`At most ${MAX_FOLLOWED_SPACES} spaces can be followed in one call.`);
  const seen = new Set<string>();
  return follow.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new FeedRequestError("Each followed space is an object.");
    const { space, after } = entry as { space?: unknown; after?: unknown };
    if (typeof space !== "string" || !space.startsWith("at://") || space.length > 512) throw new FeedRequestError("Each followed space needs its URI.");
    const parsed = parseCursorString(after);
    if (seen.has(space)) throw new FeedRequestError("Each space is followed once per call.");
    seen.add(space);
    return { space, after: parsed.after, dmCursor: parsed.dmCursor };
  });
}

export type FeedDeps = {
  mayFollow(space: string, did: string): Promise<boolean>;
  holdMs: number;
};

const defaultDeps: FeedDeps = { mayFollow: (space, did) => mayFollow(space, did), holdMs: HOLD_MS };

type EvaluatedFeed = {
  head: string;
  changed: Array<{ space: string; cursor: string }>;
  reset: string[];
};

function evaluateFeed(did: string, allowed: readonly Follow[]): EvaluatedFeed {
  const nonDm: Array<{ space: string; after: number }> = [];
  const dm: Array<{ space: string; cursor: DmCursor | null }> = [];
  for (const entry of allowed) {
    if (parseDmSpaceUri(entry.space)) {
      dm.push({ space: entry.space, cursor: entry.dmCursor ?? null });
    } else {
      nonDm.push({ space: entry.space, after: entry.after });
    }
  }
  const notices = readNotices(nonDm);
  const dmWakes = readDmWakes(did, dm);
  const head = formatFeedCursor(dmWakes.epoch, notices.head, dmWakes.head);

  const changedBySpace = new Map<string, string>();
  for (const item of notices.changed) {
    changedBySpace.set(item.space, formatFeedCursor(dmWakes.epoch, item.cursor, dmWakes.head));
  }
  for (const item of dmWakes.changed) {
    changedBySpace.set(item.space, formatFeedCursor(dmWakes.epoch, notices.head, item.seq));
  }
  const resetSet = new Set<string>([...notices.reset, ...dmWakes.reset]);

  const changed: Array<{ space: string; cursor: string }> = [];
  const reset: string[] = [];
  for (const entry of allowed) {
    if (resetSet.has(entry.space)) {
      reset.push(entry.space);
    } else if (changedBySpace.has(entry.space)) {
      changed.push({ space: entry.space, cursor: changedBySpace.get(entry.space)! });
    }
  }
  return { head, changed, reset };
}

function currentCombinedHead(did: string): string {
  const dbHead = readNotices([]).head;
  const dm = currentDmWakeHead(did);
  return formatFeedCursor(dm.epoch, dbHead, dm.head);
}

/**
 * Which followed spaces changed, waiting up to `holdMs` for one to. A space the caller may not follow is denied and the
 * rest are answered. Who may follow is decided again for the spaces about to be answered, so a member removed while the call
 * waited is denied, not told the space changed.
 */
export async function getChanges(did: string, follow: readonly Follow[], signal?: AbortSignal, deps: FeedDeps = defaultDeps): Promise<ChangesAnswer> {
  await ensureDmWakeReady();
  if (follow.length === 0) return { head: currentCombinedHead(did), changed: [], denied: [], reset: [] };
  const denied = new Set(await deniedSpaces(did, follow.map((entry) => entry.space), deps));
  const allowed = follow.filter((entry) => !denied.has(entry.space));
  // With nothing left to follow there is nothing to wait for.
  if (allowed.length === 0) return { head: currentCombinedHead(did), changed: [], denied: [...denied], reset: [] };
  const deadline = Date.now() + deps.holdMs;
  let evaluated = evaluateFeed(did, allowed);
  const hasPendingResult = () => {
    const current = evaluateFeed(did, allowed);
    return current.changed.length > 0 || current.reset.length > 0;
  };
  while (evaluated.changed.length === 0 && evaluated.reset.length === 0 && Date.now() < deadline && !signal?.aborted) {
    await poller.nextChange(did, evaluated.head, deadline - Date.now(), signal, hasPendingResult);
    evaluated = evaluateFeed(did, allowed);
  }
  const answered = [...evaluated.changed.map((change) => change.space), ...evaluated.reset];
  for (const space of await deniedSpaces(did, answered, deps)) denied.add(space);
  return {
    head: evaluated.head,
    changed: evaluated.changed.filter((change) => !denied.has(change.space)),
    denied: [...denied],
    reset: evaluated.reset.filter((space) => !denied.has(space)),
  };
}

async function deniedSpaces(did: string, spaces: readonly string[], deps: FeedDeps): Promise<string[]> {
  const distinct = [...new Set(spaces)];
  const allowed = await mapLimited(distinct, 8, (space) => deps.mayFollow(space, did));
  return distinct.filter((_, index) => !allowed[index]);
}

/**
 * One poller per process for every waiting call: wakes immediately on in-process workspace or host-local IPC DM wakes
 * (scoped to `did` for DM wakes) and also polls SQLite once a second while anyone waits so workspace notices written by
 * another process still wake waiters promptly.
 */
class NoticePoller {
  private readonly waiting = new Map<() => void, { did: string; seenHead: string; hasPendingResult?: () => boolean }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubSpace: (() => void) | undefined;
  private unsubDm: (() => void) | undefined;

  /** Resolves once the caller's combined head is no longer `seenHead`, a reset/change is ready, after `withinMs`, or when `signal` aborts. */
  nextChange(
    did: string,
    seenHead: string,
    withinMs: number,
    signal?: AbortSignal,
    hasPendingResult?: () => boolean,
  ): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", done);
        this.waiting.delete(done);
        if (this.waiting.size === 0) this.stop();
        resolve();
      };
      const timeout = setTimeout(done, Math.max(0, withinMs));
      signal?.addEventListener("abort", done, { once: true });
      this.waiting.set(done, { did, seenHead, hasPendingResult });
      if (!this.timer) {
        this.timer = setInterval(() => this.wake(), POLL_MS);
        this.timer.unref?.();
        this.unsubSpace = onSpaceNotice(() => this.wake());
        this.unsubDm = onDmWake((changedDid) => this.wake(changedDid, true));
      }
      // A notice or eviction that landed after the waiter read its spaces, and before it was registered here, still wakes it.
      this.wake(did, true);
    });
  }

  private wake(changedDid?: string, checkPendingResult = false): void {
    for (const [done, waiter] of [...this.waiting]) {
      if (changedDid !== undefined && waiter.did !== changedDid) continue;
      let head: string;
      let ready = false;
      try {
        head = currentCombinedHead(waiter.did);
        if (head === waiter.seenHead && checkPendingResult && waiter.hasPendingResult) {
          ready = waiter.hasPendingResult();
        }
      } catch {
        // The notices cannot be read (the database is closing): every waiter reads them itself and meets the error there.
        for (const allDone of [...this.waiting.keys()]) allDone();
        return;
      }
      if (head !== waiter.seenHead || ready) done();
    }
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubSpace?.();
    this.unsubSpace = undefined;
    this.unsubDm?.();
    this.unsubDm = undefined;
  }
}

const poller = new NoticePoller();
