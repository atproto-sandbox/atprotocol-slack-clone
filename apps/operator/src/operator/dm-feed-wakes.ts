import { chmodSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isDid, parseDmSpaceUri } from "@flock/protocol/keys";
import { getOperatorConfig } from "../config";
import { getRawDb, onDbClose } from "../lib/db";

// Ephemeral, caller-scoped DM wake tracker with host-local multi-process Unix domain socket coordination.
// Zero DM rows (zero DM URIs, zero DIDs, zero user activity) are ever persisted to SQLite, and zero DM data files are written to disk.
// Multi-process hub election uses a single static content-free leader lease row (`name = 'dm_ipc_hub'`) in `oauth_request_lock`
// paired with a unique per-hub socket pathname (`flock-dm-v2-<digest>-<hubId>.sock`).

export const MAX_TRACKED_DM_CALLERS = 50_000;
export const MAX_TRACKED_DM_SPACES = 50_000;
export const MAX_SPACES_PER_CALLER = 2_000;
export const SNAPSHOT_CHUNK_MAX_SPACES = 250;
/** 36^4 - 1: keeps base36 sequence <= 4 chars so `<epoch>.<dbBase36>.<dmBase36>` always fits within 16 chars. */
export const MAX_DM_SEQ_PER_EPOCH = 36 ** 4 - 1;
export const DM_WAKE_RATE_LIMIT_MAX = 120;
export const DM_WAKE_RATE_LIMIT_WINDOW_MS = 60_000;
export const HUB_LEASE_TTL_MS = 15_000;

const SNAPSHOT_CHUNK_MAX_CALLERS = 250;
const MAX_RATE_LIMIT_BUCKETS = 50_000;
const MAX_SEEN_OP_IDS = 16_384;
const DM_IPC_KEY_INFO = "flock-dm-ipc-v2";
const DM_IPC_PROTOCOL_VERSION = 2;
const DM_IPC_HUB_LOCK_NAME = "dm_ipc_hub";
const HUB_HEARTBEAT_MS = 4_000;
const MAX_IPC_FRAME_BYTES = 8 * 1024 * 1024;
const IPC_HANDSHAKE_TIMEOUT_MS = 3_000;
const IPC_ACK_TIMEOUT_MS = 1_500;
const IPC_RPC_TIMEOUT_MS = 3_000;
const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export class DmRateLimitError extends Error {
  readonly status = 429;
  readonly error = "RateLimitExceeded";
  constructor(message = "Too many DM notifications for this caller and space.") {
    super(message);
    this.name = "DmRateLimitError";
  }
}

export class DmWakeIpcError extends Error {
  readonly status = 503;
  readonly error = "Busy";
  constructor(message = "DM wake IPC coordination unavailable.") {
    super(message);
    this.name = "DmWakeIpcError";
  }
}

class HubOwnershipLostError extends Error {
  constructor(message = "DM wake hub lease ownership lost.") {
    super(message);
    this.name = "HubOwnershipLostError";
  }
}

export type DmCursor = { epoch: string; seq: number };
export type DmWakeAnswer = {
  epoch: string;
  head: number;
  changed: Array<{ space: string; seq: number }>;
  reset: string[];
};

type CallerWakeState = {
  epoch: string;
  head: number;
  evictedFloor: number;
  spaces: Map<string, number>;
};

type SerializedCallerState = {
  callerDid: string;
  epoch: string;
  head: number;
  evictedFloor: number;
  spaces: Array<[string, number]>;
};

type GlobalWakeEntry = {
  callerDid: string;
  space: string;
  seq: number;
};

type GlobalSpaceEviction = {
  callerDid: string;
  space: string;
  callerEpoch: string;
  head: number;
  evictedFloor: number;
};

type WakeMutation = {
  callerDid: string;
  space: string;
  callerEpoch: string;
  head: number;
  seq: number;
  evictedFloor: number;
  evictedCallers: number;
  globalEvictions?: GlobalSpaceEviction[];
};

type RateBucket = {
  windowStartMs: number;
  count: number;
};

type IpcFrame =
  | { type: "challenge"; nonce: string; version: number }
  | { type: "auth"; nonce: string; version: number }
  | { type: "snapshot_begin"; epoch: string; evictedCallers: number; maxSpaces: number }
  | { type: "snapshot_chunk"; callers: SerializedCallerState[] }
  | { type: "snapshot_end" }
  | { type: "wake"; bcastId: number; mutation: WakeMutation }
  | { type: "wake_ack"; bcastId: number }
  | { type: "record_wake"; reqId: number; opId?: string; callerDid: string; space: string; nowMs: number }
  | { type: "record_ok"; reqId: number }
  | { type: "record_err"; reqId: number; code: "rate_limit" | "error"; message: string }
  | { type: "reset"; epoch: string; maxSpaces: number };

function generateBootEpoch(previous?: string): string {
  while (true) {
    const bytes = randomBytes(3);
    const candidate = `${ALPHA[bytes[0]! % ALPHA.length]}${BASE36[bytes[1]! % BASE36.length]}${BASE36[bytes[2]! % BASE36.length]}`;
    if (candidate !== previous) return candidate;
  }
}

let clusterEpoch = generateBootEpoch();
let evictedCallers = 0;
let maxTrackedDmSpaces = MAX_TRACKED_DM_SPACES;
const callers = new Map<string, CallerWakeState>();
const globalEntries = new Map<string, GlobalWakeEntry>();
const rateBuckets = new Map<string, RateBucket>();
const seenOpIds = new Map<string, Promise<void>>();
const wakeListeners = new Set<(callerDid?: string) => void>();

function notifyListeners(callerDid?: string): void {
  for (const listener of [...wakeListeners]) listener(callerDid);
}

function notifyMutationListeners(mutation: WakeMutation): void {
  notifyListeners(mutation.callerDid);
  if (mutation.globalEvictions) {
    const seen = new Set<string>([mutation.callerDid]);
    for (const ev of mutation.globalEvictions) {
      if (!seen.has(ev.callerDid)) {
        seen.add(ev.callerDid);
        notifyListeners(ev.callerDid);
      }
    }
  }
}

function globalEntryKey(callerDid: string, space: string): string {
  return `${callerDid}\0${space}`;
}

function upsertGlobalEntry(callerDid: string, space: string, seq: number): void {
  const key = globalEntryKey(callerDid, space);
  globalEntries.delete(key);
  globalEntries.set(key, { callerDid, space, seq });
}

function deleteGlobalEntry(callerDid: string, space: string): void {
  globalEntries.delete(globalEntryKey(callerDid, space));
}

function clearCallerGlobalEntries(callerDid: string, state: CallerWakeState): void {
  for (const space of state.spaces.keys()) {
    globalEntries.delete(globalEntryKey(callerDid, space));
  }
}

function evictGlobalOverflow(activeCallerDid?: string): GlobalSpaceEviction[] {
  const evicted: GlobalSpaceEviction[] = [];
  const advancedVictims = new Set<string>(activeCallerDid ? [activeCallerDid] : []);
  while (globalEntries.size > maxTrackedDmSpaces) {
    const oldest = globalEntries.entries().next();
    if (oldest.done) break;
    const [oldestKey, oldestEntry] = oldest.value;
    globalEntries.delete(oldestKey);
    const ownerState = callers.get(oldestEntry.callerDid);
    if (ownerState) {
      ownerState.spaces.delete(oldestEntry.space);
      const raisedFloor = oldestEntry.seq > ownerState.evictedFloor;
      if (raisedFloor) {
        ownerState.evictedFloor = oldestEntry.seq;
      }
      if (raisedFloor && !advancedVictims.has(oldestEntry.callerDid)) {
        advancedVictims.add(oldestEntry.callerDid);
        if (ownerState.head >= MAX_DM_SEQ_PER_EPOCH) {
          clearCallerGlobalEntries(oldestEntry.callerDid, ownerState);
          ownerState.epoch = generateBootEpoch(ownerState.epoch);
          ownerState.head = 1;
          ownerState.evictedFloor = 0;
          ownerState.spaces.clear();
        } else {
          ownerState.head += 1;
        }
      }
      evicted.push({
        callerDid: oldestEntry.callerDid,
        space: oldestEntry.space,
        callerEpoch: ownerState.epoch,
        head: ownerState.head,
        evictedFloor: ownerState.evictedFloor,
      });
    }
  }
  return evicted;
}

export function onDmWake(listener: (callerDid?: string) => void): () => void {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

export function waitForDmWake(
  callerDid: string,
  spaces: ReadonlyArray<string>,
  withinMs: number,
  signal?: AbortSignal,
): Promise<void> {
  void spaces;
  return new Promise((resolveWait) => {
    if (withinMs <= 0 || signal?.aborted) {
      resolveWait();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      unsub();
      resolveWait();
    };
    const timer = setTimeout(done, withinMs);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
    const unsub = onDmWake((changedDid) => {
      if (changedDid === undefined || changedDid === callerDid) done();
    });
  });
}

function checkAndRecordRateLimit(callerDid: string, space: string, nowMs: number): void {
  const key = `${callerDid}\0${space}`;
  const existing = rateBuckets.get(key);
  if (!existing || nowMs < existing.windowStartMs || nowMs - existing.windowStartMs >= DM_WAKE_RATE_LIMIT_WINDOW_MS) {
    rateBuckets.delete(key);
    rateBuckets.set(key, { windowStartMs: nowMs, count: 1 });
    while (rateBuckets.size > MAX_RATE_LIMIT_BUCKETS) {
      const oldest = rateBuckets.keys().next();
      if (oldest.done) break;
      rateBuckets.delete(oldest.value);
    }
    return;
  }
  if (existing.count >= DM_WAKE_RATE_LIMIT_MAX) {
    throw new DmRateLimitError();
  }
  existing.count += 1;
}

function applyAuthoritativeWake(callerDid: string, space: string): WakeMutation {
  let state = callers.get(callerDid);
  if (!state) {
    state = {
      epoch: clusterEpoch,
      head: 0,
      evictedFloor: 0,
      spaces: new Map(),
    };
  } else {
    // Refresh caller LRU order
    callers.delete(callerDid);
  }

  if (state.head >= MAX_DM_SEQ_PER_EPOCH) {
    clearCallerGlobalEntries(callerDid, state);
    state.epoch = generateBootEpoch(state.epoch);
    state.head = 0;
    state.evictedFloor = 0;
    state.spaces.clear();
  }

  state.head += 1;
  const spaceSeq = state.head;
  state.spaces.delete(space);
  state.spaces.set(space, spaceSeq);
  upsertGlobalEntry(callerDid, space, spaceSeq);

  while (state.spaces.size > MAX_SPACES_PER_CALLER) {
    const oldest = state.spaces.entries().next();
    if (oldest.done) break;
    const [oldestSpace, oldestSeq] = oldest.value;
    state.spaces.delete(oldestSpace);
    deleteGlobalEntry(callerDid, oldestSpace);
    if (oldestSeq > state.evictedFloor) state.evictedFloor = oldestSeq;
  }

  callers.set(callerDid, state);
  while (callers.size > MAX_TRACKED_DM_CALLERS) {
    const oldestCaller = callers.entries().next();
    if (oldestCaller.done) break;
    const [evictedDid, evictedState] = oldestCaller.value;
    clearCallerGlobalEntries(evictedDid, evictedState);
    callers.delete(evictedDid);
    evictedCallers += 1;
  }

  const globalEvictions = evictGlobalOverflow(callerDid);

  return {
    callerDid,
    space,
    callerEpoch: state.epoch,
    head: state.head,
    seq: spaceSeq,
    evictedFloor: state.evictedFloor,
    evictedCallers,
    ...(globalEvictions.length > 0 ? { globalEvictions } : {}),
  };
}

function applyReplicaMutation(mutation: WakeMutation): void {
  let state = callers.get(mutation.callerDid);
  if (!state || state.epoch !== mutation.callerEpoch || mutation.head < state.head) {
    if (state) {
      clearCallerGlobalEntries(mutation.callerDid, state);
      callers.delete(mutation.callerDid);
    }
    state = {
      epoch: mutation.callerEpoch,
      head: mutation.head,
      evictedFloor: mutation.evictedFloor,
      spaces: new Map(),
    };
  } else {
    callers.delete(mutation.callerDid);
    state.head = mutation.head;
    if (mutation.evictedFloor > state.evictedFloor) {
      state.evictedFloor = mutation.evictedFloor;
    }
  }
  state.spaces.delete(mutation.space);
  state.spaces.set(mutation.space, mutation.seq);
  upsertGlobalEntry(mutation.callerDid, mutation.space, mutation.seq);
  while (state.spaces.size > MAX_SPACES_PER_CALLER) {
    const oldest = state.spaces.entries().next();
    if (oldest.done) break;
    const [oldestSpace, oldestSeq] = oldest.value;
    state.spaces.delete(oldestSpace);
    deleteGlobalEntry(mutation.callerDid, oldestSpace);
    if (oldestSeq > state.evictedFloor) state.evictedFloor = oldestSeq;
  }
  callers.set(mutation.callerDid, state);
  evictedCallers = mutation.evictedCallers;
  while (callers.size > MAX_TRACKED_DM_CALLERS) {
    const oldestCaller = callers.entries().next();
    if (oldestCaller.done) break;
    const [evictedDid, evictedState] = oldestCaller.value;
    clearCallerGlobalEntries(evictedDid, evictedState);
    callers.delete(evictedDid);
  }
  if (mutation.globalEvictions) {
    for (const ev of mutation.globalEvictions) {
      deleteGlobalEntry(ev.callerDid, ev.space);
      const ownerState = callers.get(ev.callerDid);
      if (ownerState) {
        if (ev.callerEpoch && ownerState.epoch !== ev.callerEpoch) {
          clearCallerGlobalEntries(ev.callerDid, ownerState);
          ownerState.epoch = ev.callerEpoch;
          ownerState.head = ev.head;
          ownerState.evictedFloor = ev.evictedFloor;
          ownerState.spaces.clear();
        } else {
          ownerState.spaces.delete(ev.space);
          if (ev.evictedFloor > ownerState.evictedFloor) {
            ownerState.evictedFloor = ev.evictedFloor;
          }
          if (typeof ev.head === "number" && ev.head > ownerState.head) {
            ownerState.head = ev.head;
          }
        }
      }
    }
  }
  evictGlobalOverflow(mutation.callerDid);
}

function buildSnapshotChunks(): SerializedCallerState[][] {
  const chunks: SerializedCallerState[][] = [];
  let currentChunk: SerializedCallerState[] = [];
  let currentPairs = 0;

  const flush = () => {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentPairs = 0;
    }
  };

  for (const [callerDid, state] of callers) {
    const allSpaces = [...state.spaces.entries()];
    if (allSpaces.length === 0) {
      if (currentChunk.length >= SNAPSHOT_CHUNK_MAX_CALLERS) {
        flush();
      }
      currentChunk.push({
        callerDid,
        epoch: state.epoch,
        head: state.head,
        evictedFloor: state.evictedFloor,
        spaces: [],
      });
      continue;
    }

    let offset = 0;
    while (offset < allSpaces.length) {
      if (currentPairs >= SNAPSHOT_CHUNK_MAX_SPACES || currentChunk.length >= SNAPSHOT_CHUNK_MAX_CALLERS) {
        flush();
      }
      const room = SNAPSHOT_CHUNK_MAX_SPACES - currentPairs;
      const slice = allSpaces.slice(offset, offset + room);
      currentChunk.push({
        callerDid,
        epoch: state.epoch,
        head: state.head,
        evictedFloor: state.evictedFloor,
        spaces: slice,
      });
      currentPairs += slice.length;
      offset += slice.length;
    }
  }

  flush();
  return chunks;
}

function mergeSerializedCallers(
  target: Map<string, CallerWakeState>,
  items: ReadonlyArray<SerializedCallerState>,
): void {
  for (const item of items) {
    let existing = target.get(item.callerDid);
    if (!existing) {
      existing = {
        epoch: item.epoch,
        head: item.head,
        evictedFloor: item.evictedFloor,
        spaces: new Map(),
      };
      target.set(item.callerDid, existing);
    } else {
      existing.epoch = item.epoch;
      if (item.head > existing.head) existing.head = item.head;
      if (item.evictedFloor > existing.evictedFloor) existing.evictedFloor = item.evictedFloor;
    }
    for (const [space, seq] of item.spaces) {
      existing.spaces.delete(space);
      existing.spaces.set(space, seq);
    }
  }
}

function loadSnapshot(
  epoch: string,
  nextEvictedCallers: number,
  snapshotCallers: ReadonlyMap<string, CallerWakeState>,
  nextMaxSpaces?: number,
): void {
  clusterEpoch = epoch;
  evictedCallers = nextEvictedCallers;
  if (typeof nextMaxSpaces === "number" && Number.isSafeInteger(nextMaxSpaces) && nextMaxSpaces >= 1) {
    maxTrackedDmSpaces = nextMaxSpaces;
  }
  callers.clear();
  globalEntries.clear();
  seenOpIds.clear();
  for (const [callerDid, state] of snapshotCallers) {
    const spaces = new Map<string, number>();
    for (const [space, seq] of state.spaces) {
      spaces.set(space, seq);
      upsertGlobalEntry(callerDid, space, seq);
    }
    callers.set(callerDid, {
      epoch: state.epoch,
      head: state.head,
      evictedFloor: state.evictedFloor,
      spaces,
    });
  }
  evictGlobalOverflow();
}

export function currentDmWakeHead(callerDid: string): { epoch: string; head: number } {
  const state = callers.get(callerDid);
  if (!state) return { epoch: clusterEpoch, head: 0 };
  return { epoch: state.epoch, head: state.head };
}

export function readDmWakes(
  callerDid: string,
  follow: ReadonlyArray<{ space: string; cursor: DmCursor | null }>,
): DmWakeAnswer {
  const state = callers.get(callerDid);
  const effectiveEpoch = state?.epoch ?? clusterEpoch;
  const effectiveHead = state?.head ?? 0;
  const answer: DmWakeAnswer = { epoch: effectiveEpoch, head: effectiveHead, changed: [], reset: [] };

  for (const { space, cursor } of follow) {
    if (!cursor || cursor.epoch !== effectiveEpoch || cursor.seq > effectiveHead || cursor.seq < 0) {
      answer.reset.push(space);
      continue;
    }
    if (!state) {
      if (evictedCallers > 0) answer.reset.push(space);
      continue;
    }
    const newest = state.spaces.get(space) ?? 0;
    if (newest > cursor.seq) {
      answer.changed.push({ space, seq: newest });
    } else if (newest === 0 && cursor.seq < state.evictedFloor) {
      answer.reset.push(space);
    }
  }
  return answer;
}

// ---- Host-local Unix domain socket IPC coordination (zero DM SQLite rows, zero DM files) ----

function dmWakeClusterDigest(databasePath?: string, operatorServiceRef?: string): string | null {
  let dbPath = databasePath;
  let serviceRef = operatorServiceRef;
  if (dbPath === undefined || serviceRef === undefined) {
    try {
      const cfg = getOperatorConfig();
      dbPath ??= cfg.databasePath;
      serviceRef ??= cfg.operatorServiceRef;
    } catch {
      return null;
    }
  }
  if (!dbPath || dbPath === ":memory:") return null;
  return createHash("sha256")
    .update(`${resolve(dbPath)}\0${serviceRef ?? ""}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function socketDirectoryFor(filename: string): string {
  const candidate = join(tmpdir(), filename);
  // POSIX/macOS sockaddr_un sun_path is 104 bytes including trailing NUL.
  return Buffer.byteLength(candidate, "utf8") <= 100 ? tmpdir() : "/tmp";
}

function buildHubSocketPath(clusterDigest: string, hubId: string): string {
  const filename = `flock-dm-v2-${clusterDigest}-${hubId}.sock`;
  return join(socketDirectoryFor(filename), filename);
}

export function formatHubLeaseToken(hubId: string, sockPath: string): string {
  return `v2|${hubId}|${sockPath}`;
}

function parseHubLeaseToken(
  token: string,
  expectedDigest?: string,
): { hubId: string; sockPath: string } | null {
  if (!token.startsWith("v2|")) return null;
  const secondPipe = token.indexOf("|", 3);
  if (secondPipe <= 3 || secondPipe >= token.length - 1) return null;
  const hubId = token.slice(3, secondPipe);
  const sockPath = token.slice(secondPipe + 1);
  if (!/^[0-9a-f]{12}$/.test(hubId) || !sockPath.endsWith(".sock")) return null;
  if (expectedDigest && !sockPath.includes(`flock-dm-v2-${expectedDigest}-${hubId}.sock`)) {
    return null;
  }
  return { hubId, sockPath };
}

function readHubLeaseRow(): { token: string; expires_at: number } | undefined {
  try {
    return getRawDb()
      .prepare("SELECT token, expires_at FROM oauth_request_lock WHERE name = ?")
      .get(DM_IPC_HUB_LOCK_NAME) as { token: string; expires_at: number } | undefined;
  } catch {
    return undefined;
  }
}

export function dmWakeSocketPath(
  databasePath?: string,
  operatorServiceRef?: string,
  hubId?: string,
): string | null {
  const digest = dmWakeClusterDigest(databasePath, operatorServiceRef);
  if (!digest) return null;
  if (hubId) return buildHubSocketPath(digest, hubId);
  if (databasePath === undefined && operatorServiceRef === undefined) {
    if ((ipcState.mode === "hub" || ipcState.mode === "client") && ipcState.clusterDigest === digest) {
      return ipcState.sockPath;
    }
    const row = readHubLeaseRow();
    if (row && row.expires_at > Date.now()) {
      const parsed = parseHubLeaseToken(row.token, digest);
      if (parsed) return parsed.sockPath;
    }
  }
  const filename = `flock-dm-v2-${digest}.sock`;
  return join(socketDirectoryFor(filename), filename);
}

function deriveIpcKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey, "", DM_IPC_KEY_INFO, 32));
}

function encodeIpcFrame(ipcKey: Buffer, frame: IpcFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  const mac = createHmac("sha256", ipcKey).update(payload).digest();
  return Buffer.concat([header, mac, payload]);
}

function attachFrameReader(
  socket: net.Socket,
  ipcKey: Buffer,
  onFrame: (frame: IpcFrame) => void,
): void {
  let buffer: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.byteLength >= 36) {
      const bodyLen = buffer.readUInt32BE(0);
      if (bodyLen > MAX_IPC_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const frameLen = 36 + bodyLen;
      if (buffer.byteLength < frameLen) return;
      const providedMac = buffer.subarray(4, 36);
      const bodyBytes = buffer.subarray(36, frameLen);
      buffer = buffer.subarray(frameLen);

      const expectedMac = createHmac("sha256", ipcKey).update(bodyBytes).digest();
      if (!timingSafeEqual(providedMac, expectedMac)) {
        socket.destroy();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBytes.toString("utf8"));
      } catch {
        socket.destroy();
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { type?: unknown }).type !== "string") {
        socket.destroy();
        return;
      }
      onFrame(parsed as IpcFrame);
    }
  });
}

type HubPeer = {
  socket: net.Socket;
  authenticated: boolean;
  pendingAcks: Map<number, () => void>;
};

type IpcState =
  | { mode: "none" }
  | { mode: "starting"; clusterDigest: string; promise: Promise<void> }
  | {
    mode: "hub";
    clusterDigest: string;
    hubId: string;
    sockPath: string;
    leaseToken: string;
    leaseExpiresAt: number;
    ipcKey: Buffer;
    server: net.Server;
    peers: Set<HubPeer>;
    nextBcastId: number;
    heartbeatTimer?: ReturnType<typeof setInterval>;
  }
  | {
    mode: "client";
    clusterDigest: string;
    sockPath: string;
    ipcKey: Buffer;
    socket: net.Socket;
    nextReqId: number;
    pendingReqs: Map<number, { resolve: () => void; reject: (err: Error) => void }>;
  };

let ipcState: IpcState = { mode: "none" };
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let closingIntentionally = false;

function safeUnlinkSocket(sockPath: string | null | undefined): void {
  if (!sockPath) return;
  try {
    unlinkSync(sockPath);
  } catch {
    // Ignore ENOENT or already-removed socket path.
  }
}

function closeHubResources(hub: Extract<IpcState, { mode: "hub" }>): void {
  if (hub.heartbeatTimer) {
    clearInterval(hub.heartbeatTimer);
    hub.heartbeatTimer = undefined;
  }
  for (const peer of hub.peers) {
    for (const finishAck of peer.pendingAcks.values()) finishAck();
    peer.pendingAcks.clear();
    peer.socket.destroy();
  }
  hub.peers.clear();
  try {
    hub.server.close();
  } catch {
    // Ignore already-closed server.
  }
  safeUnlinkSocket(hub.sockPath);
}

function stepDownHub(hub: Extract<IpcState, { mode: "hub" }>): void {
  if (ipcState.mode !== "hub" || ipcState !== hub) return;
  ipcState = { mode: "none" };
  closeHubResources(hub);
  if (!closingIntentionally) {
    clusterEpoch = generateBootEpoch(clusterEpoch);
    evictedCallers = 0;
    callers.clear();
    globalEntries.clear();
    seenOpIds.clear();
    notifyListeners(undefined);
    scheduleReconnect();
  }
}

function assertAndRefreshHubLease(hub: Extract<IpcState, { mode: "hub" }>): boolean {
  if (ipcState.mode !== "hub" || ipcState !== hub) return false;
  const now = Date.now();
  if (now >= hub.leaseExpiresAt) {
    stepDownHub(hub);
    return false;
  }
  try {
    const nextExpiresAt = now + HUB_LEASE_TTL_MS;
    const res = getRawDb()
      .prepare("UPDATE oauth_request_lock SET expires_at = ? WHERE name = ? AND token = ? AND expires_at > ?")
      .run(nextExpiresAt, DM_IPC_HUB_LOCK_NAME, hub.leaseToken, now);
    if (res.changes === 1) {
      hub.leaseExpiresAt = nextExpiresAt;
      return true;
    }
  } catch {
    // Cannot prove lease ownership -> step down immediately.
  }
  stepDownHub(hub);
  return false;
}

function startHubHeartbeat(hub: Extract<IpcState, { mode: "hub" }>): void {
  const timer = setInterval(() => {
    if (ipcState.mode !== "hub" || ipcState !== hub) {
      clearInterval(timer);
      return;
    }
    assertAndRefreshHubLease(hub);
  }, HUB_HEARTBEAT_MS);
  timer.unref?.();
  hub.heartbeatTimer = timer;
}

function broadcastFromHub(
  hub: Extract<IpcState, { mode: "hub" }>,
  mutation: WakeMutation,
): Promise<void> {
  const authedPeers = [...hub.peers].filter((peer) => peer.authenticated && !peer.socket.destroyed);
  if (authedPeers.length === 0) return Promise.resolve();

  const bcastId = ++hub.nextBcastId;
  const rawFrame = encodeIpcFrame(hub.ipcKey, { type: "wake", bcastId, mutation });
  const ackPromises = authedPeers.map((peer) =>
    new Promise<void>((resolveAck) => {
      const finish = () => {
        clearTimeout(timer);
        peer.pendingAcks.delete(bcastId);
        resolveAck();
      };
      const timer = setTimeout(finish, IPC_ACK_TIMEOUT_MS);
      timer.unref?.();
      peer.pendingAcks.set(bcastId, finish);
      try {
        peer.socket.write(rawFrame);
      } catch {
        finish();
      }
    }),
  );
  return Promise.all(ackPromises).then(() => undefined);
}

function broadcastResetFromHub(hub: Extract<IpcState, { mode: "hub" }>): void {
  const rawFrame = encodeIpcFrame(hub.ipcKey, { type: "reset", epoch: clusterEpoch, maxSpaces: maxTrackedDmSpaces });
  for (const peer of hub.peers) {
    if (peer.authenticated && !peer.socket.destroyed) {
      try {
        peer.socket.write(rawFrame);
      } catch {
        // Ignore broken peer socket.
      }
    }
  }
}

async function applyAuthoritativeWakeOnHub(
  hub: Extract<IpcState, { mode: "hub" }>,
  opId: string | undefined,
  callerDid: string,
  space: string,
  nowMs: number,
): Promise<void> {
  if (!assertAndRefreshHubLease(hub)) {
    throw new HubOwnershipLostError();
  }
  if (opId) {
    const existing = seenOpIds.get(opId);
    if (existing) {
      await existing;
      if (!assertAndRefreshHubLease(hub)) {
        throw new HubOwnershipLostError();
      }
      return;
    }
  }

  checkAndRecordRateLimit(callerDid, space, nowMs);
  const mutation = applyAuthoritativeWake(callerDid, space);
  notifyMutationListeners(mutation);
  const bcast = broadcastFromHub(hub, mutation);

  if (opId) {
    seenOpIds.set(opId, bcast);
    while (seenOpIds.size > MAX_SEEN_OP_IDS) {
      const oldest = seenOpIds.keys().next();
      if (oldest.done) break;
      seenOpIds.delete(oldest.value);
    }
  }

  await bcast;
  if (!assertAndRefreshHubLease(hub)) {
    throw new HubOwnershipLostError();
  }
}

async function applyLocalOnlyWakeIdempotent(
  opId: string | undefined,
  callerDid: string,
  space: string,
  nowMs: number,
): Promise<void> {
  if (opId) {
    const existing = seenOpIds.get(opId);
    if (existing) {
      await existing;
      return;
    }
  }

  checkAndRecordRateLimit(callerDid, space, nowMs);
  const mutation = applyAuthoritativeWake(callerDid, space);
  notifyMutationListeners(mutation);

  if (opId) {
    seenOpIds.set(opId, Promise.resolve());
    while (seenOpIds.size > MAX_SEEN_OP_IDS) {
      const oldest = seenOpIds.keys().next();
      if (oldest.done) break;
      seenOpIds.delete(oldest.value);
    }
  }
}

function tryListenAsHub(
  clusterDigest: string,
  hubId: string,
  sockPath: string,
  leaseToken: string,
  ipcKey: Buffer,
): Promise<Extract<IpcState, { mode: "hub" }> | null> {
  return new Promise((resolveHub, rejectHub) => {
    const peers = new Set<HubPeer>();
    let hubRef: Extract<IpcState, { mode: "hub" }> | null = null;
    const server = net.createServer((peerSocket) => {
      peerSocket.unref();
      const nonce = randomBytes(16).toString("hex");
      const peer: HubPeer = {
        socket: peerSocket,
        authenticated: false,
        pendingAcks: new Map(),
      };
      peers.add(peer);

      const authTimer = setTimeout(() => {
        if (!peer.authenticated) peerSocket.destroy();
      }, IPC_HANDSHAKE_TIMEOUT_MS);
      authTimer.unref?.();

      const cleanupPeer = () => {
        clearTimeout(authTimer);
        peers.delete(peer);
        for (const finishAck of peer.pendingAcks.values()) finishAck();
        peer.pendingAcks.clear();
      };
      peerSocket.once("close", cleanupPeer);
      peerSocket.on("error", () => peerSocket.destroy());

      attachFrameReader(peerSocket, ipcKey, (frame) => {
        if (!peer.authenticated) {
          if (frame.type !== "auth" || frame.nonce !== nonce || frame.version !== DM_IPC_PROTOCOL_VERSION) {
            peerSocket.destroy();
            return;
          }
          if (!hubRef || !assertAndRefreshHubLease(hubRef)) {
            peerSocket.destroy();
            return;
          }
          clearTimeout(authTimer);
          peer.authenticated = true;
          peerSocket.write(
            encodeIpcFrame(ipcKey, {
              type: "snapshot_begin",
              epoch: clusterEpoch,
              evictedCallers,
              maxSpaces: maxTrackedDmSpaces,
            }),
          );
          for (const chunk of buildSnapshotChunks()) {
            peerSocket.write(
              encodeIpcFrame(ipcKey, {
                type: "snapshot_chunk",
                callers: chunk,
              }),
            );
          }
          peerSocket.write(encodeIpcFrame(ipcKey, { type: "snapshot_end" }));
          return;
        }

        if (frame.type === "wake_ack") {
          peer.pendingAcks.get(frame.bcastId)?.();
          return;
        }

        if (frame.type === "record_wake") {
          if (!hubRef || !assertAndRefreshHubLease(hubRef)) {
            peerSocket.destroy();
            return;
          }
          if (!isDid(frame.callerDid) || !parseDmSpaceUri(frame.space)) {
            peerSocket.write(encodeIpcFrame(ipcKey, { type: "record_ok", reqId: frame.reqId }));
            return;
          }
          void applyAuthoritativeWakeOnHub(hubRef, frame.opId, frame.callerDid, frame.space, frame.nowMs).then(
            () => {
              if (!peerSocket.destroyed) {
                peerSocket.write(encodeIpcFrame(ipcKey, { type: "record_ok", reqId: frame.reqId }));
              }
            },
            (err: unknown) => {
              if (peerSocket.destroyed) return;
              if (err instanceof HubOwnershipLostError) {
                peerSocket.destroy();
                return;
              }
              if (err instanceof DmRateLimitError) {
                peerSocket.write(
                  encodeIpcFrame(ipcKey, {
                    type: "record_err",
                    reqId: frame.reqId,
                    code: "rate_limit",
                    message: err.message,
                  }),
                );
                return;
              }
              peerSocket.write(
                encodeIpcFrame(ipcKey, {
                  type: "record_err",
                  reqId: frame.reqId,
                  code: "error",
                  message: "DM wake failed.",
                }),
              );
            },
          );
        }
      });

      peerSocket.write(encodeIpcFrame(ipcKey, { type: "challenge", nonce, version: DM_IPC_PROTOCOL_VERSION }));
    });
    server.unref();

    const onListenError = (err: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      if (err.code === "EADDRINUSE") {
        resolveHub(null);
        return;
      }
      rejectHub(err);
    };

    server.once("error", onListenError);
    server.listen(sockPath, () => {
      server.removeListener("error", onListenError);
      server.on("error", () => undefined);
      try {
        chmodSync(sockPath, 0o600);
      } catch {
        // Ignore if platform does not support chmod on socket inode.
      }
      hubRef = {
        mode: "hub",
        clusterDigest,
        hubId,
        sockPath,
        leaseToken,
        leaseExpiresAt: 0,
        ipcKey,
        server,
        peers,
        nextBcastId: 0,
      };
      resolveHub(hubRef);
    });
  });
}

function disconnectClientState(client: Extract<IpcState, { mode: "client" }>): void {
  for (const pending of client.pendingReqs.values()) {
    pending.reject(new Error("DM wake hub disconnected."));
  }
  client.pendingReqs.clear();
  if (!client.socket.destroyed) {
    client.socket.destroy();
  }
  if (ipcState.mode === "client" && ipcState === client) {
    ipcState = { mode: "none" };
    if (!closingIntentionally) {
      clusterEpoch = generateBootEpoch(clusterEpoch);
      evictedCallers = 0;
      callers.clear();
      globalEntries.clear();
      seenOpIds.clear();
      notifyListeners(undefined);
      scheduleReconnect();
    }
  }
}

function tryConnectToHub(
  clusterDigest: string,
  sockPath: string,
  ipcKey: Buffer,
): Promise<Extract<IpcState, { mode: "client" }> | "enoent" | "stale_refused" | "protocol_failed"> {
  return new Promise((resolveConn, rejectConn) => {
    const socket = net.createConnection(sockPath);
    let connected = false;
    let settled = false;
    const pendingReqs = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
    let pendingSnapshot: {
      epoch: string;
      evictedCallers: number;
      maxSpaces?: number;
      callers: Map<string, CallerWakeState>;
    } | null = null;

    socket.once("connect", () => {
      connected = true;
    });

    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHandshakeTimer = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = undefined;
      }
    };
    const refreshHandshakeTimer = () => {
      clearHandshakeTimer();
      handshakeTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolveConn("protocol_failed");
        }
      }, IPC_HANDSHAKE_TIMEOUT_MS);
      handshakeTimer.unref?.();
    };
    refreshHandshakeTimer();

    const finishSnapshotHandshake = (
      epoch: string,
      nextEvictedCallers: number,
      snapshotCallers: Map<string, CallerWakeState>,
      nextMaxSpaces?: number,
    ) => {
      settled = true;
      clearHandshakeTimer();
      socket.removeListener("error", onEarlyError);
      socket.on("error", () => socket.destroy());
      socket.unref();
      loadSnapshot(epoch, nextEvictedCallers, snapshotCallers, nextMaxSpaces);
      resolveConn({
        mode: "client",
        clusterDigest,
        sockPath,
        ipcKey,
        socket,
        nextReqId: 0,
        pendingReqs,
      });
    };

    const onEarlyError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearHandshakeTimer();
      socket.destroy();
      if (err.code === "ENOENT") {
        resolveConn("enoent");
      } else if (!connected && err.code === "ECONNREFUSED") {
        resolveConn("stale_refused");
      } else if (connected || err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "EPIPE") {
        resolveConn("protocol_failed");
      } else {
        rejectConn(err);
      }
    };

    socket.once("error", onEarlyError);
    socket.once("close", () => {
      if (!settled) {
        settled = true;
        clearHandshakeTimer();
        resolveConn("protocol_failed");
        return;
      }
      for (const pending of pendingReqs.values()) {
        pending.reject(new Error("DM wake hub disconnected."));
      }
      pendingReqs.clear();
      if (!closingIntentionally && ipcState.mode === "client" && ipcState.socket === socket) {
        ipcState = { mode: "none" };
        // Hub exited: rotate epoch so attached followers receive a clean reset, then re-elect.
        clusterEpoch = generateBootEpoch(clusterEpoch);
        evictedCallers = 0;
        callers.clear();
        globalEntries.clear();
        seenOpIds.clear();
        notifyListeners(undefined);
        scheduleReconnect();
      }
    });

    attachFrameReader(socket, ipcKey, (frame) => {
      if (!settled) {
        if (frame.type === "challenge") {
          if (frame.version !== DM_IPC_PROTOCOL_VERSION) {
            socket.destroy();
            return;
          }
          refreshHandshakeTimer();
          socket.write(encodeIpcFrame(ipcKey, { type: "auth", nonce: frame.nonce, version: DM_IPC_PROTOCOL_VERSION }));
          return;
        }
        if (frame.type === "snapshot_begin") {
          refreshHandshakeTimer();
          pendingSnapshot = {
            epoch: frame.epoch,
            evictedCallers: frame.evictedCallers,
            maxSpaces: frame.maxSpaces,
            callers: new Map(),
          };
          return;
        }
        if (frame.type === "snapshot_chunk") {
          if (!pendingSnapshot) {
            socket.destroy();
            return;
          }
          refreshHandshakeTimer();
          mergeSerializedCallers(pendingSnapshot.callers, frame.callers);
          return;
        }
        if (frame.type === "snapshot_end") {
          if (!pendingSnapshot) {
            socket.destroy();
            return;
          }
          const completed = pendingSnapshot;
          pendingSnapshot = null;
          finishSnapshotHandshake(completed.epoch, completed.evictedCallers, completed.callers, completed.maxSpaces);
          return;
        }
        socket.destroy();
        return;
      }

      if (frame.type === "wake") {
        applyReplicaMutation(frame.mutation);
        notifyMutationListeners(frame.mutation);
        if (!socket.destroyed) {
          socket.write(encodeIpcFrame(ipcKey, { type: "wake_ack", bcastId: frame.bcastId }));
        }
        return;
      }

      if (frame.type === "reset") {
        clusterEpoch = frame.epoch;
        if (typeof frame.maxSpaces === "number" && Number.isSafeInteger(frame.maxSpaces) && frame.maxSpaces >= 1) {
          maxTrackedDmSpaces = frame.maxSpaces;
        }
        evictedCallers = 0;
        callers.clear();
        globalEntries.clear();
        seenOpIds.clear();
        notifyListeners(undefined);
        return;
      }

      if (frame.type === "record_ok") {
        const req = pendingReqs.get(frame.reqId);
        if (req) {
          pendingReqs.delete(frame.reqId);
          req.resolve();
        }
        return;
      }

      if (frame.type === "record_err") {
        const req = pendingReqs.get(frame.reqId);
        if (req) {
          pendingReqs.delete(frame.reqId);
          req.reject(frame.code === "rate_limit" ? new DmRateLimitError(frame.message) : new Error(frame.message));
        }
      }
    });
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer || closingIntentionally) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (!closingIntentionally) {
      void ensureDmWakeReady().catch(() => undefined);
    }
  }, 25);
  reconnectTimer.unref?.();
}

function shortDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function claimVacantOrExpiredHubLease(
  myToken: string,
  expectedDigest: string,
): { won: boolean; expiresAt: number; staleSockPath: string | null } {
  const db = getRawDb();
  return db.transaction(() => {
    const now = Date.now();
    const expiresAt = now + HUB_LEASE_TTL_MS;
    const prev = db
      .prepare("SELECT token, expires_at FROM oauth_request_lock WHERE name = ?")
      .get(DM_IPC_HUB_LOCK_NAME) as { token: string; expires_at: number } | undefined;
    const res = db
      .prepare(`
        INSERT INTO oauth_request_lock (name, token, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE oauth_request_lock.expires_at <= ?
      `)
      .run(DM_IPC_HUB_LOCK_NAME, myToken, expiresAt, now);
    if (res.changes === 1) {
      const staleSockPath = prev ? parseHubLeaseToken(prev.token, expectedDigest)?.sockPath ?? null : null;
      return { won: true, expiresAt, staleSockPath };
    }
    return { won: false, expiresAt: 0, staleSockPath: null };
  }).immediate();
}

function takeOverDeadHubLease(
  myToken: string,
  deadToken: string,
  expectedDigest: string,
): { won: boolean; expiresAt: number; deadSockPath: string | null } {
  const db = getRawDb();
  return db.transaction(() => {
    const now = Date.now();
    const expiresAt = now + HUB_LEASE_TTL_MS;
    const cur = db
      .prepare("SELECT token, expires_at FROM oauth_request_lock WHERE name = ?")
      .get(DM_IPC_HUB_LOCK_NAME) as { token: string; expires_at: number } | undefined;
    if (!cur) {
      db.prepare("INSERT INTO oauth_request_lock (name, token, expires_at) VALUES (?, ?, ?)")
        .run(DM_IPC_HUB_LOCK_NAME, myToken, expiresAt);
      return { won: true, expiresAt, deadSockPath: parseHubLeaseToken(deadToken, expectedDigest)?.sockPath ?? null };
    }
    if (cur.token === deadToken) {
      const res = db
        .prepare("UPDATE oauth_request_lock SET token = ?, expires_at = ? WHERE name = ? AND token = ?")
        .run(myToken, expiresAt, DM_IPC_HUB_LOCK_NAME, deadToken);
      if (res.changes === 1) {
        return { won: true, expiresAt, deadSockPath: parseHubLeaseToken(deadToken, expectedDigest)?.sockPath ?? null };
      }
      return { won: false, expiresAt: 0, deadSockPath: null };
    }
    if (cur.expires_at <= now) {
      const res = db
        .prepare("UPDATE oauth_request_lock SET token = ?, expires_at = ? WHERE name = ? AND expires_at <= ?")
        .run(myToken, expiresAt, DM_IPC_HUB_LOCK_NAME, now);
      if (res.changes === 1) {
        return { won: true, expiresAt, deadSockPath: parseHubLeaseToken(cur.token, expectedDigest)?.sockPath ?? null };
      }
    }
    return { won: false, expiresAt: 0, deadSockPath: null };
  }).immediate();
}

async function tryElectSelfAsHub(
  clusterDigest: string,
  ipcKey: Buffer,
  deadLeaseToken?: string,
): Promise<Extract<IpcState, { mode: "hub" }> | null> {
  const hubId = randomBytes(6).toString("hex");
  const sockPath = buildHubSocketPath(clusterDigest, hubId);
  const leaseToken = formatHubLeaseToken(hubId, sockPath);
  const hub = await tryListenAsHub(clusterDigest, hubId, sockPath, leaseToken, ipcKey);
  if (!hub) return null;

  let claim: { won: boolean; expiresAt: number; staleSockPath: string | null };
  try {
    if (deadLeaseToken !== undefined) {
      const taken = takeOverDeadHubLease(leaseToken, deadLeaseToken, clusterDigest);
      claim = { won: taken.won, expiresAt: taken.expiresAt, staleSockPath: taken.deadSockPath };
    } else {
      claim = claimVacantOrExpiredHubLease(leaseToken, clusterDigest);
    }
  } catch (err) {
    closeHubResources(hub);
    throw err;
  }

  if (!claim.won) {
    closeHubResources(hub);
    return null;
  }

  hub.leaseExpiresAt = claim.expiresAt;
  if (claim.staleSockPath && claim.staleSockPath !== sockPath) {
    safeUnlinkSocket(claim.staleSockPath);
  }
  startHubHeartbeat(hub);
  return hub;
}

function configuredIpcRequirements(): { clusterDigest: string; encryptionKey: Buffer } | null {
  try {
    const cfg = getOperatorConfig();
    const clusterDigest = dmWakeClusterDigest(cfg.databasePath, cfg.operatorServiceRef);
    if (!clusterDigest) return null;
    return { clusterDigest, encryptionKey: cfg.encryptionKey };
  } catch {
    return null;
  }
}

async function establishIpc(clusterDigest: string, ipcKey: Buffer): Promise<void> {
  // Ensure SQLite schema (`oauth_request_lock`) is initialized before leader election.
  getRawDb();

  let protocolFailures = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = Date.now();
    const row = readHubLeaseRow();
    const activeLease = row && row.expires_at > now ? parseHubLeaseToken(row.token, clusterDigest) : null;

    if (row && activeLease) {
      const conn = await tryConnectToHub(clusterDigest, activeLease.sockPath, ipcKey);
      if (typeof conn === "object") {
        ipcState = conn;
        return;
      }
      if (conn === "protocol_failed") {
        // A live hub socket accepted the connection and failed protocol/auth handshake:
        // NEVER unlink its socket, NEVER steal its lease, and NEVER degrade to isolated local authority!
        protocolFailures += 1;
        if (protocolFailures >= 2) {
          throw new DmWakeIpcError("DM wake IPC handshake with active hub failed.");
        }
        await shortDelay(10);
        continue;
      }
      // `enoent` or `stale_refused` on a published unique hub socket means that specific hub process died.
      const takeoverHub = await tryElectSelfAsHub(clusterDigest, ipcKey, row.token);
      if (takeoverHub) {
        ipcState = takeoverHub;
        return;
      }
      // Another worker won the atomic CAS takeover; connect to the new winner on the next iteration.
      continue;
    }

    // No unexpired valid hub lease exists: bind a fresh unique socket and atomically claim `dm_ipc_hub`.
    const electedHub = await tryElectSelfAsHub(clusterDigest, ipcKey);
    if (electedHub) {
      ipcState = electedHub;
      return;
    }
    // Another concurrent worker won `dm_ipc_hub`; loop immediately to connect to it.
    if (attempt > 1) {
      await shortDelay(10 * attempt);
    }
  }

  throw new DmWakeIpcError("DM wake IPC election exhausted without connecting to an active hub.");
}

function currentIpcState(): IpcState {
  return ipcState;
}

export async function ensureDmWakeReady(): Promise<void> {
  const req = configuredIpcRequirements();
  if (!req) return;
  const { clusterDigest, encryptionKey } = req;

  if (ipcState.mode === "hub" && ipcState.clusterDigest === clusterDigest && assertAndRefreshHubLease(ipcState)) {
    return;
  }
  if (ipcState.mode === "client" && ipcState.clusterDigest === clusterDigest && !ipcState.socket.destroyed) {
    return;
  }
  if (ipcState.mode === "starting" && ipcState.clusterDigest === clusterDigest) {
    await ipcState.promise;
    const afterStart = currentIpcState();
    if (
      (afterStart.mode === "hub" || (afterStart.mode === "client" && !afterStart.socket.destroyed))
      && afterStart.clusterDigest === clusterDigest
    ) {
      return;
    }
    throw new DmWakeIpcError();
  }

  closeDmWakeIpc({ keepMemoryState: true });
  closingIntentionally = false;
  const ipcKey = deriveIpcKey(encryptionKey);
  const promise = establishIpc(clusterDigest, ipcKey).finally(() => {
    if (ipcState.mode === "starting" && ipcState.promise === promise) {
      ipcState = { mode: "none" };
    }
  });
  ipcState = { mode: "starting", clusterDigest, promise };
  await promise;
}

function sendRecordWakeToHub(
  client: Extract<IpcState, { mode: "client" }>,
  opId: string,
  callerDid: string,
  space: string,
  nowMs: number,
): Promise<void> {
  const reqId = ++client.nextReqId;
  return new Promise<void>((resolveReq, rejectReq) => {
    const timer = setTimeout(() => {
      client.pendingReqs.delete(reqId);
      rejectReq(new Error("DM wake hub request timed out."));
    }, IPC_RPC_TIMEOUT_MS);
    timer.unref?.();

    client.pendingReqs.set(reqId, {
      resolve: () => {
        clearTimeout(timer);
        resolveReq();
      },
      reject: (err) => {
        clearTimeout(timer);
        rejectReq(err);
      },
    });

    try {
      client.socket.write(
        encodeIpcFrame(client.ipcKey, {
          type: "record_wake",
          reqId,
          opId,
          callerDid,
          space,
          nowMs,
        }),
      );
    } catch (err) {
      clearTimeout(timer);
      client.pendingReqs.delete(reqId);
      rejectReq(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Records an ephemeral, caller-scoped wake for `(callerDid, space)` (`dm.inbox` or `dm.conversation`), enforcing
 * per-`(callerDid, space)` rate limiting and broadcasting across any host-local operator workers sharing `DATABASE_PATH`
 * before resolving. Never writes DM URIs, DIDs, or user activity to SQLite.
 */
export async function recordDmWake(callerDid: string, space: string, nowMs = Date.now()): Promise<void> {
  if (!isDid(callerDid) || !parseDmSpaceUri(space)) return;
  const opId = randomBytes(12).toString("hex");

  const req = configuredIpcRequirements();
  if (!req) {
    await applyLocalOnlyWakeIdempotent(opId, callerDid, space, nowMs);
    return;
  }

  let lastIpcError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await ensureDmWakeReady();
    } catch (error) {
      lastIpcError = error;
      if (attempt < 3) {
        await shortDelay(25 * (attempt + 1));
        continue;
      }
      throw error instanceof DmWakeIpcError ? error : new DmWakeIpcError("DM wake IPC coordination unavailable.");
    }

    if (ipcState.mode === "client") {
      if (ipcState.socket.destroyed) {
        disconnectClientState(ipcState);
        continue;
      }
      const client = ipcState;
      try {
        await sendRecordWakeToHub(client, opId, callerDid, space, nowMs);
        return;
      } catch (error) {
        if (error instanceof DmRateLimitError) throw error;
        lastIpcError = error;
        disconnectClientState(client);
        continue;
      }
    }

    if (ipcState.mode === "hub") {
      const hub = ipcState;
      try {
        await applyAuthoritativeWakeOnHub(hub, opId, callerDid, space, nowMs);
        return;
      } catch (error) {
        if (error instanceof DmRateLimitError) throw error;
        lastIpcError = error;
        if (error instanceof HubOwnershipLostError) {
          continue;
        }
        throw error;
      }
    }
  }

  throw lastIpcError instanceof DmWakeIpcError
    ? lastIpcError
    : new DmWakeIpcError("DM wake hub unavailable after reconnection retries.");
}

export const recordDmSpaceWake = recordDmWake;

export function closeDmWakeIpc(options?: { keepMemoryState?: boolean }): void {
  closingIntentionally = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const current = ipcState;
  ipcState = { mode: "none" };
  if (current.mode === "client") {
    for (const pending of current.pendingReqs.values()) {
      pending.reject(new Error("DM wake IPC closed."));
    }
    current.pendingReqs.clear();
    current.socket.destroy();
  } else if (current.mode === "hub") {
    closeHubResources(current);
    try {
      getRawDb()
        .prepare("DELETE FROM oauth_request_lock WHERE name = ? AND token = ?")
        .run(DM_IPC_HUB_LOCK_NAME, current.leaseToken);
    } catch {
      // Ignore if DB is already closed or uninitialized.
    }
  }
  if (!options?.keepMemoryState) {
    clusterEpoch = generateBootEpoch(clusterEpoch);
    evictedCallers = 0;
    maxTrackedDmSpaces = MAX_TRACKED_DM_SPACES;
    callers.clear();
    globalEntries.clear();
    rateBuckets.clear();
    seenOpIds.clear();
  }
}

onDbClose(() => {
  closeDmWakeIpc();
});

/** Simulates an operator process restart for unit tests (rotates `clusterEpoch` and clears in-memory DM state). */
export function resetDmFeedWakesForTests(options?: { maxSpaces?: number }): void {
  if (options?.maxSpaces !== undefined && Number.isFinite(options.maxSpaces)) {
    maxTrackedDmSpaces = Math.max(1, Math.floor(options.maxSpaces));
  } else {
    maxTrackedDmSpaces = MAX_TRACKED_DM_SPACES;
  }
  clusterEpoch = generateBootEpoch(clusterEpoch);
  evictedCallers = 0;
  callers.clear();
  globalEntries.clear();
  rateBuckets.clear();
  seenOpIds.clear();
  if (ipcState.mode === "hub") {
    broadcastResetFromHub(ipcState);
  }
  notifyListeners(undefined);
}
