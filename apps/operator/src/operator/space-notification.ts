import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { getConfig } from "@flock/deployment/config";
import { isDid, parseDmSpaceUri, parseSpaceUri } from "@flock/protocol/keys";
import { getOperatorConfig } from "../config";
import { getRawDb } from "../lib/db";
import { WebhookAuthError } from "./errors";

const DM_NOTIFY_KEY_INFO = "flock-dm-notify-v1";
const DM_TOKEN_VERSION = "dm1";
const MAX_TOKEN_LENGTH = 512;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;

export type VerifiedWebhookTarget =
  | { kind: "operator" }
  | { kind: "dm"; callerDid: string };

function deriveDmNotifyKey(encryptionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", encryptionKey, "", DM_NOTIFY_KEY_INFO, 32));
}

function dmNotifyMac(dmKey: Buffer, space: string, callerDid: string): Buffer {
  return createHmac("sha256", dmKey)
    .update(`${DM_TOKEN_VERSION}\0${space}\0${callerDid}`, "utf8")
    .digest();
}

/**
 * Derives a stateless, deterministic per-caller DM webhook token:
 * `dm1.<base64url(callerDid)>.<base64url(hmacSha256(dmKey, "dm1\0" + space + "\0" + callerDid))>`.
 * Stable across renewals so `authorizeSpaceSync` renews without re-running `confirmRegistration` or duplicating PDS rows.
 */
export function deriveDmNotifyToken(
  space: string,
  callerDid: string,
  encryptionKey: Buffer = getOperatorConfig().encryptionKey,
): string {
  if (!parseDmSpaceUri(space)) throw new Error("DM notification tokens can only be derived for DM spaces.");
  if (!isDid(callerDid)) throw new Error("Invalid caller DID.");
  const dmKey = deriveDmNotifyKey(encryptionKey);
  const callerPart = Buffer.from(callerDid, "utf8").toString("base64url");
  const macPart = dmNotifyMac(dmKey, space, callerDid).toString("base64url");
  const token = `${DM_TOKEN_VERSION}.${callerPart}.${macPart}`;
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
 * - Never rejects based on `expires_at` (accepting both `expires_at = 0` staged placeholders during initial synchronous
 *   `confirmRegistration` and `#registrationExpired` callbacks arriving long after expiry).
 * - For DM spaces (`dm.inbox` / `dm.conversation`), verifies the stateless per-caller `dm1` HMAC in constant time.
 * - For operator spaces, matches `notification_registration.token` for `operatorServiceRef` in constant time.
 * - Any missing, empty, or mismatched token throws `WebhookAuthError` (HTTP 400 `InvalidRequest`).
 */
export function authenticateSpaceWebhook(
  space: string,
  token: string,
  encryptionKey?: Buffer,
): VerifiedWebhookTarget {
  if (typeof space !== "string" || !parseSpaceUri(space)) {
    throw new WebhookAuthError();
  }
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new WebhookAuthError();
  }

  if (parseDmSpaceUri(space)) {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== DM_TOKEN_VERSION) {
      throw new WebhookAuthError();
    }
    const [, callerPart, macPart] = parts;
    if (!callerPart || !macPart || !BASE64URL_PART.test(callerPart) || !BASE64URL_PART.test(macPart)) {
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
    const expectedMac = dmNotifyMac(dmKey, space, callerDid);
    if (providedMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(providedMac, expectedMac)) {
      throw new WebhookAuthError();
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
