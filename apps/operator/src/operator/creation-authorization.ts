import { getRawDb } from "../lib/db";

// A creation authorization: what a completed `createWorkspace` authority flow leaves when the person who started it is not
// the authority account. It lets that person create that one workspace under that authority, once. The authority account
// itself needs only its grant. There is no standing list of who may create under an authority.

/** How long an authorization stays usable: after its flow completes, and again after it is restored for one operation. */
export const CREATION_AUTHORIZATION_SECONDS = 15 * 60;

export type CreationAuthorization = { authorityDid: string; initiatorDid: string; name: string };

/** No authorization lets this person create this workspace under this authority with this operation. */
export class CreationNotAuthorizedError extends Error {
  constructor() {
    super("The workspace account must approve this workspace's creation first.");
    this.name = "CreationNotAuthorizedError";
  }
}

/**
 * Written when a creation flow completes for someone other than the authority: it replaces any earlier one for the same
 * three. When `operationId` (the flow's `creationKey`) is supplied, the authorization is bound to that exact operation so
 * concurrent creations for the same user and display name cannot collide.
 */
export function grantCreationAuthorization(
  authorization: CreationAuthorization,
  now: number,
  operationId: string | null = null,
): void {
  const db = getRawDb();
  db.transaction(() => {
    db.prepare("DELETE FROM creation_authorization WHERE expires_at <= ?").run(now);
    upsert(authorization, operationId, now + CREATION_AUTHORIZATION_SECONDS);
  })();
}

/**
 * Consumes the authorization for `operationId`: one granted for any operation, or one restored for this one. It runs in the
 * transaction that inserts the creation's journal row, so the row is the proof that its creator was allowed, and a retry
 * of the same operation finds its row and needs no authorization.
 */
export function consumeCreationAuthorization(authorization: CreationAuthorization, operationId: string, now: number): void {
  const removed = getRawDb().prepare(`DELETE FROM creation_authorization
    WHERE authority_did = ? AND initiator_did = ? AND name = ? AND expires_at > ? AND (operation_id IS NULL OR operation_id = ?)`)
    .run(authorization.authorityDid, authorization.initiatorDid, authorization.name, now, operationId);
  if (removed.changes !== 1) throw new CreationNotAuthorizedError();
}

/** Whether an authorization would let `operationId` create this workspace now, without using it up. */
export function hasCreationAuthorization(authorization: CreationAuthorization, operationId: string, now: number): boolean {
  return getRawDb().prepare(`SELECT 1 FROM creation_authorization
    WHERE authority_did = ? AND initiator_did = ? AND name = ? AND expires_at > ? AND (operation_id IS NULL OR operation_id = ?)`)
    .get(authorization.authorityDid, authorization.initiatorDid, authorization.name, now, operationId) !== undefined;
}

/**
 * Resolves the newly approved `groupDid` (`authority_did`) when `createWorkspace` is resumed after a `prompt=create`
 * authority flow without an explicit `authority` DID in the request body.
 *
 * Prefers an exact `operation_id` binding (from `creationKey`). Falls back to an unbound (`operation_id IS NULL`) row
 * only when exactly one non-expired unbound authorization exists for `(initiatorDid, name)` — rejecting ambiguous
 * multi-group matches rather than silently choosing the newest group.
 */
export function findCreationAuthorizationAuthority(
  initiatorDid: string,
  name: string,
  operationId: string,
  now: number,
): string | null {
  const db = getRawDb();
  const exact = db
    .prepare(`SELECT authority_did FROM creation_authorization
      WHERE initiator_did = ? AND name = ? AND expires_at > ? AND operation_id = ?
      LIMIT 2`)
    .all(initiatorDid, name, now, operationId) as Array<{ authority_did: string }>;
  if (exact.length === 1) return exact[0]!.authority_did;
  if (exact.length > 1) return null;

  const unbound = db
    .prepare(`SELECT authority_did FROM creation_authorization
      WHERE initiator_did = ? AND name = ? AND expires_at > ? AND operation_id IS NULL
      LIMIT 2`)
    .all(initiatorDid, name, now) as Array<{ authority_did: string }>;
  return unbound.length === 1 ? unbound[0]!.authority_did : null;
}

/**
 * Gives the authorization back for `operationId` only, for another 15 minutes: the creation's row was discarded because the
 * authority's grant lacked a scope for its first step, so the creator can reauthorize and retry without a second flow. It
 * runs in the transaction that discards the row.
 */
export function restoreCreationAuthorization(authorization: CreationAuthorization, operationId: string, now: number): void {
  upsert(authorization, operationId, now + CREATION_AUTHORIZATION_SECONDS);
}

function upsert(authorization: CreationAuthorization, operationId: string | null, expiresAt: number): void {
  getRawDb().prepare(`INSERT INTO creation_authorization (authority_did, initiator_did, name, operation_id, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(authority_did, initiator_did, name) DO UPDATE SET operation_id = excluded.operation_id, expires_at = excluded.expires_at`)
    .run(authorization.authorityDid, authorization.initiatorDid, authorization.name, operationId, expiresAt);
}
