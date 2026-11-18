import { ChangeFollower, pause, RETRY_DELAY_MS, type FollowerDeps } from "./feed";

// What the UI reads from the engine: one snapshot per key, replaced (never changed in place) whenever it is reloaded, with a
// subscription per key, which is what React's useSyncExternalStore needs. A key is kept loaded while something watches it,
// and loaded again when the change feed says one of the spaces it reads changed.

export type Snapshot<T> = { readonly value: T | undefined; readonly error: unknown; readonly loading: boolean };

const NOTHING_YET: Snapshot<never> = Object.freeze({ value: undefined, error: undefined, loading: false });

export class Snapshots {
  private readonly values = new Map<string, Snapshot<unknown>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  /** A load in flight per key, and whether another was asked for while it ran. */
  private readonly loads = new Map<string, { running: Promise<void>; again: boolean; load: () => Promise<unknown> }>();

  /** The key's current snapshot; the same object until the key changes, as useSyncExternalStore requires. */
  get<T>(key: string): Snapshot<T> {
    return (this.values.get(key) ?? NOTHING_YET) as Snapshot<T>;
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  /**
   * Loads the key, keeping its previous value while loading. A refresh asked for while one runs is folded into one more run
   * after it, with the loader last asked for, so the last answer always reflects the last ask.
   */
  refresh<T>(key: string, load: () => Promise<T>): Promise<void> {
    const pending = this.loads.get(key);
    if (pending) {
      pending.again = true;
      pending.load = load;
      return pending.running;
    }
    const entry: { running: Promise<void>; again: boolean; load: () => Promise<unknown> } = { running: Promise.resolve(), again: false, load };
    // Registered before it runs, so even a loader that fails at once leaves no finished entry behind.
    this.loads.set(key, entry);
    // A load the key was forgotten during answers nothing.
    const current = () => this.loads.get(key) === entry;
    entry.running = (async () => {
      try {
        do {
          entry.again = false;
          this.set(key, { ...this.get<T>(key), loading: true });
          try {
            const value = await entry.load();
            if (current()) this.set(key, { value, error: undefined, loading: false });
          } catch (error) {
            if (current()) this.set(key, { value: this.get<T>(key).value, error, loading: false });
          }
        } while (entry.again && current());
      } finally {
        if (current()) this.loads.delete(key);
      }
    })();
    return entry.running;
  }

  /** Drops a key's snapshot, and the answer of a load still running for it: nothing shows the key any more. */
  forget(key: string): void {
    this.loads.delete(key);
    if (!this.values.delete(key)) return;
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }

  private set(key: string, snapshot: Snapshot<unknown>): void {
    this.values.set(key, Object.freeze(snapshot));
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }
}

type Binding = { spaces: readonly string[]; load: () => Promise<unknown> };

/**
 * Keeps watched keys live: each key's loader is bound to the spaces it reads, those spaces are followed through the
 * operator's change feed, and when one changes (or is reset) every key bound to it is loaded again. A space no key reads
 * any more is no longer followed. The views never wait on the operator: a key is loaded even when its spaces cannot be
 * followed yet, and they are followed once the operator answers. `start` runs the long poll until `stop`; a poll held when
 * a new space is followed is asked again at once, so the new space is in it.
 */
export class LiveSpaces {
  private readonly bindings = new Map<string, Binding>();
  /** Spaces the feed stopped following (access lost, or deleted): followed again only when a key is watched anew. */
  private readonly lost = new Set<string>();
  private readonly follower: ChangeFollower;
  private readonly retryDelayMs: number;
  private controller: AbortController | undefined;
  private poll: AbortController | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly snapshots: Snapshots, deps: Omit<FollowerDeps, "sync">) {
    this.follower = new ChangeFollower({ ...deps, sync: (space) => this.reloadSpace(space) });
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /**
   * Loads `key` now and again whenever one of `spaces` changes, until `signal` aborts or the returned function is called (a
   * later watch of the same key replaces it, and stopping the earlier one then does nothing). Spaces not yet followed are
   * followed in the order that loses nothing (head, then this load, then follow from head), so following them is what loads
   * the key, once; otherwise, or when the operator cannot be reached, the key is loaded directly. A watch stopped before its
   * load begins loads nothing; one replaced loads with the replacing watch's loader. It never rejects: a load that fails is the
   * key's snapshot error.
   */
  async watch(key: string, spaces: readonly string[], load: () => Promise<unknown>, signal?: AbortSignal): Promise<() => void> {
    const binding: Binding = { spaces, load };
    const stop = () => {
      if (this.bindings.get(key) !== binding) return;
      this.bindings.delete(key);
      this.release(spaces);
    };
    if (signal?.aborted) return stop;
    const replaced = this.bindings.get(key);
    this.bindings.set(key, binding);
    if (replaced) this.release(replaced.spaces);
    signal?.addEventListener("abort", stop, { once: true });
    for (const space of spaces) this.lost.delete(space);
    const loadWhileWatched = () => {
      const current = this.bindings.get(key);
      return current ? this.snapshots.refresh(key, current.load) : Promise.resolve();
    };
    const unfollowed = spaces.filter((space) => !this.follower.following.includes(space));
    if (!(unfollowed.length > 0 && await this.followNow(unfollowed, loadWhileWatched))) await loadWhileWatched();
    // Stopped or replaced while it was following: what only this watch read is not followed.
    if (this.bindings.get(key) !== binding) this.release(spaces);
    this.wake?.();
    return stop;
  }

  /** Loads a watched key again now, as the UI asks after its own write. */
  reload(key: string): Promise<void> {
    const binding = this.bindings.get(key);
    return binding ? this.snapshots.refresh(key, binding.load) : Promise.resolve();
  }

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.wake?.();
  }

  /** Stops following each of `spaces` that no watched key reads any more. */
  private release(spaces: readonly string[]): void {
    const read = new Set([...this.bindings.values()].flatMap((binding) => binding.spaces));
    for (const space of spaces) {
      if (read.has(space)) continue;
      this.follower.unfollow(space);
      this.lost.delete(space);
    }
  }

  /**
   * Follows `spaces` (head, then `load`, then from head) and has a held poll asked again with them; false when the operator
   * could not be reached, in which case the run loop follows them once it answers.
   */
  private async followNow(spaces: readonly string[], load: () => Promise<unknown>): Promise<boolean> {
    try {
      await this.follower.follow(spaces, load);
    } catch {
      return false;
    }
    this.poll?.abort();
    return true;
  }

  /** Spaces a watched key reads that are neither followed nor lost: the operator could not be reached when they were watched. */
  private waiting(): string[] {
    const bound = new Set([...this.bindings.values()].flatMap((binding) => binding.spaces));
    return [...bound].filter((space) => !this.follower.following.includes(space) && !this.lost.has(space));
  }

  private async reloadSpace(space: string): Promise<void> {
    await Promise.all([...this.bindings].filter(([, binding]) => binding.spaces.includes(space)).map(([key]) => this.reload(key)));
  }

  /** Waits until something is watched (or the loop is stopped). */
  private async idle(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      this.wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const waiting = this.waiting();
      // Nothing to poll yet (a follow under way wakes the loop when it is done): waiting, not asking again at once.
      if (waiting.length === 0 && !this.follower.pollable) {
        await this.idle(signal);
        continue;
      }
      const poll = new AbortController();
      const end = () => poll.abort();
      signal.addEventListener("abort", end, { once: true });
      this.poll = poll;
      try {
        if (waiting.length > 0) await this.follower.follow(waiting);
        const result = await this.follower.poll(poll.signal);
        // A space the account lost (deleted, or access gone) is loaded once more, so what reads it shows that.
        for (const space of result.unfollowed) {
          this.lost.add(space);
          await this.reloadSpace(space);
        }
      } catch {
        if (signal.aborted) return;
        // A poll ended because a space was just followed is asked again at once. Otherwise the operator could not be
        // reached: the views keep what they have, and the feed is asked again after a pause.
        if (!poll.signal.aborted) await pause(this.retryDelayMs, signal);
      } finally {
        signal.removeEventListener("abort", end);
        if (this.poll === poll) this.poll = undefined;
      }
    }
  }
}
