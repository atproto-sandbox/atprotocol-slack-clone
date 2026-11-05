import type * as RegisterNotify from "@/lexicons/api/types/com/atproto/space/registerNotify";
import { resolvePds } from "@/atproto/identity";
import type { SpaceCredential } from "@/atproto/space-credential";
import { getConfig } from "@/lib/config";
import { getRawDb } from "@/lib/db";
import { parseDmSpaceUri, requireSpaceAuthority } from "@/protocol/keys";
import type { WriteNotification } from "./write-notification";

const RENEW_BEFORE_MS = 60 * 60 * 1000;
/** A notice can arrive a little after the registration it belongs to ran out on the app's clock. */
const REGISTRATION_GRACE_MS = 5 * 60 * 1000;
const NOTIFICATION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_NOTIFICATIONS_PER_SPACE = 1_000;
const MAX_NOTIFICATIONS_PER_AUTHORITY = 5_000;
const MAX_NOTIFICATIONS_TOTAL = 50_000;

export async function registerSpaceNotifications(credential: SpaceCredential, space: string): Promise<boolean> {
  const serviceRef = getConfig().operatorServiceRef;
  const authorityDid = requireSpaceAuthority(space);
  const now = Date.now();
  const prior = getRawDb().prepare("SELECT expires_at FROM notification_registration WHERE service_ref=? AND space_uri=?")
    .get(serviceRef, space) as { expires_at: number } | undefined;
  if (prior && prior.expires_at > now + RENEW_BEFORE_MS) return true;
  try {
    const pds = await resolvePds(authorityDid);
    const result = await credential.client(pds).procedure<RegisterNotify.InputSchema, RegisterNotify.OutputSchema>(
      "com.atproto.space.registerNotify", { space, service: serviceRef },
    );
    const expiresAt = Date.parse(result.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    getRawDb().prepare(`INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)
      ON CONFLICT(service_ref,space_uri) DO UPDATE SET expires_at=excluded.expires_at`).run(serviceRef, space, expiresAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the app asked this space's authority to notify it. The app registers the workspace, channel and inbox spaces itself
 * (`registerSpaceNotifications`), so a notice for any other one of those is refused before any DID is resolved for it. A DM
 * space is registered by the member's browser, which the server never sees, so those are accepted and bounded by the caps in
 * `recordWriteNotification` instead.
 */
export function isNotificationAccepted(space: string, now = Date.now()): boolean {
  if (parseDmSpaceUri(space)) return true;
  return Boolean(getRawDb().prepare("SELECT 1 FROM notification_registration WHERE service_ref=? AND space_uri=? AND expires_at>?")
    .get(getConfig().operatorServiceRef, space, now - REGISTRATION_GRACE_MS));
}

/**
 * Stores a content-free write notice for the change streams. Notices older than a week go, and so do those past the newest
 * 1,000 for the space, the newest 5,000 for its authority and those filed more than 50,000 notices ago, so neither one space host nor many
 * (a DM space needs no registration, so any DID that can sign a service token can file notices for its own) can grow the
 * table without bound. The per-space and per-authority deletes walk an index range at most as long as their cap; the overall one
 * is a comparison on the key, so a notice costs the same however large the table has been.
 */
export function recordWriteNotification(notification: WriteNotification, now = Math.floor(Date.now() / 1000)): void {
  const db = getRawDb();
  // `at://<authority>/` as an index range on space_uri: every URI under it sorts from the prefix up to the same text ending in `0`, the next character after `/`.
  const authorityStart = `at://${requireSpaceAuthority(notification.space)}/`;
  const authorityEnd = `${authorityStart.slice(0, -1)}0`;
  db.transaction(() => {
    const inserted = db.prepare("INSERT INTO space_notification (space_uri,repo_did,rev,notified_at) VALUES (?,?,?,?)")
      .run(notification.space, notification.repo, notification.repoRev, now);
    db.prepare("DELETE FROM space_notification WHERE notified_at < ?").run(now - NOTIFICATION_RETENTION_SECONDS);
    db.prepare("DELETE FROM space_notification WHERE id IN (SELECT id FROM space_notification WHERE space_uri=? ORDER BY id DESC LIMIT -1 OFFSET ?)")
      .run(notification.space, MAX_NOTIFICATIONS_PER_SPACE);
    db.prepare("DELETE FROM space_notification WHERE id IN (SELECT id FROM space_notification WHERE space_uri >= ? AND space_uri < ? ORDER BY id DESC LIMIT -1 OFFSET ?)")
      .run(authorityStart, authorityEnd, MAX_NOTIFICATIONS_PER_AUTHORITY);
    db.prepare("DELETE FROM space_notification WHERE id <= ?").run(Number(inserted.lastInsertRowid) - MAX_NOTIFICATIONS_TOTAL);
  })();
}

/** Notices older than a week, for an instance that has gone quiet and so never reaches the delete inside `recordWriteNotification`. */
export function purgeStaleNotifications(now = Math.floor(Date.now() / 1000)): void {
  getRawDb().prepare("DELETE FROM space_notification WHERE notified_at < ?").run(now - NOTIFICATION_RETENTION_SECONDS);
}

/** A deleted space's change notices and notify registration go with it. */
export function purgeSpaceNotifications(space: string): void {
  const db = getRawDb();
  db.prepare("DELETE FROM space_notification WHERE space_uri=?").run(space);
  db.prepare("DELETE FROM notification_registration WHERE space_uri=?").run(space);
}

/** Registrations the authority stopped honoring long ago; `before` is epoch milliseconds. */
export function purgeExpiredNotificationRegistrations(before: number): void {
  getRawDb().prepare("DELETE FROM notification_registration WHERE expires_at < ?").run(before);
}
