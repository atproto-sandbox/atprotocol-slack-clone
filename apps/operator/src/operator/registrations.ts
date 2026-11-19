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
import { appInboxUri, channelUri, inboxUri, parseAppInboxUri, requireSpaceAuthority } from "@flock/protocol/keys";
import { parseWorkspaceRef, type OperatorActor } from "./actor";
import { restoreAuthorityGrant } from "./authority-grant";
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

/**
 * Registers or renews one space of `workspace` using a stable 1-token-per-space webhook secret.
 * Persists a placeholder `(expires_at = 0, renew_at = 0, token)` before calling `authorizeSpaceSync` when `token` is empty
 * so the PDS's synchronous `confirmRegistration` succeeds inside `authorizeSpaceSync`, and reuses that exact `token` on
 * every subsequent renewal without rotation.
 */
export async function registerSpace(
  session: OAuthSession,
  workspace: string | null,
  space: string,
  deps: RegistrationDeps = registrationDeps,
): Promise<boolean> {
  return withSpaceRegistrationLock(space, async () => {
    const db = getRawDb();
    const { operatorServiceRef, operatorUrl } = getConfig();
    const existing = db
      .prepare("SELECT token, renew_at, last_space_rev, expires_at, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
      .get(operatorServiceRef, space) as {
        token: string;
        renew_at: number;
        last_space_rev: string | null;
        expires_at: number;
        workspace_uri: string | null;
      } | undefined;

    const effectiveWorkspace = workspace ?? existing?.workspace_uri ?? null;
    const newlyStaged = existing === undefined;
    const token = existing && existing.token.length > 0 ? existing.token : randomBytes(32).toString("base64url");

    if (!existing || existing.token.length === 0) {
      db.prepare(`INSERT INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev)
        VALUES (?, ?, 0, ?, ?, 0, NULL)
        ON CONFLICT(service_ref, space_uri) DO UPDATE SET
          token = excluded.token,
          workspace_uri = COALESCE(excluded.workspace_uri, notification_registration.workspace_uri)`)
        .run(operatorServiceRef, space, effectiveWorkspace, token);
    }

    const notify: SpaceNotifyTarget = { endpoint: operatorNotifyEndpoint(operatorUrl), token };
    let rawOutcome: RegistrationOutcome | number;
    try {
      rawOutcome = await deps.register(session, space, notify);
    } catch (error) {
      if (isSpaceDeleted(error) || (error instanceof XrpcError && error.code === "SpaceDeleted")) {
        if (newlyStaged) {
          db.prepare("DELETE FROM notification_registration WHERE service_ref = ? AND space_uri = ?").run(operatorServiceRef, space);
          db.prepare("DELETE FROM notification_registration_failure WHERE space_uri = ?").run(space);
        } else {
          purgeSpaceNotifications(space);
          dropMemberList(space);
        }
        return false;
      }
      const prior = db.prepare("SELECT failures, workspace_uri FROM notification_registration_failure WHERE space_uri = ?")
        .get(space) as { failures: number; workspace_uri: string } | undefined;
      const failures = (prior?.failures ?? 0) + 1;
      const retryIn = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), LONGEST_RETRY_MS);
      const failureWorkspace = effectiveWorkspace ?? prior?.workspace_uri ?? space;
      db.prepare(`INSERT INTO notification_registration_failure (space_uri, workspace_uri, failures, next_attempt_at, last_error)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(space_uri) DO UPDATE SET
          workspace_uri = excluded.workspace_uri,
          failures = excluded.failures,
          next_attempt_at = excluded.next_attempt_at,
          last_error = excluded.last_error`)
        .run(space, failureWorkspace, failures, deps.now() + retryIn, describeRepoFailure(error));
      return false;
    }

    const now = deps.now();
    const outcome: RegistrationOutcome = typeof rawOutcome === "number" ? { expiresAt: rawOutcome } : rawOutcome;
    const ttlMs = outcome.ttlMs ?? Math.max(0, outcome.expiresAt - now);
    const renewAt = outcome.expiresAt - computeRenewWithinMs(ttlMs);

    let shouldWake = false;
    db.transaction(() => {
      const current = db
        .prepare("SELECT last_space_rev, workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
        .get(operatorServiceRef, space) as { last_space_rev: string | null; workspace_uri: string | null } | undefined;
      const currentRev = current?.last_space_rev ?? null;
      let nextRev = currentRev;
      if (outcome.spaceRev !== undefined) {
        if (currentRev === null || outcome.spaceRev > currentRev) {
          shouldWake = true;
          nextRev = outcome.spaceRev;
        }
      }
      const storedWorkspace = effectiveWorkspace ?? current?.workspace_uri ?? null;
      db.prepare(`INSERT INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at, last_space_rev)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(service_ref, space_uri) DO UPDATE SET
          expires_at = excluded.expires_at,
          workspace_uri = excluded.workspace_uri,
          token = excluded.token,
          renew_at = excluded.renew_at,
          last_space_rev = excluded.last_space_rev`)
        .run(operatorServiceRef, space, outcome.expiresAt, storedWorkspace, token, renewAt, nextRev);
      db.prepare("DELETE FROM notification_registration_failure WHERE space_uri = ?").run(space);
    }).immediate();

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
    .prepare("SELECT workspace_uri FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
    .get(getConfig().operatorServiceRef, space) as { workspace_uri: string | null } | undefined;
  if (!row) return false;
  let session: OAuthSession;
  try {
    session = await deps.grant(requireSpaceAuthority(space));
  } catch (error) {
    const prior = db.prepare("SELECT failures, workspace_uri FROM notification_registration_failure WHERE space_uri = ?")
      .get(space) as { failures: number; workspace_uri: string } | undefined;
    const failures = (prior?.failures ?? 0) + 1;
    const retryIn = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), LONGEST_RETRY_MS);
    db.prepare(`INSERT INTO notification_registration_failure (space_uri, workspace_uri, failures, next_attempt_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(space_uri) DO UPDATE SET
        workspace_uri = excluded.workspace_uri,
        failures = excluded.failures,
        next_attempt_at = excluded.next_attempt_at,
        last_error = excluded.last_error`)
      .run(space, row.workspace_uri ?? prior?.workspace_uri ?? space, failures, deps.now() + retryIn, describeRepoFailure(error));
    return false;
  }
  return registerSpace(session, row.workspace_uri, space, deps);
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
      .prepare(`SELECT r.space_uri, r.workspace_uri
        FROM notification_registration r
        LEFT JOIN notification_registration_failure f ON f.space_uri = r.space_uri
        WHERE r.service_ref = ?
          AND (r.token = '' OR r.renew_at <= ?)
          AND COALESCE(f.next_attempt_at, 0) <= ?
        ORDER BY r.space_uri`)
      .all(serviceRef, nowMs, nowMs) as Array<{ space_uri: string; workspace_uri: string | null }>;

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

    const byAuthority = new Map<string, Array<{ space_uri: string; workspace_uri: string | null }>>();
    for (const row of dueRows) {
      const authorityDid = requireSpaceAuthority(row.space_uri);
      let group = byAuthority.get(authorityDid);
      if (!group) byAuthority.set(authorityDid, group = []);
      group.push(row);
    }

    for (const [authorityDid, rows] of byAuthority) {
      refreshRenewLease();
      let session: OAuthSession;
      try {
        session = await deps.grant(authorityDid);
      } catch (error) {
        const reason = describeRepoFailure(error);
        const workspaces = new Set(rows.map((row) => row.workspace_uri ?? row.space_uri));
        for (const ws of workspaces) report.skipped.push({ workspace: ws, reason });
        continue;
      }
      const outcomes = await mapLimited(rows, RENEW_CONCURRENCY, async (row) => {
        refreshRenewLease();
        return registerSpace(session, row.workspace_uri, row.space_uri, deps);
      });
      for (const ok of outcomes) {
        if (ok) report.registered += 1;
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
  const report: SweepReport = { registered: 0, failed: 0, skipped: [] };
  for (const { authorityDid, uri } of deps.workspaces()) {
    // What is held is read before the directory: a space's directory record is written before it is registered, so one held
    // here and missing from the directory read after is gone, while one registered meanwhile is not in this list.
    const held = heldSpaces(uri);
    let session: OAuthSession;
    let spaces: string[];
    try {
      session = await deps.grant(authorityDid);
      spaces = await deps.activeSpaces(session, uri);
    } catch (error) {
      report.skipped.push({ workspace: uri, reason: describeRepoFailure(error) });
      continue;
    }
    const dueSpaces = spaces.filter((space) => isDue(space, deps.now()));
    const outcomes = await mapLimited(dueSpaces, RENEW_CONCURRENCY, (space) => registerSpace(session, uri, space, deps));
    for (const ok of outcomes) {
      if (ok) report.registered += 1;
      else report.failed += 1;
    }
    for (const space of held.filter((space) => !spaces.includes(space))) await unregisterSpace(session, space);
  }
  return report;
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
    workspace,
    inboxUri(ref.authorityDid, ref.skey),
    ...openChannels.map(({ value }) => channelUri(ref.authorityDid, value.skey)),
    ...inboxes,
    ...extSpaces,
  ];
}
