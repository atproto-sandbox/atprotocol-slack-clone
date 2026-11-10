import { verifyJwt } from "@atproto/xrpc-server";
import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import { getIdResolver } from "@/atproto/identity";
import { sessionClient } from "@/atproto/client";
import { listBoundedMembers } from "@/atproto/record-pages";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { listSpaceMembers } from "@/atproto/space-ops";
import { getConfig } from "@/lib/config";
import { channelUri, inboxUri, isDid, isSkey, parseWorkspaceUri, subjectKey } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { WorkspaceEnvelopeError } from "@/workspaces/read-model";
import { restoreAuthorityGrant } from "./authority-grant";
import { OperatorInfrastructureError, isTransientOperatorInfrastructureError } from "./errors";

export type WorkspaceRef = { uri: string; authorityDid: string; skey: string };
export type OperatorActor = { did: string; session: OAuthSession; workspace: WorkspaceRef; canRecoverOperations: boolean };

const MAX_READ_ONLY_MEMBER_SCAN = 1_000;

export function parseWorkspaceRef(uri: string): WorkspaceRef {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace) throw new Error("Invalid workspace space URI.");
  return { uri, ...workspace };
}

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
  const client = sessionClient(session);
  const [admin, roster] = await Promise.all([
    readOwnerRecord(client, workspace.uri, workspace.authorityDid, "org.slack.admin", subjectKey(actorDid)),
    readOwnerRecord(client, workspace.uri, workspace.authorityDid, "org.slack.workspace.roster", subjectKey(actorDid)),
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

export async function requireWorkspaceActorForOperation(workspaceUri: string, actorDid: string, request: unknown): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  const client = sessionClient(session);
  const [admin, roster, workspaceMembers, inboxMembers] = await Promise.all([
    readOwnerRecord(client, workspace.uri, workspace.authorityDid, "org.slack.admin", subjectKey(actorDid)),
    readOwnerRecord(client, workspace.uri, workspace.authorityDid, "org.slack.workspace.roster", subjectKey(actorDid)),
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
  if (!isMember || !isPlainObject(request) || (request.kind !== "leaveWorkspace" && request.kind !== "leaveChannel")) {
    throw new OperatorAuthError("Active workspace admin permission is required.");
  }
  if (request.kind === "leaveChannel") {
    if (!isSkey(request.skey)) throw new OperatorAuthError("Invalid channel key.");
    const directory = await readOwnerRecord(client, workspace.uri, workspace.authorityDid, "org.slack.directory", request.skey);
    if (directory?.visibility !== "private") throw new OperatorAuthError("Only an active private channel can be left.");
    const channelMembers = await listSpaceMembers(session, channelUri(workspace.authorityDid, request.skey));
    if (!channelMembers.some((member) => member.did === actorDid && member.read && member.write)) throw new OperatorAuthError("Actor is not a member of this channel.");
  }
  return { did: actorDid, session, workspace, canRecoverOperations: false };
}

export class OperatorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorAuthError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOwnerRecord(
  client: ReturnType<typeof sessionClient>,
  space: string,
  repo: string,
  collection: string,
  rkey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await client.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", { space, repo, collection, rkey });
    return validateSpaceRecord(collection, result.value, {
      authorityDid: repo, spaceUri: space, repoDid: repo, rkey,
    }).valid ? result.value : null;
  } catch (error) {
    if (isMissingXrpcResource(error)) return null;
    throw error;
  }
}
