import { randomBytes, randomUUID } from "node:crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { claimLease } from "../auth/oauth-request-lock";
import { appInboxState, spaceExists } from "../atproto/space-ops";
import { describeRepoFailure } from "@flock/protocol/atproto/repo-failure";
import { credentialLifetimeMs, SPACE_CREDENTIAL_LIFETIME_MS } from "@flock/protocol/atproto/space-credential-core";
import { isScopeMissingError, XrpcError } from "@flock/protocol/atproto/xrpc";
import { mapLimited } from "@flock/protocol/map-limited";
import { isSpaceDeleted, mintSpaceCredential, type SpaceNotifyTarget } from "../atproto/space-credential";
import { getConfig } from "@flock/deployment/config";
import { getRawDb } from "../lib/db";
import { appInboxUri, channelUri, groupMembersUri, groupMetaUri, inboxUri, parseAppInboxUri, requireSpaceAuthority, workspaceUri } from "@flock/protocol/keys";
import { parseWorkspaceRef, type OperatorActor } from "./actor";
import { restoreAuthorityGrant } from "./authority-grant";
import {
  AUTHORITY_SUSPENDED_BACKOFF_MS,
  getAuthoritySuspensionError,
  isSuspensionError,
  markAuthorityHealthy,
  tripAuthoritySuspension,
} from "./authority-suspension";
import { dropMemberList, isRegisteredSpace } from "./member-access";
import { activeExtInstalls, activeInstalls, allExtInstalls, allInstalls } from "./membership";
import { adminMutationsPaused } from "./mutations-paused";
import type { OperationView } from "./journal";
import { listJournaledWorkspaces } from "./journal";
import type { OperationKind, OperatorRequest } from "./kinds/kind";
import { purgeSpaceNotifications, recordSpaceWake } from "./notices";
import { operatorNotifyEndpoint } from "./space-notification";
import { directoryRecords } from "./workspace-state";

// The operator's inline webhook registrations (`authorizeSpaceSync` with stable 1-token-per-space `notify`):
// staged before calling `authorizeSpaceSync` so synchronous `confirmRegistration` succeeds, renewed every 60s via
// a fast SQL-first sweep before the 10-minute space credential expires, reconciled by a 30-minute discovery sweep,
// and dropped when a space is archived or confirmed deleted.

/** Maximum margin before `expires_at` at which a registration becomes due for renewal (capped at 30% of short TTLs). */
export const RENEW_WITHIN_MS = 3 * 60 * 1000;
/** Interval of the fast SQL-first due-registration renewal loop (`main.ts`). */
export const RENEW_LOOP_INTERVAL_MS = 60_000;
/** Lease duration (seconds) for the renewable DB mutex guarding `sweepDueRegistrations`, heartbeated while active. */
export const RENEW_LEASE_SECONDS = 90;
const RENEW_HEARTBEAT_MS = 20_000;
const RENEW_CONCURRENCY = 4;
/** The discovery backfill sweep runs at most this often across every operator process: its lease is also its schedule. */
export const SWEEP_INTERVAL_SECONDS = 30 * 60;
const SWEEP_LEASE = "notice-registration-sweep";
const RENEW_SWEEP_LEASE = "notice-registration-renew";
/** Short failure backoff (`15s -> 30s -> 60s -> 120s`) so transient errors recover well within the 10-minute credential TTL. */
export const FIRST_RETRY_MS = 15_000;
export const LONGEST_RETRY_MS = 120_000;

export type RegistrationOutcome = {
  expiresAt: number;
  ttlMs?: number;
  spaceRev?: string;
};

export type RegistrationDeps = {
  /** Authorizes sync & inline webhook registration for `space` with stable `notify`; returns expiry ms or full outcome. */
  register(session: OAuthSession, space: string, notify: SpaceNotifyTarget): Promise<RegistrationOutcome | number>;
  /** Confirms whether `space` is deleted at its authority (`authorizeSpaceSync` without `notify`). */
  confirmSpaceDeleted?(session: OAuthSession, space: string): Promise<boolean>;
  now(): number;
};

export type SweepDeps = RegistrationDeps & {
  workspaces(): Array<{ authorityDid: string; uri: string }>;
  grant(authorityDid: string): Promise<OAuthSession>;
  /** The workspace's spaces that are not archived: the workspace, its inbox and its channels. */
  activeSpaces(session: OAuthSession, workspace: string): Promise<string[]>;
};

export const registrationDeps: SweepDeps = {
  register: registerWithGrant,
  confirmSpaceDeleted: confirmDeletedWithGrant,
  now: () => Date.now(),
  workspaces: () => listJournaledWorkspaces(),
  grant: (authorityDid) => restoreAuthorityGrant(authorityDid),
  activeSpaces: activeWorkspaceSpaces,
};

/** Per-space serialization queue so `#registrationExpired`, `afterOperation`, and sweeps never race on the same space. */
const spaceRegistrationLocks = new Map<string, Promise<unknown>>();
/** Tracks fire-and-forget renewals triggered by `#registrationExpired` so tests or shutdown can await them cleanly. */
const pendingAsyncRenewals = new Set<Promise<unknown>>();
/** In-process mutex for `sweepDueRegistrations`. */
let dueSweepInFlight = false;

function withSpaceRegistrationLock<T>(space: string, fn: () => Promise<T>): Promise<T> {
  const previous = spaceRegistrationLocks.get(space) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  const tracked = next.then(() => undefined, () => undefined).finally(() => {
    if (spaceRegistrationLocks.get(space) === tracked) spaceRegistrationLocks.delete(space);
  });
  spaceRegistrationLocks.set(space, tracked);
  return next;
}

export async function flushPendingRenewals(): Promise<void> {
  while (pendingAsyncRenewals.size > 0) {
    await Promise.allSettled([...pendingAsyncRenewals]);
  }
}

export function computeRenewWithinMs(ttlMs: number): number {
  return ttlMs > 0 ? Math.min(RENEW_WITHIN_MS, Math.floor(ttlMs * 0.3)) : RENEW_WITHIN_MS;
}

/**
 * Registers or drops the spaces a completed operation created or archived. A registration that fails does not fail the
 * operation: it is recorded, retried by the sweep, and reported by `listStalledOperations`.
 */
export async function afterOperation(
  actor: OperatorActor,
  kind: Pick<OperationKind, "createsSpaces" | "archivesSpaces">,
  request: OperatorRequest,
  view: Pick<OperationView, "state">,
  deps: RegistrationDeps = registrationDeps,
): Promise<void> {
  if (view.state !== "completed") return;
  for (const space of kind.createsSpaces?.(actor, request) ?? []) {
    if (parseAppInboxUri(space) && await appInboxState(actor.session, space) !== "present") continue;
    await registerSpace(actor.session, actor.workspace.uri, space, deps);
  }
  for (const space of kind.archivesSpaces?.(actor, request) ?? []) await unregisterSpace(actor.session, space);
  if (request.kind === "reconcileWorkspace") {
    await syncReconciledInboxRegistrations(actor, deps);
    await syncReconciledExtensionRegistrations(actor, deps);
  }
}

export type RegisterSpaceOptions = {
  expectedGeneration?: number;
  expectedToken?: string;
  renewalOnly?: boolean;
};

type DueRegistrationRow = {
  space_uri: string;
  workspace_uri: string | null;
  token: string;
  generation: number;
};

function recordFailureIfExtant(
  serviceRef: string,
  space: string,
  expectedToken: string,
  expectedGeneration: number,
  effectiveWorkspace: string | null,
  nowMs: number,
  error: unknown,
): boolean {
  const db = getRawDb();
  let written = false;
  db.transaction(() => {
    const extant = db
      .prepare("SELECT workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ? AND token = ? AND generation = ?")
      .get(serviceRef, space, expectedToken, expectedGeneration) as { workspace_uri: string | null } | undefined;
    if (!extant) return;
    const prior = db.prepare("SELECT failures, workspace_uri FROM notification_registration_failure WHERE space_uri = ?")
      .get(space) as { failures: number; workspace_uri: string } | undefined;
    const failures = (prior?.failures ?? 0) + 1;
    const retryIn = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), LONGEST_RETRY_MS);
    const failureWorkspace = effectiveWorkspace ?? extant.workspace_uri ?? prior?.workspace_uri ?? space;
    db.prepare(`INSERT INTO notification_registration_failure (space_uri, workspace_uri, failures, next_attempt_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(space_uri) DO UPDATE SET
        workspace_uri = excluded.workspace_uri,
        failures = excluded.failures,
        next_attempt_at = excluded.next_attempt_at,
        last_error = excluded.last_error`)
      .run(space, failureWorkspace, failures, nowMs + retryIn, describeRepoFailure(error));
    written = true;
  }).immediate();
  return written;
}

function bulkBackoffAuthorityRows(
  rows: readonly DueRegistrationRow[],
  nowMs: number,
  error: unknown,
): number {
  if (rows.length === 0) return 0;
  const db = getRawDb();
  const serviceRef = getConfig().operatorServiceRef;
  const errorText = describeRepoFailure(error);
  let backedOff = 0;
  db.transaction(() => {
    const checkStmt = db.prepare(
      "SELECT token, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ? AND generation = ?",
    );
    const priorStmt = db.prepare(
      "SELECT failures, workspace_uri FROM notification_registration_failure WHERE space_uri = ?",
    );
    const upsertStmt = db.prepare(`INSERT INTO notification_registration_failure (space_uri, workspace_uri, failures, next_attempt_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(space_uri) DO UPDATE SET
        workspace_uri = excluded.workspace_uri,
        failures = excluded.failures,
        next_attempt_at = excluded.next_attempt_at,
        last_error = excluded.last_error`);

    for (const row of rows) {
      const extant = checkStmt.get(serviceRef, row.space_uri, row.generation) as { token: string; workspace_uri: string | null } | undefined;
      if (!extant) continue;
      if (row.token !== "" && extant.token !== row.token) continue;
      const prior = priorStmt.get(row.space_uri) as { failures: number; workspace_uri: string } | undefined;
      const failures = (prior?.failures ?? 0) + 1;
      const retryIn = Math.max(
        AUTHORITY_SUSPENDED_BACKOFF_MS,
        Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), LONGEST_RETRY_MS),
      );
      const failureWorkspace = row.workspace_uri ?? extant.workspace_uri ?? prior?.workspace_uri ?? row.space_uri;
      upsertStmt.run(row.space_uri, failureWorkspace, failures, nowMs + retryIn, errorText);
      backedOff += 1;
    }
  }).immediate();
  return backedOff;
}

/**
 * Registers or renews one space of `workspace` using a stable 1-token-per-space webhook secret.
 * Claims the initial `(token, generation)` inside `BEGIN IMMEDIATE` using `INSERT ... ON CONFLICT DO NOTHING` so concurrent
 * operator processes always observe and confirm the exact same winning `token`, and conditions every post-await write on
 * `(token, generation)` so an archive (`unregisterSpace`) during an in-flight PDS call never recreates the purged row.
 */
export async function registerSpace(
  session: OAuthSession,
  workspace: string | null,
  space: string,
  deps: RegistrationDeps = registrationDeps,
  options: RegisterSpaceOptions = {},
): Promise<boolean> {
  return withSpaceRegistrationLock(space, async () => {
    const db = getRawDb();
    const { operatorServiceRef, operatorUrl } = getConfig();
    const authorityDid = requireSpaceAuthority(space);
    const isRenewalMode = options.renewalOnly === true || options.expectedGeneration !== undefined;

    type ClaimedRegistration = {
      token: string;
      generation: number;
      newlyStaged: boolean;
      effectiveWorkspace: string | null;
    };

    const claimed: ClaimedRegistration | null = isRenewalMode
      ? db.transaction((): ClaimedRegistration | null => {
        const current = db
          .prepare("SELECT token, expires_at, last_space_rev, generation, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
          .get(operatorServiceRef, space) as {
            token: string;
            expires_at: number;
            last_space_rev: string | null;
            generation: number;
            workspace_uri: string | null;
          } | undefined;
        if (!current) return null;
        if (options.expectedGeneration !== undefined && current.generation !== options.expectedGeneration) {
          return null;
        }
        if (options.expectedToken !== undefined && options.expectedToken !== "" && current.token !== options.expectedToken) {
          return null;
        }
        if (current.token === "") {
          const candidateToken = randomBytes(32).toString("base64url");
          db.prepare(`UPDATE notification_registration
            SET token = ?, workspace_uri = COALESCE(?, workspace_uri)
            WHERE service_ref = ? AND space_uri = ? AND token = '' AND generation = ?`)
            .run(candidateToken, workspace, operatorServiceRef, space, current.generation);
          const refreshed = db
            .prepare("SELECT token, expires_at, last_space_rev, generation, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
            .get(operatorServiceRef, space) as {
              token: string;
              expires_at: number;
              last_space_rev: string | null;
              generation: number;
              workspace_uri: string | null;
            } | undefined;
          if (!refreshed || refreshed.generation !== current.generation || refreshed.token === "") return null;
          return {
            token: refreshed.token,
            generation: refreshed.generation,
            newlyStaged: false,
            effectiveWorkspace: workspace ?? refreshed.workspace_uri ?? null,
          };
        }
        return {
          token: current.token,
          generation: current.generation,
          newlyStaged: false,
          effectiveWorkspace: workspace ?? current.workspace_uri ?? null,
        };
      }).immediate()
      : db.transaction((): ClaimedRegistration => {
        const prior = db
          .prepare("SELECT token, generation FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
          .get(operatorServiceRef, space) as { token: string; generation: number } | undefined;
        const candidateToken = randomBytes(32).toString("base64url");
        db.prepare(`INSERT INTO notification_registration
          (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev, generation)
          VALUES (?, ?, 0, ?, ?, 0, NULL, 1)
          ON CONFLICT(service_ref, space_uri) DO NOTHING`)
          .run(operatorServiceRef, space, workspace, candidateToken);
        db.prepare(`UPDATE notification_registration
          SET token = ?, workspace_uri = COALESCE(?, workspace_uri)
          WHERE service_ref = ? AND space_uri = ? AND token = ''`)
          .run(candidateToken, workspace, operatorServiceRef, space);
        if (workspace !== null && prior !== undefined) {
          db.prepare(`UPDATE notification_registration
            SET workspace_uri = COALESCE(workspace_uri, ?)
            WHERE service_ref = ? AND space_uri = ?`)
            .run(workspace, operatorServiceRef, space);
        }
        const row = db
          .prepare("SELECT token, expires_at, last_space_rev, generation, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
          .get(operatorServiceRef, space) as {
            token: string;
            expires_at: number;
            last_space_rev: string | null;
            generation: number;
            workspace_uri: string | null;
          };
        return {
          token: row.token,
          generation: row.generation,
          newlyStaged: prior === undefined,
          effectiveWorkspace: workspace ?? row.workspace_uri ?? null,
        };
      }).immediate();

    if (!claimed) return false;

    const notify: SpaceNotifyTarget = { endpoint: operatorNotifyEndpoint(operatorUrl), token: claimed.token };
    let rawOutcome: RegistrationOutcome | number;
    try {
      rawOutcome = await deps.register(session, space, notify);
    } catch (error) {
      if (isSuspensionError(error)) {
        tripAuthoritySuspension(authorityDid, error, deps.now());
      }
      if (isSpaceDeleted(error) || (error instanceof XrpcError && error.code === "SpaceDeleted")) {
        db.transaction(() => {
          const extant = db
            .prepare("SELECT 1 FROM notification_registration WHERE service_ref = ? AND space_uri = ? AND token = ? AND generation = ?")
            .get(operatorServiceRef, space, claimed.token, claimed.generation);
          if (!extant) return;
          if (claimed.newlyStaged) {
            db.prepare("DELETE FROM notification_registration WHERE service_ref = ? AND space_uri = ? AND token = ? AND generation = ?")
              .run(operatorServiceRef, space, claimed.token, claimed.generation);
            db.prepare("DELETE FROM notification_registration_failure WHERE space_uri = ?").run(space);
          } else {
            purgeSpaceNotifications(space);
            dropMemberList(space);
          }
        }).immediate();
        return false;
      }
      recordFailureIfExtant(
        operatorServiceRef,
        space,
        claimed.token,
        claimed.generation,
        claimed.effectiveWorkspace,
        deps.now(),
        error,
      );
      return false;
    }

    const now = deps.now();
    markAuthorityHealthy(authorityDid, now);
    const outcome: RegistrationOutcome = typeof rawOutcome === "number" ? { expiresAt: rawOutcome } : rawOutcome;
    const ttlMs = outcome.ttlMs ?? Math.max(0, outcome.expiresAt - now);
    const renewAt = outcome.expiresAt - computeRenewWithinMs(ttlMs);

    let committed = false;
    let shouldWake = false;
    db.transaction(() => {
      const current = db
        .prepare("SELECT last_space_rev, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ? AND token = ? AND generation = ?")
        .get(operatorServiceRef, space, claimed.token, claimed.generation) as { last_space_rev: string | null; workspace_uri: string | null } | undefined;
      if (!current) return;
      const currentRev = current.last_space_rev ?? null;
      let nextRev = currentRev;
      if (outcome.spaceRev !== undefined) {
        if (currentRev === null || outcome.spaceRev > currentRev) {
          shouldWake = true;
          nextRev = outcome.spaceRev;
        }
      }
      const storedWorkspace = claimed.effectiveWorkspace ?? current.workspace_uri ?? null;
      const res = db.prepare(`UPDATE notification_registration
        SET expires_at = ?, workspace_uri = ?, renew_at = ?, last_space_rev = ?
        WHERE service_ref = ? AND space_uri = ? AND token = ? AND generation = ?`)
        .run(outcome.expiresAt, storedWorkspace, renewAt, nextRev, operatorServiceRef, space, claimed.token, claimed.generation);
      if (res.changes === 0) {
        shouldWake = false;
        return;
      }
      db.prepare("DELETE FROM notification_registration_failure WHERE space_uri = ?").run(space);
      committed = true;
    }).immediate();

    if (!committed) return false;
    if (shouldWake && outcome.spaceRev !== undefined) {
      recordSpaceWake(space, "", outcome.spaceRev, Math.floor(now / 1000));
    }
    return true;
  });
}

/**
 * Drops an archived space's local registration, failure state, cached member list, and notices.
 * No PDS `unregisterNotify` XRPC exists; the PDS registration lapses at its 10-minute `exp` while any late notice is
 * refused immediately because the operator's token row is gone.
 */
export async function unregisterSpace(_session: OAuthSession, space: string): Promise<void> {
  await withSpaceRegistrationLock(space, async () => {
    purgeSpaceNotifications(space);
    dropMemberList(space);
  });
}

/** Renews a single space registration by restoring its workspace authority's grant (used by `#registrationExpired`). */
export async function renewSpaceRegistration(space: string, deps: SweepDeps = registrationDeps): Promise<boolean> {
  if (adminMutationsPaused()) return false;
  const db = getRawDb();
  const row = db
    .prepare("SELECT workspace_uri, token, generation FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
    .get(getConfig().operatorServiceRef, space) as { workspace_uri: string | null; token: string; generation: number } | undefined;
  if (!row) return false;

  const authorityDid = requireSpaceAuthority(space);
  const dueRow: DueRegistrationRow = {
    space_uri: space,
    workspace_uri: row.workspace_uri,
    token: row.token,
    generation: row.generation,
  };
  const preSuspended = getAuthoritySuspensionError(authorityDid, deps.now());
  if (preSuspended) {
    bulkBackoffAuthorityRows([dueRow], deps.now(), preSuspended);
    return false;
  }

  let session: OAuthSession;
  try {
    session = await deps.grant(authorityDid);
  } catch (error) {
    if (isSuspensionError(error)) {
      tripAuthoritySuspension(authorityDid, error, deps.now());
    }
    bulkBackoffAuthorityRows([dueRow], deps.now(), error);
    return false;
  }
  return registerSpace(session, row.workspace_uri, space, deps, {
    expectedGeneration: row.generation,
    expectedToken: row.token,
    renewalOnly: true,
  });
}

/**
 * Handles `notifySpaceUpdate#registrationExpired` for an operator space: marks `renew_at = 0`, reconciles `last_space_rev`,
 * emits a wake row so connected clients catch any write that triggered the expiry notice via `listWritersSince`, and starts
 * a serialized background renewal.
 */
export function handleRegistrationExpiredNotice(space: string, spaceRev: string, deps: SweepDeps = registrationDeps): void {
  const db = getRawDb();
  const serviceRef = getConfig().operatorServiceRef;
  db.prepare(`UPDATE notification_registration
    SET renew_at = 0,
        last_space_rev = CASE
          WHEN last_space_rev IS NULL OR last_space_rev < ? THEN ?
          ELSE last_space_rev
        END
    WHERE service_ref = ? AND space_uri = ?`)
    .run(spaceRev, spaceRev, serviceRef, space);
  recordSpaceWake(space, "", spaceRev, Math.floor(deps.now() / 1000));

  const renewal = renewSpaceRegistration(space, deps).catch(() => undefined).finally(() => {
    pendingAsyncRenewals.delete(renewal);
  });
  pendingAsyncRenewals.add(renewal);
}

/**
 * Handles `notifySpaceUpdate#spaceDeleted` for an operator space (`D12.3.3`): never purges on webhook alone.
 * Restores the workspace authority's grant and confirms via `authorizeSpaceSync`; purges ONLY when the authority returns
 * `SpaceDeleted`. Missing grants, transient failures, or `RepoTakendown`/`RepoDeactivated` leave operator state intact.
 */
export async function handleSpaceDeletedNotice(
  space: string,
  deps: Pick<SweepDeps, "grant" | "confirmSpaceDeleted"> = registrationDeps,
): Promise<boolean> {
  return withSpaceRegistrationLock(space, async () => {
    let deleted = false;
    try {
      const session = await deps.grant(requireSpaceAuthority(space));
      const confirm = deps.confirmSpaceDeleted ?? confirmDeletedWithGrant;
      deleted = await confirm(session, space);
    } catch {
      return false;
    }
    if (!deleted) return false;
    purgeSpaceNotifications(space);
    dropMemberList(space);
    return true;
  });
}

export type SweepReport = { registered: number; failed: number; skipped: Array<{ workspace: string; reason: string }> };

/**
 * Fast SQL-first renewal sweep (`60s` cadence in `main.ts`): queries due `notification_registration` rows first
 * (`(token = '' OR renew_at <= now) AND COALESCE(f.next_attempt_at, 0) <= now`). Zero due rows = zero grant restores,
 * zero DB writes, and zero PDS requests. When rows are due, claims a heartbeated renewable DB lease (plus in-process mutex),
 * restores the authority grant once per due authority, and renews with bounded concurrency (`4`).
 */
export async function sweepDueRegistrations(deps: SweepDeps = registrationDeps): Promise<SweepReport | null> {
  if (adminMutationsPaused() || dueSweepInFlight) return null;
  const serviceRef = getConfig().operatorServiceRef;
  const queryDueRows = (nowMs: number) =>
    getRawDb()
      .prepare(`SELECT r.space_uri, r.workspace_uri, r.token, r.generation
        FROM notification_registration r
        LEFT JOIN notification_registration_failure f ON f.space_uri = r.space_uri
        WHERE r.service_ref = ?
          AND (r.token = '' OR r.renew_at <= ?)
          AND COALESCE(f.next_attempt_at, 0) <= ?
        ORDER BY r.space_uri`)
      .all(serviceRef, nowMs, nowMs) as DueRegistrationRow[];

  const initialDue = queryDueRows(deps.now());
  if (initialDue.length === 0) {
    return { registered: 0, failed: 0, skipped: [] };
  }

  dueSweepInFlight = true;
  const leaseToken = randomUUID();
  const acquired = claimLease(RENEW_SWEEP_LEASE, leaseToken, RENEW_LEASE_SECONDS, Math.floor(deps.now() / 1000));
  if (!acquired) {
    dueSweepInFlight = false;
    return null;
  }

  const refreshRenewLease = () => {
    try {
      getRawDb()
        .prepare("UPDATE oauth_request_lock SET expires_at = ? WHERE name = ? AND token = ?")
        .run(Math.floor(deps.now() / 1000) + RENEW_LEASE_SECONDS, RENEW_SWEEP_LEASE, leaseToken);
    } catch {
      // Best-effort heartbeat; if DB is closing, the sweep's own queries surface it.
    }
  };
  const heartbeat = setInterval(refreshRenewLease, RENEW_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const dueRows = queryDueRows(deps.now());
    const report: SweepReport = { registered: 0, failed: 0, skipped: [] };
    if (dueRows.length === 0) return report;

    const byAuthority = new Map<string, DueRegistrationRow[]>();
    for (const row of dueRows) {
      const authorityDid = requireSpaceAuthority(row.space_uri);
      let group = byAuthority.get(authorityDid);
      if (!group) byAuthority.set(authorityDid, group = []);
      group.push(row);
    }

    for (const [authorityDid, rows] of byAuthority) {
      refreshRenewLease();
      const preSuspended = getAuthoritySuspensionError(authorityDid, deps.now());
      if (preSuspended) {
        report.failed += bulkBackoffAuthorityRows(rows, deps.now(), preSuspended);
        continue;
      }

      let session: OAuthSession;
      try {
        session = await deps.grant(authorityDid);
      } catch (error) {
        if (isSuspensionError(error)) {
          const tripped = tripAuthoritySuspension(authorityDid, error, deps.now());
          report.failed += bulkBackoffAuthorityRows(rows, deps.now(), tripped);
          continue;
        }
        const reason = describeRepoFailure(error);
        const workspaces = new Set(rows.map((row) => row.workspace_uri ?? row.space_uri));
        for (const ws of workspaces) report.skipped.push({ workspace: ws, reason });
        continue;
      }

      const [firstRow, ...restRows] = rows;
      if (!firstRow) continue;

      const firstOk = await registerSpace(session, firstRow.workspace_uri, firstRow.space_uri, deps, {
        expectedGeneration: firstRow.generation,
        expectedToken: firstRow.token,
        renewalOnly: true,
      });
      if (firstOk) report.registered += 1;
      else report.failed += 1;

      const firstSusp = getAuthoritySuspensionError(authorityDid, deps.now());
      if (firstSusp) {
        report.failed += bulkBackoffAuthorityRows(restRows, deps.now(), firstSusp);
        continue;
      }

      const deferredForBulkBackoff: DueRegistrationRow[] = [];
      const outcomes = await mapLimited(restRows, RENEW_CONCURRENCY, async (row) => {
        refreshRenewLease();
        if (getAuthoritySuspensionError(authorityDid, deps.now())) {
          deferredForBulkBackoff.push(row);
          return "suspended" as const;
        }
        return registerSpace(session, row.workspace_uri, row.space_uri, deps, {
          expectedGeneration: row.generation,
          expectedToken: row.token,
          renewalOnly: true,
        });
      });
      const afterRestSusp = getAuthoritySuspensionError(authorityDid, deps.now());
      if (deferredForBulkBackoff.length > 0 && afterRestSusp) {
        report.failed += bulkBackoffAuthorityRows(deferredForBulkBackoff, deps.now(), afterRestSusp);
      }
      for (const outcome of outcomes) {
        if (outcome === "suspended") continue;
        if (outcome) report.registered += 1;
        else report.failed += 1;
      }
    }
    return report;
  } finally {
    clearInterval(heartbeat);
    try {
      getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name = ? AND token = ?").run(RENEW_SWEEP_LEASE, leaseToken);
    } catch {
      // Ignore if DB was closed by test teardown.
    }
    dueSweepInFlight = false;
  }
}

/**
 * Discovery backfill and reconciliation sweep: for every journaled workspace, discovers active spaces, registers any space
 * whose registration is missing or due (except those waiting out a failure's backoff), and drops registrations for spaces
 * no longer active. Runs at most every 30 minutes across all operator processes; `null` when another process holds the
 * schedule lease or while admin mutations are paused.
 */
export async function sweepRegistrations(deps: SweepDeps = registrationDeps): Promise<SweepReport | null> {
  if (adminMutationsPaused()) return null;
  if (!claimLease(SWEEP_LEASE, randomUUID(), SWEEP_INTERVAL_SECONDS, Math.floor(deps.now() / 1000))) return null;
  const serviceRef = getConfig().operatorServiceRef;
  const dueWorkspaceRows = (workspaceUri: string): DueRegistrationRow[] =>
    getRawDb()
      .prepare(`SELECT space_uri, workspace_uri, token, generation
        FROM notification_registration
        WHERE service_ref = ? AND workspace_uri = ?`)
      .all(serviceRef, workspaceUri) as DueRegistrationRow[];

  const report: SweepReport = { registered: 0, failed: 0, skipped: [] };
  for (const { authorityDid, uri } of deps.workspaces()) {
    const preSuspended = getAuthoritySuspensionError(authorityDid, deps.now());
    if (preSuspended) {
      bulkBackoffAuthorityRows(dueWorkspaceRows(uri), deps.now(), preSuspended);
      report.skipped.push({ workspace: uri, reason: describeRepoFailure(preSuspended) });
      continue;
    }
    // What is held is read before the directory: a space's directory record is written before it is registered, so one held
    // here and missing from the directory read after is gone, while one registered meanwhile is not in this list.
    const held = heldSpaces(uri);
    let session: OAuthSession;
    let spaces: string[];
    try {
      session = await deps.grant(authorityDid);
      spaces = await deps.activeSpaces(session, uri);
    } catch (error) {
      if (isSuspensionError(error)) {
        const tripped = tripAuthoritySuspension(authorityDid, error, deps.now());
        bulkBackoffAuthorityRows(dueWorkspaceRows(uri), deps.now(), tripped);
      }
      report.skipped.push({ workspace: uri, reason: describeRepoFailure(error) });
      continue;
    }
    const dueSpaces = spaces.filter((space) => isDue(space, deps.now()));
    const [firstDue, ...restDue] = dueSpaces;
    if (firstDue) {
      const firstOk = await registerSpace(session, uri, firstDue, deps);
      if (firstOk) report.registered += 1;
      else report.failed += 1;

      const firstSusp = getAuthoritySuspensionError(authorityDid, deps.now());
      if (firstSusp) {
        const restSet = new Set(restDue);
        report.failed += bulkBackoffAuthorityRows(
          dueWorkspaceRows(uri).filter((row) => restSet.has(row.space_uri)),
          deps.now(),
          firstSusp,
        );
        continue;
      }

      const deferredSpaces: string[] = [];
      const outcomes = await mapLimited(restDue, RENEW_CONCURRENCY, async (space) => {
        if (getAuthoritySuspensionError(authorityDid, deps.now())) {
          deferredSpaces.push(space);
          return "suspended" as const;
        }
        return registerSpace(session, uri, space, deps);
      });
      const afterSusp = getAuthoritySuspensionError(authorityDid, deps.now());
      if (deferredSpaces.length > 0 && afterSusp) {
        const deferredSet = new Set(deferredSpaces);
        report.failed += bulkBackoffAuthorityRows(
          dueWorkspaceRows(uri).filter((row) => deferredSet.has(row.space_uri)),
          deps.now(),
          afterSusp,
        );
        continue;
      }
      for (const ok of outcomes) {
        if (ok === "suspended") continue;
        if (ok) report.registered += 1;
        else report.failed += 1;
      }
    }
    for (const space of held.filter((space) => !spaces.includes(space))) await unregisterSpace(session, space);
  }
  return report;
}

/**
 * Synchronously refreshes change-notice registrations across all active spaces of `workspace` using `session`
 * (ignoring failure backoff timers so post-deactivation / post-reauthorization reactivation restores realtime
 * coverage before `WorkspaceClient.reactivateGroup` leaves `reauthorizing_operator`), and drops stale registrations.
 */
export async function refreshWorkspaceRegistrations(
  session: OAuthSession,
  workspace: string,
  deps: SweepDeps = registrationDeps,
): Promise<{ registered: number; failed: number }> {
  markAuthorityHealthy(session.did, deps.now());
  const held = heldSpaces(workspace);
  const spaces = await deps.activeSpaces(session, workspace);
  const outcomes = await mapLimited(spaces, RENEW_CONCURRENCY, (space) =>
    registerSpace(session, workspace, space, deps),
  );
  for (const space of held.filter((space) => !spaces.includes(space))) {
    await unregisterSpace(session, space);
  }
  let registered = 0;
  let failed = 0;
  for (const ok of outcomes) {
    if (ok) registered += 1;
    else failed += 1;
  }
  return { registered, failed };
}

/**
 * Refreshes change-notice registrations across all workspaces governed by `authorityDid` after `/authority/callback`
 * persists a replacement shared OAuth grant (`purpose.kind === "reauthorize"`).
 */
export async function refreshAuthorityWorkspaceRegistrations(
  authorityDid: string,
  deps: SweepDeps = registrationDeps,
): Promise<void> {
  if (adminMutationsPaused()) return;
  markAuthorityHealthy(authorityDid, deps.now());
  const session = await deps.grant(authorityDid);
  const knownUris = deps
    .workspaces()
    .filter((ws) => ws.authorityDid === authorityDid)
    .map((ws) => ws.uri);
  if (knownUris.length === 0) {
    const defaultWs = workspaceUri(authorityDid);
    if (await spaceExists(session, defaultWs)) {
      knownUris.push(defaultWs);
    }
  }
  for (const uri of new Set(knownUris)) {
    await refreshWorkspaceRegistrations(session, uri, deps);
  }
}

export type RegistrationProblem = { space: string; failures: number; error?: string; nextAttemptAt?: string; expiredAt?: string };

/** The workspace's spaces whose registration failed since it last succeeded, or ran out: they get no change ticks meanwhile. */
export function registrationProblems(workspace: string, now = Date.now()): RegistrationProblem[] {
  const db = getRawDb();
  const failed = db.prepare("SELECT space_uri, failures, next_attempt_at, last_error FROM notification_registration_failure WHERE workspace_uri=? ORDER BY space_uri")
    .all(workspace) as Array<{ space_uri: string; failures: number; next_attempt_at: number; last_error: string }>;
  const lapsed = new Map((db.prepare("SELECT space_uri, expires_at FROM notification_registration WHERE workspace_uri=? AND expires_at > 0 AND expires_at<=?")
    .all(workspace, now) as Array<{ space_uri: string; expires_at: number }>).map((row) => [row.space_uri, row.expires_at]));
  const problems: RegistrationProblem[] = failed.map((row) => ({
    space: row.space_uri, failures: row.failures, error: row.last_error, nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    ...(lapsed.has(row.space_uri) ? { expiredAt: new Date(lapsed.get(row.space_uri)!).toISOString() } : {}),
  }));
  for (const [space, expiresAt] of lapsed) {
    if (!failed.some((row) => row.space_uri === space)) problems.push({ space, failures: 0, expiredAt: new Date(expiresAt).toISOString() });
  }
  return problems;
}

/** The spaces of a workspace the operator holds a registration or a failure for. */
function heldSpaces(workspace: string): string[] {
  return (getRawDb().prepare(`SELECT space_uri FROM notification_registration WHERE workspace_uri=?
    UNION SELECT space_uri FROM notification_registration_failure WHERE workspace_uri=?`).all(workspace, workspace) as Array<{ space_uri: string }>)
    .map((row) => row.space_uri);
}

function isDue(space: string, now: number): boolean {
  const db = getRawDb();
  const failure = db.prepare("SELECT next_attempt_at FROM notification_registration_failure WHERE space_uri=?").get(space) as { next_attempt_at: number } | undefined;
  if (failure && failure.next_attempt_at > now) return false;
  const registration = db.prepare("SELECT token, renew_at, expires_at FROM notification_registration WHERE service_ref=? AND space_uri=?")
    .get(getConfig().operatorServiceRef, space) as { token: string; renew_at: number; expires_at: number } | undefined;
  return !registration || registration.token === "" || registration.expires_at === 0 || registration.renew_at <= now;
}

function extractJwtClaims(token: string): { iat: number; exp: number } | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const { iat, exp } = decoded as { iat?: unknown; exp?: unknown };
    if (typeof iat !== "number" || !Number.isFinite(iat) || typeof exp !== "number" || !Number.isFinite(exp) || exp <= iat) {
      return null;
    }
    return { iat, exp };
  } catch {
    return null;
  }
}

async function registerWithGrant(session: OAuthSession, space: string, notify: SpaceNotifyTarget): Promise<RegistrationOutcome> {
  const credential = await mintSpaceCredential(session, space, { notify });
  const claims = extractJwtClaims(credential.token);
  const ttlMs = claims ? Math.max(0, (claims.exp - claims.iat) * 1000) : (credentialLifetimeMs(credential.token) ?? SPACE_CREDENTIAL_LIFETIME_MS);
  const expiresAt = claims ? claims.exp * 1000 : credential.expiresAt;
  return {
    expiresAt,
    ttlMs,
    ...(credential.spaceRev !== undefined ? { spaceRev: credential.spaceRev } : {}),
  };
}

async function confirmDeletedWithGrant(session: OAuthSession, space: string): Promise<boolean> {
  try {
    await mintSpaceCredential(session, space);
    return false;
  } catch (error) {
    if (isSpaceDeleted(error)) return true;
    throw error;
  }
}

function hasRegistration(space: string): boolean {
  return Boolean(getRawDb().prepare("SELECT 1 FROM notification_registration WHERE service_ref=? AND space_uri=? AND expires_at > 0 AND token != ''")
    .get(getConfig().operatorServiceRef, space));
}

async function syncReconciledInboxRegistrations(actor: OperatorActor, deps: RegistrationDeps): Promise<void> {
  const installs = await allInstalls(actor);
  for (const install of [...installs.values()].sort((left, right) => left.subject.localeCompare(right.subject))) {
    const inbox = appInboxUri(actor.workspace.authorityDid, actor.workspace.skey, install.subject);
    if (install.active) {
      if (hasRegistration(inbox)) continue;
      if (await appInboxState(actor.session, inbox) === "present") await registerSpace(actor.session, actor.workspace.uri, inbox, deps);
    } else if (isRegisteredSpace(inbox)) {
      await unregisterSpace(actor.session, inbox);
    }
  }
}

async function syncReconciledExtensionRegistrations(actor: OperatorActor, deps: RegistrationDeps): Promise<void> {
  const extInstalls = await allExtInstalls(actor);
  for (const install of [...extInstalls.values()].sort((left, right) => left.extId.localeCompare(right.extId))) {
    if (install.active) {
      if (hasRegistration(install.space)) continue;
      if (await spaceExists(actor.session, install.space)) await registerSpace(actor.session, actor.workspace.uri, install.space, deps);
    } else if (isRegisteredSpace(install.space)) {
      await unregisterSpace(actor.session, install.space);
    }
  }
}

async function activeWorkspaceSpaces(session: OAuthSession, workspace: string): Promise<string[]> {
  const ref = parseWorkspaceRef(workspace);
  const actor: OperatorActor = { did: session.did, session, workspace: ref, canRecoverOperations: false };
  const [channels, installs, extInstalls] = await Promise.all([
    directoryRecords(actor),
    activeInstalls(actor),
    activeExtInstalls(actor),
  ]);
  const openChannels = channels.filter(({ value }) => value.visibility !== "archived");
  const inboxes: string[] = [];
  for (const install of [...installs.values()].sort((left, right) => left.subject.localeCompare(right.subject))) {
    const inbox = appInboxUri(ref.authorityDid, ref.skey, install.subject);
    if (await appInboxState(session, inbox) === "present") inboxes.push(inbox);
  }
  const extSpaces: string[] = [];
  for (const install of [...extInstalls.values()].sort((left, right) => left.extId.localeCompare(right.extId))) {
    try {
      if (await spaceExists(session, install.space)) extSpaces.push(install.space);
    } catch (error) {
      if (!isScopeMissingError(error)) throw error;
    }
  }
  return [
    groupMetaUri(ref.authorityDid),
    groupMembersUri(ref.authorityDid),
    workspace,
    inboxUri(ref.authorityDid, ref.skey),
    ...openChannels.map(({ value }) => channelUri(ref.authorityDid, value.skey)),
    ...inboxes,
    ...extSpaces,
  ];
}
