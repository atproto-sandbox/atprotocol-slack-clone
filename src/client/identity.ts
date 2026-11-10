import { DID_DOCUMENT_TTL_MS } from "@/atproto/kem-key";
import type { IdentityKind, SyncStore } from "./store";
import { transportNow, type ClientTransport } from "./transport";

/**
 * DID resolutions awaited at once per origin, across every engine in the process: a browser's HTTP/1.1 connections per origin.
 * A resolution given up at its timeout is not cancelled (the transport takes no signal), so it no longer counts.
 */
export const RESOLUTIONS_PER_ORIGIN = 6;
/** A resolution not answered by then fails and gives up its slot, so a hung directory cannot hold every other resolution. */
export const RESOLUTION_TIMEOUT_MS = 10_000;

const active = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

/**
 * The transport with its DID resolution held in the store for as long as the app trusts a DID document anywhere
 * (`DID_DOCUMENT_TTL_MS`), so reopening within it, in this session or the next, does not resolve every writer again (K4); and
 * bounded per origin, so a first open of a large space does not flood the PLC directory. A failed MAC reads the key again.
 */
export function withIdentityCache(transport: ClientTransport, store: SyncStore): ClientTransport {
  const cache = new IdentityCache(transport, store);
  return {
    ...transport,
    resolvePds: (did) => cache.resolve("pds", did, false, () => transport.resolvePds(did)),
    resolveKemKey: (did, forceRefresh) => cache.resolve("kem", did, forceRefresh, () => transport.resolveKemKey(did, forceRefresh)),
  };
}

type Resolution = { forced: boolean; answer: Promise<string> };

class IdentityCache {
  /** The resolution each identity waits on. Only the latest one started stores its answer, so an older one cannot undo a forced one. */
  private readonly inFlight = new Map<string, Resolution>();

  constructor(private readonly transport: ClientTransport, private readonly store: SyncStore) {}

  async resolve(kind: IdentityKind, did: string, force: boolean, resolve: () => Promise<string>): Promise<string> {
    if (!force) {
      const held = await this.store.getIdentity(kind, did);
      const age = held ? transportNow(this.transport) - held.resolvedAt : -1;
      // An entry resolved in the future (a clock set back) is due, as a writer's check time is.
      if (held && age >= 0 && age < DID_DOCUMENT_TTL_MS) return held.value;
    }
    const key = `${kind} ${did}`;
    const pending = this.inFlight.get(key);
    // A forced resolution joins only another forced one: an unforced one may answer with the key a MAC just refused.
    if (pending && (pending.forced || !force)) return pending.answer;
    const answer: Promise<string> = limited(originOf(did), resolve).then(async (value) => {
      if (this.inFlight.get(key)?.answer === answer) await this.store.putIdentity({ kind, did, value, resolvedAt: transportNow(this.transport) });
      return value;
    });
    const resolution: Resolution = { forced: force, answer };
    this.inFlight.set(key, resolution);
    try {
      return await answer;
    } finally {
      if (this.inFlight.get(key) === resolution) this.inFlight.delete(key);
    }
  }
}

async function limited<T>(origin: string, run: () => Promise<T>): Promise<T> {
  while ((active.get(origin) ?? 0) >= RESOLUTIONS_PER_ORIGIN) {
    await new Promise<void>((wake) => waiting.set(origin, [...(waiting.get(origin) ?? []), wake]));
  }
  active.set(origin, (active.get(origin) ?? 0) + 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DID resolution at ${origin} did not answer within ${RESOLUTION_TIMEOUT_MS} ms.`)), RESOLUTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    const left = active.get(origin)! - 1;
    if (left === 0) active.delete(origin);
    else active.set(origin, left);
    const queue = waiting.get(origin) ?? [];
    queue.shift()?.();
    if (queue.length === 0) waiting.delete(origin);
  }
}

/** Where a DID's document is fetched from: the PLC directory for every `did:plc`, the named host for a `did:web`. */
function originOf(did: string): string {
  return did.startsWith("did:web:") ? did.slice("did:web:".length).split(":")[0]!.toLowerCase() : did.split(":").slice(0, 2).join(":");
}
