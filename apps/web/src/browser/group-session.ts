import { WebcryptoKey } from "@atproto/jwk-webcrypto";
import {
  OAuthCallbackError,
  OAuthClient,
  type OAuthSession,
  type RuntimeImplementation,
} from "@atproto/oauth-client";
import { atprotoLoopbackClientMetadata, type OAuthClientMetadataInput } from "@atproto/oauth-types";
import {
  GroupClient,
  groupMigrationPhaseRank,
  runWithDefaultGroupMetaLock,
  runWithDefaultGroupMigrationLock,
  type GroupMigrationCasExpected,
  type GroupMigrationPhase,
  type GroupMigrationRequestedMode,
  type GroupMigrationStateStore,
  type InFlightGroupMigration,
  type PersistedGroupMigrationState,
  type ProposedPlcOperationParams,
} from "@flock/client/group-client";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { isDid } from "@flock/protocol/keys";
import {
  groupAdminScopes,
  groupBasicEditorScopes,
  groupMembersManagerScopes,
  groupModeratorScopes,
} from "@flock/protocol/scopes";
import { buildGroupBrowserClientMetadata } from "./client-metadata";
import { wellKnownHandleResolver, type BrowserSessionConfig } from "./session";

export const GROUP_OAUTH_DB_PREFIX = "flock-group-oauth:";
export const GROUP_OAUTH_ERASURE_EPOCH_PREFIX = "flock-group-oauth-erasure-epoch:";
export const CLAIMED_ACTION_TOKEN_PREFIX = "spaces.claimedActionToken:";

export type GroupClaimPurpose = "delete_account" | "plc_operation";

export type GroupCallbackAppState = {
  viewerDid: string;
  returnTo?: string;
  purpose?: "admin" | "members" | "moderator" | "basic" | "recovery" | "step_up" | "create";
  groupDid?: string;
  claimPurpose?: GroupClaimPurpose;
  erasureGeneration?: string;
};

export type CompletedGroupCallback = {
  groupDid: string;
  session: OAuthSession;
  groupClient: GroupClient;
  appState: GroupCallbackAppState | null;
  claimedActionToken?: { purpose: GroupClaimPurpose; token: string };
};

export class GroupOAuthDeniedError extends Error {
  constructor(
    message: string,
    readonly oauthError: string,
    readonly errorDescription?: string,
  ) {
    super(message);
    this.name = "GroupOAuthDeniedError";
  }
}

const STORES = [
  "state",
  "session",
  "didCache",
  "dpopNonceCache",
  "handleCache",
  "authorizationServerMetadataCache",
  "protectedResourceMetadataCache",
] as const;

type StoreName = (typeof STORES)[number];

type EncodedWebcryptoKey = {
  keyId: string;
  keyPair: CryptoKeyPair;
};

type StoredEntry<V = unknown> = {
  value: V;
  expiresAt: string | null;
};

export function groupOAuthDbName(viewerDid: string): string {
  return `${GROUP_OAUTH_DB_PREFIX}${viewerDid}`;
}

export function claimedActionTokenKey(groupDid: string, purpose: GroupClaimPurpose): string {
  return `${CLAIMED_ACTION_TOKEN_PREFIX}${groupDid}:${purpose}`;
}

function encodeKey(key: unknown): EncodedWebcryptoKey {
  if (!(key instanceof WebcryptoKey) || !key.kid) {
    throw new Error("Invalid WebcryptoKey for GroupBrowserOAuthClient.");
  }
  return {
    keyId: key.kid,
    keyPair: key.cryptoKeyPair,
  };
}

async function decodeKey(encoded: EncodedWebcryptoKey): Promise<WebcryptoKey> {
  return WebcryptoKey.fromKeypair(encoded.keyPair, encoded.keyId);
}

function asResolvedDid(value: string): `did:plc:${string}` | `did:web:${string}` | null {
  if (!isDid(value)) return null;
  if (value.startsWith("did:plc:")) return value as `did:plc:${string}`;
  if (value.startsWith("did:web:")) return value as `did:web:${string}`;
  return null;
}

function createGroupRuntime(viewerDid: string): RuntimeImplementation {
  const requestLock: RuntimeImplementation["requestLock"] =
    typeof navigator !== "undefined" && navigator.locks?.request
      ? async <T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> => {
          let out!: T;
          await navigator.locks.request(`flock-group-lock:${viewerDid}:${name}`, { mode: "exclusive" }, async () => {
            out = await fn();
          });
          return out;
        }
      : undefined;

  return {
    async createKey() {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      return WebcryptoKey.fromKeypair(kp, crypto.randomUUID());
    },
    getRandomValues(byteLength: number) {
      return crypto.getRandomValues(new Uint8Array(byteLength));
    },
    async digest(data: Uint8Array<ArrayBuffer>, { name }) {
      switch (name) {
        case "sha256":
        case "sha384":
        case "sha512": {
          const buf = await crypto.subtle.digest(`SHA-${name.slice(3)}`, data);
          return new Uint8Array(buf);
        }
        default:
          throw new Error(`Unsupported digest algorithm: ${String(name)}`);
      }
    },
    ...(requestLock ? { requestLock } : {}),
  };
}

const fallbackErasureEpochs = new Map<string, number>();

function createKeyedAsyncMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
}

const viewerAuthProcessMutex = createKeyedAsyncMutex();

async function requestExclusiveBrowserLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") {
    let out!: T;
    await navigator.locks.request(lockName, { mode: "exclusive" }, async () => {
      out = await fn();
    });
    return out;
  }
  return fn();
}

export function withViewerAuthLock<T>(viewerDid: string, fn: () => Promise<T>): Promise<T> {
  return viewerAuthProcessMutex(viewerDid, () =>
    requestExclusiveBrowserLock(`flock-group-auth-epoch:${viewerDid}`, fn),
  );
}

function readLocalStorageAuthGeneration(viewerDid: string): string | null | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(`${GROUP_OAUTH_ERASURE_EPOCH_PREFIX}${viewerDid}`);
  } catch {
    return undefined;
  }
}

function ensureLocalStorageAuthGeneration(viewerDid: string): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const key = `${GROUP_OAUTH_ERASURE_EPOCH_PREFIX}${viewerDid}`;
    const existing = localStorage.getItem(key);
    if (existing && existing.length > 0) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return undefined;
  }
}

function clearLocalStorageAuthGeneration(viewerDid: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(`${GROUP_OAUTH_ERASURE_EPOCH_PREFIX}${viewerDid}`);
    }
  } catch {
    // Ignore storage sandbox errors.
  }
}

export function getGroupErasureEpoch(viewerDid: string): number {
  return fallbackErasureEpochs.get(viewerDid) ?? 0;
}

function bumpGroupErasureEpoch(viewerDid: string): number {
  const next = getGroupErasureEpoch(viewerDid) + 1;
  fallbackErasureEpochs.set(viewerDid, next);
  clearLocalStorageAuthGeneration(viewerDid);
  return next;
}

function groupErasureChannelName(viewerDid: string): string {
  return `flock-group-oauth:${viewerDid}`;
}

function broadcastGroupErasure(viewerDid: string, epoch: number): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(groupErasureChannelName(viewerDid));
    channel.postMessage({ type: "erased", viewerDid, epoch });
    channel.close();
  } catch {
    // Ignore environments where BroadcastChannel construction fails.
  }
}

function rawDeleteGroupOAuthIdb(viewerDid: string, idbFactory: IDBFactory): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = idbFactory.deleteDatabase(groupOAuthDbName(viewerDid));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("Failed to delete Group OAuth IndexedDB."));
    req.onblocked = () => reject(new Error("Group OAuth IndexedDB deletion was blocked."));
  });
}

function migrationStateExpiresAt(value: PersistedGroupMigrationState): Date | null {
  return value.phase === "signing_plc" || value.phase === "plc_signed" || value.phase === "plc_submitted"
    ? null
    : new Date(Date.now() + 2 * 60 * 60_000);
}

class GroupOAuthDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private closed = false;
  private readonly createdAtEpoch: number;

  constructor(
    readonly viewerDid: string,
    private readonly idbFactory: IDBFactory = globalThis.indexedDB,
  ) {
    this.createdAtEpoch = getGroupErasureEpoch(viewerDid);
  }

  get isClosed(): boolean {
    if (this.closed) return true;
    if (getGroupErasureEpoch(this.viewerDid) !== this.createdAtEpoch) {
      this.closed = true;
      return true;
    }
    return false;
  }

  private open(): Promise<IDBDatabase> {
    if (this.isClosed) {
      return Promise.reject(new Error("GroupOAuthDatabase has been closed."));
    }
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.idbFactory.open(groupOAuthDbName(this.viewerDid), 2);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name);
            store.createIndex("expiresAt", "expiresAt", { unique: false });
          }
        }
        if (event.oldVersion > 0 && event.oldVersion < 2 && tx) {
          // Clear legacy R13/R14 group.opensocial.* OAuth sessions & unversioned migration state on R15 cutover.
          if (db.objectStoreNames.contains("session")) tx.objectStore("session").clear();
          if (db.objectStoreNames.contains("state")) tx.objectStore("state").clear();
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (this.isClosed) {
          db.close();
          this.dbPromise = null;
          reject(new Error("GroupOAuthDatabase has been closed."));
          return;
        }
        db.onversionchange = (event) => {
          if (event.newVersion === null) {
            this.closed = true;
            const prev = fallbackErasureEpochs.get(this.viewerDid) ?? 0;
            if (prev <= this.createdAtEpoch) {
              fallbackErasureEpochs.set(this.viewerDid, this.createdAtEpoch + 1);
            }
          }
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error("Failed to open Group OAuth IndexedDB."));
      };
    });
    return this.dbPromise;
  }

  private async withStore<R>(
    storeName: StoreName,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> {
    const db = await this.open();
    if (this.isClosed) {
      db.close();
      this.dbPromise = null;
      throw new Error("GroupOAuthDatabase has been closed.");
    }
    return new Promise<R>((resolve, reject) => {
      const tx = db.transaction([storeName], mode);
      const req = run(tx.objectStore(storeName));
      let result!: R;
      req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error(`IndexedDB ${storeName} transaction failed.`));
      tx.onabort = () => reject(tx.error ?? new Error(`IndexedDB ${storeName} transaction aborted.`));
    });
  }

  createStore<V, E>(
    storeName: StoreName,
    codec: {
      encode: (value: V) => E | Promise<E>;
      decode: (encoded: E) => V | Promise<V>;
      expiresAt: (value: V) => Date | null;
    },
  ) {
    return {
      get: async (key: string): Promise<V | undefined> => {
        const item = await this.withStore<StoredEntry<E> | undefined>(storeName, "readonly", (s) => s.get(key));
        if (!item) return undefined;
        if (item.expiresAt !== null && new Date(item.expiresAt).getTime() <= Date.now()) {
          await this.withStore(storeName, "readwrite", (s) => s.delete(key)).catch(() => undefined);
          return undefined;
        }
        return codec.decode(item.value);
      },
      set: async (key: string, value: V): Promise<void> => {
        const encoded = await codec.encode(value);
        const exp = codec.expiresAt(value);
        const entry: StoredEntry<E> = {
          value: encoded,
          expiresAt: exp ? exp.toISOString() : null,
        };
        await this.withStore(storeName, "readwrite", (s) => s.put(entry, key));
      },
      del: async (key: string): Promise<void> => {
        await this.withStore(storeName, "readwrite", (s) => s.delete(key));
      },
    };
  }

  async compareAndSetMigrationState(
    groupDid: string,
    expected: GroupMigrationCasExpected | null,
    next: PersistedGroupMigrationState,
  ): Promise<PersistedGroupMigrationState> {
    const db = await this.open();
    if (this.isClosed) {
      db.close();
      this.dbPromise = null;
      throw new Error("GroupOAuthDatabase has been closed.");
    }
    const key = `migration:${groupDid}`;
    return new Promise<PersistedGroupMigrationState>((resolve, reject) => {
      const tx = db.transaction(["state"], "readwrite");
      const store = tx.objectStore("state");
      const getReq = store.get(key);
      let committed!: PersistedGroupMigrationState;
      let casError: unknown = null;

      getReq.onsuccess = () => {
        try {
          const rawItem = getReq.result as StoredEntry<unknown> | undefined;
          const isExpired =
            rawItem !== undefined && rawItem.expiresAt !== null && new Date(rawItem.expiresAt).getTime() <= Date.now();
          const current = rawItem && !isExpired ? parsePersistedGroupMigrationState(rawItem.value) : null;

          if (expected === null) {
            if (current !== null) {
              casError = new XrpcError(409, "Concurrent migration state already exists.", "MigrationInProgress");
              return;
            }
            const serialized = serializePersistedGroupMigrationState({ ...next, revision: 1 });
            const exp = migrationStateExpiresAt(serialized);
            committed = serialized;
            store.put({ value: serialized, expiresAt: exp ? exp.toISOString() : null }, key);
            return;
          }

          const currentRev = current ? (current.revision ?? 1) : -1;
          if (
            !current ||
            current.operationId !== expected.operationId ||
            currentRev !== expected.revision ||
            groupMigrationPhaseRank(next.phase) < groupMigrationPhaseRank(current.phase)
          ) {
            casError = new XrpcError(
              409,
              "Migration journal was modified concurrently by another tab or session.",
              "MigrationInProgress",
            );
            return;
          }

          const serialized = serializePersistedGroupMigrationState({
            ...next,
            operationId: expected.operationId,
            revision: expected.revision + 1,
          });
          const exp = migrationStateExpiresAt(serialized);
          committed = serialized;
          store.put({ value: serialized, expiresAt: exp ? exp.toISOString() : null }, key);
        } catch (err) {
          casError = err;
        }
      };

      tx.oncomplete = () => {
        if (casError !== null) {
          reject(casError);
        } else {
          resolve(committed);
        }
      };
      tx.onerror = () => reject(tx.error ?? getReq.error ?? new Error("IndexedDB state CAS transaction failed."));
      tx.onabort = () => reject(casError ?? tx.error ?? new Error("IndexedDB state CAS transaction aborted."));
    });
  }

  async compareAndDeleteMigrationState(groupDid: string, expected: GroupMigrationCasExpected): Promise<boolean> {
    const db = await this.open();
    if (this.isClosed) {
      db.close();
      this.dbPromise = null;
      throw new Error("GroupOAuthDatabase has been closed.");
    }
    const key = `migration:${groupDid}`;
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(["state"], "readwrite");
      const store = tx.objectStore("state");
      const getReq = store.get(key);
      let deleted = false;

      getReq.onsuccess = () => {
        const rawItem = getReq.result as StoredEntry<unknown> | undefined;
        const isExpired =
          rawItem !== undefined && rawItem.expiresAt !== null && new Date(rawItem.expiresAt).getTime() <= Date.now();
        const current = rawItem && !isExpired ? parsePersistedGroupMigrationState(rawItem.value) : null;
        if (current && current.operationId === expected.operationId && (current.revision ?? 1) === expected.revision) {
          deleted = true;
          store.delete(key);
        }
      };

      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error ?? getReq.error ?? new Error("IndexedDB state CAS delete failed."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB state CAS delete aborted."));
    });
  }

  async listKeys(storeName: StoreName): Promise<string[]> {
    const keys = await this.withStore<IDBValidKey[]>(storeName, "readonly", (s) => s.getAllKeys());
    return keys.filter((k): k is string => typeof k === "string");
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) {
      const db = await pending.catch(() => null);
      db?.close();
    }
  }
}

export type GroupBrowserOAuthOptions = {
  viewerDid: string;
  config: Pick<BrowserSessionConfig, "appUrl" | "plcUrl" | "loopback" | "groupHostUrl">;
  idbFactory?: IDBFactory;
  fetch?: typeof globalThis.fetch;
};

const CROSS_TAB_SIGNOUT_ERROR = "Signed out in another tab while Group OAuth callback was completing.";

/**
 * Per-user Group-DID OAuth browser client (`proposal.md:95-99`).
 * Built directly on `@atproto/oauth-client` `OAuthClient` (NEVER `BrowserOAuthClient`), isolating
 * sessions, states, and DPoP keys inside `flock-group-oauth:<viewerDid>` so multiple concurrent
 * Group-DID sessions coexist cleanly without touching the user's personal-PDS `BrowserOAuthClient` state.
 */
export class GroupBrowserOAuthClient {
  readonly viewerDid: string;
  private readonly config: Pick<BrowserSessionConfig, "appUrl" | "plcUrl" | "loopback" | "groupHostUrl">;
  private readonly idbFactory: IDBFactory | undefined;
  private readonly db: GroupOAuthDatabase;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly erasureChannel: BroadcastChannel | null = null;
  private clientPromise: Promise<OAuthClient> | null = null;

  constructor(options: GroupBrowserOAuthOptions) {
    if (!isDid(options.viewerDid)) {
      throw new TypeError(`Invalid viewer DID: ${options.viewerDid}`);
    }
    this.viewerDid = options.viewerDid;
    this.config = options.config;
    this.idbFactory = options.idbFactory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    this.db = new GroupOAuthDatabase(options.viewerDid, this.idbFactory);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const channel = new BroadcastChannel(groupErasureChannelName(this.viewerDid));
        (channel as unknown as { unref?: () => void }).unref?.();
        channel.onmessage = (ev: MessageEvent) => {
          const data = ev.data as { type?: unknown; viewerDid?: unknown; epoch?: unknown } | null;
          if (data && data.type === "erased" && data.viewerDid === this.viewerDid) {
            if (typeof data.epoch === "number" && Number.isSafeInteger(data.epoch)) {
              const prev = fallbackErasureEpochs.get(this.viewerDid) ?? 0;
              if (data.epoch > prev) fallbackErasureEpochs.set(this.viewerDid, data.epoch);
            }
            void this.close().catch(() => undefined);
          }
        };
        this.erasureChannel = channel;
      } catch {
        this.erasureChannel = null;
      }
    }
  }

  get isClosed(): boolean {
    return this.db.isClosed;
  }

  private getOAuthClient(): Promise<OAuthClient> {
    if (this.db.isClosed) {
      return Promise.reject(new Error("GroupOAuthDatabase has been closed."));
    }
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const built = buildGroupBrowserClientMetadata({ appUrl: this.config.appUrl });
      const allowHttp = new URL(this.config.appUrl).protocol === "http:";
      const clientMetadata: OAuthClientMetadataInput = built.client_id.startsWith("http:")
        ? atprotoLoopbackClientMetadata(built.client_id)
        : await OAuthClient.fetchMetadata({
            clientId: built.client_id as `https://${string}/${string}`,
            fetch: this.fetchImpl,
          });

      const sessionStore = this.db.createStore<
        { dpopKey: unknown; tokenSet: { refresh_token?: string; expires_at?: string } } & Record<string, unknown>,
        { dpopKey: EncodedWebcryptoKey; tokenSet: { refresh_token?: string; expires_at?: string } } & Record<string, unknown>
      >("session", {
        expiresAt: ({ tokenSet }) =>
          tokenSet.refresh_token || !tokenSet.expires_at ? null : new Date(tokenSet.expires_at),
        encode: ({ dpopKey, ...rest }) => ({ ...rest, dpopKey: encodeKey(dpopKey) }),
        decode: async ({ dpopKey, ...rest }) => ({ ...rest, dpopKey: await decodeKey(dpopKey) }),
      });

      const stateStore = this.db.createStore<
        { dpopKey: unknown } & Record<string, unknown>,
        { dpopKey: EncodedWebcryptoKey } & Record<string, unknown>
      >("state", {
        expiresAt: () => new Date(Date.now() + 10 * 60_000),
        encode: ({ dpopKey, ...rest }) => ({ ...rest, dpopKey: encodeKey(dpopKey) }),
        decode: async ({ dpopKey, ...rest }) => ({ ...rest, dpopKey: await decodeKey(dpopKey) }),
      });

      const simpleCache = <V>(name: StoreName, ttlMs: number) => {
        const raw = this.db.createStore<V, V>(name, {
          expiresAt: () => new Date(Date.now() + ttlMs),
          encode: (v) => v,
          decode: (v) => v,
        });
        return {
          get: async (key: string): Promise<V | undefined> => {
            if (this.db.isClosed) return undefined;
            return raw.get(key);
          },
          set: async (key: string, value: V): Promise<void> => {
            if (this.db.isClosed) return;
            await raw.set(key, value);
          },
          del: async (key: string): Promise<void> => {
            if (this.db.isClosed) return;
            await raw.del(key);
          },
        };
      };

      return new OAuthClient({
        clientMetadata,
        responseMode: "query",
        runtimeImplementation: createGroupRuntime(this.viewerDid),
        plcDirectoryUrl: this.config.plcUrl,
        allowHttp,
        fetch: this.fetchImpl,
        handleResolver: wellKnownHandleResolver(asResolvedDid),
        sessionStore: sessionStore as never,
        stateStore: stateStore as never,
        dpopNonceCache: simpleCache("dpopNonceCache", 600_000) as never,
        didCache: simpleCache("didCache", 60_000) as never,
        handleCache: simpleCache("handleCache", 60_000) as never,
        authorizationServerMetadataCache: simpleCache("authorizationServerMetadataCache", 60_000) as never,
        protectedResourceMetadataCache: simpleCache("protectedResourceMetadataCache", 60_000) as never,
      });
    })();
    this.clientPromise.catch(() => {
      this.clientPromise = null;
    });
    return this.clientPromise;
  }

  async authorizeGroup(input: {
    groupOrHost: string;
    roleScope?: "admin" | "members" | "moderator" | "basic" | string;
    prompt?: "login" | "consent" | "create";
    appState?: Omit<GroupCallbackAppState, "viewerDid">;
    signal?: AbortSignal;
  }): Promise<URL> {
    if (this.db.isClosed) {
      throw new Error("GroupOAuthDatabase has been closed.");
    }
    const erasureGeneration = ensureLocalStorageAuthGeneration(this.viewerDid);
    const client = await this.getOAuthClient();
    const scope =
      input.roleScope === undefined || input.roleScope === "admin"
        ? groupAdminScopes().join(" ")
        : input.roleScope === "members"
          ? groupMembersManagerScopes().join(" ")
          : input.roleScope === "moderator"
            ? groupModeratorScopes().join(" ")
            : input.roleScope === "basic"
              ? groupBasicEditorScopes().join(" ")
              : input.roleScope;
    const statePayload: GroupCallbackAppState = {
      viewerDid: this.viewerDid,
      ...input.appState,
      ...(erasureGeneration ? { erasureGeneration } : {}),
    };
    return client.authorize(input.groupOrHost, {
      scope,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      state: JSON.stringify(statePayload),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  private isErasedSinceCallbackStart(
    epochBefore: number,
    genBefore: string | null | undefined,
    appState: GroupCallbackAppState | null,
  ): boolean {
    if (this.db.isClosed) return true;
    const epochNow = getGroupErasureEpoch(this.viewerDid);
    if (epochNow !== epochBefore) return true;
    const genNow = readLocalStorageAuthGeneration(this.viewerDid);
    if (genBefore !== undefined && genBefore !== null && genNow !== genBefore) return true;
    if (
      typeof localStorage !== "undefined" &&
      appState?.erasureGeneration !== undefined &&
      genNow !== appState.erasureGeneration
    ) {
      return true;
    }
    return false;
  }

  private async purgeAfterCrossTabErasure(input: {
    client?: OAuthClient;
    session?: OAuthSession;
    groupDid?: string;
    claimPurpose?: GroupClaimPurpose;
  }): Promise<never> {
    await withViewerAuthLock(this.viewerDid, async () => {
      if (input.session) {
        await input.client?.revoke(input.session.sub).catch(() => undefined);
        await input.session.signOut().catch(() => undefined);
      }
      await this.close().catch(() => undefined);
      if (this.idbFactory) {
        await rawDeleteGroupOAuthIdb(this.viewerDid, this.idbFactory).catch(() => undefined);
      }
      const targetGroupDid = input.session?.sub ?? input.groupDid;
      if (typeof sessionStorage !== "undefined" && targetGroupDid) {
        if (input.claimPurpose) {
          sessionStorage.removeItem(claimedActionTokenKey(targetGroupDid, input.claimPurpose));
        } else {
          sessionStorage.removeItem(claimedActionTokenKey(targetGroupDid, "delete_account"));
          sessionStorage.removeItem(claimedActionTokenKey(targetGroupDid, "plc_operation"));
        }
      }
    });
    throw new Error(CROSS_TAB_SIGNOUT_ERROR);
  }

  async completeCallback(params: URLSearchParams): Promise<CompletedGroupCallback> {
    const errorCode = params.get("error");
    if (errorCode) {
      const desc = params.get("error_description") ?? undefined;
      throw new GroupOAuthDeniedError(
        errorCode === "access_denied"
          ? "Group authorization was declined."
          : `Group authorization failed (${errorCode}${desc ? `: ${desc}` : ""}).`,
        errorCode,
        desc,
      );
    }

    const epochBefore = getGroupErasureEpoch(this.viewerDid);
    const genBefore = readLocalStorageAuthGeneration(this.viewerDid);
    if (this.db.isClosed) {
      throw new Error(CROSS_TAB_SIGNOUT_ERROR);
    }

    const client = await this.getOAuthClient();
    let result: { session: OAuthSession; state: string | null };
    try {
      result = await client.callback(params);
    } catch (error) {
      const errAppState = error instanceof OAuthCallbackError ? parseGroupCallbackAppState(error.state ?? null) : null;
      const erasedWithoutStoredState =
        error instanceof OAuthCallbackError &&
        errAppState === null &&
        typeof localStorage !== "undefined" &&
        readLocalStorageAuthGeneration(this.viewerDid) === null;
      if (erasedWithoutStoredState || this.isErasedSinceCallbackStart(epochBefore, genBefore, errAppState)) {
        return this.purgeAfterCrossTabErasure({
          client,
          groupDid: errAppState?.groupDid,
          claimPurpose: errAppState?.claimPurpose,
        });
      }
      if (error instanceof OAuthCallbackError) {
        const errParam = error.params.get("error") ?? "callback_error";
        const desc = error.params.get("error_description") ?? error.message;
        throw new GroupOAuthDeniedError(
          errParam === "access_denied"
            ? "Group authorization was declined."
            : `Group authorization failed (${errParam}: ${desc}).`,
          errParam,
          desc,
        );
      }
      throw error;
    }

    const appState = parseGroupCallbackAppState(result.state);
    if (appState && appState.viewerDid !== this.viewerDid) {
      await client.revoke(result.session.sub).catch(() => undefined);
      throw new Error("Group OAuth callback state belonged to a different signed-in account.");
    }

    const shouldPurgePostCallback = await withViewerAuthLock(this.viewerDid, async () =>
      this.isErasedSinceCallbackStart(epochBefore, genBefore, appState),
    );
    if (shouldPurgePostCallback) {
      return this.purgeAfterCrossTabErasure({
        client,
        session: result.session,
        groupDid: result.session.sub,
        claimPurpose: appState?.claimPurpose,
      });
    }

    const groupDid = result.session.sub;
    const groupClient = this.wrapGroupClient(groupDid, result.session);

    let claimedActionToken: { purpose: GroupClaimPurpose; token: string } | undefined;
    if (appState?.claimPurpose === "delete_account" || appState?.claimPurpose === "plc_operation") {
      let claimed: { token: string; expiresAt: string };
      try {
        claimed = await groupClient.claimActionToken(appState.claimPurpose);
      } catch (claimErr) {
        if (this.isErasedSinceCallbackStart(epochBefore, genBefore, appState)) {
          return this.purgeAfterCrossTabErasure({
            client,
            session: result.session,
            groupDid,
            claimPurpose: appState.claimPurpose,
          });
        }
        throw claimErr;
      }

      const shouldPurgeAfterClaim = await withViewerAuthLock(this.viewerDid, async () => {
        if (this.isErasedSinceCallbackStart(epochBefore, genBefore, appState)) {
          return true;
        }
        claimedActionToken = { purpose: appState.claimPurpose!, token: claimed.token };
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(claimedActionTokenKey(groupDid, appState.claimPurpose!), claimed.token);
        }
        return false;
      });
      if (shouldPurgeAfterClaim) {
        return this.purgeAfterCrossTabErasure({
          client,
          session: result.session,
          groupDid,
          claimPurpose: appState.claimPurpose,
        });
      }
    }

    return {
      groupDid,
      session: result.session,
      groupClient,
      appState,
      ...(claimedActionToken ? { claimedActionToken } : {}),
    };
  }

  async restoreGroupSession(groupDid: string): Promise<OAuthSession | null> {
    if (!isDid(groupDid) || this.db.isClosed) return null;
    const keys = await this.db.listKeys("session");
    if (!keys.includes(groupDid)) return null;
    try {
      const client = await this.getOAuthClient();
      return await client.restore(groupDid);
    } catch {
      return null;
    }
  }

  async restoreGroupClient(groupDid: string): Promise<GroupClient | null> {
    const session = await this.restoreGroupSession(groupDid);
    if (!session) return null;
    return this.wrapGroupClient(groupDid, session);
  }

  async listStoredGroupDids(): Promise<string[]> {
    return (await this.db.listKeys("session")).filter(isDid).sort();
  }

  async revokeGroupSession(groupDid: string): Promise<void> {
    const client = await this.getOAuthClient();
    await client.revoke(groupDid);
  }

  async close(): Promise<void> {
    this.clientPromise = null;
    try {
      this.erasureChannel?.close();
    } catch {
      // Ignore already-closed channel.
    }
    await this.db.close();
  }

  createMigrationStateStore(): Required<GroupMigrationStateStore> {
    const migrationStore = this.db.createStore<PersistedGroupMigrationState, PersistedGroupMigrationState>("state", {
      expiresAt: (value) => migrationStateExpiresAt(value),
      encode: (value) => serializePersistedGroupMigrationState(value),
      decode: (value) => {
        const parsed = parsePersistedGroupMigrationState(value);
        if (!parsed) {
          throw new Error("Invalid persisted group migration state in IndexedDB.");
        }
        return parsed;
      },
    });
    return {
      get: async (did) => {
        try {
          return await migrationStore.get(`migration:${did}`);
        } catch {
          await migrationStore.del(`migration:${did}`).catch(() => undefined);
          return undefined;
        }
      },
      set: (did, state) => migrationStore.set(`migration:${did}`, state),
      delete: (did) => migrationStore.del(`migration:${did}`),
      compareAndSet: (did, expected, next) => this.db.compareAndSetMigrationState(did, expected, next),
      compareAndDelete: (did, expected) => this.db.compareAndDeleteMigrationState(did, expected),
    };
  }

  private wrapGroupClient(groupDid: string, session: OAuthSession): GroupClient {
    return new GroupClient({
      groupDid,
      fetchHandler: (pathname, init) => session.fetchHandler(pathname, init),
      fetchEndpoint: (request) => this.fetchImpl(request, { redirect: "error" }),
      plcUrl: this.config.plcUrl,
      migrationState: this.createMigrationStateStore(),
      withGroupLock: (did, fn) =>
        runWithDefaultGroupMetaLock(did, () =>
          requestExclusiveBrowserLock(`flock-group-meta:${this.viewerDid}:${did}`, fn),
        ),
      withMigrationLock: (did, fn) =>
        runWithDefaultGroupMigrationLock(did, () =>
          requestExclusiveBrowserLock(`flock-group-migration:${this.viewerDid}:${did}`, fn),
        ),
    });
  }
}

const VALID_MIGRATION_PHASES = new Set<GroupMigrationPhase>([
  "starting",
  "prepared",
  "account_created",
  "staged",
  "signing_plc",
  "plc_signed",
  "plc_submitted",
]);

const VALID_REQUESTED_MODES = new Set<GroupMigrationRequestedMode>(["auto", "coordinated", "standard"]);

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProposedPlcParams(raw: unknown): ProposedPlcOperationParams | null {
  if (!isPlainObjectRecord(raw)) return null;
  const out: ProposedPlcOperationParams = {};
  if (raw.rotationKeys !== undefined) {
    if (!Array.isArray(raw.rotationKeys) || !raw.rotationKeys.every((k) => typeof k === "string")) return null;
    out.rotationKeys = [...raw.rotationKeys];
  }
  if (raw.alsoKnownAs !== undefined) {
    if (!Array.isArray(raw.alsoKnownAs) || !raw.alsoKnownAs.every((k) => typeof k === "string")) return null;
    out.alsoKnownAs = [...raw.alsoKnownAs];
  }
  if (raw.verificationMethods !== undefined) {
    if (!isPlainObjectRecord(raw.verificationMethods)) return null;
    out.verificationMethods = { ...raw.verificationMethods };
  }
  if (raw.services !== undefined) {
    if (!isPlainObjectRecord(raw.services)) return null;
    out.services = { ...raw.services };
  }
  return out;
}

export function parsePersistedGroupMigrationState(raw: unknown): InFlightGroupMigration | null {
  if (!isPlainObjectRecord(raw)) return null;
  if (raw.protocolVersion !== "org.atgrp.v1") return null;
  let revision: number | undefined;
  if (raw.revision !== undefined) {
    if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
      return null;
    }
    revision = raw.revision;
  }
  if (typeof raw.operationId !== "string" || raw.operationId.length === 0) return null;
  if (typeof raw.targetOrigin !== "string" || raw.targetOrigin.length === 0) return null;
  try {
    const parsedUrl = new URL(raw.targetOrigin);
    if (parsedUrl.origin !== raw.targetOrigin) return null;
  } catch {
    return null;
  }
  if (typeof raw.handle !== "string" || raw.handle.length === 0) return null;
  let recoveryKey: string | null | undefined;
  if (raw.recoveryKey !== undefined) {
    if (raw.recoveryKey !== null && typeof raw.recoveryKey !== "string") {
      return null;
    }
    recoveryKey = raw.recoveryKey;
  }
  if (typeof raw.mode !== "string" || !VALID_REQUESTED_MODES.has(raw.mode as GroupMigrationRequestedMode)) {
    return null;
  }
  if (typeof raw.phase !== "string" || !VALID_MIGRATION_PHASES.has(raw.phase as GroupMigrationPhase)) {
    return null;
  }
  if (raw.ticketId !== null && typeof raw.ticketId !== "string") return null;

  let negotiatedMode: "coordinated" | "standard" | undefined;
  if (raw.negotiatedMode !== undefined) {
    if (raw.negotiatedMode !== "coordinated" && raw.negotiatedMode !== "standard") return null;
    negotiatedMode = raw.negotiatedMode;
  }

  let targetServiceDid: string | undefined;
  if (raw.targetServiceDid !== undefined) {
    if (!isDid(raw.targetServiceDid)) return null;
    targetServiceDid = raw.targetServiceDid;
  }

  let targetOriginVerified: boolean | undefined;
  if (raw.targetOriginVerified !== undefined) {
    if (typeof raw.targetOriginVerified !== "boolean") return null;
    targetOriginVerified = raw.targetOriginVerified;
  }

  let migrationTicket: string | null | undefined;
  if (raw.migrationTicket !== undefined) {
    if (raw.migrationTicket !== null && typeof raw.migrationTicket !== "string") return null;
    migrationTicket = raw.migrationTicket;
  }

  let accessJwt: string | undefined;
  if (raw.accessJwt !== undefined) {
    if (typeof raw.accessJwt !== "string" || raw.accessJwt.length === 0) return null;
    accessJwt = raw.accessJwt;
  }

  let refreshJwt: string | undefined;
  if (raw.refreshJwt !== undefined) {
    if (typeof raw.refreshJwt !== "string" || raw.refreshJwt.length === 0) return null;
    refreshJwt = raw.refreshJwt;
  }

  let pendingRefreshKey: string | null | undefined;
  if (raw.pendingRefreshKey !== undefined) {
    if (
      raw.pendingRefreshKey !== null &&
      (typeof raw.pendingRefreshKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.pendingRefreshKey))
    ) {
      return null;
    }
    pendingRefreshKey = raw.pendingRefreshKey;
  }

  let plcToken: string | undefined;
  if (raw.plcToken !== undefined) {
    if (typeof raw.plcToken !== "string" || raw.plcToken.length === 0) return null;
    plcToken = raw.plcToken;
  }

  let proposedPlcParams: ProposedPlcOperationParams | undefined;
  if (raw.proposedPlcParams !== undefined) {
    const parsedParams = parseProposedPlcParams(raw.proposedPlcParams);
    if (!parsedParams) return null;
    proposedPlcParams = parsedParams;
  }

  let signedPlcOp: Record<string, unknown> | undefined;
  if (raw.signedPlcOp !== undefined) {
    if (!isPlainObjectRecord(raw.signedPlcOp)) return null;
    signedPlcOp = { ...raw.signedPlcOp };
  }

  const phase = raw.phase as GroupMigrationPhase;
  if (
    (phase === "account_created" ||
      phase === "staged" ||
      phase === "signing_plc" ||
      phase === "plc_signed" ||
      phase === "plc_submitted") &&
    !accessJwt
  ) {
    return null;
  }
  if (phase === "signing_plc" && (!plcToken || !proposedPlcParams)) {
    return null;
  }
  if (phase === "plc_signed" && !signedPlcOp) {
    return null;
  }

  return {
    protocolVersion: "org.atgrp.v1",
    ...(revision !== undefined ? { revision } : {}),
    operationId: raw.operationId,
    targetOrigin: raw.targetOrigin,
    handle: raw.handle,
    ...(recoveryKey !== undefined ? { recoveryKey } : {}),
    mode: raw.mode as GroupMigrationRequestedMode,
    ...(negotiatedMode !== undefined ? { negotiatedMode } : {}),
    ...(targetServiceDid !== undefined ? { targetServiceDid } : {}),
    ...(targetOriginVerified !== undefined ? { targetOriginVerified } : {}),
    ...(migrationTicket !== undefined ? { migrationTicket } : {}),
    ticketId: raw.ticketId,
    phase,
    ...(accessJwt !== undefined ? { accessJwt } : {}),
    ...(refreshJwt !== undefined ? { refreshJwt } : {}),
    ...(pendingRefreshKey !== undefined ? { pendingRefreshKey } : {}),
    ...(plcToken !== undefined ? { plcToken } : {}),
    ...(proposedPlcParams !== undefined ? { proposedPlcParams } : {}),
    ...(signedPlcOp !== undefined ? { signedPlcOp } : {}),
  };
}

export function serializePersistedGroupMigrationState(state: PersistedGroupMigrationState): PersistedGroupMigrationState {
  const validated = parsePersistedGroupMigrationState({
    protocolVersion: "org.atgrp.v1",
    ...state,
  });
  if (!validated) {
    throw new Error("Cannot persist malformed group migration state.");
  }
  return JSON.parse(JSON.stringify(validated)) as PersistedGroupMigrationState;
}

export function parseGroupCallbackAppState(raw: string | null): GroupCallbackAppState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (!isDid(obj.viewerDid)) return null;
    const claimPurpose =
      obj.claimPurpose === "delete_account" || obj.claimPurpose === "plc_operation"
        ? obj.claimPurpose
        : undefined;
    const purpose =
      obj.purpose === "admin" ||
      obj.purpose === "members" ||
      obj.purpose === "moderator" ||
      obj.purpose === "basic" ||
      obj.purpose === "recovery" ||
      obj.purpose === "step_up" ||
      obj.purpose === "create"
        ? obj.purpose
        : undefined;
    const erasureGeneration =
      typeof obj.erasureGeneration === "string" && obj.erasureGeneration.length > 0
        ? obj.erasureGeneration
        : undefined;
    return {
      viewerDid: obj.viewerDid,
      ...(typeof obj.returnTo === "string" ? { returnTo: obj.returnTo } : {}),
      ...(purpose ? { purpose } : {}),
      ...(isDid(obj.groupDid) ? { groupDid: obj.groupDid } : {}),
      ...(claimPurpose ? { claimPurpose } : {}),
      ...(erasureGeneration ? { erasureGeneration } : {}),
    };
  } catch {
    return null;
  }
}

const clientsByKey = new Map<string, GroupBrowserOAuthClient>();

export function _resetInMemoryGroupAuthStateForNavigationTest(): void {
  for (const client of clientsByKey.values()) {
    void client.close().catch(() => undefined);
  }
  clientsByKey.clear();
  fallbackErasureEpochs.clear();
}

async function closeCachedGroupClients(viewerDid: string): Promise<void> {
  for (const [key, client] of clientsByKey) {
    if (key.startsWith(`${viewerDid}\0`)) {
      clientsByKey.delete(key);
      await client.close().catch(() => undefined);
    }
  }
}

export function getGroupBrowserOAuthClient(
  viewerDid: string,
  config: Pick<BrowserSessionConfig, "appUrl" | "plcUrl" | "loopback" | "groupHostUrl">,
): GroupBrowserOAuthClient {
  const cacheKey = `${viewerDid}\0${config.appUrl}\0${config.plcUrl}`;
  let existing = clientsByKey.get(cacheKey);
  if (!existing || existing.isClosed) {
    existing = new GroupBrowserOAuthClient({ viewerDid, config });
    clientsByKey.set(cacheKey, existing);
  }
  return existing;
}

export async function deleteGroupOAuthDatabase(
  viewerDid: string,
  idbFactory: IDBFactory | undefined = typeof indexedDB !== "undefined" ? indexedDB : undefined,
): Promise<void> {
  const epoch = bumpGroupErasureEpoch(viewerDid);
  broadcastGroupErasure(viewerDid, epoch);
  await closeCachedGroupClients(viewerDid);
  if (!idbFactory) return;
  await withViewerAuthLock(viewerDid, () => rawDeleteGroupOAuthIdb(viewerDid, idbFactory));
}

export async function revokeAndEraseGroupOAuthSessions(
  viewerDid: string,
  options: {
    config?: Pick<BrowserSessionConfig, "appUrl" | "plcUrl" | "loopback" | "groupHostUrl">;
    idbFactory?: IDBFactory;
    fetch?: typeof globalThis.fetch;
  } = {},
): Promise<{ revokedAll: boolean; erased: boolean }> {
  const idb = options.idbFactory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  const preEpoch = bumpGroupErasureEpoch(viewerDid);
  broadcastGroupErasure(viewerDid, preEpoch);
  await closeCachedGroupClients(viewerDid);

  let revokedAll = true;
  if (options.config && idb) {
    const tempClient = new GroupBrowserOAuthClient({
      viewerDid,
      config: options.config,
      idbFactory: idb,
      fetch: options.fetch,
    });
    try {
      const groupDids = await tempClient.listStoredGroupDids();
      const revocations = await Promise.allSettled(groupDids.map((gDid) => tempClient.revokeGroupSession(gDid)));
      if (revocations.some((r) => r.status === "rejected")) {
        revokedAll = false;
      }
    } catch {
      revokedAll = false;
    } finally {
      await tempClient.close().catch(() => undefined);
    }
  }
  try {
    await deleteGroupOAuthDatabase(viewerDid, idb);
    return { revokedAll, erased: true };
  } catch {
    return { revokedAll, erased: false };
  }
}
