import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { isTid, tidNow } from "@flock/protocol/keys";
import type { ClockPatch, ClockState, SyncStore } from "./store";

export const MAX_TID_COLLISION_RETRIES = 5;

const TID_BASE32 = "234567abcdefghijklmnopqrstuvwxyz";
const MIN_HLC_MS = 1_000_000_000_000;
const MAX_HLC_MS = 999_999_999_999_999;
const DEFAULT_MAX_HLC_DRIFT_MS = 24 * 60 * 60 * 1000;
const HLC_PATTERN = /^(\d{15})\.([0-9a-f]{4})$/;

export type WebLockManager = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export type AdvanceHlcFn = (input: {
  wallNowMs: number;
  ownLast?: string | null;
  observedTs?: readonly string[];
  maxDriftMs?: number;
}) => string;

export type ReservedStamp = {
  tid: string;
  tidMs: number;
  clockId: number;
  hlc: string;
};

export type WriteQueueDeps = {
  store: SyncStore;
  now?: () => number;
  randomClockId?: () => number;
  advanceHlc?: AdvanceHlcFn;
  /** Optional Web Locks override; defaults to `globalThis.navigator?.locks` when present, or `null` to disable. */
  locks?: WebLockManager | null;
};

/**
 * Serializes short account-wide monotonic TID + HLC reservations separately from per-entity editing locks (`D11.5 #1`).
 * Writes to different entities acquire independent `(accountDid, entityUri)` locks and only synchronize briefly on the
 * account's local `SyncStore` clock reservation, so parallel writes never block each other on network I/O while still
 * preserving strict monotonic HLCs and non-colliding TIDs even under out-of-order HTTP completions.
 */
export class WriteQueue {
  private readonly store: SyncStore;
  private readonly now: () => number;
  private readonly randomClockId: () => number;
  private readonly advanceHlc: AdvanceHlcFn;
  private readonly locks: WebLockManager | null | undefined;
  private readonly clockQueues = new Map<string, Promise<void>>();
  private readonly entityQueues = new Map<string, Promise<void>>();

  constructor(deps: WriteQueueDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.randomClockId = deps.randomClockId ?? defaultRandomClockId;
    this.advanceHlc = deps.advanceHlc ?? defaultAdvanceHlc;
    this.locks = deps.locks;
  }

  /**
   * Atomically reserves a strictly increasing `(tid, hlc)` stamp for `accountDid`, persisting `max(ownLastHlc)` and
   * `max(lastTidMs, lastClockId)` inside `SyncStore` before releasing the clock reservation.
   */
  async reserveStamp(
    accountDid: string,
    observedTs: readonly string[] = [],
    options: { minTidMs?: number; wallNowMs?: number; advanceHlc?: AdvanceHlcFn } = {},
  ): Promise<ReservedStamp> {
    return this.runLocked(this.clockQueues, accountDid, `flock:clock:${accountDid}`, async () => {
      const wallNowMs = Math.floor(options.wallNowMs ?? this.now());
      if (!Number.isSafeInteger(wallNowMs) || wallNowMs < 0) {
        throw new RangeError(`Invalid wall clock milliseconds for TID reservation: ${String(wallNowMs)}.`);
      }
      if (options.minTidMs !== undefined && (!Number.isSafeInteger(options.minTidMs) || options.minTidMs < 0)) {
        throw new RangeError(`Invalid minTidMs for TID reservation: ${String(options.minTidMs)}.`);
      }
      const stepHlc = options.advanceHlc ?? this.advanceHlc;
      const updated = await this.store.updateClock(
        accountDid,
        (current) => {
          const prevMs = current?.lastTidMs ?? 0;
          const prevClockId = current?.lastClockId ?? 0;
          const floorMs = Math.max(wallNowMs, options.minTidMs ?? 0);

          let nextTidMs: number;
          let nextClockId: number;
          if (floorMs > prevMs) {
            nextTidMs = floorMs;
            nextClockId = normalizeClockId(this.randomClockId());
          } else if (prevClockId < 1023) {
            nextTidMs = prevMs;
            nextClockId = prevClockId + 1;
          } else {
            nextTidMs = prevMs + 1;
            nextClockId = normalizeClockId(this.randomClockId());
          }

          const nextHlc = stepHlc({
            wallNowMs,
            ownLast: current?.ownLastHlc ?? null,
            observedTs,
          });

          return {
            lastTidMs: nextTidMs,
            lastClockId: nextClockId,
            ownLastHlc: nextHlc,
          };
        },
        "",
      );

      return {
        tid: tidNow(updated.lastTidMs, updated.lastClockId),
        tidMs: updated.lastTidMs,
        clockId: updated.lastClockId,
        hlc: updated.ownLastHlc!,
      };
    });
  }

  /**
   * Advances `SyncStore` clock state monotonically from synced own PDS records (reconciling multi-device writes and
   * ambiguous writes whose remote `createRecord` succeeded before a response drop or timeout).
   */
  async observeOwnHistory(
    accountDid: string,
    records: ReadonlyArray<{ rkey?: string; hlc?: string }>,
  ): Promise<ClockState | undefined> {
    return this.runLocked(this.clockQueues, accountDid, `flock:clock:${accountDid}`, async () => {
      let bestTidMs: number | undefined;
      let bestClockId: number | undefined;
      let bestHlc: string | undefined;

      for (const item of records) {
        if (item.rkey !== undefined) {
          const decoded = decodeTid(item.rkey);
          if (
            decoded &&
            (bestTidMs === undefined ||
              decoded.ms > bestTidMs ||
              (decoded.ms === bestTidMs && decoded.clockId > (bestClockId ?? 0)))
          ) {
            bestTidMs = decoded.ms;
            bestClockId = decoded.clockId;
          }
        }
        if (item.hlc !== undefined && parseHlcParts(item.hlc) !== null) {
          if (bestHlc === undefined || item.hlc > bestHlc) {
            bestHlc = item.hlc;
          }
        }
      }

      const patch: ClockPatch = {
        ...(bestTidMs !== undefined ? { lastTidMs: bestTidMs, lastClockId: bestClockId } : {}),
        ...(bestHlc !== undefined ? { ownLastHlc: bestHlc } : {}),
      };
      if (Object.keys(patch).length === 0) {
        return this.store.getClock(accountDid, "");
      }
      return this.store.updateClock(accountDid, patch, "");
    });
  }

  /**
   * Serializes mutations targeting the same `(accountDid, entityUri)` across in-process callers and browser tabs,
   * while allowing mutations on distinct entities to execute concurrently.
   */
  async withEntityLock<T>(accountDid: string, entityUri: string, fn: () => Promise<T>): Promise<T> {
    return this.runLocked(
      this.entityQueues,
      `${accountDid}\0${entityUri}`,
      `flock:entity:${accountDid}:${entityUri}`,
      fn,
    );
  }

  /**
   * Reserves a stamp and runs `attemptCreate`, retrying up to `MAX_TID_COLLISION_RETRIES` (5) times with a strictly
   * higher `(Math.max(wallNowMs, prevTidMs + 1), freshClockId)` TID when `com.atproto.space.createRecord` rejects a
   * cross-device duplicate `rkey` (`RecordAlreadyExists`).
   */
  async createWithTidRetry<T>(input: {
    accountDid: string;
    observedTs?: readonly string[];
    maxRetries?: number;
    advanceHlc?: AdvanceHlcFn;
    attemptCreate: (stamp: ReservedStamp) => Promise<T>;
  }): Promise<{ stamp: ReservedStamp; result: T }> {
    const maxRetries = input.maxRetries ?? MAX_TID_COLLISION_RETRIES;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(`maxRetries must be a non-negative safe integer: ${String(maxRetries)}.`);
    }

    let minTidMs: number | undefined;
    for (let retry = 0; ; retry += 1) {
      const stamp = await this.reserveStamp(input.accountDid, input.observedTs, {
        minTidMs,
        advanceHlc: input.advanceHlc,
      });
      try {
        const result = await input.attemptCreate(stamp);
        return { stamp, result };
      } catch (error) {
        if (!isDuplicateRkeyError(error) || retry >= maxRetries) {
          throw error;
        }
        minTidMs = stamp.tidMs + 1;
      }
    }
  }

  private async runLocked<T>(
    queues: Map<string, Promise<void>>,
    queueKey: string,
    webLockName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(queueKey, current);

    await previous;
    try {
      const lockManager = this.resolveLockManager();
      if (lockManager) {
        return await lockManager.request(webLockName, fn);
      }
      return await fn();
    } finally {
      release();
      if (queues.get(queueKey) === current) {
        queues.delete(queueKey);
      }
    }
  }

  private resolveLockManager(): WebLockManager | undefined {
    if (this.locks === null) return undefined;
    if (this.locks !== undefined) return this.locks;
    if (
      typeof globalThis.navigator !== "undefined" &&
      globalThis.navigator?.locks &&
      typeof globalThis.navigator.locks.request === "function"
    ) {
      return globalThis.navigator.locks;
    }
    return undefined;
  }
}

/** Matches duplicate-rkey rejections from both FakeNetwork and the pinned PDS `createRecord` (`RecordAlreadyExists`, 400/409). */
export function isDuplicateRkeyError(error: unknown): boolean {
  if (error instanceof XrpcError) {
    return error.code === "RecordAlreadyExists" && (error.status === 400 || error.status === 409);
  }
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "RecordAlreadyExists") {
    const status = (error as { status?: unknown }).status;
    return status === undefined || status === 400 || status === 409;
  }
  return false;
}

/** Decodes an ATProto TID into `{ ms, clockId }` floors suitable for strictly monotonic continuation. */
export function decodeTid(tid: string): { ms: number; clockId: number } | null {
  if (!isTid(tid)) return null;
  let value = 0n;
  for (let i = 0; i < 13; i += 1) {
    const index = TID_BASE32.indexOf(tid[i]!);
    if (index < 0) return null;
    value = (value << 5n) | BigInt(index);
  }
  const clockId = Number(value & 0x3ffn);
  const micros = value >> 10n;
  const remainder = micros % 1000n;
  const baseMs = Number(micros / 1000n);
  if (!Number.isSafeInteger(baseMs)) return null;
  if (remainder > 0n) {
    return { ms: baseMs + 1, clockId: 0 };
  }
  return { ms: baseMs, clockId };
}

function normalizeClockId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1023) {
    throw new RangeError(`TID clockId must be an integer between 0 and 1023: ${String(value)}.`);
  }
  return value;
}

function defaultRandomClockId(): number {
  const limit = Math.floor(0x100000000 / 1024) * 1024;
  let value: number;
  do {
    value = crypto.getRandomValues(new Uint32Array(1))[0]!;
  } while (value >= limit);
  return value % 1024;
}

function defaultAdvanceHlc(input: {
  wallNowMs: number;
  ownLast?: string | null;
  observedTs?: readonly string[];
  maxDriftMs?: number;
}): string {
  const wallMs = Math.floor(input.wallNowMs);
  if (!Number.isFinite(input.wallNowMs) || wallMs < MIN_HLC_MS || wallMs >= MAX_HLC_MS) {
    throw new RangeError(`Wall clock out of HLC range: ${String(input.wallNowMs)}.`);
  }
  const maxDriftMs = input.maxDriftMs ?? DEFAULT_MAX_HLC_DRIFT_MS;
  if (!Number.isFinite(maxDriftMs) || maxDriftMs < 0) {
    throw new RangeError(`Invalid maxDriftMs: ${String(maxDriftMs)}.`);
  }
  const driftCeiling = Math.min(MAX_HLC_MS, wallMs + Math.floor(maxDriftMs));

  let prev = input.ownLast != null ? requireHlcParts(input.ownLast, "ownLast") : null;
  for (const observed of input.observedTs ?? []) {
    const parsed = requireHlcParts(observed, "observedTs");
    const clamped = parsed.ms > driftCeiling ? { ms: driftCeiling, counter: 0 } : parsed;
    if (!prev || clamped.ms > prev.ms || (clamped.ms === prev.ms && clamped.counter > prev.counter)) {
      prev = clamped;
    }
  }

  if (!prev) return formatHlcParts({ ms: wallMs, counter: 0 });
  const nextMs = Math.max(wallMs, prev.ms);
  if (nextMs > prev.ms) return formatHlcParts({ ms: nextMs, counter: 0 });
  if (prev.counter < 0xffff) return formatHlcParts({ ms: nextMs, counter: prev.counter + 1 });
  if (nextMs + 1 > MAX_HLC_MS) {
    throw new RangeError("HLC timestamp exceeded MAX_HLC_MS.");
  }
  return formatHlcParts({ ms: nextMs + 1, counter: 0 });
}

function parseHlcParts(value: string): { ms: number; counter: number } | null {
  const match = HLC_PATTERN.exec(value);
  if (!match) return null;
  const ms = Number(match[1]);
  const counter = Number.parseInt(match[2]!, 16);
  if (!Number.isSafeInteger(ms) || ms < MIN_HLC_MS || ms > MAX_HLC_MS) return null;
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffff) return null;
  return { ms, counter };
}

function requireHlcParts(value: string, label: string): { ms: number; counter: number } {
  const parsed = parseHlcParts(value);
  if (!parsed) throw new RangeError(`Invalid HLC timestamp for ${label}: ${value}.`);
  return parsed;
}

function formatHlcParts(parts: { ms: number; counter: number }): string {
  return `${String(parts.ms).padStart(15, "0")}.${parts.counter.toString(16).padStart(4, "0")}`;
}
