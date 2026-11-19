import { chmodSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isDid, parseDmSpaceUri } from "@flock/protocol/keys";
import { getOperatorConfig } from "../config";
import { onDbClose } from "../lib/db";

// Ephemeral, caller-scoped DM wake tracker with host-local multi-process Unix domain socket coordination.
// Zero DM rows are ever persisted to SQLite, and zero DM data files are written to disk.

export const MAX_TRACKED_DM_CALLERS = 50_000;
export const MAX_TRACKED_DM_SPACES = 50_000;
export const MAX_SPACES_PER_CALLER = 2_000;
/** 36^4 - 1: keeps base36 sequence <= 4 chars so `<epoch>.<dbBase36>.<dmBase36>` always fits within 16 chars. */
export const MAX_DM_SEQ_PER_EPOCH = 36 ** 4 - 1;
export const DM_WAKE_RATE_LIMIT_MAX = 120;
export const DM_WAKE_RATE_LIMIT_WINDOW_MS = 60_000;

const MAX_RATE_LIMIT_BUCKETS = 50_000;
const DM_IPC_KEY_INFO = "flock-dm-ipc-v1";
const MAX_IPC_FRAME_BYTES = 8 * 1024 * 1024;
const IPC_HANDSHAKE_TIMEOUT_MS = 3_000;
const IPC_ACK_TIMEOUT_MS = 1_500;
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

type WakeMutation = {
  callerDid: string;
  space: string;
  callerEpoch: string;
  head: number;
  seq: number;
  evictedFloor: number;
  evictedCallers: number;
};

type RateBucket = {
  windowStartMs: number;
  count: number;
};

type IpcFrame =
  | { type: "challenge"; nonce: string }
  | { type: "auth"; nonce: string }
  | { type: "snapshot"; epoch: string; evictedCallers: number; callers: SerializedCallerState[] }
  | { type: "wake"; bcastId: number; mutation: WakeMutation }
  | { type: "wake_ack"; bcastId: number }
  | { type: "record_wake"; reqId: number; callerDid: string; space: string; nowMs: number }
  | { type: "record_ok"; reqId: number }
  | { type: "record_err"; reqId: number; code: "rate_limit" | "error"; message: string }
  | { type: "reset"; epoch: string };

function generateBootEpoch(previous?: string): string {
  while (true) {
    const bytes = randomBytes(3);
    const candidate = `${ALPHA[bytes[0]! % ALPHA.length]}${BASE36[bytes[1]! % BASE36.length]}${BASE36[bytes[2]! % BASE36.length]}`;
    if (candidate !== previous) return candidate;
  }
}

let clusterEpoch = generateBootEpoch();
let evictedCallers = 0;
const callers = new Map<string, CallerWakeState>();
const rateBuckets = new Map<string, RateBucket>();
const wakeListeners = new Set<(callerDid?: string) => void>();

function notifyListeners(callerDid?: string): void {
  for (const listener of [...wakeListeners]) listener(callerDid);
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
  return new Promise((resolve) => {
    if (withinMs <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      unsub();
      resolve();
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
    state.epoch = generateBootEpoch(state.epoch);
    state.head = 0;
    state.evictedFloor = 0;
    state.spaces.clear();
  }

  state.head += 1;
  state.spaces.delete(space);
  state.spaces.set(space, state.head);

  while (state.spaces.size > MAX_SPACES_PER_CALLER) {
    const oldest = state.spaces.entries().next();
    if (oldest.done) break;
    const [oldestSpace, oldestSeq] = oldest.value;
    state.spaces.delete(oldestSpace);
    if (oldestSeq > state.evictedFloor) state.evictedFloor = oldestSeq;
  }

  callers.set(callerDid, state);
  while (callers.size > MAX_TRACKED_DM_CALLERS) {
    const oldestCaller = callers.keys().next();
    if (oldestCaller.done) break;
    callers.delete(oldestCaller.value);
    evictedCallers += 1;
  }

  return {
    callerDid,
    space,
    callerEpoch: state.epoch,
    head: state.head,
    seq: state.head,
    evictedFloor: state.evictedFloor,
    evictedCallers,
  };
}

function applyReplicaMutation(mutation: WakeMutation): void {
  let state = callers.get(mutation.callerDid);
  if (!state || state.epoch !== mutation.callerEpoch || mutation.head < state.head) {
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
  while (state.spaces.size > MAX_SPACES_PER_CALLER) {
    const oldest = state.spaces.entries().next();
    if (oldest.done) break;
    const [oldestSpace, oldestSeq] = oldest.value;
    state.spaces.delete(oldestSpace);
    if (oldestSeq > state.evictedFloor) state.evictedFloor = oldestSeq;
  }
  callers.set(mutation.callerDid, state);
  evictedCallers = mutation.evictedCallers;
  while (callers.size > MAX_TRACKED_DM_CALLERS) {
    const oldestCaller = callers.keys().next();
    if (oldestCaller.done) break;
    callers.delete(oldestCaller.value);
  }
}

function serializeCallers(): SerializedCallerState[] {
  const out: SerializedCallerState[] = [];
  for (const [callerDid, state] of callers) {
    out.push({
      callerDid,
      epoch: state.epoch,
      head: state.head,
      evictedFloor: state.evictedFloor,
      spaces: [...state.spaces.entries()],
    });
  }
  return out;
}

function loadSnapshot(epoch: string, nextEvictedCallers: number, snapshotCallers: readonly SerializedCallerState[]): void {
  clusterEpoch = epoch;
  evictedCallers = nextEvictedCallers;
  callers.clear();
  for (const item of snapshotCallers) {
    callers.set(item.callerDid, {
      epoch: item.epoch,
      head: item.head,
      evictedFloor: item.evictedFloor,
      spaces: new Map(item.spaces),
    });
  }
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

export function dmWakeSocketPath(databasePath?: string, operatorServiceRef?: string): string | null {
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
  const digest = createHash("sha256")
    .update(`${resolve(dbPath)}\0${serviceRef ?? ""}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `flock-dm-${digest}.sock`);
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
  | { mode: "starting"; sockPath: string; promise: Promise<void> }
  | {
    mode: "hub";
    sockPath: string;
    ipcKey: Buffer;
    server: net.Server;
    peers: Set<HubPeer>;
    nextBcastId: number;
  }
  | {
    mode: "client";
    sockPath: string;
    ipcKey: Buffer;
    socket: net.Socket;
    nextReqId: number;
    pendingReqs: Map<number, { resolve: () => void; reject: (err: Error) => void }>;
  };

let ipcState: IpcState = { mode: "none" };
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let closingIntentionally = false;

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
  const rawFrame = encodeIpcFrame(hub.ipcKey, { type: "reset", epoch: clusterEpoch });
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

function tryListenAsHub(sockPath: string, ipcKey: Buffer): Promise<Extract<IpcState, { mode: "hub" }> | null> {
  return new Promise((resolveHub, rejectHub) => {
    const peers = new Set<HubPeer>();
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
          if (frame.type !== "auth" || frame.nonce !== nonce) {
            peerSocket.destroy();
            return;
          }
          clearTimeout(authTimer);
          peer.authenticated = true;
          peerSocket.write(
            encodeIpcFrame(ipcKey, {
              type: "snapshot",
              epoch: clusterEpoch,
              evictedCallers,
              callers: serializeCallers(),
            }),
          );
          return;
        }

        if (frame.type === "wake_ack") {
          peer.pendingAcks.get(frame.bcastId)?.();
          return;
        }

        if (frame.type === "record_wake") {
          if (!isDid(frame.callerDid) || !parseDmSpaceUri(frame.space)) {
            peerSocket.write(encodeIpcFrame(ipcKey, { type: "record_ok", reqId: frame.reqId }));
            return;
          }
          try {
            checkAndRecordRateLimit(frame.callerDid, frame.space, frame.nowMs);
          } catch (err) {
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
            return;
          }

          const mutation = applyAuthoritativeWake(frame.callerDid, frame.space);
          notifyListeners(frame.callerDid);
          const currentHub = ipcState.mode === "hub" ? ipcState : null;
          const bcast = currentHub ? broadcastFromHub(currentHub, mutation) : Promise.resolve();
          void bcast.finally(() => {
            if (!peerSocket.destroyed) {
              peerSocket.write(encodeIpcFrame(ipcKey, { type: "record_ok", reqId: frame.reqId }));
            }
          });
        }
      });

      peerSocket.write(encodeIpcFrame(ipcKey, { type: "challenge", nonce }));
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
      resolveHub({
        mode: "hub",
        sockPath,
        ipcKey,
        server,
        peers,
        nextBcastId: 0,
      });
    });
  });
}

function tryConnectToHub(
  sockPath: string,
  ipcKey: Buffer,
): Promise<Extract<IpcState, { mode: "client" }> | "enoent" | "refused"> {
  return new Promise((resolveConn, rejectConn) => {
    const socket = net.createConnection(sockPath);
    socket.unref();
    let settled = false;
    const pendingReqs = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();

    const handshakeTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolveConn("refused");
      }
    }, IPC_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    const onEarlyError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      socket.destroy();
      if (err.code === "ENOENT") {
        resolveConn("enoent");
      } else if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
        resolveConn("refused");
      } else {
        rejectConn(err);
      }
    };

    socket.once("error", onEarlyError);
    socket.once("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(handshakeTimer);
        resolveConn("refused");
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
        notifyListeners(undefined);
        scheduleReconnect();
      }
    });

    attachFrameReader(socket, ipcKey, (frame) => {
      if (!settled) {
        if (frame.type === "challenge") {
          socket.write(encodeIpcFrame(ipcKey, { type: "auth", nonce: frame.nonce }));
          return;
        }
        if (frame.type === "snapshot") {
          settled = true;
          clearTimeout(handshakeTimer);
          socket.removeListener("error", onEarlyError);
          socket.on("error", () => socket.destroy());
          loadSnapshot(frame.epoch, frame.evictedCallers, frame.callers);
          resolveConn({
            mode: "client",
            sockPath,
            ipcKey,
            socket,
            nextReqId: 0,
            pendingReqs,
          });
          return;
        }
        return;
      }

      if (frame.type === "wake") {
        applyReplicaMutation(frame.mutation);
        notifyListeners(frame.mutation.callerDid);
        if (!socket.destroyed) {
          socket.write(encodeIpcFrame(ipcKey, { type: "wake_ack", bcastId: frame.bcastId }));
        }
        return;
      }

      if (frame.type === "reset") {
        clusterEpoch = frame.epoch;
        evictedCallers = 0;
        callers.clear();
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
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

async function establishIpc(sockPath: string, ipcKey: Buffer): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const conn = await tryConnectToHub(sockPath, ipcKey);
    if (typeof conn === "object") {
      ipcState = conn;
      return;
    }
    if (conn === "refused") {
      // Confirm stale socket after brief jitter before unlinking so concurrent startups do not unlink a live bind.
      await shortDelay(5 + Math.floor(Math.random() * 15));
      const retryConn = await tryConnectToHub(sockPath, ipcKey);
      if (typeof retryConn === "object") {
        ipcState = retryConn;
        return;
      }
      if (retryConn === "refused") {
        try {
          unlinkSync(sockPath);
        } catch {
          // Another worker may have unlinked it already.
        }
      }
    }
    const hub = await tryListenAsHub(sockPath, ipcKey);
    if (hub) {
      ipcState = hub;
      return;
    }
    await shortDelay(10 * (attempt + 1));
  }
}

export async function ensureDmWakeReady(): Promise<void> {
  let encryptionKey: Buffer;
  let sockPath: string | null;
  try {
    const cfg = getOperatorConfig();
    encryptionKey = cfg.encryptionKey;
    sockPath = dmWakeSocketPath(cfg.databasePath, cfg.operatorServiceRef);
  } catch {
    return;
  }
  if (!sockPath) return;

  if (ipcState.mode === "hub" && ipcState.sockPath === sockPath) return;
  if (ipcState.mode === "client" && ipcState.sockPath === sockPath && !ipcState.socket.destroyed) return;
  if (ipcState.mode === "starting" && ipcState.sockPath === sockPath) {
    await ipcState.promise;
    return;
  }

  closeDmWakeIpc({ keepMemoryState: true });
  closingIntentionally = false;
  const ipcKey = deriveIpcKey(encryptionKey);
  const promise = establishIpc(sockPath, ipcKey).finally(() => {
    if (ipcState.mode === "starting" && ipcState.promise === promise) {
      ipcState = { mode: "none" };
    }
  });
  ipcState = { mode: "starting", sockPath, promise };
  await promise;
}

/**
 * Records an ephemeral, caller-scoped wake for `(callerDid, space)` (`dm.inbox` or `dm.conversation`), enforcing
 * per-`(callerDid, space)` rate limiting and broadcasting across any host-local operator workers sharing `DATABASE_PATH`
 * before resolving. Never touches SQLite.
 */
export async function recordDmWake(callerDid: string, space: string, nowMs = Date.now()): Promise<void> {
  if (!isDid(callerDid) || !parseDmSpaceUri(space)) return;
  await ensureDmWakeReady();

  if (ipcState.mode === "client" && !ipcState.socket.destroyed) {
    const client = ipcState;
    const reqId = ++client.nextReqId;
    try {
      await new Promise<void>((resolveReq, rejectReq) => {
        client.pendingReqs.set(reqId, { resolve: resolveReq, reject: rejectReq });
        client.socket.write(
          encodeIpcFrame(client.ipcKey, {
            type: "record_wake",
            reqId,
            callerDid,
            space,
            nowMs,
          }),
        );
      });
      return;
    } catch (error) {
      if (error instanceof DmRateLimitError) throw error;
      // Hub disconnected mid-request: re-elect and complete on the new hub.
      await ensureDmWakeReady();
    }
  }

  checkAndRecordRateLimit(callerDid, space, nowMs);
  const mutation = applyAuthoritativeWake(callerDid, space);
  notifyListeners(callerDid);
  if (ipcState.mode === "hub") {
    await broadcastFromHub(ipcState, mutation);
  }
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
    for (const peer of current.peers) {
      for (const finishAck of peer.pendingAcks.values()) finishAck();
      peer.pendingAcks.clear();
      peer.socket.destroy();
    }
    current.peers.clear();
    try {
      current.server.close();
    } catch {
      // Ignore already-closed server.
    }
    try {
      unlinkSync(current.sockPath);
    } catch {
      // Ignore already-unlinked socket path.
    }
  }
  if (!options?.keepMemoryState) {
    clusterEpoch = generateBootEpoch(clusterEpoch);
    evictedCallers = 0;
    callers.clear();
    rateBuckets.clear();
  }
}

onDbClose(() => {
  closeDmWakeIpc();
});

/** Simulates an operator process restart for unit tests (rotates `clusterEpoch` and clears in-memory DM state). */
export function resetDmFeedWakesForTests(options?: { maxSpaces?: number }): void {
  void options;
  clusterEpoch = generateBootEpoch(clusterEpoch);
  evictedCallers = 0;
  callers.clear();
  rateBuckets.clear();
  if (ipcState.mode === "hub") {
    broadcastResetFromHub(ipcState);
  }
  notifyListeners(undefined);
}
