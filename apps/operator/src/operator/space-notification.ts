import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { getConfig, isLoopback } from "@flock/deployment/config";
import { isDid, parseDmSpaceUri, parsePersonalInvitesUri, parseSpaceUri } from "@flock/protocol/keys";
import { getOperatorConfig } from "../config";
import { getRawDb } from "../lib/db";
import { WebhookAuthError } from "./errors";

/**
 * The webhook endpoint URL advertised to an ATProto PDS or Group Host (`authorizeSpaceSync` `notify.endpoint`,
 * `getDmNotifyTarget`, and `getSpaceNotifyTarget`).
 * Outside loopback development this is `operatorUrl.origin` verbatim (`https://...`). On loopback development, OAuth
 * redirect URIs require an IP literal (`127.0.0.1` or `[::1]`, per RFC 8252 and `serviceUrl`), whereas `@atproto/pds`
 * routes outbound webhook calls through `safeFetchWrap({ allowIpHost: false })`, which rejects IP literals and requires
 * `localhost` (matching `did:web:localhost%3A<port>`).
 */
export function operatorNotifyEndpoint(operatorUrl: URL = getConfig().operatorUrl): string {
  if (!isLoopback(operatorUrl.hostname)) return operatorUrl.origin;
  const endpoint = new URL(operatorUrl.origin);
  endpoint.hostname = "localhost";
  return endpoint.origin;
}

const DM_NOTIFY_KEY_INFO = "flock-dm-notify-v1";
const DM_TOKEN_VERSION = "dm1";
const INVITE_NOTIFY_KEY_INFO = "flock-invite-notify-v1";
const INVITE_TOKEN_VERSION = "inv1";
/** 30-minute HMAC epoch window; `authenticateSpaceWebhook` accepts only `[currentEpoch, currentEpoch - 1]`. */
export const DM_TOKEN_EPOCH_MS = 30 * 60 * 1000;
export const INVITE_TOKEN_EPOCH_MS = DM_TOKEN_EPOCH_MS;
const MAX_TOKEN_LENGTH = 512;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const CANONICAL_HEX_EPOCH = /^(0|[1-9a-f][0-9a-f]{0,12})$/;

export type VerifiedWebhookTarget =
  | { kind: "operator" }
  | { kind: "dm"; callerDid: string }
  | { kind: "invites"; callerDid: string };

function deriveHkdfNotifyKey(encryptionKey: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey, "", info, 32));
}

function statelessNotifyMac(key: Buffer, version: string, epochHex: string, space: string, callerDid: string): Buffer {
  return createHmac("sha256", key)
    .update(`${version}\0${epochHex}\0${space}\0${callerDid}`, "utf8")
    .digest();
}

function deriveStatelessNotifyToken(params: {
  version: string;
  keyInfo: string;
  space: string;
  callerDid: string;
  encryptionKey: Buffer;
  nowMs: number;
}): string {
  if (!isDid(params.callerDid)) throw new Error("Invalid caller DID.");
  const epoch = Math.floor(params.nowMs / DM_TOKEN_EPOCH_MS);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("Invalid notification token timestamp.");
  }
  const epochHex = epoch.toString(16);
  const subKey = deriveHkdfNotifyKey(params.encryptionKey, params.keyInfo);
  const callerPart = Buffer.from(params.callerDid, "utf8").toString("base64url");
  const macPart = statelessNotifyMac(subKey, params.version, epochHex, params.space, params.callerDid).toString("base64url");
  const token = `${params.version}.${epochHex}.${callerPart}.${macPart}`;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error("Derived notification token exceeds protocol length limit.");
  }
  return token;
}

/**
 * Derives an epoch-bounded, stateless, deterministic per-caller DM webhook token:
 * `dm1.<epochHex>.<base64url(callerDid)>.<base64url(hmacSha256(dmKey, "dm1\0" + epochHex + "\0" + space + "\0" + callerDid))>`.
 */
export function deriveDmNotifyToken(
  space: string,
  callerDid: string,
  encryptionKey: Buffer = getOperatorConfig().encryptionKey,
  nowMs: number = Date.now(),
): string {
  if (!parseDmSpaceUri(space)) throw new Error("DM notification tokens can only be derived for DM spaces.");
  return deriveStatelessNotifyToken({
    version: DM_TOKEN_VERSION,
    keyInfo: DM_NOTIFY_KEY_INFO,
    space,
    callerDid,
    encryptionKey,
    nowMs,
  });
}

/**
 * Derives an epoch-bounded, stateless, deterministic per-caller personal-invites webhook token:
 * `inv1.<epochHex>.<base64url(callerDid)>.<base64url(hmacSha256(invKey, "inv1\0" + epochHex + "\0" + space + "\0" + callerDid))>`.
 * Valid exclusively for `at://<callerDid>/space/group.opensocial.invites/self` across `[epoch, epoch - 1]`.
 */
export function deriveSpaceNotifyToken(
  space: string,
  callerDid: string,
  encryptionKey: Buffer = getOperatorConfig().encryptionKey,
  nowMs: number = Date.now(),
): string {
  const parsed = parsePersonalInvitesUri(space);
  if (!parsed || parsed.userDid !== callerDid) {
    throw new Error("Personal space notification tokens can only be derived for the caller's own group.opensocial.invites/self space.");
  }
  return deriveStatelessNotifyToken({
    version: INVITE_TOKEN_VERSION,
    keyInfo: INVITE_NOTIFY_KEY_INFO,
    space,
    callerDid,
    encryptionKey,
    nowMs,
  });
}

function verifyStatelessNotifyToken(params: {
  token: string;
  expectedVersion: string;
  keyInfo: string;
  space: string;
  encryptionKey: Buffer;
  nowMs: number;
  expiredMessage: string;
}): string {
  const parts = params.token.split(".");
  if (parts.length !== 4 || parts[0] !== params.expectedVersion) {
    throw new WebhookAuthError();
  }
  const [, epochHex, callerPart, macPart] = parts;
  if (
    !epochHex
    || !callerPart
    || !macPart
    || !CANONICAL_HEX_EPOCH.test(epochHex)
    || !BASE64URL_PART.test(callerPart)
    || !BASE64URL_PART.test(macPart)
  ) {
    throw new WebhookAuthError();
  }
  const epoch = Number.parseInt(epochHex, 16);
  const currentEpoch = Math.floor(params.nowMs / DM_TOKEN_EPOCH_MS);
  if (!Number.isSafeInteger(epoch)) {
    throw new WebhookAuthError();
  }
  const callerDid = Buffer.from(callerPart, "base64url").toString("utf8");
  if (!isDid(callerDid) || Buffer.from(callerDid, "utf8").toString("base64url") !== callerPart) {
    throw new WebhookAuthError();
  }
  const providedMac = Buffer.from(macPart, "base64url");
  if (providedMac.toString("base64url") !== macPart) {
    throw new WebhookAuthError();
  }
  const subKey = deriveHkdfNotifyKey(params.encryptionKey, params.keyInfo);
  const expectedMac = statelessNotifyMac(subKey, params.expectedVersion, epochHex, params.space, callerDid);
  if (providedMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(providedMac, expectedMac)) {
    throw new WebhookAuthError();
  }
  if (epoch !== currentEpoch && epoch !== currentEpoch - 1) {
    throw new WebhookAuthError(params.expiredMessage);
  }
  return callerDid;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

/**
 * Authenticates `(space, token)` on `confirmRegistration` and `notifySpaceUpdate`:
 * - For DM spaces (`dm.inbox` / `dm.conversation`), verifies the epoch-bounded per-caller `dm1` HMAC in constant time.
 * - For personal invites spaces (`group.opensocial.invites/self`), verifies the epoch-bounded per-caller `inv1` HMAC
 *   and asserts `parsed.userDid === callerDid`.
 * - For operator-managed group/workspace spaces, matches `notification_registration.token` for `operatorServiceRef` in constant time.
 */
export function authenticateSpaceWebhook(
  space: string,
  token: string,
  encryptionKey?: Buffer,
  nowMs: number = Date.now(),
): VerifiedWebhookTarget {
  if (typeof space !== "string" || !parseSpaceUri(space)) {
    throw new WebhookAuthError();
  }
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new WebhookAuthError();
  }

  if (parseDmSpaceUri(space)) {
    const callerDid = verifyStatelessNotifyToken({
      token,
      expectedVersion: DM_TOKEN_VERSION,
      keyInfo: DM_NOTIFY_KEY_INFO,
      space,
      encryptionKey: encryptionKey ?? getOperatorConfig().encryptionKey,
      nowMs,
      expiredMessage: "DM notification token expired.",
    });
    return { kind: "dm", callerDid };
  }

  const personalInvites = parsePersonalInvitesUri(space);
  if (personalInvites) {
    const callerDid = verifyStatelessNotifyToken({
      token,
      expectedVersion: INVITE_TOKEN_VERSION,
      keyInfo: INVITE_NOTIFY_KEY_INFO,
      space,
      encryptionKey: encryptionKey ?? getOperatorConfig().encryptionKey,
      nowMs,
      expiredMessage: "Personal invites notification token expired.",
    });
    if (callerDid !== personalInvites.userDid) {
      throw new WebhookAuthError();
    }
    return { kind: "invites", callerDid };
  }

  // Operator-managed spaces never accept `dm1.*` or `inv1.*` tokens; they match stored `notification_registration.token` only.
  if (token.startsWith(`${DM_TOKEN_VERSION}.`) || token.startsWith(`${INVITE_TOKEN_VERSION}.`)) {
    throw new WebhookAuthError();
  }
  const row = getRawDb()
    .prepare("SELECT token FROM notification_registration WHERE service_ref = ? AND space_uri = ?")
    .get(getConfig().operatorServiceRef, space) as { token: string } | undefined;
  if (!row || row.token.length === 0 || !constantTimeStringEqual(token, row.token)) {
    throw new WebhookAuthError();
  }
  return { kind: "operator" };
}

export const authenticateSpaceNotification = authenticateSpaceWebhook;
