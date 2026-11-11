import { randomUUID } from "node:crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as RegisterNotify from "@flock/protocol/lexicons/api/types/com/atproto/space/registerNotify";
import { claimLease } from "../auth/oauth-request-lock";
import { resolvePds } from "../atproto/identity";
import { describeRepoFailure } from "@flock/protocol/atproto/repo-failure";
import { mintSpaceCredential } from "../atproto/space-credential";
import { getConfig } from "@flock/deployment/config";
import { getRawDb } from "../lib/db";
import { channelUri, inboxUri, requireSpaceAuthority } from "@flock/protocol/keys";
import { parseWorkspaceRef, type OperatorActor } from "./actor";
import { restoreAuthorityGrant } from "./authority-grant";
import { adminMutationsPaused } from "./mutations-paused";
import type { OperationView } from "./journal";
import { listJournaledWorkspaces } from "./journal";
import type { OperationKind, OperatorRequest } from "./kinds/kind";
import { purgeSpaceNotifications } from "./notices";
import { directoryRecords } from "./workspace-state";

// The operator's notice sink for workspace, inbox and channel spaces: registered with the authority's grant when an operation
// creates a space, kept alive by a sweep, and dropped when a space is archived. Registering is idempotent and changes no
// membership, so none of this takes the workspace lock. DM spaces are registered by their members' clients.

/** A registration this close to running out is renewed. A registration lasts about a day. */
export const RENEW_WITHIN_MS = 6 * 60 * 60 * 1000;
/** The sweep runs at most this often across every operator process: its lease is also its schedule. */
export const SWEEP_INTERVAL_SECONDS = 30 * 60;
const SWEEP_LEASE = "notice-registration-sweep";
const FIRST_RETRY_MS = 30 * 60 * 1000;
/** At most an hour between retries, so the six hours before a registration runs out hold about six of them. */
const LONGEST_RETRY_MS = 60 * 60 * 1000;

export type RegistrationDeps = {
  /** Registers the operator's sink for `space` with its authority's grant; resolves to when the registration runs out. */
  register(session: OAuthSession, space: string): Promise<number>;
  unregister(session: OAuthSession, space: string): Promise<void>;
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
  unregister: unregisterWithGrant,
  now: () => Date.now(),
  workspaces: () => listJournaledWorkspaces(),
  grant: (authorityDid) => restoreAuthorityGrant(authorityDid),
  activeSpaces: activeWorkspaceSpaces,
};

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
  for (const space of kind.createsSpaces?.(actor, request) ?? []) await registerSpace(actor.session, actor.workspace.uri, space, deps);
  for (const space of kind.archivesSpaces?.(actor, request) ?? []) await unregisterSpace(actor.session, space, deps);
}

/** Registers one space of `workspace`; whether it is registered now. */
export async function registerSpace(session: OAuthSession, workspace: string, space: string, deps: RegistrationDeps = registrationDeps): Promise<boolean> {
  const db = getRawDb();
  let expiresAt: number;
  try {
    expiresAt = await deps.register(session, space);
  } catch (error) {
    const prior = db.prepare("SELECT failures FROM notification_registration_failure WHERE space_uri=?").get(space) as { failures: number } | undefined;
    const failures = (prior?.failures ?? 0) + 1;
    const retryIn = Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), LONGEST_RETRY_MS);
    db.prepare(`INSERT INTO notification_registration_failure (space_uri,workspace_uri,failures,next_attempt_at,last_error) VALUES (?,?,?,?,?)
      ON CONFLICT(space_uri) DO UPDATE SET workspace_uri=excluded.workspace_uri, failures=excluded.failures,
        next_attempt_at=excluded.next_attempt_at, last_error=excluded.last_error`)
      .run(space, workspace, failures, deps.now() + retryIn, describeRepoFailure(error));
    return false;
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO notification_registration (service_ref,space_uri,expires_at,workspace_uri) VALUES (?,?,?,?)
      ON CONFLICT(service_ref,space_uri) DO UPDATE SET expires_at=excluded.expires_at, workspace_uri=excluded.workspace_uri`)
      .run(getConfig().operatorServiceRef, space, expiresAt, workspace);
    db.prepare("DELETE FROM notification_registration_failure WHERE space_uri=?").run(space);
  })();
  return true;
}

/**
 * Drops an archived space's registration and notices. The authority is asked to stop sending them; if it cannot be asked
 * now, its registration still runs out within a day, and its notices are refused meanwhile because the operator no longer
 * holds the registration.
 */
export async function unregisterSpace(session: OAuthSession, space: string, deps: RegistrationDeps = registrationDeps): Promise<void> {
  const db = getRawDb();
  purgeSpaceNotifications(space);
  db.prepare("DELETE FROM notification_registration_failure WHERE space_uri=?").run(space);
  await deps.unregister(session, space).catch(() => undefined);
}

export type SweepReport = { registered: number; failed: number; skipped: Array<{ workspace: string; reason: string }> };

/**
 * Backfill and renewal: for every journaled workspace, registers each active space whose registration is missing or runs
 * out within six hours, except those waiting out a failure's backoff, and drops what it holds for a space no longer active
 * (an archive the reconcile job finished). Runs at most every 30 minutes across all operator processes, and in one of them
 * at a time; `null` when another process holds it, or while admin mutations are paused, since registering writes at the
 * authority's host.
 */
export async function sweepRegistrations(deps: SweepDeps = registrationDeps): Promise<SweepReport | null> {
  if (adminMutationsPaused()) return null;
  if (!claimLease(SWEEP_LEASE, randomUUID(), SWEEP_INTERVAL_SECONDS, Math.floor(deps.now() / 1000))) return null;
  const report: SweepReport = { registered: 0, failed: 0, skipped: [] };
  for (const { authorityDid, uri } of deps.workspaces()) {
    // What is held is read before the directory: a space's directory record is written before it is registered, so one held
    // here and missing from the directory read after is gone, while one registered meanwhile is not in this list. The other
    // way round, an archive that finishes during the sweep may be registered again by it; the next sweep drops it.
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
    for (const space of spaces.filter((space) => isDue(space, deps.now()))) {
      if (await registerSpace(session, uri, space, deps)) report.registered += 1;
      else report.failed += 1;
    }
    for (const space of held.filter((space) => !spaces.includes(space))) await unregisterSpace(session, space, deps);
  }
  return report;
}

export type RegistrationProblem = { space: string; failures: number; error?: string; nextAttemptAt?: string; expiredAt?: string };

/** The workspace's spaces whose registration failed since it last succeeded, or ran out: they get no change ticks meanwhile. */
export function registrationProblems(workspace: string, now = Date.now()): RegistrationProblem[] {
  const db = getRawDb();
  const failed = db.prepare("SELECT space_uri, failures, next_attempt_at, last_error FROM notification_registration_failure WHERE workspace_uri=? ORDER BY space_uri")
    .all(workspace) as Array<{ space_uri: string; failures: number; next_attempt_at: number; last_error: string }>;
  const lapsed = new Map((db.prepare("SELECT space_uri, expires_at FROM notification_registration WHERE workspace_uri=? AND expires_at<=?")
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
  const registration = db.prepare("SELECT expires_at FROM notification_registration WHERE service_ref=? AND space_uri=?")
    .get(getConfig().operatorServiceRef, space) as { expires_at: number } | undefined;
  return !registration || registration.expires_at - now <= RENEW_WITHIN_MS;
}

async function registerWithGrant(session: OAuthSession, space: string): Promise<number> {
  const credential = await mintSpaceCredential(session, space);
  const result = await credential.client(await resolvePds(requireSpaceAuthority(space)))
    .procedure<RegisterNotify.InputSchema, RegisterNotify.OutputSchema>("com.atproto.space.registerNotify", { space, service: getConfig().operatorServiceRef });
  const expiresAt = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("The authority answered registerNotify without a valid expiry.");
  return expiresAt;
}

async function unregisterWithGrant(session: OAuthSession, space: string): Promise<void> {
  const credential = await mintSpaceCredential(session, space);
  await credential.client(await resolvePds(requireSpaceAuthority(space)))
    .procedure("com.atproto.space.unregisterNotify", { space, service: getConfig().operatorServiceRef });
}

async function activeWorkspaceSpaces(session: OAuthSession, workspace: string): Promise<string[]> {
  const ref = parseWorkspaceRef(workspace);
  const actor: OperatorActor = { did: session.did, session, workspace: ref, canRecoverOperations: false };
  const channels = (await directoryRecords(actor)).filter(({ value }) => value.visibility !== "archived");
  return [workspace, inboxUri(ref.authorityDid, ref.skey), ...channels.map(({ value }) => channelUri(ref.authorityDid, value.skey))];
}
