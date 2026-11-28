import { readUpstreamJson } from "@flock/protocol/bounded-json";
import { listAllSpaceUris } from "@flock/protocol/atproto/record-pages";
import {
  mintSpaceCredentialWith,
  SpaceCredentialError,
  type SpaceCredentialDeps,
} from "@flock/protocol/atproto/space-credential-core";
import { isMissingXrpcResource, XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  groupMembersUri,
  isDid,
  requestDigest,
  SELF_SKEY,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_SPACE_TYPE,
  FLOCK_EXTENSION_FIELD,
} from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import { DidResolutionError } from "./did-resolver";
import {
  LifecycleActorMismatchError,
  PASSIVE_JOIN_PHASES,
  POST_ADMISSION_JOIN_PHASES,
  type DeskJoiningGroupEntry,
  type DeskLifecycleStore,
} from "./lifecycle-store";

export type DeskShellDeps = SpaceCredentialDeps & { readonly did: string };

const MAX_GROUP_MEMBER_JSON_BYTES = 256 * 1024;
const MAX_DISCOVERABLE_WORKSPACES = 1_000;

export const TERMINAL_JOIN_XRPC_CODES: ReadonlySet<string> = new Set([
  "InvalidInvite",
  "JoinClosed",
  "NoDefaultRole",
  "JoinRequestClosed",
  "IdempotencyParameterMismatch",
  "SubjectIsAppServicePrincipal",
  "CannotTargetGroupSelf",
]);

const STALE_HOST_CODES: ReadonlySet<string> = new Set([
  "RepoNotFound",
  "GroupNotFound",
  "SpaceNotFound",
  "RepoTakendown",
  "RepoDeactivated",
]);

export type JoinStatusState =
  | "admitted"
  | "pending"
  | "denied"
  | "cancelled"
  | "unknown"
  | "left_deactivated";

const VALID_JOIN_STATUS_STATES: ReadonlySet<JoinStatusState> = new Set([
  "admitted",
  "pending",
  "denied",
  "cancelled",
  "unknown",
  "left_deactivated",
]);

export type JoinStatusResponse = {
  state: JoinStatusState;
  currentIncarnation?: string;
  membership?: { uri: string; cid: string };
};

export type JoinGroupResult = {
  status: "admitted" | "pending" | "denied" | "cancelled";
  groupDid: string;
  workspaceUri: string;
  operationId?: string;
};

export class JoinOperationQuotaExceededError extends Error {
  readonly status = 429;
  readonly code = "JoinOperationQuotaExceeded";

  constructor(message = "Too many pending join operations for this group.") {
    super(message);
    this.name = "JoinOperationQuotaExceededError";
  }
}

export class UnsupportedJoinStatusError extends Error {
  constructor(readonly rawStatus: string) {
    super(`Group host returned unsupported join status '${rawStatus}'.`);
    this.name = "UnsupportedJoinStatusError";
  }
}

// Per-(viewerDid, groupDid) in-process promise queue, combined with cross-tab Web Locks when available.
const inProcessLocks = new Map<string, Promise<void>>();

export async function withGroupLifecycleLock<T>(
  viewerDid: string,
  groupDid: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `flock-desk-group:${viewerDid}:${groupDid}`;
  const runUnderWebLock = async (): Promise<T> => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks && typeof locks.request === "function") {
      return (await locks.request(key, { mode: "exclusive" }, fn)) as T;
    }
    return fn();
  };

  const prev = inProcessLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current);
  inProcessLocks.set(key, chained);

  await prev;
  try {
    return await runUnderWebLock();
  } finally {
    release();
    if (inProcessLocks.get(key) === chained) {
      inProcessLocks.delete(key);
    }
  }
}

function nowOf(deps: Pick<DeskShellDeps, "now">): number {
  return deps.now ? deps.now() : Date.now();
}

function assertRowViewer(expectedViewerDid: string, rowViewerDid: string): void {
  if (rowViewerDid !== expectedViewerDid) {
    throw new LifecycleActorMismatchError(expectedViewerDid, rowViewerDid);
  }
}

function isDidTombstonedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof DidResolutionError && (error.status === 404 || error.status === 410)) return true;
  if ("status" in error && (error.status === 404 || error.status === 410)) return true;
  if (error instanceof Error && /^fake-pds: no account registered for did:/.test(error.message)) return true;
  if (error instanceof Error && /\(404\)|\(410\)/.test(error.message)) return true;
  return false;
}

function isStaleHostError(error: unknown): boolean {
  if (error instanceof XrpcError && STALE_HOST_CODES.has(error.code)) return true;
  if (error instanceof SpaceCredentialError && error.code !== undefined && STALE_HOST_CODES.has(error.code)) {
    return true;
  }
  return false;
}

/**
 * Strictly validates every HTTP 200 `/group-member/join-status` response payload.
 * Normalizes explicit `null` `currentIncarnation`/`membership` (legacy Group Host rows) to absent;
 * rejects any unknown state, empty string, or malformed object with `XrpcError(502, ..., "InvalidJoinStatusResponse")`.
 */
export function parseJoinStatusResponse(raw: unknown): JoinStatusResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.state !== "string" || !VALID_JOIN_STATUS_STATES.has(obj.state as JoinStatusState)) {
    throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
  }
  if (
    obj.currentIncarnation !== undefined &&
    obj.currentIncarnation !== null &&
    (typeof obj.currentIncarnation !== "string" || obj.currentIncarnation.length === 0)
  ) {
    throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
  }
  let membership: { uri: string; cid: string } | undefined;
  if (obj.membership !== undefined && obj.membership !== null) {
    if (typeof obj.membership !== "object" || Array.isArray(obj.membership)) {
      throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
    }
    const memObj = obj.membership as Record<string, unknown>;
    if (typeof memObj.uri !== "string" || typeof memObj.cid !== "string") {
      throw new XrpcError(502, "Malformed /group-member/join-status response.", "InvalidJoinStatusResponse");
    }
    membership = { uri: memObj.uri, cid: memObj.cid };
  }
  return {
    state: obj.state as JoinStatusState,
    ...(typeof obj.currentIncarnation === "string" ? { currentIncarnation: obj.currentIncarnation } : {}),
    ...(membership !== undefined ? { membership } : {}),
  };
}

async function callPersonalGroupProcedure<T>(
  deps: DeskShellDeps,
  groupDid: string,
  endpoint: string,
  methodNsid: string,
  input: Record<string, unknown>,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<T> {
  const { token } = await deps.memberClient.query<{ token: string }>(
    "com.atproto.server.getServiceAuth",
    {
      aud: `${groupDid}#atproto_pds`,
      lxm: methodNsid,
    },
  );
  const url = new URL(`/xrpc/${methodNsid}`, endpoint);
  const response = await deps.fetchEndpoint(
    new Request(url, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(input),
    }),
  );
  const body = await readUpstreamJson<T & { error?: string; message?: string }>(
    response,
    MAX_GROUP_MEMBER_JSON_BYTES,
  );
  if (!response.ok) {
    throw new XrpcError(
      response.status,
      body?.message ?? `Group request ${methodNsid} failed (${response.status}).`,
      body?.error ?? "XrpcError",
    );
  }
  return (body ?? ({} as T)) as T;
}

async function queryJoinStatusAt(
  deps: DeskShellDeps,
  groupDid: string,
  endpoint: string,
  operationId?: string,
): Promise<JoinStatusResponse> {
  const { token } = await deps.memberClient.query<{ token: string }>(
    "com.atproto.server.getServiceAuth",
    {
      aud: `${groupDid}#atproto_pds`,
      lxm: ATGRP_METHOD.requestJoin,
    },
  );
  const url = new URL("/group-member/join-status", endpoint);
  url.searchParams.set("group", groupDid);
  if (operationId !== undefined) {
    url.searchParams.set("operationId", operationId);
  }
  const response = await deps.fetchEndpoint(
    new Request(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    }),
  );
  const body = await readUpstreamJson<Record<string, unknown>>(response, MAX_GROUP_MEMBER_JSON_BYTES);
  if (!response.ok) {
    const errMsg = typeof body?.message === "string" ? body.message : `Join status check failed (${response.status}).`;
    const errCode = typeof body?.error === "string" ? body.error : "XrpcError";
    throw new XrpcError(response.status, errMsg, errCode);
  }
  return parseJoinStatusResponse(body);
}

function isUnsupportedJoinStatusExtension(error: unknown): boolean {
  return error instanceof XrpcError && (error.status === 404 || error.status === 501);
}

async function readOwnAcceptanceRecord(
  deps: DeskShellDeps,
  groupDid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await deps.memberClient.query<{ value: Record<string, unknown> }>(
      "com.atproto.space.getRecord",
      {
        space: groupMembersUri(groupDid),
        repo: deps.did,
        collection: ATGRP_COLLECTION.confirmation,
        rkey: SELF_SKEY,
      },
    );
    return res.value ?? null;
  } catch (error) {
    if (isMissingXrpcResource(error) || (error instanceof XrpcError && error.code === "SpaceNotFound")) {
      return null;
    }
    throw error;
  }
}

async function writeOwnAcceptance(
  deps: DeskShellDeps,
  groupDid: string,
  incarnation?: string,
): Promise<string> {
  const membersUri = groupMembersUri(groupDid);
  const record: Record<string, unknown> = {
    $type: ATGRP_COLLECTION.confirmation,
    createdAt: new Date(nowOf(deps)).toISOString(),
    ...(incarnation !== undefined ? { [FLOCK_EXTENSION_FIELD.incarnation]: incarnation } : {}),
  };
  const validation = validateSpaceRecord(ATGRP_COLLECTION.confirmation, record, {
    authorityDid: groupDid,
    spaceUri: membersUri,
    repoDid: deps.did,
    rkey: SELF_SKEY,
  });
  if (!validation.valid) throw new Error(validation.reason);

  const result = await deps.memberClient.procedure<unknown, { uri: string }>("com.atproto.space.putRecord", {
    space: membersUri,
    repo: deps.did,
    collection: ATGRP_COLLECTION.confirmation,
    rkey: SELF_SKEY,
    record,
  });
  return result.uri;
}

async function verifyLiveGroupMembershipIncarnation(
  deps: DeskShellDeps,
  groupDid: string,
): Promise<string | undefined> {
  const membersUri = groupMembersUri(groupDid);
  const cred = await mintSpaceCredentialWith(deps, membersUri);

  const readMembershipAt = (endpoint: string) =>
    cred.client(endpoint).query<{ cid?: string; value: Record<string, unknown> }>("com.atproto.space.getRecord", {
      space: membersUri,
      repo: groupDid,
      collection: ATGRP_COLLECTION.membership,
      rkey: deps.did,
    });

  let endpoint = await deps.resolvePds(groupDid);
  let res: { cid?: string; value: Record<string, unknown> };
  try {
    res = await readMembershipAt(endpoint);
  } catch (error) {
    if (!isStaleHostError(error)) throw error;
    const refreshed = await deps.resolvePds(groupDid, true);
    if (refreshed === endpoint) throw error;
    endpoint = refreshed;
    res = await readMembershipAt(endpoint);
  }

  const extInc = res.value[FLOCK_EXTENSION_FIELD.incarnation];
  if (typeof extInc === "string" && extInc.length > 0) {
    return extInc;
  }
  const status = await queryJoinStatusAt(deps, groupDid, endpoint).catch(() => null);
  if (typeof status?.currentIncarnation === "string" && status.currentIncarnation.length > 0) {
    return status.currentIncarnation;
  }
  if (typeof res.cid === "string" && res.cid.length > 0) {
    return `legacy-cid:${res.cid}`;
  }
  return undefined;
}

async function acceptDirectMembershipUnlocked(
  deps: DeskShellDeps,
  groupDid: string,
): Promise<{ status: "admitted"; groupDid: string; workspaceUri: string; incarnation?: string }> {
  const incarnation = await verifyLiveGroupMembershipIncarnation(deps, groupDid);
  await writeOwnAcceptance(deps, groupDid, incarnation);
  return {
    status: "admitted",
    groupDid,
    workspaceUri: workspaceUri(groupDid),
    ...(incarnation !== undefined ? { incarnation } : {}),
  };
}

async function ensureNoPendingLeaveUnlocked(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  groupDid: string,
): Promise<void> {
  const pendingLeave = await store.getLeavingGroup(groupDid);
  if (!pendingLeave) return;
  assertRowViewer(deps.did, pendingLeave.viewerDid);
  if (pendingLeave.phase !== "blocked_deactivated") {
    await executeLeavingGroupPhases(deps, store, groupDid, { interactive: false });
  }
  const remaining = await store.getLeavingGroup(groupDid);
  if (remaining) {
    throw new Error(
      `Cannot join ${groupDid} while a pending leave (${remaining.phase}) has not finished.`,
    );
  }
}

/**
 * Direct-grant membership acceptance (e.g. default `@flock/web` invite without `expiresAt`, or
 * re-admission after ejection): enforces the same-group pending-leave barrier first, then mints
 * a fresh `members/self` credential, reads live `membership/<viewerDid>` incarnation (with
 * stale-host `forceRefresh` retry), and unconditionally writes/overwrites
 * `group.opensocial.acceptance/self` stamped with the live incarnation.
 */
export async function acceptDirectMembership(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  input: { groupDid: string },
): Promise<{ status: "admitted"; groupDid: string; workspaceUri: string; incarnation?: string }> {
  if (!isDid(input.groupDid)) throw new TypeError("Invalid group DID.");
  return withGroupLifecycleLock(deps.did, input.groupDid, async () => {
    await ensureNoPendingLeaveUnlocked(deps, store, input.groupDid);
    return acceptDirectMembershipUnlocked(deps, input.groupDid);
  });
}

async function allocateFreshOperationId(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  avoidId?: string,
): Promise<string> {
  let opId = tidNow(nowOf(deps));
  while (opId === avoidId || (await store.getJoiningGroup(opId)) !== undefined) {
    opId = tidNow(nowOf(deps));
  }
  return opId;
}

async function driveJoiningGroupPhases(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  operationId: string,
): Promise<JoinGroupResult> {
  let entry = await store.getJoiningGroup(operationId);
  if (!entry) {
    throw new Error(`Join operation ${operationId} not found.`);
  }
  assertRowViewer(deps.did, entry.viewerDid);

  const groupDid = entry.groupDid;
  if (PASSIVE_JOIN_PHASES.has(entry.phase)) {
    return { status: "pending", groupDid, workspaceUri: workspaceUri(groupDid), operationId };
  }

  // Phase 1: `submitting`
  if (entry.phase === "submitting") {
    const authorityEndpoint = entry.authorityEndpoint ?? (await deps.resolvePds(groupDid));
    if (!entry.authorityEndpoint) {
      entry = { ...entry, authorityEndpoint };
      await store.putJoiningGroup(entry);
    }

    let joinRes: { status: string; membership?: { uri: string; cid: string } };
    try {
      joinRes = await callPersonalGroupProcedure<{ status: string; membership?: { uri: string; cid: string } }>(
        deps,
        groupDid,
        authorityEndpoint,
        ATGRP_METHOD.requestJoin,
        {
          group: groupDid,
          ...(entry.inviteUri !== undefined ? { invite: entry.inviteUri } : {}),
          ...(entry.message !== undefined ? { message: entry.message } : {}),
        },
        { "idempotency-key": entry.operationId },
      );
    } catch (error) {
      if (error instanceof XrpcError && error.status === 429 && error.code === "JoinOperationQuotaExceeded") {
        await store.putJoiningGroup({ ...entry, phase: "quota_exceeded" });
        throw new JoinOperationQuotaExceededError(error.message);
      }
      if (error instanceof XrpcError && TERMINAL_JOIN_XRPC_CODES.has(error.code)) {
        await store.deleteJoiningGroup(entry.operationId);
        throw error;
      }
      throw error;
    }

    if (joinRes.status === "admitted") {
      entry = { ...entry, authorityEndpoint, phase: "membership_verified" };
      await store.putJoiningGroup(entry);
    } else if (joinRes.status === "pending") {
      entry = { ...entry, authorityEndpoint, mode: "approval", phase: "pending_approval" };
      await store.putJoiningGroup(entry);
      return { status: "pending", groupDid, workspaceUri: workspaceUri(groupDid), operationId };
    } else {
      await store.putJoiningGroup({
        ...entry,
        authorityEndpoint,
        rawStatus: String(joinRes.status),
        phase: "unsupported_status",
      });
      throw new UnsupportedJoinStatusError(String(joinRes.status));
    }
  }

  // Phase 2: `pending_approval` (NEVER re-calls `requestJoin`!)
  if (entry.phase === "pending_approval") {
    const currentEndpoint = await deps.resolvePds(groupDid, true);
    let joinStatus: JoinStatusResponse | null = null;
    try {
      joinStatus = await queryJoinStatusAt(deps, groupDid, currentEndpoint, entry.operationId);
    } catch (probeErr) {
      if (!isUnsupportedJoinStatusExtension(probeErr)) {
        throw probeErr;
      }
      // Spec-only host without Flock's `/group-member/join-status` extension: probe `org.atgrp.members/self` directly
      // without ever resubmitting `requestJoin`.
      try {
        const liveIncarnation = await verifyLiveGroupMembershipIncarnation(deps, groupDid);
        joinStatus = {
          state: "admitted",
          ...(liveIncarnation !== undefined ? { currentIncarnation: liveIncarnation } : {}),
        };
      } catch (liveErr) {
        const notMemberYet =
          isMissingXrpcResource(liveErr) ||
          (liveErr instanceof SpaceCredentialError && (liveErr.status === 401 || liveErr.status === 403)) ||
          (liveErr instanceof XrpcError && (liveErr.status === 401 || liveErr.status === 403 || liveErr.status === 404));
        if (!notMemberYet) throw liveErr;
        return { status: "pending", groupDid, workspaceUri: workspaceUri(groupDid), operationId };
      }
    }

    if (joinStatus.state === "admitted") {
      entry = {
        ...entry,
        authorityEndpoint: currentEndpoint,
        ...(joinStatus.currentIncarnation !== undefined
          ? { currentIncarnation: joinStatus.currentIncarnation }
          : {}),
        phase: "membership_verified",
      };
      await store.putJoiningGroup(entry);
    } else if (joinStatus.state === "denied" || joinStatus.state === "cancelled") {
      await store.deleteJoiningGroup(entry.operationId);
      return {
        status: joinStatus.state,
        groupDid,
        workspaceUri: workspaceUri(groupDid),
        operationId,
      };
    } else if (
      joinStatus.state === "unknown" &&
      entry.authorityEndpoint !== undefined &&
      currentEndpoint !== entry.authorityEndpoint
    ) {
      await store.putJoiningGroup({ ...entry, phase: "orphaned_by_migration" });
      return { status: "pending", groupDid, workspaceUri: workspaceUri(groupDid), operationId };
    } else if (joinStatus.state === "unknown") {
      await store.putJoiningGroup({ ...entry, phase: "expired_unknown" });
      return { status: "pending", groupDid, workspaceUri: workspaceUri(groupDid), operationId };
    } else {
      // `pending` or `left_deactivated`: preserve journal row intact across reloads!
      return { status: "pending", groupDid, workspaceUri: workspaceUri(groupDid), operationId };
    }
  }

  // Phase 3: `membership_verified`
  if (entry.phase === "membership_verified") {
    let currentIncarnation: string | undefined;
    try {
      currentIncarnation = await verifyLiveGroupMembershipIncarnation(deps, groupDid);
    } catch (error) {
      const membershipGone =
        isMissingXrpcResource(error) ||
        (error instanceof SpaceCredentialError && error.status === 403) ||
        (error instanceof XrpcError &&
          (error.code === "RepoDeactivated" ||
            error.code === "RepoNotFound" ||
            error.code === "GroupNotFound"));
      if (membershipGone) {
        await store.deleteJoiningGroup(entry.operationId);
      }
      throw error;
    }
    entry = {
      ...entry,
      ...(currentIncarnation !== undefined ? { currentIncarnation } : {}),
      phase: "acceptance_pending",
    };
    await store.putJoiningGroup(entry);
  }

  // Phase 4: `acceptance_pending`
  if (entry.phase === "acceptance_pending") {
    await writeOwnAcceptance(deps, groupDid, entry.currentIncarnation);
    entry = { ...entry, phase: "discovery_verified" };
    await store.putJoiningGroup(entry);
  }

  // Phase 5: `discovery_verified`
  if (entry.phase === "discovery_verified") {
    const membersUri = groupMembersUri(groupDid);
    const [spaces, ownAcc] = await Promise.all([
      listAllSpaceUris(deps.memberClient, {
        spaceType: ATGRP_SPACE_TYPE.members,
        maxSpaces: MAX_DISCOVERABLE_WORKSPACES,
      }),
      readOwnAcceptanceRecord(deps, groupDid),
    ]);
    if (!spaces.includes(membersUri) || !ownAcc) {
      throw new Error(`Discovery verification for ${groupDid} did not observe ${membersUri} and confirmation/self.`);
    }
    await store.deleteJoiningGroup(entry.operationId);
  }

  return {
    status: "admitted",
    groupDid,
    workspaceUri: workspaceUri(groupDid),
    operationId,
  };
}

/**
 * Crash-safe direct OpenSocial group join:
 * - When no `inviteUri` is supplied and the viewer already holds live `membership/<viewerDid>` on the
 *   Group Host (e.g. direct-grant invite from `@flock/web`), delegates to `acceptDirectMembership` to
 *   write/overwrite `acceptance/self` with the live incarnation.
 * - Otherwise persists a durable `joiningGroups` row BEFORE calling `group.opensocial.requestJoin`
 *   with `Idempotency-Key` and drives all 5 active phases.
 */
export async function joinGroup(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  input: { groupDid: string; inviteUri?: string; message?: string },
): Promise<JoinGroupResult> {
  if (!isDid(input.groupDid)) throw new TypeError("Invalid group DID.");
  const { groupDid, inviteUri, message } = input;

  return withGroupLifecycleLock(deps.did, groupDid, async () => {
    await ensureNoPendingLeaveUnlocked(deps, store, groupDid);
    if (inviteUri === undefined) {
      let liveIncarnation: string | undefined;
      let hasLiveMembership = false;
      try {
        liveIncarnation = await verifyLiveGroupMembershipIncarnation(deps, groupDid);
        hasLiveMembership = true;
      } catch (error) {
        const notMemberYet =
          isMissingXrpcResource(error) ||
          (error instanceof SpaceCredentialError &&
            (error.status === 401 || error.status === 403)) ||
          (error instanceof XrpcError && (error.status === 401 || error.status === 403 || error.status === 404));
        if (!notMemberYet) throw error;
      }
      if (hasLiveMembership) {
        await writeOwnAcceptance(deps, groupDid, liveIncarnation);
        return {
          status: "admitted",
          groupDid,
          workspaceUri: workspaceUri(groupDid),
        };
      }
    }

    const intentHash = requestDigest({
      group: groupDid,
      invite: inviteUri ?? null,
      message: message ?? null,
    });
    const existingRows = await store.listJoiningGroups();
    for (const row of existingRows) {
      assertRowViewer(deps.did, row.viewerDid);
    }
    const matchingActive = existingRows.find(
      (row) => row.groupDid === groupDid && row.intentHash === intentHash && !PASSIVE_JOIN_PHASES.has(row.phase),
    );
    if (matchingActive) {
      return driveJoiningGroupPhases(deps, store, matchingActive.operationId);
    }

    const operationId = await allocateFreshOperationId(deps, store);
    const authorityEndpoint = await deps.resolvePds(groupDid);
    const entry: DeskJoiningGroupEntry = {
      viewerDid: deps.did,
      operationId,
      mode: inviteUri !== undefined ? "invite" : "open",
      intentHash,
      groupDid,
      ...(inviteUri !== undefined ? { inviteUri } : {}),
      ...(message !== undefined ? { message } : {}),
      authorityEndpoint,
      phase: "submitting",
      createdAt: nowOf(deps),
    };
    await store.putJoiningGroup(entry);
    return driveJoiningGroupPhases(deps, store, operationId);
  });
}

/**
 * Admission-race-safe pending join cancellation:
 * Calls `group.opensocial.cancelJoinRequest`. On `400 JoinRequestNotFound`, probes `/group-member/join-status`
 * (falling back to live membership check if `unknown` or 404): upgrades `pending_approval` rows to
 * `membership_verified` if concurrently admitted, deletes only if confirmed cancelled/denied/absent,
 * and preserves the journal row intact if `pending` or `left_deactivated`.
 */
export async function cancelPendingJoin(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  input: { groupDid: string },
): Promise<void> {
  if (!isDid(input.groupDid)) throw new TypeError("Invalid group DID.");
  const { groupDid } = input;

  await withGroupLifecycleLock(deps.did, groupDid, async () => {
    const endpoint = await deps.resolvePds(groupDid, true);
    const allRows = await store.listJoiningGroups();
    for (const row of allRows) {
      assertRowViewer(deps.did, row.viewerDid);
    }
    const existingRows = allRows.filter((row) => row.groupDid === groupDid);
    const pendingApprovalRows = existingRows.filter((row) => row.phase === "pending_approval");
    const hasPostAdmissionRow = existingRows.some((row) => POST_ADMISSION_JOIN_PHASES.has(row.phase));

    const upgradePendingToMembershipVerified = async (incarnation: string | undefined) => {
      for (const row of pendingApprovalRows) {
        await store.putJoiningGroup({
          ...row,
          authorityEndpoint: endpoint,
          ...(incarnation !== undefined ? { currentIncarnation: incarnation } : {}),
          phase: "membership_verified",
        });
      }
    };

    const verifyNotAdmittedViaMembershipRead = async (): Promise<boolean> => {
      try {
        const liveInc = await verifyLiveGroupMembershipIncarnation(deps, groupDid);
        await upgradePendingToMembershipVerified(liveInc);
        return false;
      } catch (liveErr) {
        const definitivelyNotAdmitted =
          isMissingXrpcResource(liveErr) || (liveErr instanceof SpaceCredentialError && liveErr.status === 403);
        if (!definitivelyNotAdmitted) throw liveErr;
        return true;
      }
    };

    let confirmedTerminalAbsent = false;
    try {
      await callPersonalGroupProcedure(deps, groupDid, endpoint, ATGRP_METHOD.cancelJoinRequest, {
        group: groupDid,
      });
      confirmedTerminalAbsent = true;
    } catch (error) {
      if (!(error instanceof XrpcError && error.status === 400 && error.code === "JoinRequestNotFound")) {
        throw error;
      }
      if (hasPostAdmissionRow) {
        throw error;
      }
      if (pendingApprovalRows.length === 0) {
        return;
      }

      let joinStatus: JoinStatusResponse | null = null;
      try {
        joinStatus = await queryJoinStatusAt(deps, groupDid, endpoint, pendingApprovalRows[0]?.operationId);
      } catch (probeErr) {
        if (!isUnsupportedJoinStatusExtension(probeErr)) {
          throw probeErr;
        }
      }

      if (joinStatus === null || joinStatus.state === "unknown") {
        const notAdmitted = await verifyNotAdmittedViaMembershipRead();
        if (!notAdmitted) throw error;
        confirmedTerminalAbsent = true;
      } else if (joinStatus.state === "admitted") {
        await upgradePendingToMembershipVerified(joinStatus.currentIncarnation);
        throw error;
      } else if (joinStatus.state === "cancelled" || joinStatus.state === "denied") {
        confirmedTerminalAbsent = true;
      } else {
        // `pending` or `left_deactivated`: preserve recovery journal intact and rethrow.
        throw error;
      }
    }

    if (!confirmedTerminalAbsent) return;

    for (const row of await store.listJoiningGroups()) {
      assertRowViewer(deps.did, row.viewerDid);
      if (row.groupDid === groupDid && row.phase === "pending_approval") {
        await store.deleteJoiningGroup(row.operationId);
      }
    }
  });
}

/**
 * Retries a passive join operation (`orphaned_by_migration`, `expired_unknown`, `unsupported_status`,
 * `quota_exceeded`): validates `viewerDid`, allocates a fresh non-colliding `operationId`, preserves
 * `{ mode, groupDid, inviteUri, message }`, recomputes `intentHash`, force-refreshes `authorityEndpoint`,
 * atomically replaces the passive row in one transaction, and drives the 5-phase join machine.
 */
export async function retryJoinOperation(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  operationId: string,
): Promise<JoinGroupResult> {
  const pre = await store.getJoiningGroup(operationId);
  if (!pre) throw new Error("Join operation not found.");
  assertRowViewer(deps.did, pre.viewerDid);
  if (!isDid(pre.groupDid) || !PASSIVE_JOIN_PHASES.has(pre.phase)) {
    throw new Error(`Join operation ${operationId} in phase '${pre.phase}' cannot be retried.`);
  }
  const targetGroupDid = pre.groupDid;

  return withGroupLifecycleLock(deps.did, targetGroupDid, async () => {
    const old = await store.getJoiningGroup(operationId);
    if (!old) throw new Error("Join operation not found.");
    assertRowViewer(deps.did, old.viewerDid);
    if (old.groupDid !== targetGroupDid || !PASSIVE_JOIN_PHASES.has(old.phase)) {
      throw new Error(`Join operation ${operationId} in phase '${old.phase}' cannot be retried.`);
    }

    const freshOperationId = await allocateFreshOperationId(deps, store, operationId);
    const intentHash = requestDigest({
      group: targetGroupDid,
      invite: old.inviteUri ?? null,
      message: old.message ?? null,
    });
    const authorityEndpoint = await deps.resolvePds(targetGroupDid, true);
    const nextEntry: DeskJoiningGroupEntry = {
      viewerDid: deps.did,
      operationId: freshOperationId,
      mode: old.mode,
      intentHash,
      groupDid: targetGroupDid,
      ...(old.inviteUri !== undefined ? { inviteUri: old.inviteUri } : {}),
      ...(old.message !== undefined ? { message: old.message } : {}),
      authorityEndpoint,
      phase: "submitting",
      createdAt: nowOf(deps),
    };
    await store.replaceJoiningGroup(operationId, nextEntry);
    return driveJoiningGroupPhases(deps, store, freshOperationId);
  });
}

/** Dismisses a passive join operation under `withGroupLifecycleLock`. */
export async function dismissJoinOperation(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  operationId: string,
): Promise<void> {
  const pre = await store.getJoiningGroup(operationId);
  if (!pre) return;
  assertRowViewer(deps.did, pre.viewerDid);

  await withGroupLifecycleLock(deps.did, pre.groupDid, async () => {
    const entry = await store.getJoiningGroup(operationId);
    if (!entry) return;
    assertRowViewer(deps.did, entry.viewerDid);
    if (!PASSIVE_JOIN_PHASES.has(entry.phase)) {
      throw new Error(`Join operation ${operationId} in phase '${entry.phase}' cannot be dismissed.`);
    }
    await store.deleteJoiningGroup(operationId);
  });
}

// --- Preflight + 3-Phase Crash-/Migration-/Deactivation-/Cross-Device-Safe `leaveGroup` ---

async function resolveCurrentLeaveIncarnation(
  deps: DeskShellDeps,
  groupDid: string,
): Promise<
  | { kind: "ready"; expectedIncarnation: string | undefined }
  | { kind: "blocked"; expectedIncarnation: string | undefined; error: XrpcError }
> {
  const ownAcc = await readOwnAcceptanceRecord(deps, groupDid);
  const rawOwnInc = ownAcc?.[FLOCK_EXTENSION_FIELD.incarnation];
  const ownIncarnation = typeof rawOwnInc === "string" && rawOwnInc.length > 0 ? rawOwnInc : undefined;

  let endpoint: string;
  try {
    endpoint = await deps.resolvePds(groupDid);
  } catch (error) {
    if (isDidTombstonedError(error)) {
      return { kind: "ready", expectedIncarnation: ownIncarnation };
    }
    throw error;
  }

  const interpretJoinStatusError = async (
    error: unknown,
    attemptedEndpoint: string,
    allowPlcRefresh: boolean,
  ): Promise<
    | { kind: "ready"; expectedIncarnation: string | undefined }
    | { kind: "blocked"; expectedIncarnation: string | undefined; error: XrpcError }
    | { kind: "status"; status: JoinStatusResponse }
  > => {
    if (
      error instanceof XrpcError &&
      (error.code === "RepoNotFound" ||
        error.code === "GroupNotFound" ||
        error.code === "RepoTakendown" ||
        error.code === "RepoDeactivated")
    ) {
      if (allowPlcRefresh) {
        let refreshedEndpoint: string;
        try {
          refreshedEndpoint = await deps.resolvePds(groupDid, true);
        } catch (plcErr) {
          if (isDidTombstonedError(plcErr)) {
            return { kind: "ready", expectedIncarnation: ownIncarnation };
          }
          throw plcErr;
        }
        if (refreshedEndpoint !== attemptedEndpoint) {
          try {
            const status = await queryJoinStatusAt(deps, groupDid, refreshedEndpoint);
            return { kind: "status", status };
          } catch (retryErr) {
            return interpretJoinStatusError(retryErr, refreshedEndpoint, false);
          }
        }
      }
      if (error.code === "RepoNotFound" || error.code === "GroupNotFound") {
        return { kind: "ready", expectedIncarnation: ownIncarnation };
      }
      return { kind: "blocked", expectedIncarnation: ownIncarnation, error };
    }
    throw error;
  };

  let status: JoinStatusResponse;
  try {
    status = await queryJoinStatusAt(deps, groupDid, endpoint);
  } catch (error) {
    if (isUnsupportedJoinStatusExtension(error)) {
      return { kind: "ready", expectedIncarnation: ownIncarnation };
    }
    const outcome = await interpretJoinStatusError(error, endpoint, true);
    if (outcome.kind !== "status") {
      return outcome;
    }
    status = outcome.status;
  }

  if (status.state === "admitted" && typeof status.currentIncarnation === "string" && status.currentIncarnation.length > 0) {
    return { kind: "ready", expectedIncarnation: status.currentIncarnation };
  }
  return { kind: "ready", expectedIncarnation: ownIncarnation };
}

async function safeQueryLiveJoinStatus(
  deps: DeskShellDeps,
  groupDid: string,
): Promise<JoinStatusResponse | null> {
  let endpoint: string;
  try {
    endpoint = await deps.resolvePds(groupDid, true);
  } catch (error) {
    if (isDidTombstonedError(error)) return null;
    throw error;
  }
  try {
    return await queryJoinStatusAt(deps, groupDid, endpoint);
  } catch (error) {
    if (
      isUnsupportedJoinStatusExtension(error) ||
      (error instanceof XrpcError &&
        (error.code === "RepoNotFound" ||
          error.code === "GroupNotFound" ||
          error.code === "RepoTakendown" ||
          error.code === "RepoDeactivated"))
    ) {
      return null;
    }
    throw error;
  }
}

async function executeLeavingGroupPhases(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  groupDid: string,
  opts: { interactive: boolean },
): Promise<void> {
  let entry = await store.getLeavingGroup(groupDid);
  if (!entry) return;
  assertRowViewer(deps.did, entry.viewerDid);
  if (entry.phase === "blocked_deactivated") return;

  // Phase 1: `leaving_group`
  if (entry.phase === "leaving_group") {
    let pds: string | null = null;
    try {
      pds = await deps.resolvePds(groupDid);
    } catch (error) {
      if (isDidTombstonedError(error)) {
        entry = { ...entry, phase: "deleting_acceptance" };
        await store.putLeavingGroup(entry);
      } else {
        throw error;
      }
    }

    if (entry.phase === "leaving_group" && pds !== null) {
      const attemptLeaveAt = (endpoint: string) =>
        callPersonalGroupProcedure<Record<string, unknown>>(
          deps,
          groupDid,
          endpoint,
          ATGRP_METHOD.leaveGroup,
          { group: groupDid },
          entry!.expectedIncarnation !== undefined
            ? { "if-match-membership-incarnation": entry!.expectedIncarnation }
            : undefined,
        );

      const handleLeaveError = async (
        error: unknown,
        attemptedPds: string,
        allowPlcRefresh: boolean,
      ): Promise<"parked_or_cleared" | "advanced"> => {
        if (error instanceof XrpcError && error.code === "LastAdmin") {
          await store.deleteLeavingGroup(groupDid);
          throw error;
        }
        if (error instanceof XrpcError && error.code === "MembershipIncarnationMismatch") {
          await store.deleteLeavingGroup(groupDid);
          if (opts.interactive) throw error;
          return "parked_or_cleared";
        }
        if (error instanceof XrpcError && error.code === "RepoDeactivated") {
          await store.putLeavingGroup({ ...entry!, phase: "blocked_deactivated" });
          if (opts.interactive) throw error;
          return "parked_or_cleared";
        }
        if (error instanceof XrpcError && error.code === "RepoTakendown") {
          if (allowPlcRefresh) {
            let refreshedPds: string;
            try {
              refreshedPds = await deps.resolvePds(groupDid, true);
            } catch (plcErr) {
              if (isDidTombstonedError(plcErr)) {
                entry = { ...entry!, phase: "deleting_acceptance" };
                await store.putLeavingGroup(entry);
                return "advanced";
              }
              throw plcErr;
            }
            if (refreshedPds !== attemptedPds) {
              try {
                await attemptLeaveAt(refreshedPds);
                entry = { ...entry!, phase: "deleting_acceptance" };
                await store.putLeavingGroup(entry);
                return "advanced";
              } catch (targetErr) {
                return handleLeaveError(targetErr, refreshedPds, false);
              }
            }
          }
          await store.putLeavingGroup({ ...entry!, phase: "blocked_deactivated" });
          if (opts.interactive) throw error;
          return "parked_or_cleared";
        }
        if (error instanceof XrpcError && (error.code === "RepoNotFound" || error.code === "GroupNotFound")) {
          if (allowPlcRefresh) {
            let refreshedPds: string;
            try {
              refreshedPds = await deps.resolvePds(groupDid, true);
            } catch (plcErr) {
              if (isDidTombstonedError(plcErr)) {
                entry = { ...entry!, phase: "deleting_acceptance" };
                await store.putLeavingGroup(entry);
                return "advanced";
              }
              throw plcErr;
            }
            if (refreshedPds !== attemptedPds) {
              try {
                await attemptLeaveAt(refreshedPds);
              } catch (targetErr) {
                return handleLeaveError(targetErr, refreshedPds, false);
              }
            }
          }
          entry = { ...entry!, phase: "deleting_acceptance" };
          await store.putLeavingGroup(entry);
          return "advanced";
        }
        throw error;
      };

      try {
        await attemptLeaveAt(pds);
        entry = { ...entry, phase: "deleting_acceptance" };
        await store.putLeavingGroup(entry);
      } catch (error) {
        const resolution = await handleLeaveError(error, pds, true);
        if (resolution === "parked_or_cleared") return;
      }
    }
  }

  // Phase 2: `deleting_acceptance`
  if (entry.phase === "deleting_acceptance") {
    const [liveJoinStatus, ownAcc] = await Promise.all([
      safeQueryLiveJoinStatus(deps, groupDid),
      readOwnAcceptanceRecord(deps, groupDid),
    ]);

    const readmittedWithNewIncarnation =
      liveJoinStatus?.state === "admitted" &&
      liveJoinStatus.currentIncarnation !== undefined &&
      liveJoinStatus.currentIncarnation !== entry.expectedIncarnation;
    const ownAcceptanceMissing = ownAcc === null;
    const ownAcceptanceNewerIncarnation =
      ownAcc !== null &&
      typeof ownAcc[FLOCK_EXTENSION_FIELD.incarnation] === "string" &&
      ownAcc[FLOCK_EXTENSION_FIELD.incarnation] !== entry.expectedIncarnation;

    if (!readmittedWithNewIncarnation && !ownAcceptanceMissing && !ownAcceptanceNewerIncarnation) {
      try {
        await deps.memberClient.procedure("com.atproto.space.deleteRecord", {
          space: groupMembersUri(groupDid),
          repo: deps.did,
          collection: ATGRP_COLLECTION.confirmation,
          rkey: SELF_SKEY,
        });
      } catch (error) {
        if (!isMissingXrpcResource(error)) throw error;
      }
    }

    entry = { ...entry, phase: "reconciling_post_delete" };
    await store.putLeavingGroup(entry);
  }

  // Phase 3: `reconciling_post_delete`
  if (entry.phase === "reconciling_post_delete") {
    const liveJoinStatus = await safeQueryLiveJoinStatus(deps, groupDid);
    if (
      liveJoinStatus?.state === "admitted" &&
      liveJoinStatus.currentIncarnation !== undefined &&
      liveJoinStatus.currentIncarnation !== entry.expectedIncarnation
    ) {
      const ownAcc = await readOwnAcceptanceRecord(deps, groupDid);
      if (!ownAcc || ownAcc[FLOCK_EXTENSION_FIELD.incarnation] !== liveJoinStatus.currentIncarnation) {
        await writeOwnAcceptance(deps, groupDid, liveJoinStatus.currentIncarnation);
      }
      await store.deleteLeavingGroup(groupDid);
      return;
    }

    for (const joinRow of await store.listJoiningGroups()) {
      assertRowViewer(deps.did, joinRow.viewerDid);
      if (joinRow.groupDid === groupDid && !PASSIVE_JOIN_PHASES.has(joinRow.phase)) {
        await store.deleteJoiningGroup(joinRow.operationId);
      }
    }
    await store.deleteLeavingGroup(groupDid);
  }
}

export async function leaveGroup(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
  input: { groupDid: string },
): Promise<void> {
  if (!isDid(input.groupDid)) throw new TypeError("Invalid group DID.");
  const { groupDid } = input;

  await withGroupLifecycleLock(deps.did, groupDid, async () => {
    const existing = await store.getLeavingGroup(groupDid);
    if (existing) {
      assertRowViewer(deps.did, existing.viewerDid);
    }
    if (!existing || existing.phase === "blocked_deactivated") {
      const resolved = await resolveCurrentLeaveIncarnation(deps, groupDid);
      const expectedIncarnation = resolved.expectedIncarnation ?? existing?.expectedIncarnation;
      if (resolved.kind === "blocked") {
        await store.putLeavingGroup({
          viewerDid: deps.did,
          groupDid,
          ...(expectedIncarnation !== undefined ? { expectedIncarnation } : {}),
          phase: "blocked_deactivated",
          createdAt: existing?.createdAt ?? nowOf(deps),
        });
        throw resolved.error;
      }
      await store.putLeavingGroup({
        viewerDid: deps.did,
        groupDid,
        ...(expectedIncarnation !== undefined ? { expectedIncarnation } : {}),
        phase: "leaving_group",
        createdAt: existing?.createdAt ?? nowOf(deps),
      });
    }
    await executeLeavingGroupPhases(deps, store, groupDid, { interactive: true });
  });
}

/**
 * Reconciles persisted lifecycle journal rows in strict `leavingGroups` -> `joiningGroups` order:
 * 1. Drives all active non-parked `leavingGroups` rows (skipping `blocked_deactivated`).
 * 2. Drives all active non-passive `joiningGroups` rows — skipping any row whose `groupDid` still
 *    has an outstanding `leavingGroups` row (hard leave-completion barrier so a transient leave
 *    failure can never allow a stale `submitting` join row to re-admit the user).
 * 3. Per-row error isolation so one failing group never blocks other rows.
 */
export async function reconcileLifecycle(
  deps: DeskShellDeps,
  store: DeskLifecycleStore,
): Promise<{ leaveErrors: Array<{ groupDid: string; error: unknown }>; joinErrors: Array<{ operationId: string; error: unknown }> }> {
  const leaveErrors: Array<{ groupDid: string; error: unknown }> = [];
  const joinErrors: Array<{ operationId: string; error: unknown }> = [];

  for (const leaveEntry of await store.listLeavingGroups()) {
    try {
      assertRowViewer(deps.did, leaveEntry.viewerDid);
      if (leaveEntry.phase === "blocked_deactivated") continue;
      await withGroupLifecycleLock(deps.did, leaveEntry.groupDid, () =>
        executeLeavingGroupPhases(deps, store, leaveEntry.groupDid, { interactive: false }),
      );
    } catch (error) {
      leaveErrors.push({ groupDid: leaveEntry.groupDid, error });
    }
  }

  for (const joinEntry of await store.listJoiningGroups()) {
    try {
      assertRowViewer(deps.did, joinEntry.viewerDid);
      if (PASSIVE_JOIN_PHASES.has(joinEntry.phase)) continue;
      await withGroupLifecycleLock(deps.did, joinEntry.groupDid, async () => {
        // Hard leave-completion barrier: if ANY leavingGroups row remains for this group
        // (including transient failure or blocked_deactivated), do NOT drive the join row!
        const outstandingLeave = await store.getLeavingGroup(joinEntry.groupDid);
        if (outstandingLeave !== undefined) return;
        const freshJoin = await store.getJoiningGroup(joinEntry.operationId);
        if (!freshJoin || PASSIVE_JOIN_PHASES.has(freshJoin.phase)) return;
        await driveJoiningGroupPhases(deps, store, joinEntry.operationId);
      });
    } catch (error) {
      joinErrors.push({ operationId: joinEntry.operationId, error });
    }
  }

  return { leaveErrors, joinErrors };
}
