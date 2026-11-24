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
  groupMetaUri,
  isDid,
  parseAnySpaceRecordUri,
  SELF_SKEY,
  spaceRecordUri,
} from "@flock/protocol/keys";
import { OPENSOCIAL_COLLECTION, OPENSOCIAL_METHOD } from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { DeskShellDeps } from "./membership";

const MAX_MOD_META_RULES = 200;
const MAX_REPORT_RESPONSE_BYTES = 64 * 1024;
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
  "spam",
  "violation",
  "misleading",
  "nsfw",
  "rude",
  "other",
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
 * Reads and validates `<groupDid>`'s `group.opensocial.labeler/self` (if present) and
 * `group.opensocial.rule` records from `group.opensocial.meta/self`.
 */
export async function readGroupModerationConfig(
  deps: SpaceCredentialDeps,
  groupDid: string,
): Promise<GroupModerationConfig> {
  if (!isDid(groupDid)) throw new TypeError("Invalid group DID.");
  const metaUri = groupMetaUri(groupDid);
  const metaCred = await mintSpaceCredentialWith(deps, metaUri);

  const readAt = async (endpoint: string) => {
    const client = metaCred.client(endpoint);
    return Promise.all([
      listBoundedRecords(client, {
        space: metaUri,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.labeler,
        maxRecords: 1,
      }),
      listBoundedRecords(client, {
        space: metaUri,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.rule,
        maxRecords: MAX_MOD_META_RULES,
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
    validateSpaceRecord(OPENSOCIAL_COLLECTION.labeler, selfLabelerValue, {
      authorityDid: groupDid,
      spaceUri: metaUri,
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
      !validateSpaceRecord(OPENSOCIAL_COLLECTION.rule, recValue, {
        authorityDid: groupDid,
        spaceUri: metaUri,
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
      uri: spaceRecordUri(metaUri, groupDid, OPENSOCIAL_COLLECTION.rule, rec.rkey),
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
 * Pure client-side precondition validator matching `apps/group-host/src/moderation.ts:145-240`.
 * Used by both the Report UI and `reportSubject()`.
 */
export function validateReportPreconditions(
  config: GroupModerationConfig,
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

  const labeler = config.labeler;
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

  if (input.reasonType === "violation" && !input.rule) {
    throw new ReportPreconditionError("Reports with reasonType 'violation' require citing a group rule URI.");
  }

  if (input.rule !== undefined) {
    const metaUri = groupMetaUri(input.groupDid);
    const parsedRule = parseAnySpaceRecordUri(input.rule);
    if (
      !parsedRule ||
      parsedRule.spaceUri !== metaUri ||
      parsedRule.repoDid !== input.groupDid ||
      parsedRule.collection !== OPENSOCIAL_COLLECTION.rule
    ) {
      throw new ReportPreconditionError("Cited rule must be a group.opensocial.rule URI in meta/self.");
    }
    if (!config.rules.some((r) => r.uri === input.rule)) {
      throw new ReportPreconditionError("Cited rule does not exist in this group's meta/self space.");
    }
  }

  return {
    targetSpaceUri,
    subjectType,
    ...(subjectCollection !== undefined ? { subjectCollection } : {}),
  };
}

/**
 * Submits a moderation report (`group.opensocial.createReport`) directly to `<groupDid>`'s Group Host:
 * 1. Verifies the caller currently holds read access to the subject's space via a fresh space credential.
 * 2. Reads & validates `<groupDid>`'s `labeler/self` + `rule/*` config and enforces all Group Host preconditions.
 * 3. Calls `POST <groupHost>/xrpc/group.opensocial.createReport` with personal service JWT (`aud: <groupDid>#atproto_pds`).
 */
export async function reportSubject(
  deps: DeskShellDeps,
  input: ReportSubjectInput,
): Promise<{ id: string; createdAt: string }> {
  if (!isDid(input.groupDid)) throw new ReportPreconditionError("Invalid group DID.");
  if (deps.did === input.groupDid) {
    throw new ReportPreconditionError("createReport must act as a personal account, never the group DID.");
  }

  // First load group moderation config and validate all labeler/rule/subject preconditions.
  const config = await readGroupModerationConfig(deps, input.groupDid);
  const { targetSpaceUri } = validateReportPreconditions(config, input);

  // Enforce precondition #1: caller currently holds read access to the subject's space.
  await mintSpaceCredentialWith(deps, targetSpaceUri);

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
        lxm: OPENSOCIAL_METHOD.createReport,
      },
    );
    const response = await deps.fetchEndpoint(
      new Request(new URL(`/xrpc/${OPENSOCIAL_METHOD.createReport}`, endpoint), {
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
    const body = await readUpstreamJson<{ id?: string; createdAt?: string; error?: string; message?: string }>(
      response,
      MAX_REPORT_RESPONSE_BYTES,
    );
    if (!response.ok) {
      throw new XrpcError(
        response.status,
        body?.message ?? `createReport failed (${response.status}).`,
        body?.error ?? "XrpcError",
      );
    }
    const id = body?.id;
    const createdAt = body?.createdAt;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > MAX_REPORT_ID_LENGTH ||
      typeof createdAt !== "string" ||
      !isValidIsoDatetime(createdAt)
    ) {
      throw new XrpcError(
        502,
        "Group Host returned a malformed createReport receipt.",
        "InvalidReportResponse",
      );
    }
    return { id, createdAt };
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
