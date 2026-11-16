import { tidNow } from "@flock/protocol/keys";
import { encodeCursor } from "./merge";
import type { SetAside } from "./sync";

// The window over writer-chosen TID keys, shared by channel messages and app-inbox records (commands and actions).
// A record is new when its key is at or above `lower` and at most `now + CLOCK_SLACK_MS`, and its URI is not in `taken`.

/** How many pages back a burst of new records is followed before the older ones are reported, not given. */
export const MAX_PAGES_BACK = 5;
/** How many times a record the app keeps failing on is given before it is reported as given up. */
export const MAX_ATTEMPTS = 3;
/** How far a writer's clock may stray from the app's, either way, for its record to be given when it arrives. */
export const CLOCK_SLACK_MS = 5_000;
/** How long a read without some writer (or a failed attempt) holds the window's lower edge before moving on. */
export const MAX_HOLD_MS = 10 * 60_000;

export type WindowClock = { now(): number; elapsed(): number };

export type WindowItem = { uri: string; repo: string; rkey: string };

export type WindowPage<T extends WindowItem> = {
  items: T[];
  next?: string;
  complete: boolean;
  setAside: SetAside[];
};

type SpaceWindowState = {
  lower: string;
  /** The wall-clock time the lower edge was last moved to, and the monotonic time it was moved at. */
  basisMs: number;
  basisElapsed: number;
  taken: Map<string, string>;
  attempts: Map<string, { rkey: string; count: number; since: number }>;
  heldSince?: number;
  capReported?: boolean;
};

export type WindowLabels = {
  /** Plural noun for what is read (`"messages"` or `"records"`). */
  items: string;
  /** Noun for the space (`"channel"` or `"inbox"`). */
  space: string;
};

export class KeyWindow {
  private readonly states = new Map<string, SpaceWindowState>();
  private readonly reportedAside = new Map<string, Set<string>>();

  constructor(
    private readonly clock: WindowClock,
    private readonly onError: (error: unknown) => void,
  ) {}

  delete(space: string): void {
    this.states.delete(space);
    this.reportedAside.delete(space);
  }

  /**
   * Reads `streams` in `space` from `now + CLOCK_SLACK_MS` down to the space's lower edge (at most `MAX_PAGES_BACK` pages per
   * stream). When `deliver` is false (the initial read as a space is followed), what is already in the window is noted as taken
   * without calling `prepare`. When `deliver` is true, `prepare` may refresh state and return the per-item handler, or `null`
   * if the space's grant ended meanwhile.
   */
  async read<T extends WindowItem>(input: {
    space: string;
    deliver: boolean;
    labels: WindowLabels;
    streams: ReadonlyArray<(options: { before: string }) => Promise<WindowPage<T>>>;
    prepare: (fresh: readonly T[]) => Promise<((item: T) => Promise<void>) | null>;
  }): Promise<void> {
    const now = this.clock.now();
    const elapsed = this.clock.elapsed();
    const state: SpaceWindowState = this.states.get(input.space) ?? {
      lower: tidNow(now - CLOCK_SLACK_MS, 0),
      basisMs: now - CLOCK_SLACK_MS,
      basisElapsed: elapsed,
      taken: new Map(),
      attempts: new Map(),
    };
    const fresh: T[] = [];
    const passing = new Set<string>();
    const permanentByDid = new Map<string, SetAside>();
    let complete = true;
    let capped = false;
    const upper = encodeCursor({ key: tidNow(now + CLOCK_SLACK_MS, 1023), uri: "~" });

    for (const stream of input.streams) {
      let page = await stream({ before: upper });
      for (let pages = 1; ; pages += 1) {
        complete &&= page.complete;
        for (const aside of page.setAside) {
          if (aside.permanent) permanentByDid.set(aside.did, aside);
          else passing.add(aside.did);
        }
        fresh.push(...page.items.filter((item) => item.rkey >= state.lower && !state.taken.has(item.uri)));
        if (!page.next || page.items.some((item) => item.rkey < state.lower)) break;
        if (pages >= MAX_PAGES_BACK) {
          capped = true;
          break;
        }
        page = await stream({ before: page.next });
      }
    }
    complete &&= passing.size === 0;
    fresh.sort((left, right) => left.rkey.localeCompare(right.rkey) || (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0));

    let handler: ((item: T) => Promise<void>) | null = null;
    if (input.deliver) {
      handler = await input.prepare(fresh);
      if (!handler) return;
      this.reportRead(input.space, state, input.labels, {
        complete,
        passing: passing.size,
        permanent: [...permanentByDid.values()],
        capped,
      });
    }

    for (const item of fresh) {
      if (handler) {
        try {
          await handler(item);
        } catch (error) {
          this.onError(error);
          const attempt = state.attempts.get(item.uri) ?? { rkey: item.rkey, count: 0, since: elapsed };
          attempt.count += 1;
          if (attempt.count < MAX_ATTEMPTS) {
            state.attempts.set(item.uri, attempt);
            continue;
          }
          this.onError(new Error(`The app failed on ${item.uri} ${attempt.count} times; it is not given again.`));
        }
      }
      state.attempts.delete(item.uri);
      state.taken.set(item.uri, item.rkey);
    }

    for (const [uri, attempt] of state.attempts) {
      if (elapsed - attempt.since <= MAX_HOLD_MS) continue;
      state.attempts.delete(uri);
      this.onError(new Error(`The app failed on ${uri} and it has not been read again for ${MAX_HOLD_MS / 60_000} minutes; it is not given again.`));
    }
    state.heldSince = complete ? undefined : state.heldSince ?? elapsed;
    if (state.heldSince !== undefined && elapsed - state.heldSince > MAX_HOLD_MS) {
      this.onError(new Error(`${input.space} has been read without some writer for over ${MAX_HOLD_MS / 60_000} minutes; what it wrote before now is not given to the app.`));
      state.heldSince = undefined;
    }
    if (state.heldSince === undefined) {
      const basisMs = Math.min(now - CLOCK_SLACK_MS, state.basisMs + (elapsed - state.basisElapsed));
      if (basisMs > state.basisMs) {
        state.basisMs = basisMs;
        state.basisElapsed = elapsed;
      }
      const lower = [tidNow(Math.floor(state.basisMs), 0), ...[...state.attempts.values()].map((attempt) => attempt.rkey)]
        .reduce((lowest, key) => (key < lowest ? key : lowest));
      if (lower > state.lower) state.lower = lower;
    }
    for (const [uri, rkey] of state.taken) if (rkey < state.lower) state.taken.delete(uri);
    this.states.set(input.space, state);
  }

  private reportRead(
    space: string,
    state: SpaceWindowState,
    labels: WindowLabels,
    read: { complete: boolean; passing: number; permanent: SetAside[]; capped: boolean },
  ): void {
    if (!read.complete) {
      this.onError(new Error(`${space} was read without ${read.passing || "some"} writer(s); their ${labels.items} come when the ${labels.space} next changes.`));
    }
    const reported = this.reportedAside.get(space) ?? new Set<string>();
    this.reportedAside.set(space, reported);
    for (const aside of read.permanent.filter((entry) => !reported.has(entry.did))) {
      reported.add(aside.did);
      this.onError(new Error(`${space}: ${aside.did}'s ${labels.items} cannot be read (${aside.reason}); they are not given to the app.`));
    }
    if (read.capped && !state.capReported) {
      this.onError(new Error(`More than ${MAX_PAGES_BACK} pages of new ${labels.items} in ${space}; the older ones were not given to the app.`));
    }
    state.capReported = read.capped;
  }
}
