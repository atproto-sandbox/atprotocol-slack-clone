import { createHash, createHmac } from "node:crypto";
import { parseCid } from "@atproto/lex-data";
import type { DidString, NsidString } from "@atproto/syntax";
import {
  groupMembersUri,
  isDid,
  isValidModTag,
  parseAnySpaceRecordUri,
} from "@flock/protocol/keys";
import { projectActiveLabels } from "@flock/protocol/moderation";
import {
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_MOD_EVENT_TYPE,
  ATGRP_MOD_REASON,
  ATPROTO_SPACE_COLLECTION,
} from "@flock/protocol/nsids";
import type { GroupHostDb } from "./db";
import { revalidateLiveOAuthSessionSync, type AuthenticatedGroupSession } from "./oauth";
import { GroupHostHttpError } from "./plc";
import {
  hasActiveSourceMigrationLease,
  liveRoleGrantsRead,
  loadLiveGovernanceState,
  reapExpiredPreparedMigrationLease,
} from "./rbac";

export const MAX_TAGS_PER_SUBJECT = 100;
export const MAX_TAGS_PER_REQUEST = 25;

export type LabelerRecordValue = {
  policies: {
    labelValues: string[];
    labelValueDefinitions?: unknown[];
  };
  reasonTypes?: string[];
  subjectTypes?: string[];
  subjectCollections?: string[];
};

export type ModSubjectView = {
  subject: string;
  cid?: string;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  reportCount?: number;
  tags?: string[];
};

export type ModEventView = {
  eventId: string;
  createdAt: string;
  subject: string;
  cid?: string;
  createdBy?: string;
  event: Record<string, unknown>;
};

/**
 * Exhaustive, fail-closed self-visibility classification for `org.atgrp.mod.defs` union variants.
 * Reports and moderator tags are strictly moderator-private; appeals, status changes, labels,
 * and ejections are visible in `org.atgrp.mod.querySelfHistory` (after allowlisted projection).
 */
export function isModEventSelfVisible(eventType: string): 0 | 1 {
  switch (eventType) {
    case ATGRP_MOD_EVENT_TYPE.appeal:
    case ATGRP_MOD_EVENT_TYPE.status:
    case ATGRP_MOD_EVENT_TYPE.label:
    case ATGRP_MOD_EVENT_TYPE.eject:
      return 1;
    case ATGRP_MOD_EVENT_TYPE.report:
    case ATGRP_MOD_EVENT_TYPE.tag:
      return 0;
    default:
      throw new Error(`Unknown moderation event $type: ${eventType}`);
  }
}

function getModEventIdSecret(db: GroupHostDb): string {
  const row = db
    .prepare("SELECT value FROM host_meta WHERE key = 'mod_event_id_secret'")
    .get() as { value: string } | undefined;
  return row?.value ?? "flock-mod-event-secret";
}

/** Opaque per-group eventId derived via HMAC so global autoincrement seq never leaks cross-group volume. */
export function formatOpaqueModEventId(db: GroupHostDb, groupDid: string, seq: number): string {
  const secret = getModEventIdSecret(db);
  const digest = createHmac("sha256", secret).update(`${groupDid}\u0000${seq}`).digest("hex");
  return `ev-${digest.slice(0, 20)}`;
}

function deriveSubjectOwnerDid(subject: string): string {
  if (isDid(subject)) return subject;
  const parsed = parseAnySpaceRecordUri(subject);
  if (!parsed) {
    throw new GroupHostHttpError(400, "InvalidSubject", "Subject is not an account DID or space record URI.");
  }
  return parsed.repoDid;
}

function validateModSubjectIdentifier(groupDid: string, subject: string): void {
  if (isDid(subject)) return;
  const parsed = parseAnySpaceRecordUri(subject);
  if (!parsed || parsed.authorityDid !== groupDid) {
    throw new GroupHostHttpError(
      400,
      "InvalidSubject",
      "Subject is not an account DID or space record URI of this group.",
    );
  }
}

function filtersHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeBoundCursor<T extends Record<string, unknown>>(
  cursor: string,
  expected: { ep: string; groupDid: string; sort: string; filtersHash: string },
): T {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.v !== 1 ||
      raw.ep !== expected.ep ||
      raw.groupDid !== expected.groupDid ||
      raw.sort !== expected.sort ||
      raw.filtersHash !== expected.filtersHash
    ) {
      throw new Error("cursor mismatch");
    }
    return raw as T;
  } catch {
    throw new GroupHostHttpError(400, "InvalidCursor", `Malformed or mismatched ${expected.ep} cursor.`);
  }
}

function loadSubjectTags(
  db: GroupHostDb,
  groupDid: string,
  subject: string,
  cidKey: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT tag FROM mod_subject_tag WHERE group_did = ? AND subject = ? AND cid_key = ? ORDER BY tag ASC",
    )
    .all(groupDid, subject, cidKey) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

function formatSubjectView(
  row: {
    subject: string;
    cid_key: string;
    status: "open" | "resolved";
    report_count: number;
    created_at: string;
    updated_at: string;
  },
  tags: string[],
): ModSubjectView {
  return {
    subject: row.subject,
    ...(row.cid_key !== "" ? { cid: row.cid_key } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.report_count > 0 ? { reportCount: row.report_count } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Allowlisted projection for `org.atgrp.mod.querySelfHistory`.
 * Strips `createdBy` from the outer eventView and strips `note` from BOTH `#statusEvent` AND `#appealEvent`.
 */
function projectSelfVisibleEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const type = typeof raw.$type === "string" ? raw.$type : "";
  switch (type) {
    case ATGRP_MOD_EVENT_TYPE.appeal:
      return { $type: ATGRP_MOD_EVENT_TYPE.appeal };
    case ATGRP_MOD_EVENT_TYPE.status:
      return {
        $type: ATGRP_MOD_EVENT_TYPE.status,
        status: raw.status,
      };
    case ATGRP_MOD_EVENT_TYPE.label:
      return {
        $type: ATGRP_MOD_EVENT_TYPE.label,
        uri: raw.uri,
        val: raw.val,
        ...(raw.deleted === true ? { deleted: true } : {}),
      };
    case ATGRP_MOD_EVENT_TYPE.eject:
      return { $type: ATGRP_MOD_EVENT_TYPE.eject };
    default:
      throw new Error(`Refusing to project non-self-visible moderation event $type: ${type}`);
  }
}

export function clearModEjectionEligibilitySync(
  db: GroupHostDb,
  groupDid: string,
  memberDid: string,
): void {
  db.prepare(
    "DELETE FROM mod_ejection_eligibility WHERE group_did = ? AND member_did = ?",
  ).run(groupDid, memberDid);
}

export function recordModLabelEventSync(
  db: GroupHostDb,
  params: {
    groupDid: string;
    actorDid?: string;
    subjectUri: string;
    subjectCid?: string;
    labelRecordUri: string;
    val: string;
    deleted: boolean;
    nowIso: string;
  },
): void {
  const cidKey = params.subjectCid ?? "";
  const ownerDid = deriveSubjectOwnerDid(params.subjectUri);
  const existing = db
    .prepare("SELECT status FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ?")
    .get(params.groupDid, params.subjectUri, cidKey) as { status: string } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO mod_subject (group_did, subject, cid_key, status, report_count, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 0, ?, ?)`,
    ).run(params.groupDid, params.subjectUri, cidKey, params.nowIso, params.nowIso);
  } else {
    db.prepare(
      "UPDATE mod_subject SET updated_at = ? WHERE group_did = ? AND subject = ? AND cid_key = ?",
    ).run(params.nowIso, params.groupDid, params.subjectUri, cidKey);
  }

  const eventType = ATGRP_MOD_EVENT_TYPE.label;
  const eventObj = {
    $type: eventType,
    uri: params.labelRecordUri,
    val: params.val,
    ...(params.deleted ? { deleted: true } : {}),
  };
  db.prepare(
    `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.groupDid,
    params.subjectUri,
    cidKey,
    ownerDid,
    isModEventSelfVisible(eventType),
    params.nowIso,
    params.actorDid ?? null,
    JSON.stringify(eventObj),
  );
}

export function recordModEjectEventSync(
  db: GroupHostDb,
  params: {
    groupDid: string;
    actorDid?: string;
    ejectedMemberDid: string;
    nowIso: string;
  },
): void {
  // Extension-free durable appeal eligibility (works on standard imported memberships too).
  db.prepare(
    `INSERT INTO mod_ejection_eligibility (group_did, member_did, ejected_at)
     VALUES (?, ?, ?)
     ON CONFLICT (group_did, member_did) DO UPDATE SET ejected_at = excluded.ejected_at`,
  ).run(params.groupDid, params.ejectedMemberDid, params.nowIso);

  const existing = db
    .prepare("SELECT status FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ''")
    .get(params.groupDid, params.ejectedMemberDid) as { status: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE mod_subject SET updated_at = ? WHERE group_did = ? AND subject = ? AND cid_key = ''",
    ).run(params.nowIso, params.groupDid, params.ejectedMemberDid);
  }

  const eventType = ATGRP_MOD_EVENT_TYPE.eject;
  const eventObj = { $type: eventType };
  db.prepare(
    `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
     VALUES (?, ?, '', ?, ?, ?, ?, ?)`,
  ).run(
    params.groupDid,
    params.ejectedMemberDid,
    params.ejectedMemberDid,
    isModEventSelfVisible(eventType),
    params.nowIso,
    params.actorDid ?? null,
    JSON.stringify(eventObj),
  );
}

export function executeSubmitReportSync(
  db: GroupHostDb,
  params: {
    callerDid: string;
    groupDid: string;
    subject: string;
    cid?: string;
    reasonType: string;
    reason?: string;
    rule?: string;
    nowMs?: number;
  },
): { eventId: string; createdAt: string } {
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (params.callerDid === params.groupDid) {
    throw new GroupHostHttpError(
      400,
      "CannotTargetGroupSelf",
      "submitReport acts strictly as a personal account, never the group DID.",
    );
  }
  if (typeof params.reasonType !== "string" || params.reasonType.trim().length === 0) {
    throw new GroupHostHttpError(400, "InvalidRequest", "reasonType must be a non-empty string.");
  }

  const tx = db.transaction(() => {
    reapExpiredPreparedMigrationLease(db, params.groupDid, nowMs);
    if (hasActiveSourceMigrationLease(db, params.groupDid, nowMs)) {
      throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
    }
    const acct = db
      .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
      .get(params.groupDid) as { activated: number; takendown: number } | undefined;
    if (!acct) {
      throw new GroupHostHttpError(400, "GroupNotFound", "Group not hosted here.");
    }
    if (acct.takendown !== 0) {
      throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
    }
    if (acct.activated !== 1) {
      throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
    }

    const state = loadLiveGovernanceState(db, params.groupDid);
    const membersSpaceUri = groupMembersUri(params.groupDid);

    let subjectType: "account" | "record";
    let subjectCollection: string | undefined;
    let subjectOwnerDid: string;

    if (isDid(params.subject)) {
      subjectType = "account";
      subjectOwnerDid = params.subject;
      if (params.cid !== undefined) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Account DID reports cannot include a cid.");
      }
      if (!liveRoleGrantsRead(state, membersSpaceUri, params.callerDid, params.groupDid)) {
        throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
      }
      if (params.subject !== params.groupDid && !state.memberships.has(params.subject)) {
        throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
      }
    } else {
      subjectType = "record";
      const parsed = parseAnySpaceRecordUri(params.subject);
      if (!parsed || parsed.authorityDid !== params.groupDid) {
        throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
      }
      subjectCollection = parsed.collection;
      subjectOwnerDid = parsed.repoDid;
      const targetSpaceRow = db
        .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
        .get(parsed.spaceUri, params.groupDid) as { deleted_at: number | null } | undefined;
      if (
        !targetSpaceRow ||
        targetSpaceRow.deleted_at !== null ||
        !liveRoleGrantsRead(state, parsed.spaceUri, params.callerDid, params.groupDid)
      ) {
        throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
      }

      if (parsed.repoDid === params.groupDid) {
        const recRow = db
          .prepare(
            "SELECT cid FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
          )
          .get(parsed.spaceUri, params.groupDid, parsed.collection, parsed.rkey) as { cid: string } | undefined;
        if (!recRow || (params.cid !== undefined && recRow.cid !== params.cid)) {
          throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
        }
      } else {
        const writerRow = db
          .prepare("SELECT removed FROM space_writer WHERE space_uri = ? AND writer_did = ?")
          .get(parsed.spaceUri, parsed.repoDid) as { removed: number } | undefined;
        if (!writerRow || writerRow.removed !== 0) {
          throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
        }
        if (params.cid !== undefined) {
          try {
            parseCid(params.cid);
          } catch {
            throw new GroupHostHttpError(400, "InvalidRequest", "Invalid CID syntax.");
          }
        }
      }
    }

    // Validate against `org.atgrp.labeler/self` in `org.atgrp.members/self`
    const labelerRow = db
      .prepare(
        "SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = 'self'",
      )
      .get(membersSpaceUri, params.groupDid, ATGRP_COLLECTION.labeler) as { value: string } | undefined;
    if (labelerRow) {
      const labeler = JSON.parse(labelerRow.value) as LabelerRecordValue;
      if (labeler.reasonTypes && !labeler.reasonTypes.includes(params.reasonType)) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          `Report reasonType '${params.reasonType}' is not accepted by this group.`,
        );
      }
      if (labeler.subjectTypes && !labeler.subjectTypes.includes(subjectType)) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          `Report subjectType '${subjectType}' is not accepted by this group.`,
        );
      }
      if (
        subjectCollection &&
        labeler.subjectCollections &&
        !labeler.subjectCollections.includes(subjectCollection)
      ) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          `Report collection '${subjectCollection}' is not accepted by this group.`,
        );
      }
    }

    if (params.reasonType === ATGRP_MOD_REASON.violation && !params.rule) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        `reasonType '${ATGRP_MOD_REASON.violation}' requires citing 'rule'.`,
      );
    }
    if (params.rule !== undefined) {
      const parsedRule = parseAnySpaceRecordUri(params.rule);
      if (
        !parsedRule ||
        parsedRule.spaceUri !== membersSpaceUri ||
        parsedRule.repoDid !== params.groupDid ||
        parsedRule.collection !== ATGRP_COLLECTION.rule
      ) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          "Cited rule must be an org.atgrp.rule record in org.atgrp.members/self.",
        );
      }
      const ruleExists = db
        .prepare(
          "SELECT 1 AS ok FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
        )
        .get(membersSpaceUri, params.groupDid, ATGRP_COLLECTION.rule, parsedRule.rkey);
      if (!ruleExists) {
        throw new GroupHostHttpError(
          400,
          "InvalidRequest",
          "Cited rule record does not exist in org.atgrp.members/self.",
        );
      }
    }

    const cidKey = params.cid ?? "";
    const existingSubject = db
      .prepare("SELECT status, report_count FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ?")
      .get(params.groupDid, params.subject, cidKey) as { status: string; report_count: number } | undefined;

    if (!existingSubject) {
      db.prepare(
        `INSERT INTO mod_subject (group_did, subject, cid_key, status, report_count, created_at, updated_at)
         VALUES (?, ?, ?, 'open', 1, ?, ?)`,
      ).run(params.groupDid, params.subject, cidKey, nowIso, nowIso);
    } else {
      db.prepare(
        `UPDATE mod_subject
         SET status = 'open', report_count = report_count + 1, updated_at = ?
         WHERE group_did = ? AND subject = ? AND cid_key = ?`,
      ).run(nowIso, params.groupDid, params.subject, cidKey);
    }

    const eventType = ATGRP_MOD_EVENT_TYPE.report;
    const eventObj = {
      $type: eventType,
      reasonType: params.reasonType,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.rule !== undefined ? { rule: params.rule } : {}),
    };
    const info = db
      .prepare(
        `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.groupDid,
        params.subject,
        cidKey,
        subjectOwnerDid,
        isModEventSelfVisible(eventType),
        nowIso,
        params.callerDid,
        JSON.stringify(eventObj),
      );

    return {
      eventId: formatOpaqueModEventId(db, params.groupDid, Number(info.lastInsertRowid)),
      createdAt: nowIso,
    };
  });

  return tx.immediate();
}

export function executeSubmitAppealSync(
  db: GroupHostDb,
  params: {
    callerDid: string;
    groupDid: string;
    subject: string;
    note?: string;
    nowMs?: number;
  },
): { eventId: string; createdAt: string } {
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (params.callerDid === params.groupDid) {
    throw new GroupHostHttpError(
      400,
      "CannotTargetGroupSelf",
      "submitAppeal acts strictly as a personal account, never the group DID.",
    );
  }

  let targetSpaceUri: string;
  let isAccountSubject = false;

  if (isDid(params.subject)) {
    if (params.subject !== params.callerDid) {
      throw new GroupHostHttpError(
        400,
        "InvalidSubject",
        "The subject isn't the caller's account or record.",
      );
    }
    isAccountSubject = true;
    targetSpaceUri = groupMembersUri(params.groupDid);
  } else {
    const parsed = parseAnySpaceRecordUri(params.subject);
    if (!parsed || parsed.authorityDid !== params.groupDid || parsed.repoDid !== params.callerDid) {
      throw new GroupHostHttpError(
        400,
        "InvalidSubject",
        "The subject isn't the caller's account or record.",
      );
    }
    targetSpaceUri = parsed.spaceUri;
  }

  const tx = db.transaction(() => {
    reapExpiredPreparedMigrationLease(db, params.groupDid, nowMs);
    if (hasActiveSourceMigrationLease(db, params.groupDid, nowMs)) {
      throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
    }
    const acct = db
      .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
      .get(params.groupDid) as { activated: number; takendown: number } | undefined;
    if (!acct) {
      throw new GroupHostHttpError(400, "GroupNotFound", "Group not hosted here.");
    }
    if (acct.takendown !== 0) {
      throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
    }
    if (acct.activated !== 1) {
      throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
    }

    // Check active labels in target space (anti-oracle: missing/deleted space returns uniform 400 NotAppealable!)
    const targetSpaceRow = db
      .prepare("SELECT deleted_at FROM group_space WHERE space_uri = ? AND group_did = ?")
      .get(targetSpaceUri, params.groupDid) as { deleted_at: number | null } | undefined;

    let hasActiveLabel = false;
    if (targetSpaceRow && targetSpaceRow.deleted_at === null) {
      const rawLabels = db
        .prepare(
          "SELECT repo_did, rkey, value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ?",
        )
        .all(targetSpaceUri, params.groupDid, ATPROTO_SPACE_COLLECTION.label) as Array<{
        repo_did: string;
        rkey: string;
        value: string;
      }>;
      const active = projectActiveLabels(
        rawLabels.map((row) => ({
          repoDid: row.repo_did,
          rkey: row.rkey,
          value: JSON.parse(row.value) as Record<string, unknown>,
        })),
        { groupDid: params.groupDid, spaceUri: targetSpaceUri, nowMs },
      );
      hasActiveLabel = active.some((lbl) => lbl.uri === params.subject);
    }

    let hasActiveEjection = false;
    if (isAccountSubject) {
      const ejectRow = db
        .prepare("SELECT 1 AS ok FROM mod_ejection_eligibility WHERE group_did = ? AND member_did = ?")
        .get(params.groupDid, params.callerDid) as { ok: number } | undefined;
      hasActiveEjection = Boolean(ejectRow);
    }

    if (!hasActiveLabel && !hasActiveEjection) {
      // Uniform error whether target space/record does not exist or has no active label/ejection
      throw new GroupHostHttpError(400, "NotAppealable", "The subject has no active label or ejection.");
    }

    // Appeals open/reopen deterministic (group_did, subject, cid_key = '')
    const cidKey = "";
    const existingSubject = db
      .prepare("SELECT status FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ?")
      .get(params.groupDid, params.subject, cidKey) as { status: string } | undefined;

    if (!existingSubject) {
      db.prepare(
        `INSERT INTO mod_subject (group_did, subject, cid_key, status, report_count, created_at, updated_at)
         VALUES (?, ?, ?, 'open', 0, ?, ?)`,
      ).run(params.groupDid, params.subject, cidKey, nowIso, nowIso);
    } else {
      db.prepare(
        "UPDATE mod_subject SET status = 'open', updated_at = ? WHERE group_did = ? AND subject = ? AND cid_key = ?",
      ).run(nowIso, params.groupDid, params.subject, cidKey);
    }

    const eventType = ATGRP_MOD_EVENT_TYPE.appeal;
    const eventObj = {
      $type: eventType,
      ...(params.note !== undefined ? { note: params.note } : {}),
    };
    const info = db
      .prepare(
        `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.groupDid,
        params.subject,
        cidKey,
        params.callerDid,
        isModEventSelfVisible(eventType),
        nowIso,
        params.callerDid,
        JSON.stringify(eventObj),
      );

    return {
      eventId: formatOpaqueModEventId(db, params.groupDid, Number(info.lastInsertRowid)),
      createdAt: nowIso,
    };
  });

  return tx.immediate();
}

export function executeQueryModSubjects(
  db: GroupHostDb,
  params: {
    groupDid: string;
    status?: "open" | "resolved";
    tags?: readonly string[];
    sort?: string;
    limit?: number;
    cursor?: string;
  },
): {
  subjects: ModSubjectView[];
  cursor?: string;
} {
  if (params.status !== undefined && params.status !== "open" && params.status !== "resolved") {
    throw new GroupHostHttpError(400, "InvalidRequest", "status must be 'open' or 'resolved'.");
  }
  const sort = params.sort ?? "oldest";
  if (sort !== "oldest" && sort !== "newest" && sort !== "updated") {
    throw new GroupHostHttpError(400, "InvalidRequest", "sort must be 'oldest', 'newest', or 'updated'.");
  }
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
  ) {
    throw new GroupHostHttpError(400, "InvalidRequest", "limit must be an integer between 1 and 100.");
  }
  const limit = params.limit ?? 50;

  let normalizedTags: string[] = [];
  if (params.tags !== undefined) {
    if (params.tags.length > MAX_TAGS_PER_REQUEST) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        `tags filter cannot exceed ${MAX_TAGS_PER_REQUEST} entries.`,
      );
    }
    for (const tag of params.tags) {
      if (!isValidModTag(tag)) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Invalid moderation tag '${tag}'.`);
      }
    }
    normalizedTags = [...new Set(params.tags)].sort();
  }

  const fHash = filtersHash({ status: params.status ?? null, tags: normalizedTags });
  let cursorDecoded: { ts: string; subject: string; cidKey: string } | null = null;
  if (params.cursor !== undefined) {
    const raw = decodeBoundCursor<{ ts?: unknown; subject?: unknown; cidKey?: unknown }>(params.cursor, {
      ep: "querySubjects",
      groupDid: params.groupDid,
      sort,
      filtersHash: fHash,
    });
    if (typeof raw.ts !== "string" || typeof raw.subject !== "string" || typeof raw.cidKey !== "string") {
      throw new GroupHostHttpError(400, "InvalidCursor", "Malformed querySubjects cursor.");
    }
    cursorDecoded = { ts: raw.ts, subject: raw.subject, cidKey: raw.cidKey };
  }

  const whereClauses: string[] = ["m.group_did = ?"];
  const args: unknown[] = [params.groupDid];

  if (params.status !== undefined) {
    whereClauses.push("m.status = ?");
    args.push(params.status);
  }
  if (normalizedTags.length > 0) {
    const placeholders = normalizedTags.map(() => "?").join(", ");
    whereClauses.push(
      `EXISTS (
         SELECT 1 FROM mod_subject_tag t
         WHERE t.group_did = m.group_did
           AND t.subject = m.subject
           AND t.cid_key = m.cid_key
           AND t.tag IN (${placeholders})
       )`,
    );
    args.push(...normalizedTags);
  }

  let orderBySql: string;
  if (sort === "oldest") {
    orderBySql = "ORDER BY m.created_at ASC, m.subject ASC, m.cid_key ASC";
    if (cursorDecoded) {
      whereClauses.push(
        "(m.created_at > ? OR (m.created_at = ? AND m.subject > ?) OR (m.created_at = ? AND m.subject = ? AND m.cid_key > ?))",
      );
      args.push(
        cursorDecoded.ts,
        cursorDecoded.ts,
        cursorDecoded.subject,
        cursorDecoded.ts,
        cursorDecoded.subject,
        cursorDecoded.cidKey,
      );
    }
  } else if (sort === "newest") {
    orderBySql = "ORDER BY m.created_at DESC, m.subject DESC, m.cid_key DESC";
    if (cursorDecoded) {
      whereClauses.push(
        "(m.created_at < ? OR (m.created_at = ? AND m.subject < ?) OR (m.created_at = ? AND m.subject = ? AND m.cid_key < ?))",
      );
      args.push(
        cursorDecoded.ts,
        cursorDecoded.ts,
        cursorDecoded.subject,
        cursorDecoded.ts,
        cursorDecoded.subject,
        cursorDecoded.cidKey,
      );
    }
  } else {
    orderBySql = "ORDER BY m.updated_at DESC, m.subject ASC, m.cid_key ASC";
    if (cursorDecoded) {
      whereClauses.push(
        "(m.updated_at < ? OR (m.updated_at = ? AND m.subject > ?) OR (m.updated_at = ? AND m.subject = ? AND m.cid_key > ?))",
      );
      args.push(
        cursorDecoded.ts,
        cursorDecoded.ts,
        cursorDecoded.subject,
        cursorDecoded.ts,
        cursorDecoded.subject,
        cursorDecoded.cidKey,
      );
    }
  }

  args.push(limit + 1);
  const rows = db
    .prepare(
      `SELECT m.subject, m.cid_key, m.status, m.report_count, m.created_at, m.updated_at
       FROM mod_subject m
       WHERE ${whereClauses.join(" AND ")}
       ${orderBySql}
       LIMIT ?`,
    )
    .all(...args) as Array<{
    subject: string;
    cid_key: string;
    status: "open" | "resolved";
    report_count: number;
    created_at: string;
    updated_at: string;
  }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v: 1,
          ep: "querySubjects",
          groupDid: params.groupDid,
          sort,
          filtersHash: fHash,
          ts: sort === "updated" ? last.updated_at : last.created_at,
          subject: last.subject,
          cidKey: last.cid_key,
        })
      : undefined;

  return {
    subjects: page.map((r) => formatSubjectView(r, loadSubjectTags(db, params.groupDid, r.subject, r.cid_key))),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export function executeQuerySubjectHistory(
  db: GroupHostDb,
  params: {
    groupDid: string;
    subject: string;
    cid?: string;
    sort?: string;
    limit?: number;
    cursor?: string;
  },
): {
  events: ModEventView[];
  cursor?: string;
} {
  validateModSubjectIdentifier(params.groupDid, params.subject);
  const sort = params.sort ?? "newest";
  if (sort !== "newest" && sort !== "oldest") {
    throw new GroupHostHttpError(400, "InvalidRequest", "sort must be 'newest' or 'oldest'.");
  }
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
  ) {
    throw new GroupHostHttpError(400, "InvalidRequest", "limit must be an integer between 1 and 100.");
  }
  const limit = params.limit ?? 50;

  const fHash = filtersHash({ subject: params.subject, cid: params.cid ?? null });
  let cursorSeq: number | null = null;
  if (params.cursor !== undefined) {
    const raw = decodeBoundCursor<{ seq?: unknown }>(params.cursor, {
      ep: "querySubjectHistory",
      groupDid: params.groupDid,
      sort,
      filtersHash: fHash,
    });
    if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) {
      throw new GroupHostHttpError(400, "InvalidCursor", "Malformed querySubjectHistory cursor.");
    }
    cursorSeq = raw.seq;
  }

  const cmp = sort === "newest" ? "<" : ">";
  const order = sort === "newest" ? "DESC" : "ASC";

  const whereClauses = ["group_did = ?", "subject = ?"];
  const args: unknown[] = [params.groupDid, params.subject];
  if (params.cid !== undefined) {
    whereClauses.push("cid_key = ?");
    args.push(params.cid);
  }
  if (cursorSeq !== null) {
    whereClauses.push(`seq ${cmp} ?`);
    args.push(cursorSeq);
  }
  args.push(limit + 1);

  const rows = db
    .prepare(
      `SELECT seq, subject, cid_key, created_at, created_by, event_json
       FROM mod_event
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY seq ${order}
       LIMIT ?`,
    )
    .all(...args) as Array<{
    seq: number;
    subject: string;
    cid_key: string;
    created_at: string;
    created_by: string | null;
    event_json: string;
  }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v: 1,
          ep: "querySubjectHistory",
          groupDid: params.groupDid,
          sort,
          filtersHash: fHash,
          seq: last.seq,
        })
      : undefined;

  return {
    events: page.map((r) => ({
      eventId: formatOpaqueModEventId(db, params.groupDid, r.seq),
      createdAt: r.created_at,
      subject: r.subject,
      ...(r.cid_key !== "" ? { cid: r.cid_key } : {}),
      ...(r.created_by !== null ? { createdBy: r.created_by } : {}),
      event: JSON.parse(r.event_json) as Record<string, unknown>,
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export function executeQuerySelfHistory(
  db: GroupHostDb,
  params: {
    callerDid: string;
    groupDid: string;
    subject?: string;
    sort?: string;
    limit?: number;
    cursor?: string;
  },
): {
  events: ModEventView[];
  cursor?: string;
} {
  if (params.callerDid === params.groupDid) {
    throw new GroupHostHttpError(
      400,
      "CannotTargetGroupSelf",
      "querySelfHistory acts strictly as a personal account, never the group DID.",
    );
  }
  const sort = params.sort ?? "newest";
  if (sort !== "newest" && sort !== "oldest") {
    throw new GroupHostHttpError(400, "InvalidRequest", "sort must be 'newest' or 'oldest'.");
  }
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
  ) {
    throw new GroupHostHttpError(400, "InvalidRequest", "limit must be an integer between 1 and 100.");
  }
  const limit = params.limit ?? 50;

  if (params.subject !== undefined) {
    if (isDid(params.subject)) {
      if (params.subject !== params.callerDid) {
        throw new GroupHostHttpError(
          400,
          "InvalidSubject",
          "The subject isn't the caller's account or record.",
        );
      }
    } else {
      const parsed = parseAnySpaceRecordUri(params.subject);
      if (!parsed || parsed.authorityDid !== params.groupDid || parsed.repoDid !== params.callerDid) {
        throw new GroupHostHttpError(
          400,
          "InvalidSubject",
          "The subject isn't the caller's account or record.",
        );
      }
    }
  }

  const acct = db
    .prepare("SELECT activated, takendown FROM group_account WHERE did = ?")
    .get(params.groupDid) as { activated: number; takendown: number } | undefined;
  if (!acct) {
    throw new GroupHostHttpError(400, "GroupNotFound", "Group not hosted here.");
  }
  if (acct.takendown !== 0) {
    throw new GroupHostHttpError(400, "RepoTakendown", "Group is taken down.");
  }
  if (acct.activated !== 1) {
    throw new GroupHostHttpError(400, "RepoDeactivated", "Group is deactivated.");
  }

  const fHash = filtersHash({ callerDid: params.callerDid, subject: params.subject ?? null });
  let cursorSeq: number | null = null;
  if (params.cursor !== undefined) {
    const raw = decodeBoundCursor<{ seq?: unknown }>(params.cursor, {
      ep: "querySelfHistory",
      groupDid: params.groupDid,
      sort,
      filtersHash: fHash,
    });
    if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) {
      throw new GroupHostHttpError(400, "InvalidCursor", "Malformed querySelfHistory cursor.");
    }
    cursorSeq = raw.seq;
  }

  const cmp = sort === "newest" ? "<" : ">";
  const order = sort === "newest" ? "DESC" : "ASC";

  const whereClauses = ["group_did = ?", "subject_owner_did = ?", "is_self_visible = 1"];
  const args: unknown[] = [params.groupDid, params.callerDid];
  if (params.subject !== undefined) {
    whereClauses.push("subject = ?");
    args.push(params.subject);
  }
  if (cursorSeq !== null) {
    whereClauses.push(`seq ${cmp} ?`);
    args.push(cursorSeq);
  }
  args.push(limit + 1);

  const rows = db
    .prepare(
      `SELECT seq, subject, cid_key, created_at, event_json
       FROM mod_event
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY seq ${order}
       LIMIT ?`,
    )
    .all(...args) as Array<{
    seq: number;
    subject: string;
    cid_key: string;
    created_at: string;
    event_json: string;
  }>;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v: 1,
          ep: "querySelfHistory",
          groupDid: params.groupDid,
          sort,
          filtersHash: fHash,
          seq: last.seq,
        })
      : undefined;

  return {
    events: page.map((r) => ({
      eventId: formatOpaqueModEventId(db, params.groupDid, r.seq),
      createdAt: r.created_at,
      subject: r.subject,
      ...(r.cid_key !== "" ? { cid: r.cid_key } : {}),
      // Explicitly omit createdBy and project allowlisted fields (stripping notes from statusEvent & appealEvent)
      event: projectSelfVisibleEvent(JSON.parse(r.event_json) as Record<string, unknown>),
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export function executeUpdateModSubjectSync(
  db: GroupHostDb,
  params: {
    groupDid: string;
    actorDid: string;
    session?: AuthenticatedGroupSession;
    subject: string;
    cid?: string;
    status?: "open" | "resolved";
    note?: string;
    addTags?: readonly string[];
    removeTags?: readonly string[];
    nowMs?: number;
  },
): ModSubjectView {
  validateModSubjectIdentifier(params.groupDid, params.subject);
  if (params.status !== undefined && params.status !== "open" && params.status !== "resolved") {
    throw new GroupHostHttpError(400, "InvalidRequest", "status must be 'open' or 'resolved'.");
  }
  const addTags = params.addTags ? [...new Set(params.addTags)] : [];
  const removeTags = params.removeTags ? [...new Set(params.removeTags)] : [];
  if (addTags.length > MAX_TAGS_PER_REQUEST || removeTags.length > MAX_TAGS_PER_REQUEST) {
    throw new GroupHostHttpError(
      400,
      "InvalidRequest",
      `addTags and removeTags cannot exceed ${MAX_TAGS_PER_REQUEST} entries each.`,
    );
  }
  for (const tag of [...addTags, ...removeTags]) {
    if (!isValidModTag(tag)) {
      throw new GroupHostHttpError(400, "InvalidRequest", `Invalid moderation tag '${tag}'.`);
    }
  }
  const addSet = new Set(addTags);
  for (const tag of removeTags) {
    if (addSet.has(tag)) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        `Tag '${tag}' cannot appear in both addTags and removeTags.`,
      );
    }
  }

  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cidKey = params.cid ?? "";
  const subjectOwnerDid = deriveSubjectOwnerDid(params.subject);

  const tx = db.transaction(() => {
    reapExpiredPreparedMigrationLease(db, params.groupDid, nowMs);
    if (hasActiveSourceMigrationLease(db, params.groupDid, nowMs)) {
      throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
    }
    if (params.session) {
      const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(db, params.session, { nowMs });
      commitPerms.assertRpc({
        aud: `${params.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: ATGRP_METHOD.modUpdateSubject as NsidString,
      });
    }
    const existing = db
      .prepare(
        "SELECT subject, cid_key, status, report_count, created_at, updated_at FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ?",
      )
      .get(params.groupDid, params.subject, cidKey) as
      | {
          subject: string;
          cid_key: string;
          status: "open" | "resolved";
          report_count: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!existing) {
      throw new GroupHostHttpError(400, "SubjectNotFound", "The subject has never been reported.");
    }

    const currentTags = new Set(loadSubjectTags(db, params.groupDid, params.subject, cidKey));
    const actuallyRemoved = removeTags.filter((t) => currentTags.has(t)).sort();
    for (const t of actuallyRemoved) currentTags.delete(t);
    const actuallyAdded = addTags.filter((t) => !currentTags.has(t)).sort();
    for (const t of actuallyAdded) currentTags.add(t);

    if (currentTags.size > MAX_TAGS_PER_SUBJECT) {
      throw new GroupHostHttpError(
        400,
        "InvalidRequest",
        `Subject cannot exceed ${MAX_TAGS_PER_SUBJECT} moderation tags.`,
      );
    }

    const nextStatus = params.status ?? existing.status;
    const hasStatusOrNote = params.status !== undefined || params.note !== undefined;
    const hasTagMutation = actuallyAdded.length > 0 || actuallyRemoved.length > 0;
    const nextUpdatedAt = hasStatusOrNote || hasTagMutation ? nowIso : existing.updated_at;

    if (hasStatusOrNote || hasTagMutation) {
      db.prepare(
        "UPDATE mod_subject SET status = ?, updated_at = ? WHERE group_did = ? AND subject = ? AND cid_key = ?",
      ).run(nextStatus, nextUpdatedAt, params.groupDid, params.subject, cidKey);
    }

    if (actuallyRemoved.length > 0) {
      const delStmt = db.prepare(
        "DELETE FROM mod_subject_tag WHERE group_did = ? AND subject = ? AND cid_key = ? AND tag = ?",
      );
      for (const tag of actuallyRemoved) {
        delStmt.run(params.groupDid, params.subject, cidKey, tag);
      }
    }
    if (actuallyAdded.length > 0) {
      const insStmt = db.prepare(
        "INSERT OR IGNORE INTO mod_subject_tag (group_did, subject, cid_key, tag) VALUES (?, ?, ?, ?)",
      );
      for (const tag of actuallyAdded) {
        insStmt.run(params.groupDid, params.subject, cidKey, tag);
      }
    }

    if (hasStatusOrNote) {
      const eventType = ATGRP_MOD_EVENT_TYPE.status;
      const eventObj = {
        $type: eventType,
        status: nextStatus,
        ...(params.note !== undefined ? { note: params.note } : {}),
      };
      db.prepare(
        `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.groupDid,
        params.subject,
        cidKey,
        subjectOwnerDid,
        isModEventSelfVisible(eventType),
        nowIso,
        params.actorDid,
        JSON.stringify(eventObj),
      );
    }

    if (hasTagMutation) {
      const eventType = ATGRP_MOD_EVENT_TYPE.tag;
      const eventObj = {
        $type: eventType,
        ...(actuallyAdded.length > 0 ? { add: actuallyAdded } : {}),
        ...(actuallyRemoved.length > 0 ? { remove: actuallyRemoved } : {}),
      };
      db.prepare(
        `INSERT INTO mod_event (group_did, subject, cid_key, subject_owner_did, is_self_visible, created_at, created_by, event_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.groupDid,
        params.subject,
        cidKey,
        subjectOwnerDid,
        isModEventSelfVisible(eventType),
        nowIso,
        params.actorDid,
        JSON.stringify(eventObj),
      );
    }

    const sortedTags = [...currentTags].sort();
    return formatSubjectView(
      {
        ...existing,
        status: nextStatus,
        updated_at: nextUpdatedAt,
      },
      sortedTags,
    );
  });

  return tx.immediate();
}
