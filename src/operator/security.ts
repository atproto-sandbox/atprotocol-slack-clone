import { verifyJwt } from "@atproto/xrpc-server";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { getIdResolver } from "@/atproto/identity";
import { sessionClient } from "@/atproto/client";
import { listBoundedMembers } from "@/atproto/record-pages";
import { listSpaceMembers } from "@/atproto/space-ops";
import { getConfig } from "@/lib/config";
import { inboxUri, isDid, subjectKey } from "@/protocol/keys";
import { WorkspaceEnvelopeError } from "@/protocol/workspace-summary";
import { restoreAuthorityGrant } from "./authority-grant";
import { OperatorAuthError, OperatorInfrastructureError, isTransientOperatorInfrastructureError } from "./errors";
import { hasJournaledOperation } from "./journal";
import { operationKind } from "./kinds";
import { assertMayStartKind, validateOperatorRequest } from "./operations";
import { COLLECTION } from "@/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor, type WorkspaceRef } from "./actor";
import { getOwnerRecord } from "./workspace-state";

const MAX_READ_ONLY_MEMBER_SCAN = 1_000;

function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
}

/**
 * The `iss` a bearer service token claims, read without verifying it, or `null` when there is no well-formed token. It proves
 * nothing; it lets a caller refuse a token that names the wrong issuer before any DID is resolved for it.
 */
export function unverifiedBearerIssuer(request: Request): string | null {
  const payload = bearerToken(request)?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isPlainObject(claims) && typeof claims.iss === "string" ? claims.iss : null;
  } catch {
    return null;
  }
}

export async function authenticateOperatorRequest(request: Request, method: string): Promise<string> {
  const token = bearerToken(request);
  if (!token) throw new OperatorAuthError("Bearer service authorization is required.");
  const serviceRef = getConfig().operatorServiceRef;
  const payload = await verifyJwt(
    token,
    serviceRef,
    method,
    async (issuer) => getIdResolver().did.resolveAtprotoKey(issuer.split("#", 1)[0]),
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
  if (typeof issuedAt !== "number" || issuedAt > now + 5 || payload.exp <= issuedAt || payload.exp - issuedAt > 75 || now - issuedAt > 75) {
    throw new OperatorAuthError("Service authorization is outside the accepted lifetime.");
  }
  return payload.iss;
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
