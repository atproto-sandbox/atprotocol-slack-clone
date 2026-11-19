import { cryptoVerifySignatureWithKey, verifyJwt } from "@atproto/xrpc-server";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { getIdResolver, resolveSigningKey as cachedResolveSigningKey } from "../atproto/identity";
import { sessionClient } from "../atproto/client";
import { listBoundedMembers } from "@flock/protocol/atproto/record-pages";
import { verifyCredentialSig } from "@flock/protocol/atproto/space-credential-core";
import { listSpaceMembers } from "../atproto/space-ops";
import { getConfig } from "@flock/deployment/config";
import { inboxUri, isDid, parseDmSpaceUri, parseSpaceUri, requireSpaceAuthority, subjectKey } from "@flock/protocol/keys";
import { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { authorizeDmSubscription } from "../lib/dm-subscription";
import { restoreAuthorityGrant } from "./authority-grant";
import { OperatorAuthError, OperatorInfrastructureError, isTransientOperatorInfrastructureError } from "./errors";
import { hasJournaledOperation } from "./journal";
import { operationKind } from "./kinds/index";
import { assertMayStartKind, validateOperatorRequest } from "./operations";
import { COLLECTION, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor, type WorkspaceRef } from "./actor";
import { getOwnerRecord } from "./workspace-state";

const MAX_READ_ONLY_MEMBER_SCAN = 1_000;
const SPACE_CREDENTIAL_TYP = "atproto-space-credential+jwt";
const SPACE_CREDENTIAL_MAX_AGE_SECONDS = 3_600;
const CREDENTIAL_IAT_CLOCK_SKEW_SECONDS = 5;
const PROOF_CREATED_WINDOW_SECONDS = 60;
const MAX_DM_PROOF_REPLAY_ENTRIES = 16_384;

const dmProofReplayCache = new Map<string, number>();

export function resetDmProofReplayCacheForTests(): void {
  dmProofReplayCache.clear();
}

/** The bearer token an `authorization` header value carries. */
function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
}

/**
 * The `iss` a bearer service token claims, read without verifying it, or `null` when there is no well-formed token. It proves
 * nothing; it lets a caller refuse a token that names the wrong issuer before any DID is resolved for it.
 */
export function unverifiedBearerIssuer(authorization: string | undefined): string | null {
  const payload = bearerToken(authorization)?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isPlainObject(claims) && typeof claims.iss === "string" ? claims.iss : null;
  } catch {
    return null;
  }
}

/**
 * How long a service token may live, from when it was issued, per method: a minute and a little more for one call,
 * fifteen minutes for the long poll, so a client reuses one token across polls.
 */
const SERVICE_TOKEN_LIFETIME_SECONDS: Readonly<Record<string, number>> = { [OPERATOR_METHOD.getChanges]: 15 * 60 };
const DEFAULT_SERVICE_TOKEN_LIFETIME_SECONDS = 75;

export function serviceTokenLifetimeSeconds(method: string): number {
  return SERVICE_TOKEN_LIFETIME_SECONDS[method] ?? DEFAULT_SERVICE_TOKEN_LIFETIME_SECONDS;
}

/** The caller's DID from a PDS-issued service token bound to this operator and to `method`, within that method's lifetime. */
export async function authenticateOperatorRequest(
  authorization: string | undefined,
  method: string,
  resolveSigningKey: (did: string) => Promise<string> = (did) => getIdResolver().did.resolveAtprotoKey(did),
): Promise<string> {
  const token = bearerToken(authorization);
  if (!token) throw new OperatorAuthError("Bearer service authorization is required.");
  const serviceRef = getConfig().operatorServiceRef;
  const payload = await verifyJwt(
    token,
    serviceRef,
    method,
    async (issuer) => resolveSigningKey(issuer.split("#", 1)[0]!),
  ).catch((error: unknown) => {
    if (isTransientOperatorInfrastructureError(error)) throw new OperatorInfrastructureError();
    throw new OperatorAuthError("Service authorization is invalid or expired.");
  });
  if (!isDid(payload.iss)) {
    throw new OperatorAuthError("Service authorization issuer must be an actor DID.");
  }
  const payloadBytes = Buffer.from(token.split(".")[1] ?? "", "base64url");
  const decoded: unknown = JSON.parse(payloadBytes.toString("utf8"));
  const issuedAt = isPlainObject(decoded) ? decoded.iat : undefined;
  const now = Math.floor(Date.now() / 1000);
  const lifetime = serviceTokenLifetimeSeconds(method);
  // The token's age, from the PDS's own iat, bounds when it is accepted; its exp is the client's ask, made on the client's
  // clock, so it is only required to come after iat.
  if (typeof issuedAt !== "number" || issuedAt > now + 5 || payload.exp <= issuedAt || now - issuedAt > lifetime) {
    throw new OperatorAuthError("Service authorization is outside the accepted lifetime.");
  }
  return payload.iss;
}

export type DmCredentialProof = {
  authorization: string;
  signatureInput: string;
  signature: string;
};

export type VerifyDmNotifyTargetDeps = {
  resolveSigningKey?: (did: string, forceRefresh: boolean) => Promise<string>;
  operatorServiceRef?: string;
  now?: () => number;
};

/**
 * Verifies that `callerDid` may watch `space` (a DM inbox or DM conversation) and holds both:
 * 1) an unexpired `SpaceCredential` JWT issued by `requireSpaceAuthority(space)` for `sub === space`, and
 * 2) a fresh RFC 9421 PoP signature (`tag="atproto-space-credential"`) bound to `payload.cnf.kid` and `operatorServiceRef`,
 *    checked against a bounded replay cache and optional `created` timestamp window.
 */
export async function verifyDmNotifyCredentialAndProof(
  input: {
    space: string;
    callerDid: string;
    credential: string;
    proof: DmCredentialProof;
  },
  deps: VerifyDmNotifyTargetDeps = {},
): Promise<void> {
  if (!parseSpaceUri(input.space)) {
    throw new Error("Invalid permissioned space URI.");
  }
  if (!parseDmSpaceUri(input.space)) {
    throw new OperatorAuthError("DM notification targets are available only for DM spaces.");
  }
  const subscription = authorizeDmSubscription(input.space, input.callerDid);
  if (!subscription.allowed) {
    if (subscription.status === 400) throw new Error(subscription.reason);
    throw new OperatorAuthError(subscription.reason);
  }

  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const expectedIssuer = requireSpaceAuthority(input.space);
  const parsed = parseCredentialJwt(input.credential, input.space, expectedIssuer, nowSec);

  const resolveKey = deps.resolveSigningKey ?? cachedResolveSigningKey;
  let signatureValid = false;
  try {
    const didKey = await resolveKey(expectedIssuer, false);
    signatureValid = await cryptoVerifySignatureWithKey(didKey, parsed.signingInput, parsed.sig, parsed.alg);
    if (!signatureValid) {
      const freshKey = await resolveKey(expectedIssuer, true);
      if (freshKey !== didKey) {
        signatureValid = await cryptoVerifySignatureWithKey(freshKey, parsed.signingInput, parsed.sig, parsed.alg);
      }
    }
  } catch (error) {
    if (isTransientOperatorInfrastructureError(error)) throw new OperatorInfrastructureError();
    throw new OperatorAuthError("Space credential signature could not be verified.");
  }
  if (!signatureValid) {
    throw new OperatorAuthError("Space credential signature is invalid.");
  }

  const expectedAuthorization = `Atproto-Space-Credential ${input.credential}`;
  if (input.proof.authorization !== expectedAuthorization) {
    throw new OperatorAuthError("Credential proof authorization does not match the presented credential.");
  }

  const operatorServiceRef = deps.operatorServiceRef ?? getConfig().operatorServiceRef;
  try {
    await verifyCredentialSig(
      {
        authorization: input.proof.authorization,
        "atproto-space-audience": operatorServiceRef,
        "signature-input": input.proof.signatureInput,
        signature: input.proof.signature,
      },
      parsed.cnfKid,
    );
  } catch {
    throw new OperatorAuthError("Invalid space credential possession proof.");
  }

  assertProofSignatureTimestamps(input.proof.signatureInput, nowSec);
  recordAndCheckProofReplay(parsed.jti, input.proof.signatureInput, input.proof.signature, parsed.exp * 1000, nowMs);
}

function parseCredentialJwt(
  jwt: string,
  expectedSpace: string,
  expectedIssuer: string,
  nowSec: number,
): {
  alg: string;
  cnfKid: `did:key:${string}`;
  jti: string;
  exp: number;
  signingInput: Uint8Array;
  sig: Uint8Array;
} {
  const refusal = () => new OperatorAuthError("Invalid or expired space credential.");
  if (typeof jwt !== "string" || jwt.length === 0 || jwt.length > 8192) throw refusal();
  const parts = jwt.split(".");
  if (parts.length !== 3) throw refusal();
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  if (!headerB64 || !payloadB64 || !sigB64 || !/^[A-Za-z0-9_-]+$/.test(sigB64)) throw refusal();

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw refusal();
  }
  if (!isPlainObject(header) || !isPlainObject(payload)) throw refusal();
  if (header.typ !== SPACE_CREDENTIAL_TYP || header.kid !== "#atproto" || typeof header.alg !== "string" || header.alg.length === 0) {
    throw refusal();
  }
  // Check issuer and subject before resolving any DID document.
  if (payload.iss !== expectedIssuer || payload.sub !== expectedSpace) {
    throw refusal();
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256) {
    throw refusal();
  }
  if (
    typeof payload.iat !== "number"
    || !Number.isFinite(payload.iat)
    || typeof payload.exp !== "number"
    || !Number.isFinite(payload.exp)
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > SPACE_CREDENTIAL_MAX_AGE_SECONDS
  ) {
    throw refusal();
  }
  if (payload.iat > nowSec + CREDENTIAL_IAT_CLOCK_SKEW_SECONDS) {
    throw refusal();
  }
  // Strict credential expiry cutoff (D12.2: zero clock-skew extension past exp).
  if (nowSec >= payload.exp) {
    throw refusal();
  }
  const cnf = payload.cnf;
  if (!isPlainObject(cnf) || typeof cnf.kid !== "string" || !cnf.kid.startsWith("did:key:")) {
    throw refusal();
  }

  const sig = Buffer.from(sigB64, "base64url");
  if (sig.toString("base64url") !== sigB64 || sig.byteLength !== 64) {
    throw refusal();
  }
  return {
    alg: header.alg,
    cnfKid: cnf.kid as `did:key:${string}`,
    jti: payload.jti,
    exp: payload.exp,
    signingInput: Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
    sig,
  };
}

function assertProofSignatureTimestamps(signatureInput: string, nowSec: number): void {
  // Inspect parameters on the tagged credential signature entry (verified by verifyCredentialSig).
  for (const member of signatureInput.split(",")) {
    if (!member.includes('tag="atproto-space-credential"')) continue;
    const closeParen = member.indexOf(")");
    const paramTail = closeParen >= 0 ? member.slice(closeParen + 1) : member;
    const createdMatch = /;created=([^;,\s]+)/.exec(paramTail);
    if (createdMatch) {
      const raw = createdMatch[1]!;
      if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new OperatorAuthError("Malformed created parameter in credential proof.");
      }
      const created = Number(raw);
      if (!Number.isSafeInteger(created) || Math.abs(nowSec - created) > PROOF_CREATED_WINDOW_SECONDS) {
        throw new OperatorAuthError("Credential proof timestamp is outside the accepted window.");
      }
    }
    const expiresMatch = /;expires=([^;,\s]+)/.exec(paramTail);
    if (expiresMatch) {
      const raw = expiresMatch[1]!;
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) <= nowSec) {
        throw new OperatorAuthError("Credential proof has expired.");
      }
    }
  }
}

function recordAndCheckProofReplay(
  jti: string,
  signatureInput: string,
  signature: string,
  expiresAtMs: number,
  nowMs: number,
): void {
  for (const [key, exp] of dmProofReplayCache) {
    if (exp <= nowMs) dmProofReplayCache.delete(key);
  }
  const replayKey = `${jti}\u0000${signatureInput}\u0000${signature}`;
  if (dmProofReplayCache.has(replayKey)) {
    throw new OperatorAuthError("Credential proof has already been used.");
  }
  dmProofReplayCache.set(replayKey, expiresAtMs);
  while (dmProofReplayCache.size > MAX_DM_PROOF_REPLAY_ENTRIES) {
    const oldest = dmProofReplayCache.keys().next();
    if (oldest.done) break;
    dmProofReplayCache.delete(oldest.value);
  }
}

export async function requireActiveWorkspaceAdmin(
  workspaceUri: string,
  actorDid: string,
  options: { allowDegradedLookup?: boolean } = {},
): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  const [admin, roster] = await Promise.all([
    getOwnerRecord(session, workspace.uri, COLLECTION.admin, subjectKey(actorDid)),
    getOwnerRecord(session, workspace.uri, COLLECTION.workspaceRoster, subjectKey(actorDid)),
  ]);
  if (admin?.subject !== actorDid || admin.active !== true || roster?.subject !== actorDid || roster.active !== true) throw new OperatorAuthError("Actor is not an active workspace admin.");
  const isAuthority = actorDid === workspace.authorityDid;
  const inbox = inboxUri(workspace.authorityDid, workspace.skey);
  const [hasWorkspaceAccess, hasInboxAccess] = isAuthority
    ? [true, true]
    : await Promise.all([
      hasCurrentMembership(session, workspace.uri, actorDid, options.allowDegradedLookup === true),
      hasCurrentMembership(session, inbox, actorDid, options.allowDegradedLookup === true),
    ]);
  if (!hasWorkspaceAccess || !hasInboxAccess) throw new OperatorAuthError("Actor lacks current workspace or inbox membership.");
  return { did: actorDid, session, workspace, canRecoverOperations: true };
}

/**
 * The operator itself, for its scheduled reconcile job: the workspace authority's grant, with the authority as the journal and
 * audit principal. A workspace created under a dedicated account (R8) gives its authority no admin or roster record, so this
 * actor is not checked as an admin. It proves the grant reads the workspace (its profile), and the job runs `reconcileWorkspace`
 * with it, and the recovery an admin's operation would do, nothing else.
 */
export async function requireWorkspaceOperator(workspaceUri: string): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  if (!(await getOwnerRecord(session, workspace.uri, COLLECTION.workspaceProfile, "self"))) throw new OperatorAuthError("The authority's grant does not read this workspace.");
  return { did: workspace.authorityDid, session, workspace, canRecoverOperations: true };
}

async function hasCurrentMembership(session: OAuthSession, space: string, did: string, allowDegradedLookup: boolean): Promise<boolean> {
  if (!allowDegradedLookup) {
    return (await listSpaceMembers(session, space)).some((member) => member.did === did && member.read && member.write);
  }
  const result = await listBoundedMembers(sessionClient(session), { space, maxMembers: MAX_READ_ONLY_MEMBER_SCAN });
  const member = result.members.find((entry) => entry.did === did);
  if (member) return member.read && member.write;
  if (result.truncated) throw new WorkspaceEnvelopeError(`Could not verify this actor within the ${MAX_READ_ONLY_MEMBER_SCAN}-member read-only authorization scan.`);
  return false;
}

export async function requireWorkspaceActorForOperation(workspaceUri: string, actorDid: string, operationId: string, request: unknown): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  return authorizeSubmittedOperation(await restoreAuthorityGrant(workspace.authorityDid), workspace, actorDid, operationId, request);
}

/**
 * Who `actorDid` is for a submission of `operationId`. The workspace's current state decides, with one exception: a request
 * that takes away the role that let its submitter start it (leaving, removing or demoting oneself) can stop part-way, after
 * which current state refuses the submitter. They may still send that same operation again when the journal holds it. The
 * journal then resumes it or returns its recorded result, and the submitter recovers nobody else's operations.
 */
export async function authorizeSubmittedOperation(
  session: OAuthSession,
  workspace: WorkspaceRef,
  actorDid: string,
  operationId: string,
  request: unknown,
): Promise<OperatorActor> {
  try {
    return await authorizeOperationActor(session, workspace, actorDid, request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError) || !isPlainObject(request)) throw error;
    const kind = operationKind(request.kind);
    const submitter: OperatorActor = { did: actorDid, session, workspace, canRecoverOperations: false };
    if (kind?.endsOwnRole?.({ ...request, kind: kind.kind }, actorDid) && hasJournaledOperation(submitter, operationId, request)) return submitter;
    throw error;
  }
}

/**
 * Who `actorDid` is for `request`, read from the workspace's current state with the authority's session. An active admin may
 * run any kind but one only the authority may start; an active member may run only a kind that concerns their own membership,
 * once the request is valid and the kind's own check agrees.
 */
export async function authorizeOperationActor(session: OAuthSession, workspace: WorkspaceRef, actorDid: string, request: unknown): Promise<OperatorActor> {
  const kind = isPlainObject(request) ? operationKind(request.kind) : undefined;
  if (kind) assertMayStartKind(kind, actorDid, workspace);
  const [admin, roster, workspaceMembers, inboxMembers] = await Promise.all([
    getOwnerRecord(session, workspace.uri, COLLECTION.admin, subjectKey(actorDid)),
    getOwnerRecord(session, workspace.uri, COLLECTION.workspaceRoster, subjectKey(actorDid)),
    listSpaceMembers(session, workspace.uri),
    listSpaceMembers(session, inboxUri(workspace.authorityDid, workspace.skey)),
  ]);
  const isAuthority = actorDid === workspace.authorityDid;
  const isAdmin = admin?.subject === actorDid && admin.active === true && roster?.subject === actorDid && roster.active === true &&
    (isAuthority || workspaceMembers.some((member) => member.did === actorDid && member.read && member.write)) &&
    (isAuthority || inboxMembers.some((member) => member.did === actorDid && member.read && member.write));
  if (isAdmin) return { did: actorDid, session, workspace, canRecoverOperations: true };
  const isMember = roster?.subject === actorDid && roster.active === true && workspaceMembers.some((member) => member.did === actorDid && member.read && member.write) &&
    inboxMembers.some((member) => member.did === actorDid && member.write);
  if (!isMember || kind?.actor !== "member") throw new OperatorAuthError("Active workspace admin permission is required.");
  const actor: OperatorActor = { did: actorDid, session, workspace, canRecoverOperations: false };
  await kind.authorizeMember?.(actor, validateOperatorRequest(request, actor, "execute").request);
  return actor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
