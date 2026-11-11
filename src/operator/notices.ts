import { getConfig } from "@/lib/config";
import { getRawDb } from "@/lib/db";
import { parseDmSpaceUri, parseSpaceUri, requireSpaceAuthority } from "@/protocol/keys";
import type { WriteNotification } from "@/atproto/write-notification";

/** A notice can arrive a little after the registration it belongs to ran out on the app's clock. */
const REGISTRATION_GRACE_MS = 5 * 60 * 1000;
const NOTIFICATION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_NOTIFICATIONS_PER_SPACE = 1_000;
const MAX_NOTIFICATIONS_PER_AUTHORITY = 5_000;
const MAX_NOTIFICATIONS_PER_SPACE_TYPE = 50_000;

/**
 * Whether the app asked this space's authority to notify it. The operator registers the workspace, channel and inbox spaces
 * itself (`src/operator/registrations.ts`), so a notice for any other one of those is refused before any DID is resolved for it. A DM
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
 * 1,000 for the space, the newest 5,000 for its authority and the newest 50,000 of its space type, so neither one space host
 * nor many (a DM space needs no registration, so any DID that can sign a service token can file notices for its own) can
 * grow the table without bound, and one busy type cannot evict another's. Whatever is pruned raises a floor, per type or,
 * for a space's own cap, per space, so a cursor below it is answered with a reset instead of silently missing a change.
 * The per-space and per-authority deletes walk an index range at most as long as their cap; the per-type one is a range on
 * the type's own sequence, so a notice costs the same however large the table has been.
 */
export function recordWriteNotification(notification: WriteNotification, now = Math.floor(Date.now() / 1000)): void {
  const db = getRawDb();
  const space = notification.space;
  const type = spaceTypeOf(space);
  // `at://<authority>/` as an index range on space_uri: every URI under it sorts from the prefix up to the same text ending in `0`, the next character after `/`.
  const authorityStart = `at://${requireSpaceAuthority(space)}/`;
  const authorityEnd = `${authorityStart.slice(0, -1)}0`;
  db.transaction(() => {
    const { seq } = db.prepare("SELECT COALESCE(MAX(type_seq), 0) + 1 AS seq FROM space_notification WHERE space_type=?").get(type) as { seq: number };
    db.prepare("INSERT INTO space_notification (space_uri,space_type,type_seq,repo_did,rev,notified_at) VALUES (?,?,?,?,?,?)")
      .run(space, type, seq, notification.repo, notification.repoRev, now);
    pruneRaisingTypeFloors("notified_at < ?", now - NOTIFICATION_RETENTION_SECONDS);
    pruneRaisingSpaceFloor(space, type, "id IN (SELECT id FROM space_notification WHERE space_uri=? ORDER BY id DESC LIMIT -1 OFFSET ?)", space, MAX_NOTIFICATIONS_PER_SPACE);
    pruneRaisingTypeFloors("id IN (SELECT id FROM space_notification WHERE space_uri >= ? AND space_uri < ? ORDER BY id DESC LIMIT -1 OFFSET ?)", authorityStart, authorityEnd, MAX_NOTIFICATIONS_PER_AUTHORITY);
    pruneRaisingTypeFloors("space_type=? AND type_seq <= ?", type, seq - MAX_NOTIFICATIONS_PER_SPACE_TYPE);
    // A space's own floor at or below its type's says nothing the type's does not.
    db.prepare(`DELETE FROM space_notification_space_floor WHERE space_type=?
      AND floor <= COALESCE((SELECT floor FROM space_notification_type_floor WHERE space_type=?), 0)`).run(type, type);
  }).immediate(); // A writer from the start: it reads before it writes, and a reader upgraded after another process committed would fail, losing the notice.
}

/** Notices older than a week, for an instance that has gone quiet and so never reaches the delete inside `recordWriteNotification`. */
export function purgeStaleNotifications(now = Math.floor(Date.now() / 1000)): void {
  getRawDb().transaction(() => pruneRaisingTypeFloors("notified_at < ?", now - NOTIFICATION_RETENTION_SECONDS)).immediate();
}

export type NoticeAnswer = { head: number; changed: Array<{ space: string; cursor: number }>; reset: string[] };

/**
 * What the notices say about followed spaces: `head`, the newest notice id ever assigned; the spaces with a notice newer than
 * their cursor, with their newest; and those to sync again, whose cursor is below what was pruned for them or above `head`
 * (a cursor from another database).
 */
export function readNotices(follow: ReadonlyArray<{ space: string; after: number }>): NoticeAnswer {
  const db = getRawDb();
  const head = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='space_notification'").get() as { seq: number } | undefined)?.seq ?? 0;
  if (follow.length === 0) return { head, changed: [], reset: [] };
  const spaces = [...new Set(follow.map((entry) => entry.space))];
  const placeholders = spaces.map(() => "?").join(",");
  const newest = new Map((db.prepare(`SELECT space_uri, MAX(id) AS id FROM space_notification WHERE space_uri IN (${placeholders}) GROUP BY space_uri`)
    .all(...spaces) as Array<{ space_uri: string; id: number }>).map((row) => [row.space_uri, row.id]));
  const typeFloors = new Map((db.prepare("SELECT space_type, floor FROM space_notification_type_floor").all() as Array<{ space_type: string; floor: number }>)
    .map((row) => [row.space_type, row.floor]));
  const spaceFloors = new Map((db.prepare(`SELECT space_uri, floor FROM space_notification_space_floor WHERE space_uri IN (${placeholders})`)
    .all(...spaces) as Array<{ space_uri: string; floor: number }>).map((row) => [row.space_uri, row.floor]));
  const answer: NoticeAnswer = { head, changed: [], reset: [] };
  for (const { space, after } of follow) {
    const floor = Math.max(typeFloors.get(spaceTypeOf(space)) ?? 0, spaceFloors.get(space) ?? 0);
    if (after > head || after < floor) answer.reset.push(space);
    else if ((newest.get(space) ?? 0) > after) answer.changed.push({ space, cursor: newest.get(space)! });
  }
  return answer;
}

/** A deleted space's change notices and notify registration go with it. */
export function purgeSpaceNotifications(space: string): void {
  const db = getRawDb();
  db.prepare("DELETE FROM space_notification WHERE space_uri=?").run(space);
  db.prepare("DELETE FROM space_notification_space_floor WHERE space_uri=?").run(space);
  db.prepare("DELETE FROM notification_registration WHERE space_uri=?").run(space);
  db.prepare("DELETE FROM notification_registration_failure WHERE space_uri=?").run(space);
}

/** Registrations the authority stopped honoring long ago; `before` is epoch milliseconds. */
export function purgeExpiredNotificationRegistrations(before: number): void {
  getRawDb().prepare("DELETE FROM notification_registration WHERE expires_at < ?").run(before);
}

/** A notice's space type, under which the per-type cap and floor count it. */
function spaceTypeOf(space: string): string {
  return parseSpaceUri(space)?.type ?? "unknown";
}

/** Deletes the notices `where` selects, raising each affected type's floor to the newest of them first. */
function pruneRaisingTypeFloors(where: string, ...params: unknown[]): void {
  const db = getRawDb();
  db.prepare(`INSERT INTO space_notification_type_floor (space_type, floor)
    SELECT space_type, MAX(id) FROM space_notification WHERE ${where} GROUP BY space_type
    ON CONFLICT(space_type) DO UPDATE SET floor=MAX(floor, excluded.floor)`).run(...params);
  db.prepare(`DELETE FROM space_notification WHERE ${where}`).run(...params);
}

/** Deletes the notices `where` selects from one space, raising that space's own floor to the newest of them first. */
function pruneRaisingSpaceFloor(space: string, type: string, where: string, ...params: unknown[]): void {
  const db = getRawDb();
  const pruned = db.prepare(`SELECT MAX(id) AS id FROM space_notification WHERE ${where}`).get(...params) as { id: number | null };
  if (pruned.id === null) return;
  db.prepare(`INSERT INTO space_notification_space_floor (space_uri, space_type, floor) VALUES (?,?,?)
    ON CONFLICT(space_uri) DO UPDATE SET floor=MAX(floor, excluded.floor)`).run(space, type, pruned.id);
  db.prepare(`DELETE FROM space_notification WHERE ${where}`).run(...params);
}
