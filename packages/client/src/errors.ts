export { isAccessLost } from "@flock/protocol/atproto/space-credential-core";
export { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";

/** A channel the directory marks as transitioning or archived: no new reads or writes until it is public or private again. */
export class ChannelUnavailableError extends Error {
  constructor(message: string, readonly visibility: "transitioning" | "archived") {
    super(message);
    this.name = "ChannelUnavailableError";
  }
}

/** Personal `group.opensocial.invites/self` already exists with an incompatible policy (`publicWrite !== true`, `publicRead !== false`, `allowedApps !== undefined`) or non-empty member list. */
export class IncompatibleInvitesSpacePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleInvitesSpacePolicyError";
  }
}

/** `group.opensocial.requestJoin` returned a forward-compatible `status` outside `{ "admitted", "pending" }`. */
export class UnsupportedJoinStatusError extends Error {
  constructor(readonly rawStatus: string) {
    super(`Unsupported join status returned by group host: ${rawStatus}`);
    this.name = "UnsupportedJoinStatusError";
  }
}

/** `group.opensocial.requestJoin` returned HTTP `429 JoinOperationQuotaExceeded` (200 unexpired idempotency rows). */
export class JoinOperationQuotaExceededError extends Error {
  readonly status = 429;
  readonly code = "JoinOperationQuotaExceeded";

  constructor(message = "Too many recent join operations for this group. Wait or dismiss before retrying.") {
    super(message);
    this.name = "JoinOperationQuotaExceededError";
  }
}

/** Reusing an existing lifecycle `operationId` with different group or intent parameters (`409 IdempotencyParameterMismatch`). */
export class IdempotencyParameterMismatchError extends Error {
  readonly status = 409;
  readonly code = "IdempotencyParameterMismatch";

  constructor(message = "Operation ID was already recorded with different parameters.") {
    super(message);
    this.name = "IdempotencyParameterMismatchError";
  }
}

/** Authoritative HTTP 404 / tombstoned DID resolution failure on PLC or `did:web`. */
export class DidNotFoundError extends Error {
  readonly status = 404;

  constructor(readonly did: string, message = `Could not resolve ${did} (404).`) {
    super(message);
    this.name = "DidNotFoundError";
  }
}

/** True iff `error` indicates authoritative DID absence / PLC tombstone (never transient network/5xx errors). */
export function isDidTombstonedError(error: unknown): boolean {
  if (error instanceof DidNotFoundError) return true;
  if (error instanceof Error && /^fake-pds: no account registered for did:/.test(error.message)) {
    return true;
  }
  return false;
}
