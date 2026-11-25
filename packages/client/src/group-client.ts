import { listAllSpaceUris, listBoundedRecords } from "@flock/protocol/atproto/record-pages";
import { AtprotoClient, isMissingXrpcResource, XrpcError, type AtprotoFetchHandler } from "@flock/protocol/atproto/xrpc";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import {
  groupMembersUri,
  groupMetaUri,
  isDid,
  isRecordKey,
  isTid,
  parseAnySpaceRecordUri,
  parseSpaceUri,
  personalInvitesUri,
  SELF_SKEY,
  spaceRecordUri,
  tidNow,
} from "@flock/protocol/keys";
import {
  ATPROTO_SPACE_COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  REPO_COLLECTION,
} from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";

const MAX_ADMIN_JSON_BYTES = 4 * 1024 * 1024;

export type GroupProfile = {
  displayName: string;
  description?: string;
  joinPolicy: string;
  url?: string;
};

export type PublicMetaStatus = {
  publicRead: boolean;
  hasDeclaration: boolean;
  consistent: boolean;
};

export class PublicMetaReconciliationError extends Error {
  readonly consistent: boolean;

  constructor(message: string, consistent: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PublicMetaReconciliationError";
    this.consistent = consistent;
  }
}

export type GroupRule = {
  rkey: string;
  uri: string;
  title: string;
  text: string;
  order?: number;
};

export type GroupRoleEntry = {
  rkey: string;
  uri: string;
  displayName: string;
  description?: string;
  default: boolean;
  scopes: string[];
  assignable: string[];
};

export type GroupMembershipEntry = {
  memberDid: string;
  uri: string;
  cid?: string;
  roles: string[];
  createdAt: string;
  incarnation?: string;
};

export type GroupJoinRequestItem = {
  member: string;
  createdAt: string;
  message?: string;
};

export type GroupInviteDelivery = {
  inviteUri: string;
  spaceUri: string;
  inviteeDid: string;
  rkey: string;
  repoRev: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModSubjectItem = {
  subject: string;
  cid?: string;
  status: "open" | "resolved" | "escalated" | string;
  createdAt: string;
  updatedAt: string;
  reportCount: number;
};

export type ModSubjectHistoryEvent = {
  id: string;
  createdAt: string;
  createdBy?: string;
  event: Record<string, unknown>;
};

export type PreparedGroupMigration = {
  groupDid: string;
  operationId: string;
  mode: "coordinated" | "standard";
  targetEndpoint: string;
  targetServiceDid: string;
  deadlineAtMs: number;
  manifestDigest: string;
  migrationTicket: string | null;
  ticketId?: string | null;
};

export type GroupMigrationRequestedMode = "auto" | "coordinated" | "standard";

export type GroupMigrationPhase =
  | "starting"
  | "prepared"
  | "account_created"
  | "staged"
  | "signing_plc"
  | "plc_signed"
  | "plc_submitted";

export type ProposedPlcOperationParams = {
  rotationKeys?: string[];
  alsoKnownAs?: string[];
  verificationMethods?: Record<string, unknown>;
  services?: Record<string, unknown>;
};

export type PersistedGroupMigrationState = {
  readonly revision?: number;
  operationId: string;
  targetOrigin: string;
  handle: string;
  recoveryKey?: string | null;
  mode: GroupMigrationRequestedMode;
  negotiatedMode?: "coordinated" | "standard";
  targetServiceDid?: string;
  targetOriginVerified?: boolean;
  migrationTicket?: string | null;
  ticketId: string | null;
  phase: GroupMigrationPhase;
  accessJwt?: string;
  refreshJwt?: string;
  pendingRefreshKey?: string | null;
  plcToken?: string;
  proposedPlcParams?: ProposedPlcOperationParams;
  signedPlcOp?: Record<string, unknown>;
};

export type InFlightGroupMigration = PersistedGroupMigrationState;

export type GroupMigrationCasExpected = {
  operationId: string;
  revision: number;
};

export type GroupMigrationStateStore = {
  get(groupDid: string): PersistedGroupMigrationState | undefined | Promise<PersistedGroupMigrationState | undefined>;
  set(groupDid: string, state: PersistedGroupMigrationState): unknown | Promise<unknown>;
  delete(groupDid: string): unknown | Promise<unknown>;
  compareAndSet?(
    groupDid: string,
    expected: GroupMigrationCasExpected | null,
    next: PersistedGroupMigrationState,
  ): Promise<PersistedGroupMigrationState>;
  compareAndDelete?(groupDid: string, expected: GroupMigrationCasExpected): Promise<boolean>;
};

const MIGRATION_PHASE_RANKS: Record<GroupMigrationPhase, number> = {
  starting: 0,
  prepared: 1,
  account_created: 2,
  staged: 3,
  signing_plc: 4,
  plc_signed: 5,
  plc_submitted: 6,
};

export function groupMigrationPhaseRank(phase: GroupMigrationPhase): number {
  return MIGRATION_PHASE_RANKS[phase];
}

function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
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

export const runWithDefaultGroupMetaLock = createKeyedMutex();
export const runWithDefaultGroupMigrationLock = createKeyedMutex();

export function createInMemoryMigrationStateStore(
  backing: Map<string, PersistedGroupMigrationState> = new Map(),
): Required<GroupMigrationStateStore> {
  const storeLock = createKeyedMutex();
  return {
    get: (groupDid) => backing.get(groupDid),
    set: (groupDid, state) => storeLock(groupDid, async () => {
      backing.set(groupDid, state);
    }),
    delete: (groupDid) => storeLock(groupDid, async () => {
      backing.delete(groupDid);
    }),
    compareAndSet: (groupDid, expected, next) =>
      storeLock(groupDid, async () => {
        const current = backing.get(groupDid);
        if (expected === null) {
          if (current !== undefined) {
            throw new XrpcError(409, "Concurrent migration state already exists.", "MigrationInProgress");
          }
          const committed: PersistedGroupMigrationState = { ...next, revision: 1 };
          backing.set(groupDid, committed);
          return committed;
        }
        const currentRev = current ? (current.revision ?? 1) : -1;
        if (
          !current ||
          current.operationId !== expected.operationId ||
          currentRev !== expected.revision ||
          groupMigrationPhaseRank(next.phase) < groupMigrationPhaseRank(current.phase)
        ) {
          throw new XrpcError(
            409,
            "Migration journal was modified concurrently by another tab or session.",
            "MigrationInProgress",
          );
        }
        const committed: PersistedGroupMigrationState = {
          ...next,
          operationId: expected.operationId,
          revision: expected.revision + 1,
        };
        backing.set(groupDid, committed);
        return committed;
      }),
    compareAndDelete: (groupDid, expected) =>
      storeLock(groupDid, async () => {
        const current = backing.get(groupDid);
        if (!current || current.operationId !== expected.operationId || (current.revision ?? 1) !== expected.revision) {
          return false;
        }
        backing.delete(groupDid);
        return true;
      }),
  };
}

const defaultMigrationBackingMap = new Map<string, PersistedGroupMigrationState>();
const defaultMigrationStateStore = createInMemoryMigrationStateStore(defaultMigrationBackingMap);
const fallbackCasAdapters = new WeakMap<
  GroupMigrationStateStore,
  Required<Pick<GroupMigrationStateStore, "compareAndSet" | "compareAndDelete">>
>();

function ensureCasMigrationStateStore(store: GroupMigrationStateStore): Required<GroupMigrationStateStore> {
  if (typeof store.compareAndSet === "function" && typeof store.compareAndDelete === "function") {
    return store as Required<GroupMigrationStateStore>;
  }
  let adapter = fallbackCasAdapters.get(store);
  if (!adapter) {
    const storeLock = createKeyedMutex();
    adapter = {
      compareAndSet: (groupDid, expected, next) =>
        storeLock(groupDid, async () => {
          const current = await Promise.resolve(store.get(groupDid));
          if (expected === null) {
            if (current !== undefined) {
              throw new XrpcError(409, "Concurrent migration state already exists.", "MigrationInProgress");
            }
            const committed: PersistedGroupMigrationState = { ...next, revision: 1 };
            await Promise.resolve(store.set(groupDid, committed));
            return committed;
          }
          const currentRev = current ? (current.revision ?? 1) : -1;
          if (
            !current ||
            current.operationId !== expected.operationId ||
            currentRev !== expected.revision ||
            groupMigrationPhaseRank(next.phase) < groupMigrationPhaseRank(current.phase)
          ) {
            throw new XrpcError(
              409,
              "Migration journal was modified concurrently by another tab or session.",
              "MigrationInProgress",
            );
          }
          const committed: PersistedGroupMigrationState = {
            ...next,
            operationId: expected.operationId,
            revision: expected.revision + 1,
          };
          await Promise.resolve(store.set(groupDid, committed));
          return committed;
        }),
      compareAndDelete: (groupDid, expected) =>
        storeLock(groupDid, async () => {
          const current = await Promise.resolve(store.get(groupDid));
          if (
            !current ||
            current.operationId !== expected.operationId ||
            (current.revision ?? 1) !== expected.revision
          ) {
            return false;
          }
          await Promise.resolve(store.delete(groupDid));
          return true;
        }),
    };
    fallbackCasAdapters.set(store, adapter);
  }
  return {
    get: (groupDid) => store.get(groupDid),
    set: (groupDid, state) => store.set(groupDid, state),
    delete: (groupDid) => store.delete(groupDid),
    compareAndSet: store.compareAndSet ? store.compareAndSet.bind(store) : adapter.compareAndSet,
    compareAndDelete: store.compareAndDelete ? store.compareAndDelete.bind(store) : adapter.compareAndDelete,
  };
}

export function clearDefaultMigrationStateForTest(): void {
  defaultMigrationBackingMap.clear();
}

function isDeterministicPreCutover4xx(err: unknown): err is XrpcError {
  return (
    err instanceof XrpcError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.code !== "ExpiredToken" &&
    err.code !== "MigrationCutoverCommitted" &&
    err.code !== "MigrationCutoverPending" &&
    err.code !== "MigrationInProgress" &&
    err.code !== "ConcurrentModification" &&
    err.code !== "OutboxDrainIncomplete" &&
    err.status !== 408 &&
    err.status !== 429
  );
}

export type GroupClientDeps = {
  groupDid: string;
  fetchHandler: AtprotoFetchHandler;
  /** External fetch for cross-host Group Host migration calls; defaults to `globalThis.fetch`. */
  fetchEndpoint?: (request: Request) => Promise<Response>;
  /** Optional durable or in-memory store for crash-safe `migrateToHost` operationId reuse. */
  migrationState?: GroupMigrationStateStore;
  /** Optional per-group lock for serializing `setPublicMeta` across tabs and processes. */
  withGroupLock?: <T>(groupDid: string, fn: () => Promise<T>) => Promise<T>;
  /** Optional per-group lock for serializing `migrateToHost` and `abortMigration` across tabs and clients. */
  withMigrationLock?: <T>(groupDid: string, fn: () => Promise<T>) => Promise<T>;
  /** Optional PLC directory URL used when verifying `did:plc:` target service DIDs during Standard migration. */
  plcUrl?: string;
  now?: () => number;
};

export type GroupClientOptions = GroupClientDeps;

const ACCESS_JWT_REFRESH_LEAD_MS = 120_000;
const DEFAULT_ACCESS_JWT_LIFETIME_MS = 15 * 60_000;
const MAX_DID_DOCUMENT_BYTES = 256 * 1024;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XrpcError(400, "Invalid target endpoint URL.", "InvalidRequest");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new XrpcError(400, "Target endpoint must be a valid HTTP(S) origin.", "InvalidRequest");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new XrpcError(400, "Non-loopback target endpoints must use HTTPS.", "InvalidRequest");
  }
  return parsed.origin;
}

function normalizeCanonicalOrigin(url: string): string {
  const parsed = new URL(normalizeOrigin(url));
  if (parsed.protocol === "http:" && parsed.hostname.toLowerCase() === "localhost") {
    parsed.hostname = "127.0.0.1";
  }
  return parsed.origin;
}

function assertProposedPlcTargetOrigin(
  proposed: ProposedPlcOperationParams | undefined,
  targetOrigin: string,
): void {
  const proposedPds = (proposed?.services as { atproto_pds?: { endpoint?: unknown } } | undefined)?.atproto_pds
    ?.endpoint;
  if (typeof proposedPds !== "string") {
    throw new XrpcError(
      400,
      `Target proposed PLC #atproto_pds endpoint is missing or invalid for ${targetOrigin}.`,
      "UnsupportedGroupHostTarget",
    );
  }
  let normalizedProposed: string;
  try {
    normalizedProposed = normalizeCanonicalOrigin(proposedPds);
  } catch {
    throw new XrpcError(
      400,
      `Target proposed PLC #atproto_pds endpoint is invalid for ${targetOrigin}.`,
      "UnsupportedGroupHostTarget",
    );
  }
  if (normalizedProposed !== normalizeCanonicalOrigin(targetOrigin)) {
    throw new XrpcError(
      400,
      `Target proposed PLC #atproto_pds endpoint (${normalizedProposed}) does not match ${targetOrigin}.`,
      "UnsupportedGroupHostTarget",
    );
  }
}

function resolveTargetDidDocumentUrl(did: string, targetOrigin: string, plcUrl: string | undefined): string {
  if (!isDid(did)) {
    throw new XrpcError(400, `Invalid target service DID: ${did}`, "UnsupportedGroupHostTarget");
  }
  const targetParsed = new URL(targetOrigin);
  const allowLoopback = targetParsed.protocol === "http:" && isLoopbackHostname(targetParsed.hostname);

  if (did.startsWith("did:web:")) {
    const methodSpecificId = did.slice("did:web:".length);
    const segments = methodSpecificId.split(":").map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new XrpcError(400, "Target service did:web identifier is malformed.", "UnsupportedGroupHostTarget");
      }
    });
    if (segments.length !== 1) {
      throw new XrpcError(
        400,
        "Path-based did:web target service DIDs are not supported.",
        "UnsupportedGroupHostTarget",
      );
    }
    const host = segments[0]!;
    if (host.length === 0 || host !== host.trim()) {
      throw new XrpcError(400, "Target service did:web host is malformed.", "UnsupportedGroupHostTarget");
    }
    let probe: URL;
    try {
      probe = new URL(`https://${host}/.well-known/did.json`);
    } catch {
      throw new XrpcError(400, "Target service did:web host is malformed.", "UnsupportedGroupHostTarget");
    }
    if (probe.host !== host || probe.username || probe.password || probe.pathname !== "/.well-known/did.json") {
      throw new XrpcError(400, "Target service did:web host is malformed.", "UnsupportedGroupHostTarget");
    }
    const isLocal = isLoopbackHostname(probe.hostname);
    if (isLocal && !allowLoopback) {
      throw new XrpcError(
        400,
        "Loopback target service DID cannot bind to a non-loopback target origin.",
        "UnsupportedGroupHostTarget",
      );
    }
    const scheme = isLocal ? "http" : "https";
    const fetchHost =
      isLocal && probe.hostname.toLowerCase() === "localhost" && targetParsed.hostname === "127.0.0.1"
        ? host.replace(/^localhost/i, "127.0.0.1")
        : host;
    return `${scheme}://${fetchHost}/.well-known/did.json`;
  }

  if (did.startsWith("did:plc:")) {
    if (!plcUrl) {
      throw new XrpcError(
        400,
        "plcUrl must be configured to verify did:plc target service DIDs.",
        "UnsupportedGroupHostTarget",
      );
    }
    let base: URL;
    try {
      base = new URL(plcUrl);
    } catch {
      throw new XrpcError(400, "Configured plcUrl is invalid.", "UnsupportedGroupHostTarget");
    }
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && allowLoopback && isLoopbackHostname(base.hostname)))
    ) {
      throw new XrpcError(400, "Configured plcUrl is unsafe.", "UnsupportedGroupHostTarget");
    }
    return `${base.origin}${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(did)}`;
  }

  throw new XrpcError(
    400,
    `Unsupported target service DID method: ${did}`,
    "UnsupportedGroupHostTarget",
  );
}

function extractTicketIdFromMigrationTicket(ticket: string | null | undefined): string | null {
  if (typeof ticket !== "string") return null;
  const parts = ticket.split(".");
  if (parts.length === 3 && parts[0] === "v1" && parts[1]) {
    return parts[1];
  }
  return null;
}

function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    // Fall back to elapsed-time tracking when token is opaque or unparseable.
  }
  return null;
}

/**
 * Per-user Group-DID session client (`proposal.md:95-99`).
 * Wraps an authenticated Group-DID DPoP OAuth `fetchHandler` (`sub === groupDid`) for direct
 * governance, moderation, join-request review, cross-PDS invites, step-up action claims, and migration.
 */
export class GroupClient {
  readonly groupDid: string;
  readonly xrpc: AtprotoClient;
  private readonly fetchHandler: AtprotoFetchHandler;
  private readonly fetchExternal: (request: Request) => Promise<Response>;
  private readonly migrationState: GroupMigrationStateStore;
  private readonly withGroupLock: <T>(groupDid: string, fn: () => Promise<T>) => Promise<T>;
  private readonly withMigrationLock: <T>(groupDid: string, fn: () => Promise<T>) => Promise<T>;
  private readonly plcUrl: string | undefined;
  private readonly now: () => number;

  constructor(deps: GroupClientDeps) {
    if (!isDid(deps.groupDid)) {
      throw new TypeError(`Invalid group DID: ${deps.groupDid}`);
    }
    this.groupDid = deps.groupDid;
    this.fetchHandler = deps.fetchHandler;
    this.xrpc = new AtprotoClient(deps.fetchHandler);
    this.fetchExternal = deps.fetchEndpoint ?? ((request) => fetch(request));
    this.migrationState = deps.migrationState ?? defaultMigrationStateStore;
    this.withGroupLock = deps.withGroupLock ?? runWithDefaultGroupMetaLock;
    this.withMigrationLock = deps.withMigrationLock ?? runWithDefaultGroupMigrationLock;
    this.plcUrl = deps.plcUrl;
    this.now = deps.now ?? Date.now;
  }

  private async verifyTargetServiceDidBinding(targetServiceDid: string, targetOrigin: string): Promise<void> {
    const normalizedTarget = normalizeCanonicalOrigin(targetOrigin);
    const docUrl = resolveTargetDidDocumentUrl(targetServiceDid, targetOrigin, this.plcUrl);
    const docRes = await this.fetchExternal(
      new Request(docUrl, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/did+ld+json, application/json" },
      }),
    );
    if (docRes.status !== 200) {
      await docRes.body?.cancel().catch(() => undefined);
      if (docRes.status >= 500) {
        throw new XrpcError(
          502,
          `Failed to resolve target service DID ${targetServiceDid} (${docRes.status}).`,
          "UpstreamDidResolutionFailed",
        );
      }
      throw new XrpcError(
        400,
        `Target service DID ${targetServiceDid} could not be resolved (${docRes.status}).`,
        "UnsupportedGroupHostTarget",
      );
    }
    const doc = await readUpstreamJson<{
      id?: unknown;
      service?: Array<{ id?: unknown; type?: unknown; serviceEndpoint?: unknown }>;
    }>(docRes, MAX_DID_DOCUMENT_BYTES).catch(() => null);
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.id !== targetServiceDid) {
      throw new XrpcError(
        400,
        `Target service DID document for ${targetServiceDid} is invalid or mismatched.`,
        "UnsupportedGroupHostTarget",
      );
    }
    const services = Array.isArray(doc.service) ? doc.service : [];
    const pdsSvc = services.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry.id === "#atproto_pds" || entry.id === `${targetServiceDid}#atproto_pds`),
    );
    if (!pdsSvc || typeof pdsSvc.serviceEndpoint !== "string" || pdsSvc.serviceEndpoint.length === 0) {
      throw new XrpcError(
        400,
        `Target service DID ${targetServiceDid} has no #atproto_pds service endpoint.`,
        "UnsupportedGroupHostTarget",
      );
    }
    let resolvedPdsCanonical: string;
    try {
      resolvedPdsCanonical = normalizeCanonicalOrigin(pdsSvc.serviceEndpoint);
    } catch {
      throw new XrpcError(
        400,
        `Target service DID ${targetServiceDid} #atproto_pds endpoint is invalid.`,
        "UnsupportedGroupHostTarget",
      );
    }
    if (resolvedPdsCanonical !== normalizedTarget) {
      throw new XrpcError(
        400,
        `Target service DID ${targetServiceDid} #atproto_pds (${resolvedPdsCanonical}) does not match requested target origin ${normalizedTarget}.`,
        "UnsupportedGroupHostTarget",
      );
    }
  }

  private runWithGroupMetaLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withGroupLock(this.groupDid, fn);
  }

  get metaSpaceUri(): string {
    return groupMetaUri(this.groupDid);
  }

  get membersSpaceUri(): string {
    return groupMembersUri(this.groupDid);
  }

  // ---------------------------------------------------------------------------
  // Profile, Rules & Labeler (`group.opensocial.meta/self`)
  // ---------------------------------------------------------------------------

  async getProfile(): Promise<GroupProfile | null> {
    try {
      const res = await this.xrpc.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: this.metaSpaceUri,
        repo: this.groupDid,
        collection: OPENSOCIAL_COLLECTION.profile,
        rkey: SELF_SKEY,
      });
      const val = res.value;
      if (!val || typeof val.displayName !== "string") return null;
      return {
        displayName: val.displayName,
        ...(typeof val.description === "string" ? { description: val.description } : {}),
        joinPolicy: typeof val.joinPolicy === "string" ? val.joinPolicy : "invite",
        ...(typeof val.url === "string" ? { url: val.url } : {}),
      };
    } catch (error) {
      if (isMissingXrpcResource(error)) return null;
      throw error;
    }
  }

  async updateProfile(patch: {
    displayName?: string;
    description?: string | null;
    joinPolicy?: "open" | "approval" | "invite";
    url?: string | null;
  }): Promise<GroupProfile> {
    const existing = await this.xrpc
      .query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: this.metaSpaceUri,
        repo: this.groupDid,
        collection: OPENSOCIAL_COLLECTION.profile,
        rkey: SELF_SKEY,
      })
      .then((res) => res.value, (err: unknown) => {
        if (isMissingXrpcResource(err)) return {} as Record<string, unknown>;
        throw err;
      });

    const next: Record<string, unknown> = {
      ...existing,
      $type: OPENSOCIAL_COLLECTION.profile,
    };
    if (patch.displayName !== undefined) next.displayName = patch.displayName;
    if (patch.description === null) delete next.description;
    else if (patch.description !== undefined) next.description = patch.description;
    if (patch.joinPolicy !== undefined) next.joinPolicy = patch.joinPolicy;
    if (patch.url === null) delete next.url;
    else if (patch.url !== undefined) next.url = patch.url;

    const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.profile, next, {
      authorityDid: this.groupDid,
      spaceUri: this.metaSpaceUri,
      repoDid: this.groupDid,
      rkey: SELF_SKEY,
    });
    if (!check.valid) throw new Error(check.reason);

    await this.xrpc.procedure("com.atproto.space.putRecord", {
      space: this.metaSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.profile,
      rkey: SELF_SKEY,
      record: next,
    });

    return {
      displayName: String(next.displayName),
      ...(typeof next.description === "string" ? { description: next.description } : {}),
      joinPolicy: typeof next.joinPolicy === "string" ? next.joinPolicy : "invite",
      ...(typeof next.url === "string" ? { url: next.url } : {}),
    };
  }

  async getPublicMeta(): Promise<boolean> {
    const current = await this.xrpc.query<{ policy?: Record<string, unknown> }>("com.atproto.space.getSpace", {
      space: this.metaSpaceUri,
    });
    return current.policy?.publicRead === true;
  }

  private async inspectPublicMetaState(): Promise<
    PublicMetaStatus & { policy: Record<string, unknown>; declarationCid?: string }
  > {
    const [current, decl] = await Promise.all([
      this.xrpc.query<{ policy?: Record<string, unknown> }>("com.atproto.space.getSpace", {
        space: this.metaSpaceUri,
      }),
      this.xrpc
        .query<{ cid?: string; value?: Record<string, unknown> }>("com.atproto.repo.getRecord", {
          repo: this.groupDid,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
        })
        .then(
          (res) => ({
            hasDeclaration: typeof res?.value === "object" && res.value !== null,
            ...(typeof res?.cid === "string" && res.cid.length > 0 ? { cid: res.cid } : {}),
          }),
          (err: unknown): { hasDeclaration: boolean; cid?: string } => {
            if (isMissingXrpcResource(err)) return { hasDeclaration: false };
            throw err;
          },
        ),
    ]);
    const policy = current.policy && typeof current.policy === "object" ? { ...current.policy } : {};
    const publicRead = policy.publicRead === true;
    return {
      publicRead,
      hasDeclaration: decl.hasDeclaration,
      consistent: publicRead === decl.hasDeclaration,
      policy,
      ...(decl.cid !== undefined ? { declarationCid: decl.cid } : {}),
    };
  }

  private async readRepoSwapCommit(): Promise<string | undefined> {
    try {
      const desc = await this.xrpc.query<Record<string, unknown>>("com.atproto.repo.describeRepo", {
        repo: this.groupDid,
      });
      if (typeof desc?.cid === "string" && desc.cid.length > 0) return desc.cid;
      if (typeof desc?.commit === "string" && desc.commit.length > 0) return desc.commit;
      if (
        desc?.commit &&
        typeof desc.commit === "object" &&
        typeof (desc.commit as { cid?: unknown }).cid === "string"
      ) {
        return (desc.commit as { cid: string }).cid;
      }
    } catch {
      // Optional CAS fallback when third-party host omits record CID and describeRepo is unavailable.
    }
    return undefined;
  }

  async getPublicMetaStatus(): Promise<PublicMetaStatus> {
    const state = await this.inspectPublicMetaState();
    return {
      publicRead: state.publicRead,
      hasDeclaration: state.hasDeclaration,
      consistent: state.consistent,
    };
  }

  private isInvalidSwapError(err: unknown): boolean {
    return err instanceof XrpcError && (err.code === "InvalidSwap" || err.code === "ConcurrentModification");
  }

  private async deleteDeclarationRecord(declarationCid?: string, swapCommit?: string): Promise<void> {
    await this.xrpc
      .procedure("com.atproto.repo.deleteRecord", {
        repo: this.groupDid,
        collection: REPO_COLLECTION.groupDeclaration,
        rkey: SELF_SKEY,
        ...(declarationCid ? { swapRecord: declarationCid } : swapCommit ? { swapCommit } : {}),
      })
      .catch((err: unknown) => {
        if (!isMissingXrpcResource(err)) throw err;
      });
  }

  private async putDeclarationRecord(declarationCid: string | null, swapCommit?: string): Promise<void> {
    await this.xrpc.procedure("com.atproto.repo.putRecord", {
      repo: this.groupDid,
      collection: REPO_COLLECTION.groupDeclaration,
      rkey: SELF_SKEY,
      swapRecord: declarationCid,
      ...(swapCommit ? { swapCommit } : {}),
      record: {
        $type: REPO_COLLECTION.groupDeclaration,
        meta: this.metaSpaceUri,
        createdAt: new Date(this.now()).toISOString(),
      },
    });
  }

  async setPublicMeta(publicMeta: boolean): Promise<void> {
    return this.runWithGroupMetaLock(async () => {
      const initial = await this.inspectPublicMetaState();

      if (!publicMeta) {
        await this.xrpc.procedure("com.atproto.space.updateSpace", {
          space: this.metaSpaceUri,
          policy: {
            ...initial.policy,
            publicRead: false,
          },
        });

        const afterSpace = await this.inspectPublicMetaState();
        if (afterSpace.publicRead !== false) {
          throw new PublicMetaReconciliationError(
            "Group metadata policy did not converge to publicRead=false.",
            afterSpace.consistent,
          );
        }

        try {
          if (afterSpace.hasDeclaration) {
            const swapCommit = afterSpace.declarationCid === undefined ? await this.readRepoSwapCommit() : undefined;
            try {
              await this.deleteDeclarationRecord(afterSpace.declarationCid, swapCommit);
            } catch (delErr) {
              if (!this.isInvalidSwapError(delErr)) throw delErr;
              const fresh = await this.inspectPublicMetaState();
              if (fresh.publicRead !== false) {
                throw new PublicMetaReconciliationError(
                  "Concurrent modification set publicRead=true during setPublicMeta(false).",
                  fresh.consistent,
                );
              }
              if (fresh.hasDeclaration) {
                await this.deleteDeclarationRecord(fresh.declarationCid);
              }
            }
          }
        } catch (declErr) {
          if (declErr instanceof PublicMetaReconciliationError) throw declErr;
          let rollbackErr: unknown;
          const liveOnErr = await this.inspectPublicMetaState().catch(() => undefined);
          if ((liveOnErr ? !liveOnErr.publicRead && liveOnErr.hasDeclaration : true) && initial.publicRead) {
            try {
              await this.xrpc.procedure("com.atproto.space.updateSpace", {
                space: this.metaSpaceUri,
                policy: {
                  ...(liveOnErr?.policy ?? afterSpace.policy),
                  ...initial.policy,
                  publicRead: true,
                },
              });
            } catch (rbErr) {
              rollbackErr = rbErr;
            }
          }
          const finalStatus = await this.getPublicMetaStatus().catch(() => ({
            publicRead: false,
            hasDeclaration: afterSpace.hasDeclaration,
            consistent: false,
          }));
          if (rollbackErr !== undefined || !finalStatus.consistent || finalStatus.publicRead !== initial.publicRead) {
            const detail = declErr instanceof Error ? declErr.message : String(declErr);
            const rbDetail = rollbackErr instanceof Error ? ` (rollback failed: ${rollbackErr.message})` : "";
            throw new PublicMetaReconciliationError(
              `Failed to reconcile group public declaration: ${detail}${rbDetail}`,
              finalStatus.consistent,
              { cause: declErr },
            );
          }
          throw declErr;
        }

        let verified = await this.inspectPublicMetaState();
        if (!verified.publicRead && verified.hasDeclaration) {
          await this.deleteDeclarationRecord(verified.declarationCid).catch(() => undefined);
          verified = await this.inspectPublicMetaState();
        } else if (verified.publicRead && !verified.hasDeclaration) {
          await this.putDeclarationRecord(null).catch(() => undefined);
          const repaired = await this.inspectPublicMetaState();
          if (!repaired.publicRead && repaired.hasDeclaration) {
            await this.deleteDeclarationRecord(repaired.declarationCid).catch(() => undefined);
          }
          const finalStatus = await this.getPublicMetaStatus();
          throw new PublicMetaReconciliationError(
            "Concurrent enable superseded setPublicMeta(false); restored declaration.",
            finalStatus.consistent,
          );
        }
        if (!verified.consistent || verified.publicRead !== false || verified.hasDeclaration !== false) {
          throw new PublicMetaReconciliationError(
            `Group public declaration remained inconsistent after update (publicRead=${String(verified.publicRead)}, hasDeclaration=${String(verified.hasDeclaration)}).`,
            verified.consistent,
          );
        }
        return;
      }

      await this.xrpc.procedure("com.atproto.space.updateSpace", {
        space: this.metaSpaceUri,
        policy: {
          ...initial.policy,
          publicRead: true,
        },
      });

      const statusAfterUpdate = await this.inspectPublicMetaState();
      if (statusAfterUpdate.publicRead !== true) {
        if (statusAfterUpdate.hasDeclaration) {
          await this.deleteDeclarationRecord(statusAfterUpdate.declarationCid).catch(() => undefined);
        }
        const repaired = await this.getPublicMetaStatus();
        throw new PublicMetaReconciliationError(
          "Concurrent modification set publicRead=false during setPublicMeta(true).",
          repaired.consistent,
        );
      }
      if (statusAfterUpdate.hasDeclaration) {
        return;
      }

      const swapCommit =
        statusAfterUpdate.declarationCid === undefined ? await this.readRepoSwapCommit() : undefined;
      const prePutSpace = await this.inspectPublicMetaState();
      if (prePutSpace.publicRead !== true) {
        if (prePutSpace.hasDeclaration) {
          await this.deleteDeclarationRecord(prePutSpace.declarationCid).catch(() => undefined);
        }
        const repaired = await this.getPublicMetaStatus();
        throw new PublicMetaReconciliationError(
          "Concurrent modification set publicRead=false before declaration write.",
          repaired.consistent,
        );
      }
      if (prePutSpace.hasDeclaration) {
        return;
      }

      let wroteDeclaration = false;
      try {
        await this.putDeclarationRecord(prePutSpace.declarationCid ?? null, swapCommit);
        wroteDeclaration = true;
      } catch (declErr) {
        const liveOnErr = await this.inspectPublicMetaState().catch(() => undefined);
        if (this.isInvalidSwapError(declErr) && liveOnErr?.publicRead === true && liveOnErr.hasDeclaration === true) {
          return;
        }
        let rollbackErr: unknown;
        if (liveOnErr && !liveOnErr.publicRead && liveOnErr.hasDeclaration) {
          await this.deleteDeclarationRecord(liveOnErr.declarationCid).catch((rbErr: unknown) => {
            rollbackErr = rbErr;
          });
        } else if ((liveOnErr ? liveOnErr.publicRead && !liveOnErr.hasDeclaration : !wroteDeclaration) && !initial.publicRead) {
          try {
            await this.xrpc.procedure("com.atproto.space.updateSpace", {
              space: this.metaSpaceUri,
              policy: {
                ...(liveOnErr?.policy ?? prePutSpace.policy),
                ...initial.policy,
                publicRead: false,
              },
            });
          } catch (rbErr) {
            rollbackErr = rbErr;
          }
        }
        let finalState = await this.inspectPublicMetaState().catch(() => ({
          publicRead: true,
          hasDeclaration: false,
          consistent: false,
          policy: prePutSpace.policy,
          declarationCid: undefined,
        }));
        if (!finalState.publicRead && finalState.hasDeclaration) {
          await this.deleteDeclarationRecord(finalState.declarationCid).catch(() => undefined);
          finalState = await this.inspectPublicMetaState().catch(() => finalState);
        }
        if (rollbackErr !== undefined || !finalState.consistent || finalState.publicRead !== initial.publicRead) {
          const detail = declErr instanceof Error ? declErr.message : String(declErr);
          const rbDetail = rollbackErr instanceof Error ? ` (rollback failed: ${rollbackErr.message})` : "";
          throw new PublicMetaReconciliationError(
            `Failed to reconcile group public declaration: ${detail}${rbDetail}`,
            finalState.consistent,
            { cause: declErr },
          );
        }
        throw declErr;
      }

      const verified = await this.inspectPublicMetaState();
      if (!verified.publicRead && verified.hasDeclaration) {
        await this.deleteDeclarationRecord(verified.declarationCid).catch(() => undefined);
        const repaired = await this.getPublicMetaStatus();
        throw new PublicMetaReconciliationError(
          "Concurrent disable superseded setPublicMeta(true); removed dangling declaration.",
          repaired.consistent,
        );
      }
      if (!verified.consistent || verified.publicRead !== true || verified.hasDeclaration !== true) {
        throw new PublicMetaReconciliationError(
          `Group public declaration remained inconsistent after update (publicRead=${String(verified.publicRead)}, hasDeclaration=${String(verified.hasDeclaration)}).`,
          verified.consistent,
        );
      }
    });
  }

  async listRules(maxRecords = 200): Promise<GroupRule[]> {
    const scanned = await listBoundedRecords(this.xrpc, {
      space: this.metaSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.rule,
      maxRecords,
    });
    return scanned.records
      .filter((rec) =>
        validateSpaceRecord(OPENSOCIAL_COLLECTION.rule, rec.value, {
          authorityDid: this.groupDid,
          spaceUri: this.metaSpaceUri,
          repoDid: this.groupDid,
          rkey: rec.rkey,
        }).valid,
      )
      .map((rec) => ({
        rkey: rec.rkey,
        uri: spaceRecordUri(this.metaSpaceUri, this.groupDid, OPENSOCIAL_COLLECTION.rule, rec.rkey),
        title: String(rec.value.title),
        text: String(rec.value.text),
        ...(typeof rec.value.order === "number" ? { order: rec.value.order } : {}),
      }))
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.rkey.localeCompare(b.rkey));
  }

  async putRule(input: { rkey?: string; title: string; text: string; order?: number }): Promise<{ uri: string; rkey: string }> {
    const rkey = input.rkey ?? tidNow(this.now());
    if (!isTid(rkey)) throw new Error("Rule rkey must be a valid TID.");
    const record: Record<string, unknown> = {
      $type: OPENSOCIAL_COLLECTION.rule,
      title: input.title,
      text: input.text,
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.rule, record, {
      authorityDid: this.groupDid,
      spaceUri: this.metaSpaceUri,
      repoDid: this.groupDid,
      rkey,
    });
    if (!check.valid) throw new Error(check.reason);
    const out = await this.xrpc.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: this.metaSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.rule,
      rkey,
      record,
    });
    return { uri: out.uri, rkey };
  }

  async deleteRule(rkey: string): Promise<void> {
    if (!isTid(rkey)) throw new Error("Rule rkey must be a valid TID.");
    await this.xrpc.procedure("com.atproto.space.deleteRecord", {
      space: this.metaSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.rule,
      rkey,
    });
  }

  async getLabeler(): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.xrpc.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: this.metaSpaceUri,
        repo: this.groupDid,
        collection: OPENSOCIAL_COLLECTION.labeler,
        rkey: SELF_SKEY,
      });
      return res.value;
    } catch (error) {
      if (isMissingXrpcResource(error)) return null;
      throw error;
    }
  }

  async putLabeler(policies: Record<string, unknown>): Promise<{ uri: string }> {
    const record: Record<string, unknown> = {
      $type: OPENSOCIAL_COLLECTION.labeler,
      policies,
    };
    const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.labeler, record, {
      authorityDid: this.groupDid,
      spaceUri: this.metaSpaceUri,
      repoDid: this.groupDid,
      rkey: SELF_SKEY,
    });
    if (!check.valid) throw new Error(check.reason);
    return this.xrpc.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: this.metaSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.labeler,
      rkey: SELF_SKEY,
      record,
    });
  }

  // ---------------------------------------------------------------------------
  // Roles & Memberships (`group.opensocial.members/self`)
  // ---------------------------------------------------------------------------

  async listRoles(maxRecords = 500): Promise<GroupRoleEntry[]> {
    const scanned = await listBoundedRecords(this.xrpc, {
      space: this.membersSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.role,
      maxRecords,
    });
    return scanned.records
      .filter((rec) =>
        validateSpaceRecord(OPENSOCIAL_COLLECTION.role, rec.value, {
          authorityDid: this.groupDid,
          spaceUri: this.membersSpaceUri,
          repoDid: this.groupDid,
          rkey: rec.rkey,
        }).valid,
      )
      .map((rec) => ({
        rkey: rec.rkey,
        uri: spaceRecordUri(this.membersSpaceUri, this.groupDid, OPENSOCIAL_COLLECTION.role, rec.rkey),
        displayName: String(rec.value.displayName),
        ...(typeof rec.value.description === "string" ? { description: rec.value.description } : {}),
        default: rec.value.default === true,
        scopes: Array.isArray(rec.value.scopes) ? (rec.value.scopes as string[]) : [],
        assignable: Array.isArray(rec.value.assignable) ? (rec.value.assignable as string[]) : [],
      }))
      .sort((a, b) => a.rkey.localeCompare(b.rkey));
  }

  async putRole(
    rkey: string,
    role: {
      displayName: string;
      description?: string;
      default?: boolean;
      scopes?: readonly string[];
      assignable?: readonly string[];
    },
  ): Promise<{ uri: string }> {
    if (!isRecordKey(rkey)) throw new Error("Invalid role rkey.");
    const record: Record<string, unknown> = {
      $type: OPENSOCIAL_COLLECTION.role,
      displayName: role.displayName,
      ...(role.description !== undefined ? { description: role.description } : {}),
      ...(role.default !== undefined ? { default: role.default } : {}),
      ...(role.scopes !== undefined ? { scopes: [...role.scopes] } : {}),
      ...(role.assignable !== undefined ? { assignable: [...role.assignable] } : {}),
    };
    const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.role, record, {
      authorityDid: this.groupDid,
      spaceUri: this.membersSpaceUri,
      repoDid: this.groupDid,
      rkey,
    });
    if (!check.valid) throw new Error(check.reason);
    return this.xrpc.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: this.membersSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.role,
      rkey,
      record,
    });
  }

  async deleteRole(rkey: string): Promise<void> {
    if (!isRecordKey(rkey)) throw new Error("Invalid role rkey.");
    await this.xrpc.procedure("com.atproto.space.deleteRecord", {
      space: this.membersSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.role,
      rkey,
    });
  }

  async listMemberships(maxRecords = 1_000): Promise<GroupMembershipEntry[]> {
    const scanned = await listBoundedRecords(this.xrpc, {
      space: this.membersSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      maxRecords,
    });
    return scanned.records
      .filter((rec) =>
        validateSpaceRecord(OPENSOCIAL_COLLECTION.membership, rec.value, {
          authorityDid: this.groupDid,
          spaceUri: this.membersSpaceUri,
          repoDid: this.groupDid,
          rkey: rec.rkey,
        }).valid,
      )
      .map((rec) => ({
        memberDid: rec.rkey,
        uri: spaceRecordUri(this.membersSpaceUri, this.groupDid, OPENSOCIAL_COLLECTION.membership, rec.rkey),
        roles: [...(rec.value.roles as string[])],
        createdAt: String(rec.value.createdAt),
        ...(typeof rec.value[FLOCK_EXTENSION_FIELD.incarnation] === "string"
          ? { incarnation: rec.value[FLOCK_EXTENSION_FIELD.incarnation] as string }
          : {}),
      }))
      .sort((a, b) => a.memberDid.localeCompare(b.memberDid));
  }

  async getMembership(memberDid: string): Promise<GroupMembershipEntry | null> {
    if (!isDid(memberDid)) throw new Error("Invalid member DID.");
    try {
      const res = await this.xrpc.query<{ uri: string; cid?: string; value: Record<string, unknown> }>(
        "com.atproto.space.getRecord",
        {
          space: this.membersSpaceUri,
          repo: this.groupDid,
          collection: OPENSOCIAL_COLLECTION.membership,
          rkey: memberDid,
        },
      );
      return {
        memberDid,
        uri: res.uri,
        ...(res.cid ? { cid: res.cid } : {}),
        roles: Array.isArray(res.value.roles) ? (res.value.roles as string[]) : [],
        createdAt: String(res.value.createdAt),
        ...(typeof res.value[FLOCK_EXTENSION_FIELD.incarnation] === "string"
          ? { incarnation: res.value[FLOCK_EXTENSION_FIELD.incarnation] as string }
          : {}),
      };
    } catch (error) {
      if (isMissingXrpcResource(error)) return null;
      throw error;
    }
  }

  async putMembership(
    memberDid: string,
    roles: readonly string[],
    options: { requireJoinRequest?: boolean } = {},
  ): Promise<{ uri: string; cid: string }> {
    if (!isDid(memberDid)) throw new Error("Invalid member DID.");
    if (roles.length === 0) throw new Error("Membership requires at least one role.");
    const existing = await this.getMembership(memberDid);
    const record: Record<string, unknown> = {
      $type: OPENSOCIAL_COLLECTION.membership,
      roles: [...new Set(roles)],
      createdAt: existing?.createdAt ?? new Date(this.now()).toISOString(),
    };
    return this.xrpc.procedure<unknown, { uri: string; cid: string }>(
      "com.atproto.space.putRecord",
      {
        space: this.membersSpaceUri,
        repo: this.groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: memberDid,
        record,
      },
      {},
      options.requireJoinRequest ? { headers: { "if-join-request-present": "true" } } : undefined,
    );
  }

  async deleteMembership(memberDid: string): Promise<void> {
    if (!isDid(memberDid)) throw new Error("Invalid member DID.");
    await this.xrpc.procedure("com.atproto.space.deleteRecord", {
      space: this.membersSpaceUri,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: memberDid,
    });
  }

  // ---------------------------------------------------------------------------
  // Cross-PDS Invitations & Delivery
  // ---------------------------------------------------------------------------

  async createInvite(
    inviteeDid: string,
    options: { expiresAt?: string; message?: string; rkey?: string } = {},
  ): Promise<{ uri: string; rkey: string }> {
    if (!isDid(inviteeDid)) throw new Error("Invalid invitee DID.");
    const rkey = options.rkey ?? tidNow(this.now());
    if (!isTid(rkey)) throw new Error("Invite rkey must be a valid TID.");
    const invitesSpace = personalInvitesUri(inviteeDid);
    const record: Record<string, unknown> = {
      $type: OPENSOCIAL_COLLECTION.invite,
      createdAt: new Date(this.now()).toISOString(),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.message !== undefined ? { message: options.message } : {}),
    };
    const check = validateSpaceRecord(OPENSOCIAL_COLLECTION.invite, record, {
      authorityDid: inviteeDid,
      spaceUri: invitesSpace,
      repoDid: this.groupDid,
      rkey,
    });
    if (!check.valid) throw new Error(check.reason);
    const out = await this.xrpc.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: invitesSpace,
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.invite,
      rkey,
      record,
    });
    return { uri: out.uri, rkey };
  }

  async revokeInvite(inviteeDid: string, rkey: string): Promise<void> {
    if (!isDid(inviteeDid)) throw new Error("Invalid invitee DID.");
    if (!isTid(rkey)) throw new Error("Invite rkey must be a valid TID.");
    await this.xrpc.procedure("com.atproto.space.deleteRecord", {
      space: personalInvitesUri(inviteeDid),
      repo: this.groupDid,
      collection: OPENSOCIAL_COLLECTION.invite,
      rkey,
    });
  }

  async listInviteDeliveries(options: { limit?: number; cursor?: string } = {}): Promise<{
    deliveries: GroupInviteDelivery[];
    cursor?: string;
  }> {
    const params = new URLSearchParams({ group: this.groupDid });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    return this.requestAdminJson(`/group-admin/invite-deliveries?${params.toString()}`, {
      method: "GET",
    });
  }

  async retryInviteDelivery(inviteUri: string): Promise<Record<string, unknown>> {
    return this.requestAdminJson("/group-admin/retry-invite-delivery", {
      method: "POST",
      body: { group: this.groupDid, inviteUri },
    });
  }

  // ---------------------------------------------------------------------------
  // Join Requests (`group.opensocial.listJoinRequests`, approve, deny)
  // ---------------------------------------------------------------------------

  async listJoinRequests(options: { limit?: number; cursor?: string } = {}): Promise<{
    requests: GroupJoinRequestItem[];
    cursor?: string;
  }> {
    return this.xrpc.query(OPENSOCIAL_METHOD.listJoinRequests, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
  }

  async approveJoinRequest(memberDid: string, roles?: readonly string[]): Promise<{ uri: string; cid: string }> {
    let assignedRoles = roles ? [...roles] : undefined;
    if (!assignedRoles || assignedRoles.length === 0) {
      const groupRoles = await this.listRoles();
      assignedRoles = groupRoles.filter((r) => r.default).map((r) => r.rkey);
      if (assignedRoles.length === 0) {
        throw new Error("No default role is configured for this group.");
      }
    }
    return this.putMembership(memberDid, assignedRoles, { requireJoinRequest: true });
  }

  async denyJoinRequest(memberDid: string): Promise<void> {
    if (!isDid(memberDid)) throw new Error("Invalid member DID.");
    await this.xrpc.procedure(OPENSOCIAL_METHOD.denyJoinRequest, { member: memberDid });
  }

  // ---------------------------------------------------------------------------
  // Moderation & Labels (`listModSubjects`, `getModSubjectHistory`, `resolveModSubject`, `com.atproto.label.record`)
  // ---------------------------------------------------------------------------

  async listModSubjects(options: {
    status?: "open" | "resolved" | "escalated";
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ subjects: ModSubjectItem[]; cursor?: string }> {
    return this.xrpc.query(OPENSOCIAL_METHOD.listModSubjects, {
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
  }

  async getModSubjectHistory(options: {
    subject: string;
    cid?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ events: ModSubjectHistoryEvent[]; cursor?: string }> {
    return this.xrpc.query(OPENSOCIAL_METHOD.getModSubjectHistory, {
      subject: options.subject,
      ...(options.cid !== undefined ? { cid: options.cid } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
  }

  async resolveModSubject(input: {
    subject: string;
    cid?: string;
    status: "resolved" | "escalated";
  }): Promise<ModSubjectItem> {
    return this.xrpc.procedure(OPENSOCIAL_METHOD.resolveModSubject, {
      subject: input.subject,
      ...(input.cid !== undefined ? { cid: input.cid } : {}),
      status: input.status,
    });
  }

  async publishLabel(input: {
    spaceUri?: string;
    uri: string;
    cid?: string;
    val: string;
    neg?: boolean;
    exp?: string;
    rkey?: string;
  }): Promise<{ uri: string; rkey: string }> {
    const targetSpaceUri = isDid(input.uri)
      ? this.membersSpaceUri
      : input.spaceUri ?? inferSpaceUriFromSubject(input.uri);
    if (!targetSpaceUri) {
      throw new Error("Target space URI is required for non-account label subjects.");
    }
    const rkey = input.rkey ?? tidNow(this.now());
    if (!isTid(rkey)) throw new Error("Label rkey must be a valid TID.");
    const record: Record<string, unknown> = {
      $type: ATPROTO_SPACE_COLLECTION.label,
      ver: 1,
      src: this.groupDid,
      uri: input.uri,
      ...(input.cid !== undefined ? { cid: input.cid } : {}),
      val: input.val,
      ...(input.neg !== undefined ? { neg: input.neg } : {}),
      cts: new Date(this.now()).toISOString(),
      ...(input.exp !== undefined ? { exp: input.exp } : {}),
    };
    const check = validateSpaceRecord(ATPROTO_SPACE_COLLECTION.label, record, {
      authorityDid: this.groupDid,
      spaceUri: targetSpaceUri,
      repoDid: this.groupDid,
      rkey,
    });
    if (!check.valid) throw new Error(check.reason);
    const out = await this.xrpc.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
      space: targetSpaceUri,
      repo: this.groupDid,
      collection: ATPROTO_SPACE_COLLECTION.label,
      rkey,
      record,
    });
    return { uri: out.uri, rkey };
  }

  async negateLabel(input: {
    spaceUri?: string;
    uri: string;
    cid?: string;
    val: string;
  }): Promise<{ uri: string; rkey: string }> {
    return this.publishLabel({ ...input, neg: true });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle, Step-Up Action Claim & Group Host Migration
  // ---------------------------------------------------------------------------

  async checkAccountStatus(): Promise<{
    activated: boolean;
    validDid: boolean;
    repoCommit: string;
    repoRev: string;
    repoBlocks: number;
    indexedRecords: number;
    privateStateValues: number;
    expectedBlobs: number;
    importedBlobs: number;
  }> {
    return this.xrpc.query("com.atproto.server.checkAccountStatus");
  }

  async deactivateAccount(deleteAfter?: string): Promise<void> {
    await this.xrpc.procedure("com.atproto.server.deactivateAccount", {
      ...(deleteAfter !== undefined ? { deleteAfter } : {}),
    });
  }

  async activateAccount(): Promise<void> {
    await this.xrpc.procedure("com.atproto.server.activateAccount", {});
  }

  async requestAccountDelete(): Promise<void> {
    await this.xrpc.procedure("com.atproto.server.requestAccountDelete", {});
  }

  async claimActionToken(purpose: "plc_operation" | "delete_account"): Promise<{ token: string; expiresAt: string }> {
    return this.requestAdminJson("/group-admin/claim-action-token", {
      method: "POST",
      body: { group: this.groupDid, purpose },
    });
  }

  async deleteAccount(token: string): Promise<void> {
    await this.xrpc.procedure("com.atproto.server.deleteAccount", {
      did: this.groupDid,
      password: this.groupDid,
      token,
    });
  }

  async prepareMigration(
    targetEndpoint: string,
    operationId = tidNow(this.now()),
    options?: { mode?: "auto" | "coordinated" },
  ): Promise<PreparedGroupMigration> {
    return this.requestAdminJson("/group-admin/prepare-migration", {
      method: "POST",
      body: {
        group: this.groupDid,
        operationId,
        targetEndpoint: normalizeOrigin(targetEndpoint),
        ...(options?.mode !== undefined ? { mode: options.mode } : {}),
      },
    });
  }

  async abortMigration(
    operationId?: string,
    options?: { migrationState?: GroupMigrationStateStore },
  ): Promise<{ status: string }> {
    return this.withMigrationLock(this.groupDid, async () => {
      const stateStore = ensureCasMigrationStateStore(options?.migrationState ?? this.migrationState);
      const existingState = await Promise.resolve(stateStore.get(this.groupDid));
      if (!existingState) {
        return this.requestSourceAbortMigration(operationId);
      }

      if (operationId !== undefined && existingState.operationId !== operationId) {
        return this.requestSourceAbortMigration(operationId);
      }

      if (existingState.phase === "plc_submitted") {
        throw new XrpcError(
          409,
          "Migration cutover has already been submitted to PLC and cannot be aborted.",
          "MigrationCutoverCommitted",
        );
      }

      let currentState: PersistedGroupMigrationState = existingState;
      let expected: GroupMigrationCasExpected = {
        operationId: existingState.operationId,
        revision: existingState.revision ?? 1,
      };
      const casUpdate = async (patch: Partial<PersistedGroupMigrationState>): Promise<void> => {
        const saved = await stateStore.compareAndSet(this.groupDid, expected, {
          ...currentState,
          ...patch,
        });
        currentState = saved;
        expected = {
          operationId: saved.operationId,
          revision: saved.revision ?? expected.revision + 1,
        };
      };

      const effectiveOpId = operationId ?? currentState.operationId;
      const isStandard =
        currentState.negotiatedMode === "standard" ||
        (currentState.negotiatedMode === undefined && currentState.mode === "standard");
      const resolvedTicketId =
        currentState.ticketId ?? extractTicketIdFromMigrationTicket(currentState.migrationTicket);

      const recoverUnleasedStandardTargetSession = async (): Promise<
        { kind: "recovered"; accessJwt: string; refreshJwt: string } | { kind: "already_aborted" }
      > => {
        if (!currentState.targetOriginVerified) {
          if (!currentState.targetServiceDid || !isDid(currentState.targetServiceDid)) {
            throw new XrpcError(400, "Target service DID is missing or invalid.", "UnsupportedGroupHostTarget");
          }
          await this.verifyTargetServiceDidBinding(currentState.targetServiceDid, currentState.targetOrigin);
          await casUpdate({ targetOriginVerified: true });
        }
        const { token: recoverCreateJwt } = await this.xrpc.query<{ token: string }>(
          "com.atproto.server.getServiceAuth",
          {
            aud: currentState.targetServiceDid!,
            lxm: "com.atproto.server.createAccount",
          },
        );
        const recoverRes = await this.fetchExternal(
          new Request(`${currentState.targetOrigin}/xrpc/com.atproto.server.createAccount`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${recoverCreateJwt}`,
              "x-group-migration-operation-id": effectiveOpId,
            },
            body: JSON.stringify({
              did: this.groupDid,
              handle: currentState.handle,
              ...(typeof currentState.recoveryKey === "string"
                ? { recoveryKey: currentState.recoveryKey }
                : {}),
            }),
          }),
        );
        const recoverBody = await readUpstreamJson<{
          accessJwt?: unknown;
          refreshJwt?: unknown;
          error?: string;
          message?: string;
        }>(recoverRes, MAX_ADMIN_JSON_BYTES).catch(() => null);
        if (recoverRes.status === 200) {
          if (
            typeof recoverBody?.accessJwt !== "string" ||
            recoverBody.accessJwt.length === 0 ||
            typeof recoverBody?.refreshJwt !== "string" ||
            recoverBody.refreshJwt.length === 0
          ) {
            throw new XrpcError(
              502,
              "Target createAccount recovery returned incomplete migration session tokens.",
              "InvalidResponse",
            );
          }
          await casUpdate({
            phase: groupMigrationPhaseRank(currentState.phase) < groupMigrationPhaseRank("account_created")
              ? "account_created"
              : currentState.phase,
            accessJwt: recoverBody.accessJwt,
            refreshJwt: recoverBody.refreshJwt,
            pendingRefreshKey: null,
          });
          return {
            kind: "recovered",
            accessJwt: recoverBody.accessJwt,
            refreshJwt: recoverBody.refreshJwt,
          };
        }
        if (recoverRes.status === 409 && recoverBody?.error === "OperationIdAlreadyAborted") {
          return { kind: "already_aborted" };
        }
        if (
          (recoverRes.status === 409 && recoverBody?.error === "MigrationCutoverCommitted") ||
          (recoverRes.status === 400 && recoverBody?.error === "AlreadyHostedHere")
        ) {
          await casUpdate({ phase: "plc_submitted" }).catch(() => undefined);
          throw new XrpcError(
            409,
            recoverBody?.message ?? "Migration cutover has already committed on target.",
            "MigrationCutoverCommitted",
          );
        }
        throw new XrpcError(
          recoverRes.status,
          recoverBody?.message ?? `Target createAccount recovery during abort failed (${recoverRes.status}).`,
          recoverBody?.error ?? "XrpcError",
        );
      };

      let targetCleanupAlreadyProven = false;
      if (
        currentState.mode === "standard" &&
        !currentState.accessJwt &&
        currentState.phase === "prepared" &&
        currentState.targetOrigin &&
        currentState.targetServiceDid &&
        currentState.handle
      ) {
        // Explicit unleased Standard mode has no Source lease, so if `createAccount` committed on Target
        // before the HTTP response was lost, Source abort (`already_absent`) will not purge Target and
        // service-JWT target abort fails closed (`ticket_id === null`). Recover the Target bearer via
        // idempotent `createAccount` replay so we can purge Target cleanly (or confirm it was already aborted).
        const recovered = await recoverUnleasedStandardTargetSession();
        if (recovered.kind === "already_aborted") {
          targetCleanupAlreadyProven = true;
        }
      }

      if (!targetCleanupAlreadyProven && currentState.targetOrigin && currentState.accessJwt) {
        if (!currentState.targetOriginVerified) {
          if (!currentState.targetServiceDid || !isDid(currentState.targetServiceDid)) {
            throw new XrpcError(400, "Target service DID is missing or invalid.", "UnsupportedGroupHostTarget");
          }
          await this.verifyTargetServiceDidBinding(currentState.targetServiceDid, currentState.targetOrigin);
          await casUpdate({ targetOriginVerified: true });
        }
        let targetAccessJwt = currentState.accessJwt;
        let targetRefreshJwt = currentState.refreshJwt;
        let targetAccessExpiresAtMs =
          decodeJwtExpMs(targetAccessJwt) ?? this.now() + DEFAULT_ACCESS_JWT_LIFETIME_MS;

        const refreshAbortTargetSession = async (): Promise<void> => {
          if (!targetRefreshJwt) return;
          let refreshKey =
            typeof currentState.pendingRefreshKey === "string" && currentState.pendingRefreshKey.length > 0
              ? currentState.pendingRefreshKey
              : null;
          if (!refreshKey) {
            refreshKey = `migref-${globalThis.crypto.randomUUID()}`;
            await casUpdate({ pendingRefreshKey: refreshKey });
          }
          const refreshRes = await this.fetchExternal(
            new Request(`${currentState.targetOrigin}/xrpc/com.atproto.server.refreshSession`, {
              method: "POST",
              headers: {
                accept: "application/json",
                authorization: `Bearer ${targetRefreshJwt}`,
                "idempotency-key": refreshKey,
              },
            }),
          );
          const refreshed = await readUpstreamJson<{
            accessJwt?: string;
            refreshJwt?: string;
            error?: string;
            message?: string;
          }>(refreshRes, MAX_ADMIN_JSON_BYTES).catch(() => null);
          if (!refreshRes.ok || !refreshed?.accessJwt) {
            throw new XrpcError(
              refreshRes.status,
              refreshed?.message ?? `Target refreshSession failed (${refreshRes.status}).`,
              refreshed?.error ?? "XrpcError",
            );
          }
          targetAccessJwt = refreshed.accessJwt;
          if (refreshed.refreshJwt) {
            targetRefreshJwt = refreshed.refreshJwt;
          }
          targetAccessExpiresAtMs =
            decodeJwtExpMs(targetAccessJwt) ?? this.now() + DEFAULT_ACCESS_JWT_LIFETIME_MS;
          await casUpdate({
            accessJwt: targetAccessJwt,
            ...(targetRefreshJwt !== undefined ? { refreshJwt: targetRefreshJwt } : {}),
            pendingRefreshKey: null,
          });
        };

        const sendTargetAbort = (bearer: string): Promise<Response> =>
          this.fetchExternal(
            new Request(`${currentState.targetOrigin}/group-admin/abort-migration`, {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                authorization: `Bearer ${bearer}`,
              },
              body: JSON.stringify({
                group: this.groupDid,
                operationId: effectiveOpId,
                ...(resolvedTicketId ? { ticketId: resolvedTicketId } : {}),
              }),
            }),
          );

        let usedServiceFallback = false;
        const tryFallbackServiceAbort = async (): Promise<Response | null> => {
          if (!currentState.targetServiceDid || !effectiveOpId) return null;
          if (!currentState.targetOriginVerified) {
            await this.verifyTargetServiceDidBinding(currentState.targetServiceDid, currentState.targetOrigin);
            await casUpdate({ targetOriginVerified: true });
          }
          let token: string | undefined;
          try {
            const out = await this.xrpc.query<{ token: string }>(
              "com.atproto.server.getServiceAuth",
              {
                aud: currentState.targetServiceDid,
                lxm: "group.opensocial.abortMigration",
              },
            );
            token = out.token;
          } catch {
            return null;
          }
          if (!token) return null;
          usedServiceFallback = true;
          return sendTargetAbort(token);
        };

        const tryRecoverStandardBearerAbort = async (): Promise<Response | null> => {
          if (!isStandard || !currentState.targetServiceDid || !currentState.handle) {
            return null;
          }
          const recovered = await recoverUnleasedStandardTargetSession();
          if (recovered.kind === "already_aborted") {
            targetCleanupAlreadyProven = true;
            return null;
          }
          targetAccessJwt = recovered.accessJwt;
          targetRefreshJwt = recovered.refreshJwt;
          targetAccessExpiresAtMs =
            decodeJwtExpMs(targetAccessJwt) ?? this.now() + DEFAULT_ACCESS_JWT_LIFETIME_MS;
          usedServiceFallback = false;
          return sendTargetAbort(targetAccessJwt);
        };

        const hasPendingRefresh =
          typeof currentState.pendingRefreshKey === "string" && currentState.pendingRefreshKey.length > 0;
        let targetAbortRes: Response | null = null;
        if (
          targetRefreshJwt &&
          (hasPendingRefresh || this.now() + ACCESS_JWT_REFRESH_LEAD_MS >= targetAccessExpiresAtMs)
        ) {
          try {
            await refreshAbortTargetSession();
          } catch (refreshErr) {
            if (refreshErr instanceof XrpcError && refreshErr.status === 401) {
              // If Target already purged `migration_session` on a prior lost abort response, `refreshSession` returns 401:
              // try the unexpired `targetAccessJwt` first (`already_absent`), then recover Standard bearer via
              // `createAccount` replay (or fall back to `<groupDid>` service-JWT abort when coordinated).
              if (this.now() < targetAccessExpiresAtMs) {
                const directRes = await sendTargetAbort(targetAccessJwt);
                if (directRes.status === 200 || (isStandard && directRes.status === 404)) {
                  targetAbortRes = directRes;
                }
              }
              if (!targetAbortRes) {
                targetAbortRes = await tryRecoverStandardBearerAbort();
              }
              if (!targetAbortRes && !targetCleanupAlreadyProven) {
                targetAbortRes = await tryFallbackServiceAbort();
              }
              if (!targetAbortRes && !targetCleanupAlreadyProven) {
                throw refreshErr;
              }
            } else {
              throw refreshErr;
            }
          }
        }

        if (!targetAbortRes && !targetCleanupAlreadyProven) {
          targetAbortRes = await sendTargetAbort(targetAccessJwt);
          if (targetAbortRes.status === 401 || targetAbortRes.status === 400) {
            const errBody = await readUpstreamJson<{ error?: string }>(
              targetAbortRes.clone(),
              MAX_ADMIN_JSON_BYTES,
            ).catch(() => null);
            if (targetRefreshJwt && errBody?.error === "ExpiredToken") {
              try {
                await refreshAbortTargetSession();
                targetAbortRes = await sendTargetAbort(targetAccessJwt);
              } catch (refreshErr) {
                if (refreshErr instanceof XrpcError && refreshErr.status === 401) {
                  const recoveredRes = await tryRecoverStandardBearerAbort();
                  if (recoveredRes) {
                    targetAbortRes = recoveredRes;
                  } else if (!targetCleanupAlreadyProven) {
                    const fallbackRes = await tryFallbackServiceAbort();
                    if (!fallbackRes) throw refreshErr;
                    targetAbortRes = fallbackRes;
                  }
                } else {
                  throw refreshErr;
                }
              }
            } else if (targetAbortRes.status === 401) {
              const recoveredRes = await tryRecoverStandardBearerAbort();
              if (recoveredRes) {
                targetAbortRes = recoveredRes;
              } else if (!targetCleanupAlreadyProven) {
                const fallbackRes = await tryFallbackServiceAbort();
                if (fallbackRes) {
                  targetAbortRes = fallbackRes;
                }
              }
            }
          }
        }

        if (!targetCleanupAlreadyProven && targetAbortRes) {
          if (targetAbortRes.status !== 200) {
            if (!(isStandard && !usedServiceFallback && targetAbortRes.status === 404)) {
              const abortErr = await readUpstreamJson<{ error?: string; message?: string }>(
                targetAbortRes,
                MAX_ADMIN_JSON_BYTES,
              ).catch(() => null);
              if (abortErr?.error === "MigrationCutoverCommitted") {
                await casUpdate({ phase: "plc_submitted" }).catch(() => undefined);
              }
              const isUnexpected2xx = targetAbortRes.status >= 200 && targetAbortRes.status < 300;
              throw new XrpcError(
                isUnexpected2xx ? 502 : targetAbortRes.status,
                isUnexpected2xx
                  ? `Target abort-migration returned unexpected HTTP ${targetAbortRes.status} (expected 200).`
                  : (abortErr?.message ?? `Target abort-migration failed (${targetAbortRes.status}).`),
                isUnexpected2xx ? "InvalidResponse" : (abortErr?.error ?? "XrpcError"),
              );
            }
          } else {
            const okBody = await readUpstreamJson<{ status?: unknown }>(
              targetAbortRes,
              MAX_ADMIN_JSON_BYTES,
            ).catch(() => null);
            const status = okBody?.status;
            const validStatus = usedServiceFallback
              ? status === "purged" || status === "already_absent"
              : status === "purged" || status === "already_absent" || status === "superseded";
            if (!validStatus) {
              throw new XrpcError(
                usedServiceFallback && status === "superseded" ? 409 : 502,
                usedServiceFallback && status === "superseded"
                  ? "Target service-JWT abort returned superseded without proving staging cleanup."
                  : "Target abort-migration returned an invalid or unverified acknowledgement.",
                usedServiceFallback && status === "superseded" ? "TargetAbortUnproven" : "InvalidResponse",
              );
            }
          }
        }
      }

      let out: { status: "aborted" | "already_absent" };
      try {
        out = await this.requestSourceAbortMigration(effectiveOpId);
      } catch (sourceAbortErr) {
        if (sourceAbortErr instanceof XrpcError && sourceAbortErr.code === "MigrationCutoverCommitted") {
          await casUpdate({ phase: "plc_submitted" }).catch(() => undefined);
        }
        throw sourceAbortErr;
      }

      await stateStore.compareAndDelete(this.groupDid, expected);
      return out;
    });
  }

  private async requestSourceAbortMigration(
    operationId?: string,
  ): Promise<{ status: "aborted" | "already_absent" }> {
    const response = await this.fetchHandler("/group-admin/abort-migration", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        group: this.groupDid,
        ...(operationId !== undefined ? { operationId } : {}),
      }),
    });
    const body = await readUpstreamJson<{ status?: unknown; error?: string; message?: string }>(
      response,
      MAX_ADMIN_JSON_BYTES,
    ).catch(() => null);
    if (response.status !== 200) {
      const isUnexpected2xx = response.status >= 200 && response.status < 300;
      throw new XrpcError(
        isUnexpected2xx ? 502 : response.status,
        isUnexpected2xx
          ? `Source abort-migration returned unexpected HTTP ${response.status} (expected 200).`
          : (body?.message ?? `Source abort-migration failed (${response.status}).`),
        isUnexpected2xx ? "InvalidResponse" : (body?.error ?? "XrpcError"),
      );
    }
    if (body?.status !== "aborted" && body?.status !== "already_absent") {
      throw new XrpcError(
        502,
        "Source abort-migration returned an invalid or unverified acknowledgement.",
        "InvalidResponse",
      );
    }
    return { status: body.status };
  }

  /**
   * Executes end-to-end phase-resumable Group Host migration (`proposal.md:161-175`) in `"auto"`, explicit
   * `"coordinated"` v1 mode, or `"standard"` ATProto migration mode.
   */
  async migrateToHost(
    targetEndpoint: string,
    options: {
      handle: string;
      operationId?: string;
      recoveryKey?: string;
      mode?: GroupMigrationRequestedMode;
      useCoordinated?: boolean;
      migrationState?: GroupMigrationStateStore;
    },
  ): Promise<{ mode: "coordinated" | "standard"; did: string; handle: string; targetEndpoint: string }> {
    const targetOrigin = normalizeOrigin(targetEndpoint);
    const normalizedHandle = options.handle.trim().toLowerCase();
    if (normalizedHandle.length === 0) {
      throw new XrpcError(400, "Group migration handle must not be empty.", "InvalidHandle");
    }
    const hasExplicitRecoveryKey = options.recoveryKey !== undefined;
    const normalizedRecoveryKey: string | null =
      options.recoveryKey !== undefined ? options.recoveryKey.trim() : null;
    const requestedMode: GroupMigrationRequestedMode =
      options.mode ?? (options.useCoordinated === false ? "standard" : "auto");

    return this.withMigrationLock(this.groupDid, async () => {
      const stateStore = ensureCasMigrationStateStore(options.migrationState ?? this.migrationState);
      const existingState = await Promise.resolve(stateStore.get(this.groupDid));
      const existingPhase: GroupMigrationPhase = existingState?.phase ?? "starting";

      const isModeCompatible = (state: PersistedGroupMigrationState): boolean => {
        if (state.mode === requestedMode) return true;
        if (requestedMode === "auto") {
          return state.negotiatedMode !== undefined || state.mode === "coordinated";
        }
        if (state.mode === "auto" && state.negotiatedMode !== undefined) {
          return state.negotiatedMode === requestedMode;
        }
        return false;
      };

      let resuming = false;
      if (existingState) {
        const existingNormalizedHandle = existingState.handle.trim().toLowerCase();
        const sameTarget = normalizeCanonicalOrigin(existingState.targetOrigin) === normalizeCanonicalOrigin(targetOrigin);
        const sameHandle =
          existingNormalizedHandle.length === 0 || normalizedHandle === existingNormalizedHandle;
        const sameRecoveryKey =
          !hasExplicitRecoveryKey ||
          existingState.recoveryKey === undefined ||
          normalizedRecoveryKey === existingState.recoveryKey;
        const compatibleMode = isModeCompatible(existingState);
        const explicitOverrideOp =
          options.operationId !== undefined && options.operationId !== existingState.operationId;

        if (explicitOverrideOp || !sameTarget || !sameHandle || !sameRecoveryKey || !compatibleMode) {
          throw new XrpcError(
            409,
            `Migration ${existingState.operationId} (phase: ${existingPhase}) is already recorded for ${this.groupDid}; resume with matching migration parameters or abort it first.`,
            "MigrationInProgress",
          );
        }
        resuming = true;
      }

      const operationId = resuming ? existingState!.operationId : (options.operationId ?? tidNow(this.now()));

      let currentState: PersistedGroupMigrationState;
      let expected: GroupMigrationCasExpected;
      if (resuming) {
        const persistedHandle = existingState!.handle.trim().toLowerCase();
        const persistedRecoveryKey =
          existingState!.recoveryKey !== undefined ? existingState!.recoveryKey : normalizedRecoveryKey;
        currentState = {
          ...existingState!,
          handle: persistedHandle || normalizedHandle,
          recoveryKey: persistedRecoveryKey,
          phase: existingPhase,
        };
        expected = {
          operationId: existingState!.operationId,
          revision: existingState!.revision ?? 1,
        };
      } else {
        const initial: PersistedGroupMigrationState = {
          operationId,
          targetOrigin,
          handle: normalizedHandle,
          recoveryKey: normalizedRecoveryKey,
          mode: requestedMode,
          ticketId: null,
          phase: "starting",
        };
        currentState = await stateStore.compareAndSet(this.groupDid, null, initial);
        expected = {
          operationId: currentState.operationId,
          revision: currentState.revision ?? 1,
        };
      }

      let casChain: Promise<void> = Promise.resolve();
      const persistState = (patch: Partial<PersistedGroupMigrationState>): Promise<void> => {
        const run = casChain.then(async () => {
          const candidate: PersistedGroupMigrationState = { ...currentState, ...patch };
          const saved = await stateStore.compareAndSet(this.groupDid, expected, candidate);
          currentState = saved;
          expected = {
            operationId: saved.operationId,
            revision: saved.revision ?? expected.revision + 1,
          };
        });
        casChain = run.catch(() => undefined);
        return run;
      };

      const deleteCurrentState = async (): Promise<boolean> => {
        await casChain;
        return stateStore.compareAndDelete(this.groupDid, expected);
      };

      const hasResumableTargetSession =
        (currentState.phase === "account_created" ||
          currentState.phase === "staged" ||
          currentState.phase === "signing_plc" ||
          currentState.phase === "plc_signed" ||
          currentState.phase === "plc_submitted") &&
        typeof currentState.accessJwt === "string" &&
        currentState.accessJwt.length > 0;

      if (!hasResumableTargetSession) {
        if (
          currentState.phase === "starting" ||
          !currentState.targetServiceDid ||
          (requestedMode !== "standard" && currentState.negotiatedMode === undefined)
        ) {
          if (requestedMode !== "standard") {
            let prepared: PreparedGroupMigration;
            try {
              prepared = await this.prepareMigration(
                targetOrigin,
                operationId,
                requestedMode === "coordinated" ? { mode: "coordinated" } : undefined,
              );
            } catch (err) {
              if (isDeterministicPreCutover4xx(err)) {
                await deleteCurrentState().catch(() => false);
              }
              throw err;
            }
            if (requestedMode === "coordinated" && prepared.mode !== "coordinated") {
              const aborted = await this.requestSourceAbortMigration(operationId).then(
                () => true,
                () => false,
              );
              if (aborted) {
                await deleteCurrentState().catch(() => false);
              }
              throw new XrpcError(
                409,
                `Target host ${targetOrigin} did not negotiate coordinated migration (received "${prepared.mode}").`,
                "CoordinatedMigrationUnsupported",
              );
            }
            if (
              !isDid(prepared.targetServiceDid) ||
              typeof prepared.targetEndpoint !== "string" ||
              normalizeCanonicalOrigin(prepared.targetEndpoint) !== normalizeCanonicalOrigin(targetOrigin)
            ) {
              throw new XrpcError(
                400,
                `Source prepare-migration returned mismatched target binding for ${targetOrigin}.`,
                "UnsupportedGroupHostTarget",
              );
            }
            const resolvedTicketId = prepared.ticketId ?? extractTicketIdFromMigrationTicket(prepared.migrationTicket);
            await persistState({
              phase: "prepared",
              negotiatedMode: prepared.mode,
              targetServiceDid: prepared.targetServiceDid,
              targetOriginVerified: true,
              migrationTicket: prepared.migrationTicket,
              ticketId: resolvedTicketId,
            });
          } else {
            try {
              const descRes = await this.fetchExternal(
                new Request(`${targetOrigin}/xrpc/com.atproto.server.describeServer`, {
                  method: "GET",
                  headers: { accept: "application/json" },
                }),
              );
              const descBody = await readUpstreamJson<{ did?: string; error?: string; message?: string }>(
                descRes,
                MAX_ADMIN_JSON_BYTES,
              ).catch(() => null);
              if (descRes.status !== 200 || typeof descBody?.did !== "string" || !isDid(descBody.did)) {
                const isUnexpected2xx = descRes.status >= 200 && descRes.status < 300;
                throw new XrpcError(
                  isUnexpected2xx ? 400 : descRes.status,
                  isUnexpected2xx
                    ? `Target describeServer returned invalid DID or unexpected HTTP ${descRes.status}.`
                    : (descBody?.message ?? `Failed to describe target host (${descRes.status}).`),
                  isUnexpected2xx ? "UnsupportedGroupHostTarget" : (descBody?.error ?? "XrpcError"),
                );
              }
              await this.verifyTargetServiceDidBinding(descBody.did, targetOrigin);
              await persistState({
                phase: "prepared",
                negotiatedMode: "standard",
                targetServiceDid: descBody.did,
                targetOriginVerified: true,
                migrationTicket: null,
                ticketId: null,
              });
            } catch (err) {
              if (isDeterministicPreCutover4xx(err)) {
                await deleteCurrentState().catch(() => false);
              }
              throw err;
            }
          }
        } else if (requestedMode === "coordinated" && currentState.negotiatedMode !== "coordinated") {
          const aborted = await this.requestSourceAbortMigration(operationId).then(
            () => true,
            () => false,
          );
          if (aborted) {
            await deleteCurrentState().catch(() => false);
          }
          throw new XrpcError(
            409,
            `Target host ${targetOrigin} did not negotiate coordinated migration (received "${currentState.negotiatedMode}").`,
            "CoordinatedMigrationUnsupported",
          );
        }

        if (!currentState.targetOriginVerified) {
          if (!currentState.targetServiceDid || !isDid(currentState.targetServiceDid)) {
            throw new XrpcError(400, "Target service DID is missing or invalid.", "UnsupportedGroupHostTarget");
          }
          await this.verifyTargetServiceDidBinding(currentState.targetServiceDid, targetOrigin);
          await persistState({ targetOriginVerified: true });
        }

        try {
          const { token: createAccountJwt } = await this.xrpc.query<{ token: string }>(
            "com.atproto.server.getServiceAuth",
            {
              aud: currentState.targetServiceDid!,
              lxm: "com.atproto.server.createAccount",
            },
          );

          const createHeaders: Record<string, string> = {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${createAccountJwt}`,
            "x-group-migration-operation-id": operationId,
          };
          if (currentState.migrationTicket) {
            createHeaders["x-group-migration-ticket"] = currentState.migrationTicket;
          }
          const createRes = await this.fetchExternal(
            new Request(`${targetOrigin}/xrpc/com.atproto.server.createAccount`, {
              method: "POST",
              headers: createHeaders,
              body: JSON.stringify({
                did: this.groupDid,
                handle: currentState.handle,
                ...(typeof currentState.recoveryKey === "string"
                  ? { recoveryKey: currentState.recoveryKey }
                  : {}),
              }),
            }),
          );
          const created = await readUpstreamJson<{
            accessJwt?: string;
            refreshJwt?: string;
            handle?: string;
            did?: string;
            error?: string;
            message?: string;
          }>(createRes, MAX_ADMIN_JSON_BYTES);
          if (!createRes.ok || !created?.accessJwt) {
            throw new XrpcError(
              createRes.status,
              created?.message ?? `Target createAccount failed (${createRes.status}).`,
              created?.error ?? "XrpcError",
            );
          }

          await persistState({
            phase: "account_created",
            handle: created.handle ?? currentState.handle,
            accessJwt: created.accessJwt,
            ...(created.refreshJwt !== undefined ? { refreshJwt: created.refreshJwt } : {}),
            pendingRefreshKey: null,
          });
        } catch (err) {
          if (err instanceof XrpcError && err.code === "MigrationCutoverCommitted") {
            throw err;
          }
          if (isDeterministicPreCutover4xx(err)) {
            const sourceAborted = await this.requestSourceAbortMigration(operationId).then(
              () => true,
              () => false,
            );
            if (sourceAborted) {
              await deleteCurrentState().catch(() => false);
            }
          }
          throw err;
        }
      }

      if (!currentState.targetOriginVerified) {
        if (!currentState.targetServiceDid || !isDid(currentState.targetServiceDid)) {
          throw new XrpcError(400, "Target service DID is missing or invalid.", "UnsupportedGroupHostTarget");
        }
        await this.verifyTargetServiceDidBinding(currentState.targetServiceDid, targetOrigin);
        await persistState({ targetOriginVerified: true });
      }

      const mode: "coordinated" | "standard" =
        currentState.negotiatedMode ?? (requestedMode === "coordinated" ? "coordinated" : "standard");
      const ticketId: string | null =
        currentState.ticketId ?? extractTicketIdFromMigrationTicket(currentState.migrationTicket);

      let accessJwt = currentState.accessJwt!;
      let refreshJwt = currentState.refreshJwt;
      let accessJwtExpiresAtMs = decodeJwtExpMs(accessJwt) ?? this.now() + DEFAULT_ACCESS_JWT_LIFETIME_MS;
      let refreshInFlight: Promise<void> | null = null;

      const refreshTargetSession = async (): Promise<void> => {
        if (!refreshJwt) return;
        if (refreshInFlight) {
          await refreshInFlight;
          return;
        }
        refreshInFlight = (async () => {
          let refreshKey =
            typeof currentState.pendingRefreshKey === "string" && currentState.pendingRefreshKey.length > 0
              ? currentState.pendingRefreshKey
              : null;
          if (!refreshKey) {
            refreshKey = `migref-${globalThis.crypto.randomUUID()}`;
            await persistState({ pendingRefreshKey: refreshKey });
          }
          const refreshRes = await this.fetchExternal(
            new Request(`${targetOrigin}/xrpc/com.atproto.server.refreshSession`, {
              method: "POST",
              headers: {
                accept: "application/json",
                authorization: `Bearer ${refreshJwt}`,
                "idempotency-key": refreshKey,
              },
            }),
          );
          const refreshed = await readUpstreamJson<{
            accessJwt?: string;
            refreshJwt?: string;
            error?: string;
            message?: string;
          }>(refreshRes, MAX_ADMIN_JSON_BYTES);
          if (!refreshRes.ok || !refreshed?.accessJwt) {
            throw new XrpcError(
              refreshRes.status,
              refreshed?.message ?? `Target refreshSession failed (${refreshRes.status}).`,
              refreshed?.error ?? "XrpcError",
            );
          }
          accessJwt = refreshed.accessJwt;
          if (refreshed.refreshJwt) {
            refreshJwt = refreshed.refreshJwt;
          }
          accessJwtExpiresAtMs = decodeJwtExpMs(accessJwt) ?? this.now() + DEFAULT_ACCESS_JWT_LIFETIME_MS;
          await persistState({
            accessJwt,
            ...(refreshJwt !== undefined ? { refreshJwt } : {}),
            pendingRefreshKey: null,
          });
        })();
        try {
          await refreshInFlight;
        } finally {
          refreshInFlight = null;
        }
      };

      const targetFetch = async (path: string, init: RequestInit): Promise<Response> => {
        const explicitAuth = new Headers(init.headers).has("authorization");
        const hasPendingRefresh =
          typeof currentState.pendingRefreshKey === "string" && currentState.pendingRefreshKey.length > 0;
        if (
          !explicitAuth &&
          refreshJwt &&
          (hasPendingRefresh || this.now() + ACCESS_JWT_REFRESH_LEAD_MS >= accessJwtExpiresAtMs)
        ) {
          await refreshTargetSession();
        }
        const sendOnce = (): Promise<Response> => {
          const headers = new Headers(init.headers);
          if (!explicitAuth) {
            headers.set("authorization", `Bearer ${accessJwt}`);
          }
          return this.fetchExternal(
            new Request(`${targetOrigin}${path}`, {
              ...init,
              headers,
            }),
          );
        };

        const res = await sendOnce();
        if (!explicitAuth && refreshJwt && (res.status === 401 || res.status === 400)) {
          const errBody = await readUpstreamJson<{ error?: string }>(res.clone(), MAX_ADMIN_JSON_BYTES).catch(
            () => null,
          );
          if (errBody?.error === "ExpiredToken") {
            await refreshTargetSession();
            return sendOnce();
          }
        }
        return res;
      };
      const targetXrpc = new AtprotoClient(targetFetch);

      if (currentState.phase !== "plc_submitted") {
        try {
          if (currentState.phase === "account_created") {
            // 1. Public CAR export -> importRepo
            const carRes = await this.fetchHandler(
              `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(this.groupDid)}`,
              { method: "GET" },
            );
            if (!carRes.ok) {
              throw new XrpcError(carRes.status, `Source sync.getRepo failed (${carRes.status}).`, "XrpcError");
            }
            const carBytes = new Uint8Array(await carRes.arrayBuffer());
            const importRepoRes = await targetFetch("/xrpc/com.atproto.repo.importRepo", {
              method: "POST",
              headers: { "content-type": "application/vnd.ipld.car" },
              body: carBytes,
            });
            if (!importRepoRes.ok) {
              const errBody = await readUpstreamJson<{ error?: string; message?: string }>(
                importRepoRes,
                MAX_ADMIN_JSON_BYTES,
              );
              throw new XrpcError(
                importRepoRes.status,
                errBody?.message ?? `Target repo.importRepo failed (${importRepoRes.status}).`,
                errBody?.error ?? "XrpcError",
              );
            }

            // 2. Blobs: list all blobs on source & upload to target
            let blobCursor: string | undefined;
            const allBlobCids: string[] = [];
            while (true) {
              const page = await this.xrpc.query<{ cids: string[]; cursor?: string }>("com.atproto.sync.listBlobs", {
                did: this.groupDid,
                limit: 500,
                ...(blobCursor ? { cursor: blobCursor } : {}),
              });
              allBlobCids.push(...page.cids);
              if (!page.cursor) break;
              blobCursor = page.cursor;
            }
            for (const cid of allBlobCids) {
              const blobRes = await this.fetchHandler(
                `/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(this.groupDid)}&cid=${encodeURIComponent(cid)}`,
                { method: "GET" },
              );
              if (!blobRes.ok) {
                throw new XrpcError(
                  blobRes.status,
                  `Source sync.getBlob(${cid}) failed (${blobRes.status}).`,
                  "XrpcError",
                );
              }
              const mime = blobRes.headers.get("content-type") ?? "application/octet-stream";
              const bytes = new Uint8Array(await blobRes.arrayBuffer());
              const upRes = await targetFetch("/xrpc/com.atproto.repo.uploadBlob", {
                method: "POST",
                headers: { "content-type": mime },
                body: bytes,
              });
              if (!upRes.ok) {
                const errBody = await readUpstreamJson<{ error?: string; message?: string }>(
                  upRes,
                  MAX_ADMIN_JSON_BYTES,
                );
                throw new XrpcError(
                  upRes.status,
                  errBody?.message ?? `Target uploadBlob(${cid}) failed (${upRes.status}).`,
                  errBody?.error ?? "XrpcError",
                );
              }
            }

            // 3. Spaces: listSpaces -> exportSpaceMeta / importSpaceMeta (for own-authority spaces) + space.getRepo / space.importRepo
            const spaces = await listAllSpaceUris(this.xrpc, { maxSpaces: 2_000 });
            for (const spUri of spaces) {
              const parsed = parseSpaceUri(spUri);
              if (parsed && parsed.authorityDid === this.groupDid) {
                const metaRes = await this.fetchHandler(
                  `/xrpc/com.atproto.space.exportSpaceMeta?space=${encodeURIComponent(spUri)}`,
                  { method: "GET" },
                );
                if (!metaRes.ok) {
                  throw new XrpcError(
                    metaRes.status,
                    `exportSpaceMeta(${spUri}) failed (${metaRes.status}).`,
                    "XrpcError",
                  );
                }
                const metaStar = new Uint8Array(await metaRes.arrayBuffer());
                const impMetaRes = await targetFetch(
                  `/xrpc/com.atproto.space.importSpaceMeta?space=${encodeURIComponent(spUri)}`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/vnd.dasl.star" },
                    body: metaStar,
                  },
                );
                if (!impMetaRes.ok) {
                  const errBody = await readUpstreamJson<{ error?: string; message?: string }>(
                    impMetaRes,
                    MAX_ADMIN_JSON_BYTES,
                  );
                  throw new XrpcError(
                    impMetaRes.status,
                    errBody?.message ?? `importSpaceMeta(${spUri}) failed (${impMetaRes.status}).`,
                    errBody?.error ?? "XrpcError",
                  );
                }
              }

              const repoRes = await this.fetchHandler(
                `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(spUri)}&repo=${encodeURIComponent(this.groupDid)}`,
                { method: "GET" },
              );
              if (!repoRes.ok) {
                const errBody = await readUpstreamJson<{ error?: string; message?: string }>(
                  repoRes,
                  MAX_ADMIN_JSON_BYTES,
                );
                if (errBody?.error === "RepoNotFound") continue;
                throw new XrpcError(
                  repoRes.status,
                  errBody?.message ?? `space.getRepo(${spUri}) failed (${repoRes.status}).`,
                  errBody?.error ?? "XrpcError",
                );
              }
              const repoStar = new Uint8Array(await repoRes.arrayBuffer());
              const impRepoRes = await targetFetch("/xrpc/com.atproto.space.importRepo", {
                method: "POST",
                headers: { "content-type": "application/vnd.dasl.star" },
                body: repoStar,
              });
              if (!impRepoRes.ok) {
                const errBody = await readUpstreamJson<{ error?: string; message?: string }>(
                  impRepoRes,
                  MAX_ADMIN_JSON_BYTES,
                );
                throw new XrpcError(
                  impRepoRes.status,
                  errBody?.message ?? `space.importRepo(${spUri}) failed (${impRepoRes.status}).`,
                  errBody?.error ?? "XrpcError",
                );
              }
            }

            await persistState({ phase: "staged" });
          }

          if (
            currentState.phase === "staged" ||
            (currentState.phase === "signing_plc" && (!currentState.plcToken || !currentState.proposedPlcParams))
          ) {
            const recommended = await targetXrpc.query<ProposedPlcOperationParams>(
              "com.atproto.identity.getRecommendedDidCredentials",
            );
            assertProposedPlcTargetOrigin(recommended, targetOrigin);
            await this.xrpc.procedure("com.atproto.identity.requestPlcOperationSignature", {});
            const { token: plcToken } = await this.claimActionToken("plc_operation");
            const proposedPlcParams: ProposedPlcOperationParams = {
              rotationKeys: recommended.rotationKeys,
              alsoKnownAs: recommended.alsoKnownAs,
              verificationMethods: recommended.verificationMethods,
              services: recommended.services,
            };
            await persistState({
              phase: "signing_plc",
              plcToken,
              proposedPlcParams,
            });
          }

          if (currentState.phase === "signing_plc") {
            assertProposedPlcTargetOrigin(currentState.proposedPlcParams, targetOrigin);
            let signedPlcOp: Record<string, unknown>;
            try {
              const signed = await this.requestAdminJson<{ operation: Record<string, unknown> }>(
                "/xrpc/com.atproto.identity.signPlcOperation",
                {
                  method: "POST",
                  headers: { "x-group-migration-operation-id": operationId },
                  body: {
                    token: currentState.plcToken!,
                    rotationKeys: currentState.proposedPlcParams!.rotationKeys,
                    alsoKnownAs: currentState.proposedPlcParams!.alsoKnownAs,
                    verificationMethods: currentState.proposedPlcParams!.verificationMethods,
                    services: currentState.proposedPlcParams!.services,
                  },
                },
              );
              signedPlcOp = signed.operation;
            } catch (signErr) {
              if (signErr instanceof XrpcError && signErr.code === "ExpiredToken") {
                await this.xrpc.procedure("com.atproto.identity.requestPlcOperationSignature", {});
                const { token: freshPlcToken } = await this.claimActionToken("plc_operation");
                await persistState({ plcToken: freshPlcToken });
                const signed = await this.requestAdminJson<{ operation: Record<string, unknown> }>(
                  "/xrpc/com.atproto.identity.signPlcOperation",
                  {
                    method: "POST",
                    headers: { "x-group-migration-operation-id": operationId },
                    body: {
                      token: freshPlcToken,
                      rotationKeys: currentState.proposedPlcParams!.rotationKeys,
                      alsoKnownAs: currentState.proposedPlcParams!.alsoKnownAs,
                      verificationMethods: currentState.proposedPlcParams!.verificationMethods,
                      services: currentState.proposedPlcParams!.services,
                    },
                  },
                );
                signedPlcOp = signed.operation;
              } else {
                throw signErr;
              }
            }

            await persistState({
              phase: "plc_signed",
              signedPlcOp,
            });
          }

          if (currentState.phase === "plc_signed") {
            if (!currentState.signedPlcOp) {
              throw new Error("Persisted plc_signed migration state is missing signedPlcOp.");
            }
            await targetXrpc.procedure("com.atproto.identity.submitPlcOperation", {
              operation: currentState.signedPlcOp,
            });
            await persistState({
              phase: "plc_submitted",
            });
          }
        } catch (err) {
          if ((currentState.phase as GroupMigrationPhase) === "plc_submitted") {
            throw err;
          }
          if (err instanceof XrpcError && err.code === "MigrationCutoverCommitted") {
            await persistState({ phase: "plc_submitted" }).catch(() => undefined);
            throw err;
          }
          if (!isDeterministicPreCutover4xx(err)) {
            throw err;
          }

          let targetAbortOk = false;
          let cutoverCommitted = false;
          try {
            const targetAbortRes = await targetFetch("/group-admin/abort-migration", {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                group: this.groupDid,
                operationId,
                ...(ticketId ? { ticketId } : {}),
              }),
            });
            if (targetAbortRes.status === 200) {
              const okBody = await readUpstreamJson<{ status?: unknown }>(
                targetAbortRes,
                MAX_ADMIN_JSON_BYTES,
              ).catch(() => null);
              if (
                okBody?.status === "purged" ||
                okBody?.status === "already_absent" ||
                okBody?.status === "superseded"
              ) {
                targetAbortOk = true;
              }
            } else if (mode === "standard" && targetAbortRes.status === 404) {
              targetAbortOk = true;
            } else {
              const abortErr = await readUpstreamJson<{ error?: string }>(
                targetAbortRes,
                MAX_ADMIN_JSON_BYTES,
              ).catch(() => null);
              if (abortErr?.error === "MigrationCutoverCommitted") {
                cutoverCommitted = true;
              }
            }
          } catch {
            targetAbortOk = false;
          }

          if (cutoverCommitted) {
            await persistState({ phase: "plc_submitted" }).catch(() => undefined);
            throw err;
          }

          let sourceAbortOk = false;
          try {
            await this.requestSourceAbortMigration(operationId);
            sourceAbortOk = true;
          } catch (sourceAbortErr) {
            if (sourceAbortErr instanceof XrpcError && sourceAbortErr.code === "MigrationCutoverCommitted") {
              await persistState({ phase: "plc_submitted" }).catch(() => undefined);
              throw err;
            }
            sourceAbortOk = false;
          }

          if (targetAbortOk && sourceAbortOk) {
            await deleteCurrentState().catch(() => false);
          }
          throw err;
        }
      }

      await targetXrpc.procedure("com.atproto.server.activateAccount", {});
      await deleteCurrentState();

      return {
        mode,
        did: this.groupDid,
        handle: currentState.handle || options.handle,
        targetEndpoint: targetOrigin,
      };
    });
  }

  private async requestAdminJson<T>(
    path: string,
    input: { method: "GET" | "POST"; body?: Record<string, unknown>; headers?: Record<string, string> },
  ): Promise<T> {
    const response = await this.fetchHandler(path, {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.headers ?? {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    const body = await readUpstreamJson<T & { error?: string; message?: string }>(response, MAX_ADMIN_JSON_BYTES);
    if (!response.ok || body === null) {
      throw new XrpcError(
        response.status,
        body?.message ?? `Group admin request failed (${response.status}).`,
        body?.error ?? "XrpcError",
      );
    }
    return body;
  }
}

function inferSpaceUriFromSubject(subjectUri: string): string | null {
  return parseAnySpaceRecordUri(subjectUri)?.spaceUri ?? null;
}
