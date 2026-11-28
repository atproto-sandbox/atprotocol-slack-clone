import { readUpstreamJson } from "@flock/protocol/bounded-json";
import { listBoundedRecords } from "@flock/protocol/atproto/record-pages";
import {
  mintSpaceCredentialWith,
  SpaceCredentialError,
  type SpaceCredentialDeps,
} from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  groupMembersUri,
  isDid,
  parseAnySpaceRecordUri,
  SELF_SKEY,
  spaceRecordUri,
} from "@flock/protocol/keys";
import { ATGRP_COLLECTION, ATGRP_METHOD, ATGRP_MOD_REASON } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { DeskShellDeps } from "./membership";

const MAX_MOD_RULES = 200;
const MAX_MOD_RESPONSE_BYTES = 256 * 1024;
const MAX_REPORT_ID_LENGTH = 512;
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidIsoDatetime(value: string): boolean {
  const match = ISO_DATETIME_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

export const STANDARD_REPORT_REASON_TYPES = [
  ATGRP_MOD_REASON.spam,
  ATGRP_MOD_REASON.violation,
  ATGRP_MOD_REASON.misleading,
  ATGRP_MOD_REASON.nsfw,
  ATGRP_MOD_REASON.rude,
  ATGRP_MOD_REASON.other,
] as const;

export type GroupLabelerConfig = {
  policies: {
    labelValues: string[];
    labelValueDefinitions?: unknown[];
  };
  reasonTypes?: string[];
  subjectTypes?: Array<"account" | "record">;
  subjectCollections?: string[];
};

export type GroupModerationRule = {
  uri: string;
  rkey: string;
  title: string;
  text: string;
  order?: number;
};

export type GroupModerationConfig = {
  labeler?: GroupLabelerConfig;
  rules: GroupModerationRule[];
};

export type ReportSubjectInput = {
  groupDid: string;
  subject: string;
  cid?: string;
  reasonType: string;
  reason?: string;
  rule?: string;
};

export type SubmitAppealInput = {
  groupDid: string;
  subject: string;
  reason?: string;
};

export type QuerySelfHistoryInput = {
  groupDid: string;
  subject?: string;
  sort?: "newest" | "oldest";
  limit?: number;
  cursor?: string;
};

export type SelfModerationHistoryEvent = {
  eventId: string;
  createdAt: string;
  subject: string;
  cid?: string;
  event: Record<string, unknown>;
};

export class ReportPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportPreconditionError";
  }
}

const STALE_HOST_CODES: ReadonlySet<string> = new Set([
  "RepoNotFound",
  "GroupNotFound",
  "SpaceNotFound",
  "RepoTakendown",
  "RepoDeactivated",
]);

function isStaleHostError(error: unknown): boolean {
  if (error instanceof XrpcError && STALE_HOST_CODES.has(error.code)) return true;
  if (error instanceof SpaceCredentialError && error.code !== undefined && STALE_HOST_CODES.has(error.code)) {
    return true;
  }
  return false;
}

/**
 * Reads and validates `<groupDid>`'s `org.atgrp.labeler/self` (if present) and
 * `org.atgrp.rule` records from `org.atgrp.members/self`.
 */
export async function readGroupModerationConfig(
  deps: SpaceCredentialDeps,
  groupDid: string,
): Promise<GroupModerationConfig> {
  if (!isDid(groupDid)) throw new TypeError("Invalid group DID.");
  const membersUri = groupMembersUri(groupDid);
  const membersCred = await mintSpaceCredentialWith(deps, membersUri);

  const readAt = async (endpoint: string) => {
    const client = membersCred.client(endpoint);
    return Promise.all([
      listBoundedRecords(client, {
        space: membersUri,
        repo: groupDid,
        collection: ATGRP_COLLECTION.labeler,
        maxRecords: 1,
      }),
      listBoundedRecords(client, {
        space: membersUri,
        repo: groupDid,
        collection: ATGRP_COLLECTION.rule,
        maxRecords: MAX_MOD_RULES,
      }),
    ]);
  };

  let endpoint = await deps.resolvePds(groupDid);
  let labelerScan: Awaited<ReturnType<typeof listBoundedRecords>>;
  let ruleScan: Awaited<ReturnType<typeof listBoundedRecords>>;
  try {
    [labelerScan, ruleScan] = await readAt(endpoint);
  } catch (error) {
    if (!isStaleHostError(error)) throw error;
    const refreshed = await deps.resolvePds(groupDid, true);
    if (refreshed === endpoint) throw error;
    endpoint = refreshed;
    [labelerScan, ruleScan] = await readAt(endpoint);
  }

  let labeler: GroupLabelerConfig | undefined;
  const selfLabeler = labelerScan.records.find((r) => r.rkey === SELF_SKEY);
  const selfLabelerValue = selfLabeler?.value;
  if (
    selfLabelerValue &&
    validateSpaceRecord(ATGRP_COLLECTION.labeler, selfLabelerValue, {
      authorityDid: groupDid,
      spaceUri: membersUri,
      repoDid: groupDid,
      rkey: SELF_SKEY,
    }).valid
  ) {
    const val = selfLabelerValue;
    const policies = val.policies as { labelValues?: unknown; labelValueDefinitions?: unknown[] } | undefined;
    const labelValues = Array.isArray(policies?.labelValues)
      ? policies.labelValues.filter((v): v is string => typeof v === "string")
      : [];
    const reasonTypes = Array.isArray(val.reasonTypes)
      ? val.reasonTypes.filter((v): v is string => typeof v === "string")
      : undefined;
    const subjectTypes = Array.isArray(val.subjectTypes)
      ? val.subjectTypes.filter((v): v is "account" | "record" => v === "account" || v === "record")
      : undefined;
    const subjectCollections = Array.isArray(val.subjectCollections)
      ? val.subjectCollections.filter((v): v is string => typeof v === "string")
      : undefined;

    labeler = {
      policies: {
        labelValues,
        ...(Array.isArray(policies?.labelValueDefinitions)
          ? { labelValueDefinitions: policies.labelValueDefinitions }
          : {}),
      },
      ...(reasonTypes !== undefined ? { reasonTypes } : {}),
      ...(subjectTypes !== undefined ? { subjectTypes } : {}),
      ...(subjectCollections !== undefined ? { subjectCollections } : {}),
    };
  }

  const rules: GroupModerationRule[] = [];
  for (const rec of ruleScan.records) {
    const recValue = rec.value;
    if (
      !recValue ||
      !validateSpaceRecord(ATGRP_COLLECTION.rule, recValue, {
        authorityDid: groupDid,
        spaceUri: membersUri,
        repoDid: groupDid,
        rkey: rec.rkey,
      }).valid
    ) {
      continue;
    }
    const title = typeof recValue.title === "string" ? recValue.title : rec.rkey;
    const text = typeof recValue.text === "string" ? recValue.text : "";
    const order = typeof recValue.order === "number" ? recValue.order : undefined;
    rules.push({
      uri: spaceRecordUri(membersUri, groupDid, ATGRP_COLLECTION.rule, rec.rkey),
      rkey: rec.rkey,
      title,
      text,
      ...(order !== undefined ? { order } : {}),
    });
  }
  rules.sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title) || a.rkey.localeCompare(b.rkey);
  });

  return {
    ...(labeler !== undefined ? { labeler } : {}),
    rules,
  };
}

/**
 * Pure client-side precondition validator matching `apps/group-host/src/moderation.ts`.
 * When `config` is `null` (best-effort fallback for spec-only hosts where `readGroupModerationConfig`
 * was unavailable), validates local syntax/group-binding/rule-URI invariants without blocking on remote config.
 */
export function validateReportPreconditions(
  config: GroupModerationConfig | null,
  input: ReportSubjectInput,
): { targetSpaceUri: string; subjectType: "account" | "record"; subjectCollection?: string } {
  if (!isDid(input.groupDid)) {
    throw new ReportPreconditionError("Invalid group DID.");
  }
  if (
    typeof input.reasonType !== "string" ||
    input.reasonType.trim().length === 0 ||
    input.reasonType !== input.reasonType.trim()
  ) {
    throw new ReportPreconditionError("Report reasonType must be a non-empty trimmed string.");
  }

  let subjectType: "account" | "record";
  let subjectCollection: string | undefined;
  let targetSpaceUri: string;

  if (isDid(input.subject)) {
    subjectType = "account";
    targetSpaceUri = groupMembersUri(input.groupDid);
    if (input.cid !== undefined) {
      throw new ReportPreconditionError("Account DID reports must omit cid.");
    }
  } else {
    subjectType = "record";
    const parsed = parseAnySpaceRecordUri(input.subject);
    if (!parsed || parsed.authorityDid !== input.groupDid) {
      throw new ReportPreconditionError("Subject must be an account DID or a space record URI belonging to this group.");
    }
    targetSpaceUri = parsed.spaceUri;
    subjectCollection = parsed.collection;
  }

  const labeler = config?.labeler;
  if (labeler) {
    if (labeler.subjectTypes && !labeler.subjectTypes.includes(subjectType)) {
      throw new ReportPreconditionError(`Report subjectType '${subjectType}' is not accepted by this group.`);
    }
    if (subjectCollection && labeler.subjectCollections && !labeler.subjectCollections.includes(subjectCollection)) {
      throw new ReportPreconditionError(`Report collection '${subjectCollection}' is not accepted by this group.`);
    }
    if (labeler.reasonTypes && !labeler.reasonTypes.includes(input.reasonType)) {
      throw new ReportPreconditionError(`Report reasonType '${input.reasonType}' is not accepted by this group.`);
    }
  }

  if (input.reasonType === ATGRP_MOD_REASON.violation && !input.rule) {
    throw new ReportPreconditionError(`Reports with reasonType '${ATGRP_MOD_REASON.violation}' require citing a group rule URI.`);
  }

  if (input.rule !== undefined) {
    const membersUri = groupMembersUri(input.groupDid);
    const parsedRule = parseAnySpaceRecordUri(input.rule);
    if (
      !parsedRule ||
      parsedRule.spaceUri !== membersUri ||
      parsedRule.repoDid !== input.groupDid ||
      parsedRule.collection !== ATGRP_COLLECTION.rule
    ) {
      throw new ReportPreconditionError("Cited rule must be an org.atgrp.rule URI in members/self.");
    }
    if (config && !config.rules.some((r) => r.uri === input.rule)) {
      throw new ReportPreconditionError("Cited rule does not exist in this group's members/self space.");
    }
  }

  return {
    targetSpaceUri,
    subjectType,
    ...(subjectCollection !== undefined ? { subjectCollection } : {}),
  };
}

/**
 * Submits a moderation report (`org.atgrp.mod.submitReport`) directly to `<groupDid>`'s Group Host:
 * 1. Best-effort reads `<groupDid>`'s `labeler/self` + `rule/*` config from `org.atgrp.members/self` and validates preconditions.
 * 2. Calls `POST <groupHost>/xrpc/org.atgrp.mod.submitReport` with a fresh personal service JWT (`aud: <groupDid>#atproto_pds`).
 */
export async function reportSubject(
  deps: DeskShellDeps,
  input: ReportSubjectInput,
): Promise<{ eventId: string; createdAt: string }> {
  if (!isDid(input.groupDid)) throw new ReportPreconditionError("Invalid group DID.");
  if (deps.did === input.groupDid) {
    throw new ReportPreconditionError("submitReport must act as a personal account, never the group DID.");
  }

  // Best-effort load group moderation config from members/self so spec-only hosts without custom config
  // or unreadable labeler spaces do not block report submission.
  let config: GroupModerationConfig | null = null;
  try {
    config = await readGroupModerationConfig(deps, input.groupDid);
  } catch {
    config = null;
  }
  const { targetSpaceUri } = validateReportPreconditions(config, input);

  // When config loaded cleanly, also verify read access to the subject space up front for fast feedback;
  // if minting fails due to a non-access error on a spec-only host, let the server adjudicate.
  if (config !== null) {
    await mintSpaceCredentialWith(deps, targetSpaceUri);
  }

  const payload: Record<string, unknown> = {
    group: input.groupDid,
    subject: input.subject,
    reasonType: input.reasonType,
    ...(input.cid !== undefined ? { cid: input.cid } : {}),
    ...(input.reason !== undefined && input.reason.trim().length > 0 ? { reason: input.reason } : {}),
    ...(input.rule !== undefined ? { rule: input.rule } : {}),
  };

  const submitAt = async (endpoint: string) => {
    const { token } = await deps.memberClient.query<{ token: string }>(
      "com.atproto.server.getServiceAuth",
      {
        aud: `${input.groupDid}#atproto_pds`,
        lxm: ATGRP_METHOD.modSubmitReport,
      },
    );
    const response = await deps.fetchEndpoint(
      new Request(new URL(`/xrpc/${ATGRP_METHOD.modSubmitReport}`, endpoint), {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      }),
    );
    const body = await readUpstreamJson<{ eventId?: string; createdAt?: string; error?: string; message?: string }>(
      response,
      MAX_MOD_RESPONSE_BYTES,
    );
    if (!response.ok) {
      throw new XrpcError(
        response.status,
        body?.message ?? `submitReport failed (${response.status}).`,
        body?.error ?? "XrpcError",
      );
    }
    const eventId = body?.eventId;
    const createdAt = body?.createdAt;
    if (
      typeof eventId !== "string" ||
      eventId.length < 1 ||
      eventId.length > MAX_REPORT_ID_LENGTH ||
      typeof createdAt !== "string" ||
      !isValidIsoDatetime(createdAt)
    ) {
      throw new XrpcError(
        502,
        "Group Host returned a malformed submitReport receipt.",
        "InvalidReportResponse",
      );
    }
    return { eventId, createdAt };
  };

  const endpoint = await deps.resolvePds(input.groupDid);
  try {
    return await submitAt(endpoint);
  } catch (error) {
    if (!isStaleHostError(error)) throw error;
    const refreshed = await deps.resolvePds(input.groupDid, true);
    if (refreshed === endpoint) throw error;
    return submitAt(refreshed);
  }
}

function validateSelfModSubject(viewerDid: string, groupDid: string, subject: string): void {
  if (subject === viewerDid) return;
  const parsed = parseAnySpaceRecordUri(subject);
  if (!parsed || parsed.authorityDid !== groupDid || parsed.repoDid !== viewerDid) {
    throw new ReportPreconditionError(
      "Subject must be your own account DID or a space record URI you authored in this group.",
    );
  }
}

/**
 * Submits a moderation appeal (`org.atgrp.mod.submitAppeal`) directly to `<groupDid>`'s Group Host
 * using a fresh per-request personal service JWT (`aud: <groupDid>#atproto_pds`).
 * Works for both current and former (ejected/labeled) members without touching the Operator.
 */
export async function submitAppeal(
  deps: DeskShellDeps,
  input: SubmitAppealInput,
): Promise<{ eventId: string; createdAt: string }> {
  if (!isDid(input.groupDid)) throw new ReportPreconditionError("Invalid group DID.");
  if (deps.did === input.groupDid) {
    throw new ReportPreconditionError("submitAppeal must act as a personal account, never the group DID.");
  }
  validateSelfModSubject(deps.did, input.groupDid, input.subject);

  const payload: Record<string, unknown> = {
    group: input.groupDid,
    subject: input.subject,
    ...(input.reason !== undefined && input.reason.trim().length > 0 ? { reason: input.reason } : {}),
  };

  const submitAt = async (endpoint: string) => {
    const { token } = await deps.memberClient.query<{ token: string }>(
      "com.atproto.server.getServiceAuth",
      {
        aud: `${input.groupDid}#atproto_pds`,
        lxm: ATGRP_METHOD.modSubmitAppeal,
      },
    );
    const response = await deps.fetchEndpoint(
      new Request(new URL(`/xrpc/${ATGRP_METHOD.modSubmitAppeal}`, endpoint), {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      }),
    );
    const body = await readUpstreamJson<{ eventId?: string; createdAt?: string; error?: string; message?: string }>(
      response,
      MAX_MOD_RESPONSE_BYTES,
    );
    if (!response.ok) {
      throw new XrpcError(
        response.status,
        body?.message ?? `submitAppeal failed (${response.status}).`,
        body?.error ?? "XrpcError",
      );
    }
    const eventId = body?.eventId;
    const createdAt = body?.createdAt;
    if (
      typeof eventId !== "string" ||
      eventId.length < 1 ||
      eventId.length > MAX_REPORT_ID_LENGTH ||
      typeof createdAt !== "string" ||
      !isValidIsoDatetime(createdAt)
    ) {
      throw new XrpcError(
        502,
        "Group Host returned a malformed submitAppeal receipt.",
        "InvalidAppealResponse",
      );
    }
    return { eventId, createdAt };
  };

  const endpoint = await deps.resolvePds(input.groupDid);
  try {
    return await submitAt(endpoint);
  } catch (error) {
    if (!isStaleHostError(error)) throw error;
    const refreshed = await deps.resolvePds(input.groupDid, true);
    if (refreshed === endpoint) throw error;
    return submitAt(refreshed);
  }
}

/**
 * Queries the viewer's own moderation history (`org.atgrp.mod.querySelfHistory`) directly at `<groupDid>`'s
 * Group Host using a fresh per-request/per-page personal service JWT (`aud: <groupDid>#atproto_pds`).
 * Works for both current and former members without touching the Operator.
 */
export async function querySelfHistory(
  deps: DeskShellDeps,
  input: QuerySelfHistoryInput,
): Promise<{ events: SelfModerationHistoryEvent[]; cursor?: string }> {
  if (!isDid(input.groupDid)) throw new ReportPreconditionError("Invalid group DID.");
  if (deps.did === input.groupDid) {
    throw new ReportPreconditionError("querySelfHistory must act as a personal account, never the group DID.");
  }
  if (input.subject !== undefined) {
    validateSelfModSubject(deps.did, input.groupDid, input.subject);
  }

  const queryAt = async (endpoint: string) => {
    const { token } = await deps.memberClient.query<{ token: string }>(
      "com.atproto.server.getServiceAuth",
      {
        aud: `${input.groupDid}#atproto_pds`,
        lxm: ATGRP_METHOD.modQuerySelfHistory,
      },
    );
    const url = new URL(`/xrpc/${ATGRP_METHOD.modQuerySelfHistory}`, endpoint);
    url.searchParams.set("group", input.groupDid);
    if (input.subject !== undefined) url.searchParams.set("subject", input.subject);
    if (input.sort !== undefined) url.searchParams.set("sort", input.sort);
    if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
    if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);

    const response = await deps.fetchEndpoint(
      new Request(url, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      }),
    );
    const body = await readUpstreamJson<{
      events?: unknown;
      cursor?: unknown;
      error?: string;
      message?: string;
    }>(response, MAX_MOD_RESPONSE_BYTES);
    if (!response.ok) {
      throw new XrpcError(
        response.status,
        body?.message ?? `querySelfHistory failed (${response.status}).`,
        body?.error ?? "XrpcError",
      );
    }
    if (!body || !Array.isArray(body.events)) {
      throw new XrpcError(
        502,
        "Group Host returned a malformed querySelfHistory response.",
        "InvalidSelfHistoryResponse",
      );
    }
    const events: SelfModerationHistoryEvent[] = [];
    for (const raw of body.events) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new XrpcError(
          502,
          "Group Host returned a malformed querySelfHistory event.",
          "InvalidSelfHistoryResponse",
        );
      }
      const item = raw as Record<string, unknown>;
      if (
        typeof item.eventId !== "string" ||
        typeof item.createdAt !== "string" ||
        typeof item.subject !== "string" ||
        !item.event ||
        typeof item.event !== "object" ||
        Array.isArray(item.event)
      ) {
        throw new XrpcError(
          502,
          "Group Host returned a malformed querySelfHistory event.",
          "InvalidSelfHistoryResponse",
        );
      }
      events.push({
        eventId: item.eventId,
        createdAt: item.createdAt,
        subject: item.subject,
        ...(typeof item.cid === "string" ? { cid: item.cid } : {}),
        event: item.event as Record<string, unknown>,
      });
    }
    return {
      events,
      ...(typeof body.cursor === "string" && body.cursor.length > 0 ? { cursor: body.cursor } : {}),
    };
  };

  const endpoint = await deps.resolvePds(input.groupDid);
  try {
    return await queryAt(endpoint);
  } catch (error) {
    if (!isStaleHostError(error)) throw error;
    const refreshed = await deps.resolvePds(input.groupDid, true);
    if (refreshed === endpoint) throw error;
    return queryAt(refreshed);
  }
}
