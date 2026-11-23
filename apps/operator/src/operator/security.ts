import { createHmac, hkdfSync } from "node:crypto";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { cryptoVerifySignatureWithKey, verifyJwt } from "@atproto/xrpc-server";
import { getConfig } from "@flock/deployment/config";
import { verifyCredentialSig } from "@flock/protocol/atproto/space-credential-core";
import {
  groupMetaUri,
  isDid,
  parseDmSpaceUri,
  parsePersonalInvitesUri,
  parseSpaceUri,
  personalInvitesUri,
  requireSpaceAuthority,
} from "@flock/protocol/keys";
import { OPENSOCIAL_COLLECTION, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { effectiveMemberPermissions, isEffectiveAdminMember } from "@flock/protocol/scopes";
import { getIdResolver, resolveSigningKey as cachedResolveSigningKey } from "../atproto/identity";
import { getOperatorConfig } from "../config";
import { getRawDb } from "../lib/db";
import { authorizeDmSubscription } from "../lib/dm-subscription";
import { parseWorkspaceRef, type OperatorActor, type WorkspaceRef } from "./actor";
import { restoreAuthorityGrant } from "./authority-grant";
import {
  isTransientOperatorInfrastructureError,
  OperatorAuthError,
  OperatorInfrastructureError,
} from "./errors";
import { hasJournaledOperation } from "./journal";
import { operationKind } from "./kinds/index";
import type { OperatorRequest } from "./kinds/kind";
import { assertActorAuthorizedForOperation, assertMayStartKind, validateOperatorRequest } from "./operations";
import { getOwnerRecord, readGroupGovernanceState } from "./workspace-state";

const SPACE_CREDENTIAL_TYP = "atproto-space-credential+jwt";
const SPACE_CREDENTIAL_MAX_AGE_SECONDS = 3_600;
const INVITE_SPACE_CREDENTIAL_MAX_AGE_SECONDS = 600;
const CREDENTIAL_IAT_CLOCK_SKEW_SECONDS = 5;
const PROOF_CREATED_WINDOW_SECONDS = 60;
const DM_REPLAY_KEY_INFO = "flock-dm-pop-replay-v1";
const CREDENTIAL_SIGNATURE_TAG = "atproto-space-credential";

function deriveDmReplayKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", getOperatorConfig().encryptionKey, "", DM_REPLAY_KEY_INFO, 32));
}

export function resetDmProofReplayCacheForTests(): void {
  try {
    getRawDb().prepare("DELETE FROM oauth_request_lock WHERE name LIKE 'pop:%'").run();
  } catch {
    // Database may not be initialized yet.
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
}

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

const SERVICE_TOKEN_LIFETIME_SECONDS: Readonly<Record<string, number>> = { [OPERATOR_METHOD.getChanges]: 15 * 60 };
const DEFAULT_SERVICE_TOKEN_LIFETIME_SECONDS = 75;

export function serviceTokenLifetimeSeconds(method: string): number {
  return SERVICE_TOKEN_LIFETIME_SECONDS[method] ?? DEFAULT_SERVICE_TOKEN_LIFETIME_SECONDS;
}

export async function authenticateOperatorRequest(
  authorization: string | undefined,
  method: string,
  resolveSigningKey: (did: string) => Promise<string> = (did) => getIdResolver().did.resolveAtprotoKey(did),
): Promise<string> {
  const token = bearerToken(authorization);
  if (!token) throw new OperatorAuthError("Bearer service authorization is required.");
  const serviceRef = getConfig().operatorServiceRef;
  const payload = await verifyJwt(token, serviceRef, method, async (issuer) =>
    resolveSigningKey(issuer.split("#", 1)[0]!),
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

async function verifyCredentialJwtAndProof(
  input: {
    space: string;
    expectedIssuer: string;
    credential: string;
    proof: DmCredentialProof;
    maxAgeSeconds: number;
  },
  deps: VerifyDmNotifyTargetDeps,
): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const parsed = parseCredentialJwt(
    input.credential,
    input.space,
    input.expectedIssuer,
    nowSec,
    input.maxAgeSeconds,
  );

  const resolveKey = deps.resolveSigningKey ?? cachedResolveSigningKey;
  let signatureValid = false;
  try {
    const didKey = await resolveKey(input.expectedIssuer, false);
    signatureValid = await cryptoVerifySignatureWithKey(didKey, parsed.signingInput, parsed.sig, parsed.alg);
    if (!signatureValid) {
      const freshKey = await resolveKey(input.expectedIssuer, true);
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

  const created = extractAndAssertProofCreated(input.proof.signatureInput, nowSec, parsed.exp);
  consumeProofReplayLock(parsed.iss, parsed.jti, created, parsed.exp, nowMs);
}

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

  await verifyCredentialJwtAndProof(
    {
      space: input.space,
      expectedIssuer: requireSpaceAuthority(input.space),
      credential: input.credential,
      proof: input.proof,
      maxAgeSeconds: SPACE_CREDENTIAL_MAX_AGE_SECONDS,
    },
    deps,
  );
}

/**
 * Verifies `OPERATOR_METHOD.getSpaceNotifyTarget` for `at://<callerDid>/space/group.opensocial.invites/self`:
 * - Rejects (`400 InvalidRequest` via plain `Error`) any space other than `personalInvitesUri(callerDid)`.
 * - Verifies `SPACE_CREDENTIAL_TYP` (`iss === callerDid`, `sub === space`, `nowSec < exp`, `exp - iat <= 600`) against `callerDid` `#atproto`.
 * - Verifies RFC 9421 PoP (`"atproto-space-audience": operatorServiceRef`) + single-use replay lock.
 */
export async function verifySpaceNotifyCredentialAndProof(
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
  const parsedInvites = parsePersonalInvitesUri(input.space);
  if (!parsedInvites || parsedInvites.userDid !== input.callerDid || input.space !== personalInvitesUri(input.callerDid)) {
    throw new Error("getSpaceNotifyTarget only accepts the caller's own group.opensocial.invites/self space.");
  }

  await verifyCredentialJwtAndProof(
    {
      space: input.space,
      expectedIssuer: input.callerDid,
      credential: input.credential,
      proof: input.proof,
      maxAgeSeconds: INVITE_SPACE_CREDENTIAL_MAX_AGE_SECONDS,
    },
    deps,
  );
}

function parseCredentialJwt(
  jwt: string,
  expectedSpace: string,
  expectedIssuer: string,
  nowSec: number,
  maxAgeSeconds = SPACE_CREDENTIAL_MAX_AGE_SECONDS,
): {
  alg: string;
  iss: string;
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
  if (
    header.typ !== SPACE_CREDENTIAL_TYP ||
    header.kid !== "#atproto" ||
    typeof header.alg !== "string" ||
    header.alg.length === 0
  ) {
    throw refusal();
  }
  if (payload.iss !== expectedIssuer || payload.sub !== expectedSpace) {
    throw refusal();
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256) {
    throw refusal();
  }
  if (
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > maxAgeSeconds
  ) {
    throw refusal();
  }
  if (payload.iat > nowSec + CREDENTIAL_IAT_CLOCK_SKEW_SECONDS) {
    throw refusal();
  }
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
    iss: payload.iss,
    cnfKid: cnf.kid as `did:key:${string}`,
    jti: payload.jti,
    exp: payload.exp,
    signingInput: Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
    sig,
  };
}

type SfBareItem =
  | { kind: "integer"; value: number }
  | { kind: "decimal"; value: number }
  | { kind: "string"; value: string }
  | { kind: "token"; value: string }
  | { kind: "bytes"; value: string }
  | { kind: "boolean"; value: boolean };

type SfParameters = Map<string, SfBareItem>;
type SfItem = { kind: "item"; bare: SfBareItem; parameters: SfParameters };
type SfInnerList = { kind: "innerList"; items: SfItem[]; parameters: SfParameters };

function parseStructuredDictionary(input: string): Map<string, SfItem | SfInnerList> {
  let pos = 0;
  const eof = () => pos >= input.length;
  const look = () => input[pos];
  const next = () => input[pos++]!;
  const skipWs = () => {
    while (look() === " ") pos += 1;
  };
  const skipOws = () => {
    while (look() === " " || look() === "\t") pos += 1;
  };
  const parseKey = (): string => {
    const first = look();
    if (!first || !/^[a-z*]$/.test(first)) throw new Error("Invalid dictionary/parameter key.");
    let key = "";
    while (!eof()) {
      const ch = look();
      if (!ch || !/^[a-z0-9_\-.*]$/.test(ch)) break;
      key += next();
    }
    return key;
  };
  const parseBareItem = (): SfBareItem => {
    const ch = look();
    if (ch === undefined) throw new Error("Unexpected EOF.");
    if (/^[-0-9]$/.test(ch)) {
      let sign = 1;
      if (look() === "-") {
        sign = -1;
        pos += 1;
      }
      if (!/^[0-9]$/.test(look() ?? "")) throw new Error("Expected digit.");
      let digits = "";
      let isDecimal = false;
      while (!eof()) {
        const c = next();
        if (/^[0-9]$/.test(c)) {
          digits += c;
        } else if (!isDecimal && c === ".") {
          if (digits.length > 12) throw new Error("Decimal too long.");
          digits += ".";
          isDecimal = true;
        } else {
          pos -= 1;
          break;
        }
        if (!isDecimal && digits.length > 15) throw new Error("Integer too long.");
        if (isDecimal && digits.length > 16) throw new Error("Decimal too long.");
      }
      if (!isDecimal) {
        return { kind: "integer", value: Number.parseInt(digits, 10) * sign };
      }
      if (digits.endsWith(".") || (digits.split(".")[1]?.length ?? 0) > 3) {
        throw new Error("Invalid decimal.");
      }
      return { kind: "decimal", value: Number.parseFloat(digits) * sign };
    }
    if (ch === '"') {
      pos += 1;
      let out = "";
      while (!eof()) {
        const c = next();
        if (c === "\\") {
          if (eof()) throw new Error("Unterminated escape.");
          const esc = next();
          if (esc !== "\\" && esc !== '"') throw new Error("Invalid escape.");
          out += esc;
        } else if (c === '"') {
          return { kind: "string", value: out };
        } else {
          const code = c.charCodeAt(0);
          if (code < 0x20 || code > 0x7e) throw new Error("Non-ASCII string character.");
          out += c;
        }
      }
      throw new Error("Unterminated string.");
    }
    if (/^[A-Za-z*]$/.test(ch)) {
      let tok = "";
      while (!eof()) {
        const c = look();
        if (!c || !/^[:/!#$%&'*+\-.^_`|~A-Za-z0-9]$/.test(c)) break;
        tok += next();
      }
      return { kind: "token", value: tok };
    }
    if (ch === ":") {
      pos += 1;
      const end = input.indexOf(":", pos);
      if (end === -1) throw new Error("Unterminated byte sequence.");
      const b64 = input.slice(pos, end);
      pos = end + 1;
      if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new Error("Invalid byte sequence.");
      return { kind: "bytes", value: b64 };
    }
    if (ch === "?") {
      pos += 1;
      const b = next();
      if (b === "1") return { kind: "boolean", value: true };
      if (b === "0") return { kind: "boolean", value: false };
      throw new Error("Invalid boolean.");
    }
    throw new Error("Unexpected bare item.");
  };
  const parseParameters = (): SfParameters => {
    const params: SfParameters = new Map();
    while (!eof() && look() === ";") {
      pos += 1;
      skipWs();
      const k = parseKey();
      let val: SfBareItem = { kind: "boolean", value: true };
      if (look() === "=") {
        pos += 1;
        val = parseBareItem();
      }
      params.set(k, val);
    }
    return params;
  };
  const parseItem = (): SfItem => ({
    kind: "item",
    bare: parseBareItem(),
    parameters: parseParameters(),
  });
  const parseInnerList = (): SfInnerList => {
    if (next() !== "(") throw new Error("Expected '('.");
    const items: SfItem[] = [];
    while (!eof()) {
      skipWs();
      if (look() === ")") {
        pos += 1;
        return { kind: "innerList", items, parameters: parseParameters() };
      }
      items.push(parseItem());
      const after = look();
      if (after !== " " && after !== ")") throw new Error("Expected space or ')' in inner list.");
    }
    throw new Error("Unterminated inner list.");
  };

  skipWs();
  const dict = new Map<string, SfItem | SfInnerList>();
  while (!eof()) {
    const key = parseKey();
    let member: SfItem | SfInnerList;
    if (look() === "=") {
      pos += 1;
      member = look() === "(" ? parseInnerList() : parseItem();
    } else {
      member = { kind: "item", bare: { kind: "boolean", value: true }, parameters: parseParameters() };
    }
    dict.set(key, member);
    skipOws();
    if (eof()) return dict;
    if (next() !== ",") throw new Error("Expected ','.");
    skipOws();
    if (eof()) throw new Error("Trailing comma in dictionary.");
  }
  return dict;
}

function extractAndAssertProofCreated(signatureInput: string, nowSec: number, credentialExp: number): number {
  let dict: Map<string, SfItem | SfInnerList>;
  try {
    dict = parseStructuredDictionary(signatureInput);
  } catch {
    throw new OperatorAuthError("Malformed Signature-Input in credential proof.");
  }
  const tagged: SfInnerList[] = [];
  for (const member of dict.values()) {
    const tagParam = member.parameters.get("tag");
    if (member.kind === "innerList" && tagParam?.kind === "string" && tagParam.value === CREDENTIAL_SIGNATURE_TAG) {
      tagged.push(member);
    }
  }
  if (tagged.length !== 1) {
    throw new OperatorAuthError("Invalid space credential possession proof.");
  }
  const parameters = tagged[0]!.parameters;
  const createdParam = parameters.get("created");
  if (!createdParam) {
    throw new OperatorAuthError("Credential proof requires a signed created timestamp.");
  }
  if (createdParam.kind !== "integer" || !Number.isSafeInteger(createdParam.value) || createdParam.value <= 0) {
    throw new OperatorAuthError("Malformed created parameter in credential proof.");
  }
  const created = createdParam.value;
  if (Math.abs(nowSec - created) > PROOF_CREATED_WINDOW_SECONDS || created > credentialExp) {
    throw new OperatorAuthError("Credential proof timestamp is outside the accepted window.");
  }
  const expiresParam = parameters.get("expires");
  if (expiresParam !== undefined) {
    if (expiresParam.kind !== "integer" || !Number.isSafeInteger(expiresParam.value) || expiresParam.value <= nowSec) {
      throw new OperatorAuthError("Credential proof has expired.");
    }
  }
  return created;
}

function consumeProofReplayLock(
  iss: string,
  jti: string,
  created: number,
  credentialExp: number,
  nowMs: number,
): void {
  const replayName = `pop:${createHmac("sha256", deriveDmReplayKey()).update(`${iss}\0${jti}`, "utf8").digest("hex")}`;
  const expiresAt = Math.max((created + 65) * 1000, credentialExp * 1000 + 5_000);
  const db = getRawDb();
  const consumed = db
    .transaction(() => {
      db.prepare("DELETE FROM oauth_request_lock WHERE name LIKE 'pop:%' AND expires_at <= ?").run(nowMs);
      const res = db
        .prepare("INSERT INTO oauth_request_lock (name, token, expires_at) VALUES (?, '1', ?) ON CONFLICT(name) DO NOTHING")
        .run(replayName, expiresAt);
      return res.changes === 1;
    })
    .immediate();
  if (!consumed) {
    throw new OperatorAuthError("Credential proof has already been used.");
  }
}

export async function requireActiveWorkspaceAdmin(
  workspaceUri: string,
  actorDid: string,
  options: { allowDegradedLookup?: boolean } = {},
): Promise<OperatorActor> {
  void options;
  const workspace = parseWorkspaceRef(workspaceUri);
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  const state = await readGroupGovernanceState(session, workspace.authorityDid);
  if (
    actorDid === workspace.authorityDid ||
    state.knownAppSubjects.has(actorDid) ||
    !isEffectiveAdminMember(actorDid, state, workspace.authorityDid)
  ) {
    throw new OperatorAuthError("Actor is not an active workspace admin.");
  }
  return { did: actorDid, session, workspace, canRecoverOperations: true };
}

export async function requireWorkspaceOrLifecycleAdmin(
  workspaceUri: string,
  actorDid: string,
): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  const state = await readGroupGovernanceState(session, workspace.authorityDid);
  const isLifecycleAdmin =
    actorDid !== workspace.authorityDid &&
    !state.knownAppSubjects.has(actorDid) &&
    state.memberships.has(actorDid) &&
    (isEffectiveAdminMember(actorDid, state, workspace.authorityDid) ||
      effectiveMemberPermissions(
        state,
        workspace.authorityDid as Parameters<typeof effectiveMemberPermissions>[1],
        actorDid as Parameters<typeof effectiveMemberPermissions>[2],
      ).allowsAccount({ attr: "status", action: "manage" }));
  if (!isLifecycleAdmin) {
    throw new OperatorAuthError("Actor is not an active workspace or lifecycle admin.");
  }
  return { did: actorDid, session, workspace, canRecoverOperations: true };
}

export async function requireWorkspaceOperator(workspaceUri: string): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  const session = await restoreAuthorityGrant(workspace.authorityDid);
  const profile = await getOwnerRecord(
    session,
    groupMetaUri(workspace.authorityDid),
    OPENSOCIAL_COLLECTION.profile,
    "self",
  );
  if (!profile) throw new OperatorAuthError("The authority's grant does not read this group.");
  return { did: workspace.authorityDid, session, workspace, canRecoverOperations: true };
}

export async function requireWorkspaceActorForOperation(
  workspaceUri: string,
  actorDid: string,
  operationId: string,
  request: unknown,
): Promise<OperatorActor> {
  const workspace = parseWorkspaceRef(workspaceUri);
  return authorizeSubmittedOperation(await restoreAuthorityGrant(workspace.authorityDid), workspace, actorDid, operationId, request);
}

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
    if (kind?.endsOwnRole?.({ ...request, kind: kind.kind }, actorDid) && hasJournaledOperation(submitter, operationId, request)) {
      return submitter;
    }
    throw error;
  }
}

export async function authorizeOperationActor(
  session: OAuthSession,
  workspace: WorkspaceRef,
  actorDid: string,
  request: unknown,
): Promise<OperatorActor> {
  const kind = isPlainObject(request) ? operationKind(request.kind) : undefined;
  if (kind) assertMayStartKind(kind, actorDid, workspace);
  const groupDid = workspace.authorityDid;

  if (kind?.actor === "authority") {
    return { did: actorDid, session, workspace, canRecoverOperations: true };
  }

  const probeActor: OperatorActor = { did: actorDid, session, workspace, canRecoverOperations: false };
  if (!kind) {
    // Malformed kind: check admin status first so outsiders get 403 before 400 validation errors!
    const state = await readGroupGovernanceState(session, groupDid);
    if (actorDid === groupDid || state.knownAppSubjects.has(actorDid) || !isEffectiveAdminMember(actorDid, state, groupDid)) {
      throw new OperatorAuthError("Active workspace admin permission is required.");
    }
    return { did: actorDid, session, workspace, canRecoverOperations: true };
  }

  let validated: OperatorRequest;
  try {
    validated = validateOperatorRequest(request, probeActor, "execute").request;
  } catch (valErr) {
    // Still enforce auth first before exposing field validation errors to unauthorized callers.
    const state = await readGroupGovernanceState(session, groupDid);
    if (actorDid === groupDid || state.knownAppSubjects.has(actorDid) || !state.memberships.has(actorDid)) {
      throw new OperatorAuthError("Active workspace admin permission is required.");
    }
    if (kind.actor === "admin" && !isEffectiveAdminMember(actorDid, state, groupDid)) {
      throw new OperatorAuthError("Active workspace admin permission is required.");
    }
    throw valErr;
  }

  const state = await assertActorAuthorizedForOperation(session, workspace, actorDid, kind, validated);
  const canRecover =
    kind.actor === "admin" &&
    actorDid !== groupDid &&
    !state.knownAppSubjects.has(actorDid);
  return { did: actorDid, session, workspace, canRecoverOperations: canRecover };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
