import { mapLimited } from "@/lib/map-limited";
import { mayFollow } from "./member-access";
import { readNotices } from "./notices";

/** Spaces one `getChanges` call may follow. */
export const MAX_FOLLOWED_SPACES = 200;
/** How long a call waits for a change before answering that nothing changed. */
export const HOLD_MS = 25_000;
const POLL_MS = 1_000;
const MAX_CURSOR_DIGITS = 16;


export type Follow = { space: string; after: number };
export type ChangesAnswer = { head: string; changed: Array<{ space: string; cursor: string }>; denied: string[]; reset: string[] };

export class FeedRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "FeedRequestError";
  }
}

/** The `follow` list of a `getChanges` call: at most 200 entries, each a space and the decimal cursor it was last synced at. */
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
    if (typeof after !== "string" || !/^(0|[1-9][0-9]*)$/.test(after) || after.length > MAX_CURSOR_DIGITS || !Number.isSafeInteger(Number(after))) {
      throw new FeedRequestError("Each followed space needs its cursor, a whole number written in decimal.");
    }
    if (seen.has(space)) throw new FeedRequestError("Each space is followed once per call.");
    seen.add(space);
    return { space, after: Number(after) };
  });
}

export type FeedDeps = {
  mayFollow(space: string, did: string): Promise<boolean>;
  holdMs: number;
};

const defaultDeps: FeedDeps = { mayFollow: (space, did) => mayFollow(space, did), holdMs: HOLD_MS };

/**
 * Which followed spaces changed, waiting up to `holdMs` for one to. A space the caller may not follow is denied and the
 * rest are answered. Who may follow is decided again for the spaces about to be answered, so a member removed while the call
 * waited is denied, not told the space changed.
 */
export async function getChanges(did: string, follow: readonly Follow[], signal?: AbortSignal, deps: FeedDeps = defaultDeps): Promise<ChangesAnswer> {
  if (follow.length === 0) return answer(readNotices([]).head, [], [], []);
  const denied = new Set(await deniedSpaces(did, follow.map((entry) => entry.space), deps));
  const allowed = follow.filter((entry) => !denied.has(entry.space));
  // With nothing left to follow there is nothing to wait for.
  if (allowed.length === 0) return answer(readNotices([]).head, [], [...denied], []);
  const deadline = Date.now() + deps.holdMs;
  let notices = readNotices(allowed);
  while (notices.changed.length === 0 && notices.reset.length === 0 && Date.now() < deadline && !signal?.aborted) {
    await poller.nextChange(notices.head, deadline - Date.now(), signal);
    notices = readNotices(allowed);
  }
  const answered = [...notices.changed.map((change) => change.space), ...notices.reset];
  for (const space of await deniedSpaces(did, answered, deps)) denied.add(space);
  return answer(
    notices.head,
    notices.changed.filter((change) => !denied.has(change.space)).map((change) => ({ space: change.space, cursor: change.cursor })),
    [...denied],
    notices.reset.filter((space) => !denied.has(space)),
  );
}

async function deniedSpaces(did: string, spaces: readonly string[], deps: FeedDeps): Promise<string[]> {
  const distinct = [...new Set(spaces)];
  const allowed = await mapLimited(distinct, 8, (space) => deps.mayFollow(space, did));
  return distinct.filter((_, index) => !allowed[index]);
}

function answer(head: number, changed: Array<{ space: string; cursor: number }>, denied: string[], reset: string[]): ChangesAnswer {
  return { head: String(head), changed: changed.map((change) => ({ space: change.space, cursor: String(change.cursor) })), denied, reset };
}

/**
 * One poller per process for every waiting call: it reads the newest notice id once a second while anyone waits, and wakes
 * each waiter once the id has moved past the one it last saw.
 */
class NoticePoller {
  private readonly waiting = new Map<() => void, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Resolves once the newest notice id is no longer `seenHead`, after `withinMs`, or when `signal` aborts. */
  nextChange(seenHead: number, withinMs: number, signal?: AbortSignal): Promise<void> {
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
      this.waiting.set(done, seenHead);
      this.timer ??= setInterval(() => this.wake(), POLL_MS);
      // A notice that landed after the waiter read its spaces, and before it was registered here, still wakes it.
      this.wake();
    });
  }

  private wake(): void {
    let head: number;
    try {
      head = readNotices([]).head;
    } catch {
      // The notices cannot be read (the database is closing): every waiter reads them itself and meets the error there.
      for (const done of [...this.waiting.keys()]) done();
      return;
    }
    for (const [done, seenHead] of [...this.waiting]) if (head !== seenHead) done();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

const poller = new NoticePoller();
