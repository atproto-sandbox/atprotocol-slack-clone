import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { getConfig, isLoopback } from "@flock/deployment/config";
import { isDid, parseDmSpaceUri, parseSpaceUri } from "@flock/protocol/keys";
import { getOperatorConfig } from "../config";
import { getRawDb } from "../lib/db";
import { WebhookAuthError } from "./errors";

/**
 * The webhook endpoint URL advertised to an ATProto PDS (`authorizeSpaceSync` `notify.endpoint` and `getDmNotifyTarget`).
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
/** 30-minute HMAC epoch window; `authenticateSpaceWebhook` accepts only `[currentEpoch, currentEpoch - 1]`. */
export const DM_TOKEN_EPOCH_MS = 30 * 60 * 1000;
const MAX_TOKEN_LENGTH = 512;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const CANONICAL_HEX_EPOCH = /^(0|[1-9a-f][0-9a-f]{0,12})$/;

export type VerifiedWebhookTarget =
  | { kind: "operator" }
  | { kind: "dm"; callerDid: string };

function deriveDmNotifyKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey, "", DM_NOTIFY_KEY_INFO, 32));
}

function dmNotifyMac(dmKey: Buffer, epochHex: string, space: string, callerDid: string): Buffer {
  return createHmac("sha256", dmKey)
    .update(`${DM_TOKEN_VERSION}\0${epochHex}\0${space}\0${callerDid}`, "utf8")
    .digest();
}

/**
 * Derives an epoch-bounded, stateless, deterministic per-caller DM webhook token:
 * `dm1.<epochHex>.<base64url(callerDid)>.<base64url(hmacSha256(dmKey, "dm1\0" + epochHex + "\0" + space + "\0" + callerDid))>`.
 * Stable within a 30-minute epoch and accepted across `[epoch, epoch - 1]` so renewals transition smoothly while revoked
 * participants lose webhook capability once the epoch window rolls past.
 */
export function deriveDmNotifyToken(
  space: string,
  callerDid: string,
  encryptionKey: Buffer = getOperatorConfig().encryptionKey,
  nowMs: number = Date.now(),
): string {
  if (!parseDmSpaceUri(space)) throw new Error("DM notification tokens can only be derived for DM spaces.");
  if (!isDid(callerDid)) throw new Error("Invalid caller DID.");
  const epoch = Math.floor(nowMs / DM_TOKEN_EPOCH_MS);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("Invalid DM notification token timestamp.");
  }
  const epochHex = epoch.toString(16);
  const dmKey = deriveDmNotifyKey(encryptionKey);
  const callerPart = Buffer.from(callerDid, "utf8").toString("base64url");
  const macPart = dmNotifyMac(dmKey, epochHex, space, callerDid).toString("base64url");
  const token = `${DM_TOKEN_VERSION}.${epochHex}.${callerPart}.${macPart}`;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error("Derived DM notification token exceeds protocol length limit.");
  }
  return token;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

/**
 * Authenticates `(space, token)` on `confirmRegistration` and `notifySpaceUpdate`:
 * - Never rejects operator spaces based on `expires_at` (accepting both `expires_at = 0` staged placeholders during initial
 *   synchronous `confirmRegistration` and `#registrationExpired` callbacks arriving long after expiry).
 * - For DM spaces (`dm.inbox` / `dm.conversation`), verifies the epoch-bounded per-caller `dm1` HMAC in constant time and
 *   accepts ONLY `epoch === currentEpoch || epoch === currentEpoch - 1`.
 * - For operator spaces, matches `notification_registration.token` for `operatorServiceRef` in constant time.
 * - Any missing, empty, expired-epoch, or mismatched token throws `WebhookAuthError` (HTTP 400 `InvalidRequest`).
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
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== DM_TOKEN_VERSION) {
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
    const currentEpoch = Math.floor(nowMs / DM_TOKEN_EPOCH_MS);
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
    const dmKey = deriveDmNotifyKey(encryptionKey ?? getOperatorConfig().encryptionKey);
    const expectedMac = dmNotifyMac(dmKey, epochHex, space, callerDid);
    if (providedMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(providedMac, expectedMac)) {
      throw new WebhookAuthError();
    }
    if (epoch !== currentEpoch && epoch !== currentEpoch - 1) {
      throw new WebhookAuthError("DM notification token expired.");
    }
    return { kind: "dm", callerDid };
  }

  // Non-DM spaces never accept `dm1.*` tokens; they match stored `notification_registration.token` only.
  if (token.startsWith(`${DM_TOKEN_VERSION}.`)) {
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
