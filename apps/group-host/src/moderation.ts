import { parseCid } from "@atproto/lex-data";
import type { DidString, NsidString } from "@atproto/syntax";
import { groupMembersUri, groupMetaUri, isDid, parseAnySpaceRecordUri } from "@flock/protocol/keys";
import { OPENSOCIAL_COLLECTION, OPENSOCIAL_METHOD } from "@flock/protocol/nsids";
import type { GroupHostDb } from "./db";
import { revalidateLiveOAuthSessionSync, type AuthenticatedGroupSession } from "./oauth";
import { GroupHostHttpError } from "./plc";
import { liveRoleGrantsRead, loadLiveGovernanceState, reapExpiredPreparedMigrationLease, hasActiveSourceMigrationLease } from "./rbac";

export type LabelerRecordValue = {
  policies: {
    labelValues: string[];
    labelValueDefinitions?: unknown[];
  };
  reasonTypes?: string[];
  subjectTypes?: Array<"account" | "record">;
  subjectCollections?: string[];
};

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

  const eventObj = {
    $type: "group.opensocial.defs#labelEvent",
    uri: params.labelRecordUri,
    val: params.val,
    ...(params.deleted ? { deleted: true } : {}),
  };
  db.prepare(
    `INSERT INTO mod_event (group_did, subject, cid_key, created_at, created_by, event_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.groupDid,
    params.subjectUri,
    cidKey,
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
  const existing = db
    .prepare("SELECT status FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ''")
    .get(params.groupDid, params.ejectedMemberDid) as { status: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE mod_subject SET updated_at = ? WHERE group_did = ? AND subject = ? AND cid_key = ''",
    ).run(params.nowIso, params.groupDid, params.ejectedMemberDid);
    const eventObj = {
      $type: "group.opensocial.defs#ejectEvent",
    };
    db.prepare(
      `INSERT INTO mod_event (group_did, subject, cid_key, created_at, created_by, event_json)
       VALUES (?, ?, '', ?, ?, ?)`,
    ).run(
      params.groupDid,
      params.ejectedMemberDid,
      params.nowIso,
      params.actorDid ?? null,
      JSON.stringify(eventObj),
    );
  }
}

function validateModSubjectIdentifier(groupDid: string, subject: string): void {
  if (isDid(subject)) return;
  const parsed = parseAnySpaceRecordUri(subject);
  if (!parsed || parsed.authorityDid !== groupDid) {
    throw new GroupHostHttpError(400, "InvalidSubject", "Subject is not an account DID or space record URI of this group.");
  }
}

export function executeCreateReportSync(
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
): { id: string; createdAt: string } {
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (params.callerDid === params.groupDid) {
    throw new GroupHostHttpError(400, "CannotTargetGroupSelf", "createReport acts strictly as a personal account, never the group DID.");
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
    const metaSpaceUri = groupMetaUri(params.groupDid);
    const membersSpaceUri = groupMembersUri(params.groupDid);

    let subjectType: "account" | "record";
    let subjectCollection: string | undefined;

    if (isDid(params.subject)) {
      subjectType = "account";
      if (params.cid !== undefined) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Account DID reports cannot include a cid.");
      }
      if (!liveRoleGrantsRead(state, membersSpaceUri, params.callerDid, params.groupDid)) {
        throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
      }
      // Accept implicit group account (`subject === groupDid`) OR existing membership/<subject>
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
        // Host-stored `<groupDid>` record
        const recRow = db
          .prepare(
            "SELECT cid FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
          )
          .get(parsed.spaceUri, params.groupDid, parsed.collection, parsed.rkey) as { cid: string } | undefined;
        if (!recRow || (params.cid !== undefined && recRow.cid !== params.cid)) {
          throw new GroupHostHttpError(400, "InvalidSubject", "The subject isn't in this group.");
        }
      } else {
        // Member/bot personal-PDS record: must currently exist as an active writer in `space_writer`!
        const writerRow = db
          .prepare(
            "SELECT removed FROM space_writer WHERE space_uri = ? AND writer_did = ?",
          )
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

    // Validate against `labeler/self` filters & `rule` requirement
    const labelerRow = db
      .prepare(
        "SELECT value FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = 'self'",
      )
      .get(metaSpaceUri, params.groupDid, OPENSOCIAL_COLLECTION.labeler) as { value: string } | undefined;
    if (labelerRow) {
      const labeler = JSON.parse(labelerRow.value) as LabelerRecordValue;
      if (labeler.reasonTypes && !labeler.reasonTypes.includes(params.reasonType)) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Report reasonType '${params.reasonType}' is not accepted by this group.`);
      }
      if (labeler.subjectTypes && !labeler.subjectTypes.includes(subjectType)) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Report subjectType '${subjectType}' is not accepted by this group.`);
      }
      if (subjectCollection && labeler.subjectCollections && !labeler.subjectCollections.includes(subjectCollection)) {
        throw new GroupHostHttpError(400, "InvalidRequest", `Report collection '${subjectCollection}' is not accepted by this group.`);
      }
    }

    if (params.reasonType === "violation" && !params.rule) {
      throw new GroupHostHttpError(400, "InvalidRequest", "reasonType 'violation' requires citing 'rule'.");
    }
    if (params.rule !== undefined) {
      const parsedRule = parseAnySpaceRecordUri(params.rule);
      if (
        !parsedRule ||
        parsedRule.spaceUri !== metaSpaceUri ||
        parsedRule.repoDid !== params.groupDid ||
        parsedRule.collection !== OPENSOCIAL_COLLECTION.rule
      ) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Cited rule must be a group.opensocial.rule record in meta/self.");
      }
      const ruleExists = db
        .prepare(
          "SELECT 1 AS ok FROM space_record WHERE space_uri = ? AND repo_did = ? AND collection = ? AND rkey = ?",
        )
        .get(metaSpaceUri, params.groupDid, OPENSOCIAL_COLLECTION.rule, parsedRule.rkey);
      if (!ruleExists) {
        throw new GroupHostHttpError(400, "InvalidRequest", "Cited rule record does not exist in meta/self.");
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
      const nextStatus = existingSubject.status === "resolved" ? "open" : existingSubject.status;
      db.prepare(
        `UPDATE mod_subject
         SET status = ?, report_count = report_count + 1, updated_at = ?
         WHERE group_did = ? AND subject = ? AND cid_key = ?`,
      ).run(nextStatus, nowIso, params.groupDid, params.subject, cidKey);
    }

    const eventObj = {
      $type: "group.opensocial.defs#reportEvent",
      reasonType: params.reasonType,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.rule !== undefined ? { rule: params.rule } : {}),
    };
    const info = db
      .prepare(
        `INSERT INTO mod_event (group_did, subject, cid_key, created_at, created_by, event_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(params.groupDid, params.subject, cidKey, nowIso, params.callerDid, JSON.stringify(eventObj));

    return { id: String(info.lastInsertRowid), createdAt: nowIso };
  });

  return tx.immediate();
}

export function executeListModSubjects(
  db: GroupHostDb,
  params: {
    groupDid: string;
    status?: "open" | "escalated" | "resolved";
    limit?: number;
    cursor?: string;
  },
): {
  subjects: Array<{
    subject: string;
    cid?: string;
    status: "open" | "escalated" | "resolved";
    createdAt: string;
    updatedAt: string;
    reportCount: number;
  }>;
  cursor?: string;
} {
  const status = params.status ?? "open";
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
  ) {
    throw new GroupHostHttpError(400, "InvalidRequest", "limit must be an integer between 1 and 100.");
  }
  const limit = params.limit ?? 50;

  let cursorDecoded: { updatedAt: string; subject: string; cidKey: string } | null = null;
  if (params.cursor !== undefined) {
    try {
      const raw = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
      if (
        typeof raw?.updatedAt !== "string" ||
        typeof raw?.subject !== "string" ||
        typeof raw?.cidKey !== "string"
      ) {
        throw new Error("bad cursor");
      }
      cursorDecoded = { updatedAt: raw.updatedAt, subject: raw.subject, cidKey: raw.cidKey };
    } catch {
      throw new GroupHostHttpError(400, "InvalidCursor", "Malformed listModSubjects cursor.");
    }
  }

  const rows = cursorDecoded
    ? (db
        .prepare(
          `SELECT subject, cid_key, status, report_count, created_at, updated_at
           FROM mod_subject
           WHERE group_did = ? AND status = ?
             AND (
               updated_at < ?
               OR (updated_at = ? AND subject > ?)
               OR (updated_at = ? AND subject = ? AND cid_key > ?)
             )
           ORDER BY updated_at DESC, subject ASC, cid_key ASC
           LIMIT ?`,
        )
        .all(
          params.groupDid,
          status,
          cursorDecoded.updatedAt,
          cursorDecoded.updatedAt,
          cursorDecoded.subject,
          cursorDecoded.updatedAt,
          cursorDecoded.subject,
          cursorDecoded.cidKey,
          limit + 1,
        ) as Array<{
        subject: string;
        cid_key: string;
        status: "open" | "escalated" | "resolved";
        report_count: number;
        created_at: string;
        updated_at: string;
      }>)
    : (db
        .prepare(
          `SELECT subject, cid_key, status, report_count, created_at, updated_at
           FROM mod_subject
           WHERE group_did = ? AND status = ?
           ORDER BY updated_at DESC, subject ASC, cid_key ASC
           LIMIT ?`,
        )
        .all(params.groupDid, status, limit + 1) as Array<{
        subject: string;
        cid_key: string;
        status: "open" | "escalated" | "resolved";
        report_count: number;
        created_at: string;
        updated_at: string;
      }>);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            updatedAt: last.updated_at,
            subject: last.subject,
            cidKey: last.cid_key,
          }),
          "utf8",
        ).toString("base64url")
      : undefined;

  return {
    subjects: page.map((r) => ({
      subject: r.subject,
      ...(r.cid_key !== "" ? { cid: r.cid_key } : {}),
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      reportCount: r.report_count,
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export function executeGetModSubjectHistory(
  db: GroupHostDb,
  params: {
    groupDid: string;
    subject: string;
    cid?: string;
    limit?: number;
    cursor?: string;
  },
): {
  events: Array<{
    id: string;
    createdAt: string;
    createdBy?: string;
    event: Record<string, unknown>;
  }>;
  cursor?: string;
} {
  validateModSubjectIdentifier(params.groupDid, params.subject);
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
  ) {
    throw new GroupHostHttpError(400, "InvalidRequest", "limit must be an integer between 1 and 100.");
  }
  const limit = params.limit ?? 50;

  let afterSeq = 0;
  if (params.cursor !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(params.cursor)) {
      throw new GroupHostHttpError(400, "InvalidCursor", "Malformed getModSubjectHistory cursor.");
    }
    afterSeq = Number(params.cursor);
  }

  const rows =
    params.cid !== undefined
      ? (db
          .prepare(
            `SELECT seq, created_at, created_by, event_json
             FROM mod_event
             WHERE group_did = ? AND subject = ? AND cid_key = ? AND seq > ?
             ORDER BY seq ASC
             LIMIT ?`,
          )
          .all(params.groupDid, params.subject, params.cid, afterSeq, limit + 1) as Array<{
          seq: number;
          created_at: string;
          created_by: string | null;
          event_json: string;
        }>)
      : (db
          .prepare(
            `SELECT seq, created_at, created_by, event_json
             FROM mod_event
             WHERE group_did = ? AND subject = ? AND seq > ?
             ORDER BY seq ASC
             LIMIT ?`,
          )
          .all(params.groupDid, params.subject, afterSeq, limit + 1) as Array<{
          seq: number;
          created_at: string;
          created_by: string | null;
          event_json: string;
        }>);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    events: page.map((r) => ({
      id: String(r.seq),
      createdAt: r.created_at,
      ...(r.created_by !== null ? { createdBy: r.created_by } : {}),
      event: JSON.parse(r.event_json) as Record<string, unknown>,
    })),
    ...(hasMore && last ? { cursor: String(last.seq) } : {}),
  };
}

export function executeResolveModSubjectSync(
  db: GroupHostDb,
  params: {
    groupDid: string;
    actorDid: string;
    session?: AuthenticatedGroupSession;
    subject: string;
    cid?: string;
    status: "resolved" | "escalated";
    note?: string;
    nowMs?: number;
  },
): {
  subject: string;
  cid?: string;
  status: "open" | "escalated" | "resolved";
  createdAt: string;
  updatedAt: string;
  reportCount: number;
} {
  validateModSubjectIdentifier(params.groupDid, params.subject);
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cidKey = params.cid ?? "";

  const tx = db.transaction(() => {
    reapExpiredPreparedMigrationLease(db, params.groupDid, nowMs);
    if (hasActiveSourceMigrationLease(db, params.groupDid, nowMs)) {
      throw new GroupHostHttpError(409, "MigrationInProgress", "Group is frozen during active migration.");
    }
    if (params.session) {
      const { permissions: commitPerms } = revalidateLiveOAuthSessionSync(db, params.session, { nowMs });
      commitPerms.assertRpc({
        aud: `${params.groupDid}#atproto_pds` as `${DidString}#${string}`,
        lxm: OPENSOCIAL_METHOD.resolveModSubject as NsidString,
      });
    }
    const existing = db
      .prepare(
        "SELECT subject, cid_key, status, report_count, created_at FROM mod_subject WHERE group_did = ? AND subject = ? AND cid_key = ?",
      )
      .get(params.groupDid, params.subject, cidKey) as
      | {
          subject: string;
          cid_key: string;
          status: string;
          report_count: number;
          created_at: string;
        }
      | undefined;

    if (!existing) {
      throw new GroupHostHttpError(400, "SubjectNotFound", "The subject has never been reported.");
    }

    db.prepare(
      "UPDATE mod_subject SET status = ?, updated_at = ? WHERE group_did = ? AND subject = ? AND cid_key = ?",
    ).run(params.status, nowIso, params.groupDid, params.subject, cidKey);

    const eventObj = {
      $type: "group.opensocial.defs#statusEvent",
      status: params.status,
      ...(params.note !== undefined ? { note: params.note } : {}),
    };
    db.prepare(
      `INSERT INTO mod_event (group_did, subject, cid_key, created_at, created_by, event_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(params.groupDid, params.subject, cidKey, nowIso, params.actorDid, JSON.stringify(eventObj));

    return {
      subject: existing.subject,
      ...(existing.cid_key !== "" ? { cid: existing.cid_key } : {}),
      status: params.status,
      createdAt: existing.created_at,
      updatedAt: nowIso,
      reportCount: existing.report_count,
    };
  });

  return tx.immediate();
}
