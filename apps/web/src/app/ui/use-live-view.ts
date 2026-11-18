"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { LiveSpaces, Snapshot, Snapshots } from "@flock/client/views";

// How components read the engine's views: a key's snapshot through useSyncExternalStore, and a key kept live (loaded now and
// whenever the change feed names one of the spaces it reads) while the component wants it.

const NONE: Snapshot<never> = Object.freeze({ value: undefined, error: undefined, loading: false });

/** The key's current snapshot; nothing while there is no session or no key. */
export function useSnapshot<T>(snapshots: Snapshots | null, key: string | null): Snapshot<T> {
  const subscribe = useCallback((onChange: () => void) => (snapshots && key ? snapshots.subscribe(key, onChange) : () => undefined), [snapshots, key]);
  const read = useCallback(() => (snapshots && key ? snapshots.get<T>(key) : NONE), [snapshots, key]);
  return useSyncExternalStore(subscribe, read, () => NONE);
}

/**
 * Keeps `key` live while `key` and the session are set: watched over `spaces` with `load` as its one loader (watched again,
 * keeping what it shows, when those change), and forgotten once it is no longer shown, so opening it again reads it afresh. A
 * load that fails is the key's snapshot error.
 */
export function useLiveKey(session: { live: LiveSpaces | null; snapshots: Snapshots | null }, key: string | null, spaces: readonly string[], load: () => Promise<unknown>): void {
  const { live, snapshots } = session;
  const spaceList = spaces.join(" ");
  useEffect(() => {
    if (!snapshots || !key) return;
    return () => snapshots.forget(key);
  }, [snapshots, key]);
  useEffect(() => {
    if (!live || !key) return;
    const watching = new AbortController();
    void live.watch(key, spaceList ? spaceList.split(" ") : [], load, watching.signal);
    return () => watching.abort();
  }, [live, key, spaceList, load]);
}
