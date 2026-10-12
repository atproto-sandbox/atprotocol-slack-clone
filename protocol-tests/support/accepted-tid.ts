import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The PDS refuses record keys that match its explicit-slur filter. A TID is a clock reading, so a workload that writes
// millions of consecutive timestamps meets a few matching keys (a person sending one message would simply retry).
// The synthetic workloads therefore skip those timestamps: the keys stay unique and in timestamp order.

export async function loadSlurFilter(pinnedCheckout: string): Promise<(key: string) => boolean> {
  const filter = await import(pathToFileURL(join(pinnedCheckout, "packages/pds/dist/handle/explicit-slurs.js")).href) as { hasExplicitSlur(value: string): boolean };
  return filter.hasExplicitSlur;
}

/** `count` consecutive-as-possible timestamps from `start` whose TID key the PDS accepts. */
export function acceptedTimestamps(
  tidNow: (timestamp: number, clockId: number) => string,
  rejects: (key: string) => boolean,
  start: number,
  count: number,
): number[] {
  const accepted: number[] = [];
  for (let timestamp = start; accepted.length < count; timestamp += 1) {
    if (!rejects(tidNow(timestamp, 0))) accepted.push(timestamp);
  }
  return accepted;
}
