import type * as GetRecord from "@flock/protocol/lexicons/api/types/com/atproto/space/getRecord";
import type * as ListRecords from "@flock/protocol/lexicons/api/types/com/atproto/space/listRecords";
import {
  assertBoundedRecordPage,
  listAllSpaceUris,
  listBoundedRecords,
  listBoundedWriters,
  type WriterWrite,
} from "@flock/protocol/atproto/record-pages";
import { classifyRepoFailure, describeRepoFailure, MAX_LISTED_SET_ASIDE } from "@flock/protocol/atproto/repo-failure";
import {
  mintSpaceCredentialWith,
  SpaceCredentialError,
  type SpaceCredential,
  type SpaceCredentialDeps,
} from "@flock/protocol/atproto/space-credential-core";
import { selectValidChannelMessages } from "@flock/protocol/atproto/valid-channel-messages";
import { isMissingXrpcResource, XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  groupMembersUri,
  groupMetaUri,
  isDid,
  isTid,
  parseGroupMembersUri,
  parseWorkspaceUri,
  personalInvitesUri,
  SELF_SKEY,
  spaceRecordUri,
  workspaceUri,
} from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import {
  isHidden,
  isTakendown,
  labelsForResource,
  projectActiveLabels,
  type ActiveSpaceLabel,
} from "@flock/protocol/moderation";
import {
  ATPROTO_SPACE_COLLECTION,
  COLLECTION,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_SPACE_TYPE,
} from "@flock/protocol/nsids";
import { validateSpaceRecord } from "@flock/protocol/registry";
import type { GroupOpenSocialPolicy } from "@flock/protocol/scopes";
import {
  extractGroupSpacePolicyRecord,
  summarizeWorkspace,
  WORKSPACE_ENVELOPE,
  type MemberAcceptanceEntry,
  type MemberWriterRev,
} from "@flock/protocol/workspace-summary";

export type IndependentWorkspace = {
  uri: string;
  authorityDid: string;
  groupDid: string;
  name: string;
  joinPolicy: string;
  publicMeta: boolean;
  members: string[];
  pendingMembers: string[];
  takendownMembers?: string[];
  rosterComplete?: boolean;
  admins: string[];
  moderators: string[];
  channels: Array<{ uri: string; skey: string; name: string; visibility: string }>;
  degradedReasons: string[];
};

export type IndependentInvite = {
  uri: string;
  rkey: string;
  groupDid: string;
  createdAt: string;
  expiresAt?: string;
  message?: string;
};

const MAX_SUPPORTED_MEMBERS = WORKSPACE_ENVELOPE.members;
const MAX_AUTHORITY_RECORD_SCAN = WORKSPACE_ENVELOPE.authorityRecordScan;
const MAX_DISCOVERABLE_WORKSPACES = 1_000;
const MAX_CHANNEL_WRITERS = 20_000;
const MAX_CHANNEL_RECORD_SCAN = 20_000;
const MAX_CHANNEL_RECORD_PAGES = MAX_CHANNEL_RECORD_SCAN + MAX_CHANNEL_WRITERS;
const MAX_CHANNEL_REACTION_RECORDS = 20_000;
const MAX_CHANNEL_REACTION_PAGES = MAX_CHANNEL_WRITERS + Math.ceil((MAX_CHANNEL_REACTION_RECORDS + 1) / 100) + 1;

/** What the reader needs from its host: the account's own client and the transports a space credential is minted with. */
export type IndependentDeps = SpaceCredentialDeps & {
  readonly did?: string;
};

export type IndependentMessage = {
  uri: string;
  rkey: string;
  repo: string;
  cid?: string;
  value: Record<string, unknown>;
  hidden?: boolean;
  labels?: string[];
};
export type IndependentReaction = {
  uri: string;
  rkey: string;
  repo: string;
  cid?: string;
  value: Record<string, unknown>;
  labels?: string[];
};
export type IndependentChannelPage = {
  messages: IndependentMessage[];
  reactions: IndependentReaction[];
  degraded: boolean;
  degradedReasons: string[];
};

function isTombstonedResolutionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("status" in error && (error.status === 404 || error.status === 410)) return true;
  if (error instanceof Error && /^fake-pds: no account registered for did:/.test(error.message)) return true;
  if (error instanceof Error && /\(404\)|\(410\)/.test(error.message)) return true;
  return false;
}

const STALE_GROUP_HOST_CODES = new Set([
  "RepoNotFound",
  "GroupNotFound",
  "SpaceNotFound",
  "RepoTakendown",
  "RepoDeactivated",
]);

function isStaleGroupHostError(error: unknown): boolean {
  if (error instanceof XrpcError && STALE_GROUP_HOST_CODES.has(error.code)) return true;
  if (error instanceof SpaceCredentialError && error.code !== undefined && STALE_GROUP_HOST_CODES.has(error.code)) {
    return true;
  }
  return false;
}

async function withGroupOriginRefresh<T>(
  deps: IndependentDeps,
  groupDid: string,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const initialOrigin = await deps.resolvePds(groupDid);
  try {
    return await run(initialOrigin);
  } catch (error) {
    if (!isStaleGroupHostError(error)) throw error;
    const refreshedOrigin = await deps.resolvePds(groupDid, true);
    if (refreshedOrigin === initialOrigin) throw error;
    return run(refreshedOrigin);
  }
}

/**
 * Stateless independent reader for a second OpenSocial + Flock client (`proposal.md:95-99`).
 * Uses only published `group.opensocial.*` + Flock lexicons and standard ATProto Space credentials.
 */
export async function listIndependentWorkspaces(deps: IndependentDeps): Promise<IndependentWorkspace[]> {
  const memberSpaces = await listAllSpaceUris(deps.memberClient, {
    spaceType: OPENSOCIAL_SPACE_TYPE.members,
    maxSpaces: MAX_DISCOVERABLE_WORKSPACES,
  });

  const groupDids: string[] = [];
  await mapLimited(memberSpaces, 8, async (membersUri) => {
    const parsed = parseGroupMembersUri(membersUri);
    if (!parsed) return;
    if (deps.did) {
      let hasOwnAcceptance = false;
      try {
        const rec = await deps.memberClient.query<{ value?: Record<string, unknown> }>(
          "com.atproto.space.getRecord",
          {
            space: membersUri,
            repo: deps.did,
            collection: OPENSOCIAL_COLLECTION.acceptance,
            rkey: SELF_SKEY,
          },
        );
        hasOwnAcceptance = rec.value !== undefined && rec.value !== null;
      } catch (error) {
        const isTrueAbsence =
          isMissingXrpcResource(error) ||
          (error instanceof XrpcError && error.code === "SpaceNotFound") ||
          isTombstonedResolutionError(error) ||
          error instanceof SpaceCredentialError;
        if (!isTrueAbsence) throw error;
      }
      if (!hasOwnAcceptance) return;
    }
    groupDids.push(parsed.groupDid);
  });

  const summaries = await mapLimited(groupDids, 8, async (groupDid) => {
    try {
      return await readIndependentWorkspace(deps, workspaceUri(groupDid));
    } catch (error) {
      if (error instanceof SpaceCredentialError || isTombstonedResolutionError(error)) return null;
      throw error;
    }
  });
  return summaries
    .flatMap((summary) => (summary ? [summary] : []))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readIndependentWorkspace(
  deps: IndependentDeps,
  uri: string,
): Promise<IndependentWorkspace | null> {
  const workspace = parseWorkspaceUri(uri);
  if (!workspace || workspace.skey !== SELF_SKEY) return null;
  const { authorityDid } = workspace;
  const metaUri = groupMetaUri(authorityDid);
  const membersUri = groupMembersUri(authorityDid);

  const [metaCred, membersCred, wsCred] = await Promise.all([
    mintSpaceCredentialWith(deps, metaUri),
    mintSpaceCredentialWith(deps, membersUri),
    mintSpaceCredentialWith(deps, uri),
  ]);

  const [
    profiles,
    metaPol,
    roles,
    memberships,
    membersPol,
    accountLabelScan,
    membersWriterScan,
    directory,
    installs,
    extInstalls,
    wsPol,
  ] = await withGroupOriginRefresh(deps, authorityDid, async (authorityPds) => {
    const metaClient = metaCred.client(authorityPds);
    const membersClient = membersCred.client(authorityPds);
    const wsClient = wsCred.client(authorityPds);

    return Promise.all([
      listBoundedRecords(metaClient, { space: metaUri, repo: authorityDid, collection: OPENSOCIAL_COLLECTION.profile, maxRecords: 1 }),
      listBoundedRecords(metaClient, { space: metaUri, repo: authorityDid, collection: ATPROTO_SPACE_COLLECTION.spacePolicy, maxRecords: 1 }),
      listBoundedRecords(membersClient, { space: membersUri, repo: authorityDid, collection: OPENSOCIAL_COLLECTION.role, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
      listBoundedRecords(membersClient, { space: membersUri, repo: authorityDid, collection: OPENSOCIAL_COLLECTION.membership, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
      listBoundedRecords(membersClient, { space: membersUri, repo: authorityDid, collection: ATPROTO_SPACE_COLLECTION.spacePolicy, maxRecords: 1 }),
      listBoundedRecords(membersClient, { space: membersUri, repo: authorityDid, collection: ATPROTO_SPACE_COLLECTION.label, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
      listBoundedWriters(membersClient, { space: membersUri, maxRepos: 2_000 }),
      listBoundedRecords(wsClient, { space: uri, repo: authorityDid, collection: COLLECTION.directory, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
      listBoundedRecords(wsClient, { space: uri, repo: authorityDid, collection: COLLECTION.appInstall, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
      listBoundedRecords(wsClient, { space: uri, repo: authorityDid, collection: COLLECTION.extInstall, maxRecords: MAX_AUTHORITY_RECORD_SCAN }),
      listBoundedRecords(wsClient, { space: uri, repo: authorityDid, collection: ATPROTO_SPACE_COLLECTION.spacePolicy, maxRecords: 1 }),
    ]);
  });

  const spacePolicies = new Map<string, GroupOpenSocialPolicy>();
  let invalidPolicyScan = false;
  for (const [spUri, polScan] of [
    [metaUri, metaPol],
    [membersUri, membersPol],
    [uri, wsPol],
  ] as const) {
    const extracted = extractGroupSpacePolicyRecord(authorityDid, spUri, polScan);
    if (extracted.valid && extracted.policy) {
      spacePolicies.set(spUri, extracted.policy);
    } else {
      invalidPolicyScan = true;
    }
  }

  const memberWriters = new Map<string, MemberWriterRev>();
  for (const w of membersWriterScan.writers) {
    memberWriters.set(w.repo, { repoRev: w.repoRev, spaceRev: w.spaceRev });
  }

  const knownApps = new Set<string>(
    installs.records
      .map((r) => (typeof r.value.subject === "string" ? r.value.subject : ""))
      .filter((s) => s.length > 0),
  );
  const admittedHumanDids = memberships.records
    .map((r) => r.rkey)
    .filter((did) => isDid(did) && did !== authorityDid && !knownApps.has(did));

  const acceptances: MemberAcceptanceEntry[] = [];
  await mapLimited(admittedHumanDids, 8, async (memberDid) => {
    if (!memberWriters.has(memberDid) && memberDid !== deps.did) return;
    try {
      const pds = await deps.resolvePds(memberDid);
      const rec = await membersCred.client(pds).query<{ value: Record<string, unknown> }>(
        "com.atproto.space.getRecord",
        {
          space: membersUri,
          repo: memberDid,
          collection: OPENSOCIAL_COLLECTION.acceptance,
          rkey: SELF_SKEY,
        },
      );
      if (rec.value && typeof rec.value === "object" && !Array.isArray(rec.value)) {
        acceptances.push({ repoDid: memberDid, rkey: SELF_SKEY, value: rec.value });
      }
    } catch (error) {
      if (isMissingXrpcResource(error) || isTombstonedResolutionError(error)) return;
      const failure = classifyRepoFailure(error, { space: membersUri, repo: memberDid, authorityDid });
      if (!failure) throw error;
    }
  });

  const activeAccountLabels = projectActiveLabels(
    accountLabelScan.records.map((r) => ({ repoDid: authorityDid, rkey: r.rkey, value: r.value })),
    { groupDid: authorityDid, spaceUri: membersUri, nowMs: deps.now ? deps.now() : Date.now() },
  );

  const summary = summarizeWorkspace(uri, deps.did ?? "", {
    profiles,
    roles,
    memberships,
    directory,
    installs,
    extInstalls,
    acceptances,
    memberWriters,
    spacePolicies,
    accountLabels: activeAccountLabels,
  });
  if (!summary) return null;

  const invalidRosterRecords =
    roles.records.filter(
      (record) =>
        !validateSpaceRecord(OPENSOCIAL_COLLECTION.role, record.value, {
          authorityDid,
          spaceUri: membersUri,
          repoDid: authorityDid,
          rkey: record.rkey,
        }).valid,
    ).length +
    memberships.records.filter(
      (record) =>
        !validateSpaceRecord(OPENSOCIAL_COLLECTION.membership, record.value, {
          authorityDid,
          spaceUri: membersUri,
          repoDid: authorityDid,
          rkey: record.rkey,
        }).valid,
    ).length;
  const totalHumanMembers =
    summary.members.length + summary.pendingMembers.length + (summary.takendownMembers?.length ?? 0);
  const rosterComplete =
    !roles.truncated &&
    !memberships.truncated &&
    !membersWriterScan.truncated &&
    !accountLabelScan.truncated &&
    !invalidPolicyScan &&
    invalidRosterRecords === 0 &&
    totalHumanMembers <= MAX_SUPPORTED_MEMBERS;

  const degradedReasons = [
    ...summary.degradedReasons,
    ...(invalidPolicyScan && !summary.degradedReasons.some((r) => r.includes("Space policy records"))
      ? ["Space policy records contain malformed or missing entries; workspace access governance may be incomplete."]
      : []),
    ...(membersWriterScan.truncated
      ? ["Members space writer set exceeds the 2000-repo scan limit; member acceptance state may be incomplete."]
      : []),
    ...(accountLabelScan.truncated
      ? [
          `Account moderation label records exceed the ${MAX_AUTHORITY_RECORD_SCAN}-record scan limit; the member list is withheld.`,
        ]
      : []),
  ];

  return {
    uri,
    authorityDid,
    groupDid: authorityDid,
    name: summary.name,
    joinPolicy: summary.joinPolicy,
    publicMeta: summary.publicMeta,
    members: accountLabelScan.truncated ? [] : summary.members.map((m) => m.did),
    pendingMembers: accountLabelScan.truncated ? [] : summary.pendingMembers.map((m) => m.did),
    ...(summary.takendownMembers ? { takendownMembers: summary.takendownMembers } : {}),
    rosterComplete,
    admins: summary.admins,
    moderators: summary.moderators,
    channels: summary.channels,
    degradedReasons,
  };
}

export async function readIndependentPrivateRoster(
  deps: IndependentDeps,
  workspace: string,
  skey: string,
): Promise<string[]> {
  const summary = await readIndependentWorkspace(deps, workspace);
  const channel = summary?.channels.find((entry) => entry.skey === skey && entry.visibility === "private");
  if (!summary || !channel) throw new Error("Private channel is unavailable.");

  const membersUri = groupMembersUri(summary.authorityDid);
  const [channelCred, membersCred, wsCred] = await Promise.all([
    mintSpaceCredentialWith(deps, channel.uri),
    mintSpaceCredentialWith(deps, membersUri),
    mintSpaceCredentialWith(deps, workspace),
  ]);

  const [channelPolScan, membershipsScan, accountLabelScan, installsScan] = await withGroupOriginRefresh(
    deps,
    summary.authorityDid,
    (authorityPds) =>
      Promise.all([
        listBoundedRecords(channelCred.client(authorityPds), {
          space: channel.uri,
          repo: summary.authorityDid,
          collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
          maxRecords: 1,
        }),
        listBoundedRecords(membersCred.client(authorityPds), {
          space: membersUri,
          repo: summary.authorityDid,
          collection: OPENSOCIAL_COLLECTION.membership,
          maxRecords: MAX_AUTHORITY_RECORD_SCAN,
        }),
        listBoundedRecords(membersCred.client(authorityPds), {
          space: membersUri,
          repo: summary.authorityDid,
          collection: ATPROTO_SPACE_COLLECTION.label,
          maxRecords: MAX_AUTHORITY_RECORD_SCAN,
        }),
        listBoundedRecords(wsCred.client(authorityPds), {
          space: workspace,
          repo: summary.authorityDid,
          collection: COLLECTION.appInstall,
          maxRecords: MAX_AUTHORITY_RECORD_SCAN,
        }),
      ]),
  );

  if (
    channelPolScan.truncated ||
    membershipsScan.truncated ||
    accountLabelScan.truncated ||
    installsScan.truncated
  ) {
    throw new Error(
      `Private-channel roster or moderation label scan exceeds the ${MAX_AUTHORITY_RECORD_SCAN}-record limit; refusing fail-open roster projection.`,
    );
  }

  const extractedChannelPolicy = extractGroupSpacePolicyRecord(summary.authorityDid, channel.uri, channelPolScan);
  if (!extractedChannelPolicy.valid || !extractedChannelPolicy.policy) {
    throw new Error("Private-channel space policy is missing or invalid; refusing fail-open roster projection.");
  }

  const validatedPolicy = extractedChannelPolicy.policy;
  const grantedReadRoles = new Set<string>();
  for (const g of validatedPolicy.grants) {
    if (g.read === true && typeof g.role === "string") grantedReadRoles.add(g.role);
  }

  const accountLabels = projectActiveLabels(
    accountLabelScan.records.map((r) => ({ repoDid: summary.authorityDid, rkey: r.rkey, value: r.value })),
    { groupDid: summary.authorityDid, spaceUri: membersUri, nowMs: deps.now ? deps.now() : Date.now() },
  );

  const knownAppSubjects = new Set<string>(
    installsScan.records
      .filter((r) =>
        validateSpaceRecord(COLLECTION.appInstall, r.value, {
          authorityDid: summary.authorityDid,
          spaceUri: workspace,
          repoDid: summary.authorityDid,
          rkey: r.rkey,
        }).valid,
      )
      .map((r) => String(r.value.subject)),
  );

  const members: string[] = [];
  for (const rec of membershipsScan.records) {
    if (!isDid(rec.rkey) || rec.rkey === summary.authorityDid || knownAppSubjects.has(rec.rkey)) continue;
    if (isTakendown(accountLabels, rec.rkey)) continue;
    if (
      !validateSpaceRecord(OPENSOCIAL_COLLECTION.membership, rec.value, {
        authorityDid: summary.authorityDid,
        spaceUri: membersUri,
        repoDid: summary.authorityDid,
        rkey: rec.rkey,
      }).valid
    ) {
      continue;
    }
    const roles = rec.value.roles as string[];
    if (roles.some((r) => grantedReadRoles.has(r))) {
      members.push(rec.rkey);
    }
  }
  members.sort();

  if (members.length > MAX_SUPPORTED_MEMBERS) {
    throw new Error(`Private-channel roster exceeds ${MAX_SUPPORTED_MEMBERS} members.`);
  }
  return members;
}

/**
 * Stateless tombstone- & takedown-aware cross-PDS invite reader (`proposal.md:155`, `§4.2`).
 */
export async function readIndependentInvites(
  deps: IndependentDeps,
  viewerDid: string,
  nowMs = Date.now(),
): Promise<IndependentInvite[]> {
  if (!isDid(viewerDid)) throw new TypeError("Invalid viewer DID.");
  const space = personalInvitesUri(viewerDid);
  let credential: SpaceCredential;
  try {
    credential = await mintSpaceCredentialWith(deps, space);
  } catch (error) {
    if (error instanceof SpaceCredentialError && error.code === "SpaceNotFound") return [];
    throw error;
  }

  const ownPds = await deps.resolvePds(viewerDid);
  const writerScan = await listBoundedWriters(credential.client(ownPds), { space, maxRepos: 2_000 });
  if (writerScan.truncated) {
    throw new Error("Invite scan exceeded bounded limits; invite list is incomplete.");
  }
  const externalWriters = writerScan.writers.filter((w) => w.repo !== viewerDid && isDid(w.repo));

  const perWriter = await mapLimited(externalWriters, 8, async (w): Promise<IndependentInvite[]> => {
    const groupDid = w.repo;

    let scanned;
    try {
      scanned = await withGroupOriginRefresh(deps, groupDid, (groupPds) =>
        listBoundedRecords(credential.client(groupPds), {
          space,
          repo: groupDid,
          collection: OPENSOCIAL_COLLECTION.invite,
          maxRecords: 100,
        }),
      );
    } catch (error) {
      if (isTombstonedResolutionError(error) || isStaleGroupHostError(error)) {
        return [];
      }
      const failure = classifyRepoFailure(error, { space, repo: groupDid, authorityDid: viewerDid });
      if (failure) return [];
      throw error;
    }

    if (scanned.truncated) {
      throw new Error("Invite scan exceeded bounded limits; invite list is incomplete.");
    }

    const out: IndependentInvite[] = [];
    for (const rec of scanned.records) {
      if (!isTid(rec.rkey)) continue;
      if (
        !validateSpaceRecord(OPENSOCIAL_COLLECTION.invite, rec.value, {
          authorityDid: viewerDid,
          spaceUri: space,
          repoDid: groupDid,
          rkey: rec.rkey,
        }).valid
      ) {
        continue;
      }
      if (rec.value.group !== undefined && rec.value.group !== groupDid) continue;
      const expiresAt = typeof rec.value.expiresAt === "string" ? rec.value.expiresAt : undefined;
      if (expiresAt !== undefined) {
        const expMs = Date.parse(expiresAt);
        if (!Number.isFinite(expMs) || expMs <= nowMs) continue;
      }
      const message = typeof rec.value.message === "string" ? rec.value.message : undefined;
      out.push({
        uri: spaceRecordUri(space, groupDid, OPENSOCIAL_COLLECTION.invite, rec.rkey),
        rkey: rec.rkey,
        groupDid,
        createdAt: String(rec.value.createdAt),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(message !== undefined ? { message } : {}),
      });
    }
    return out;
  });

  return perWriter.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.uri.localeCompare(b.uri));
}

export async function readIndependentChannelPage(
  deps: IndependentDeps,
  workspace: string,
  skey: string,
  limit = 100,
): Promise<IndependentChannelPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Independent reader page limit must be between 1 and 100.");
  }
  const summary = await readIndependentWorkspace(deps, workspace);
  const channel = summary?.channels.find((entry) => entry.skey === skey);
  if (!summary || !channel || (channel.visibility !== "public" && channel.visibility !== "private")) {
    throw new Error("Channel is unavailable for new reads.");
  }

  const membersUri = groupMembersUri(summary.authorityDid);
  const [credential, membersCred] = await Promise.all([
    mintSpaceCredentialWith(deps, channel.uri),
    mintSpaceCredentialWith(deps, membersUri),
  ]);

  const setAside = new Map<string, string>();
  const readWriter = async <T>(did: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      const failure = classifyRepoFailure(error, {
        space: channel.uri,
        repo: did,
        authorityDid: summary.authorityDid,
      });
      if (!failure) throw error;
      console.warn(`Independent reader set a writer aside (${failure.permanent ? "permanent" : "transient"}): ${describeRepoFailure(error)}`);
      setAside.set(did, failure.reason);
      return null;
    }
  };

  const { repoScan, rawChannelLabels, rawAccountLabels } = await withGroupOriginRefresh(
    deps,
    summary.authorityDid,
    async (authorityPds) => {
      const authClient = credential.client(authorityPds);
      const memClient = membersCred.client(authorityPds);
      const [scannedWriters, scannedChannelLabels, scannedAccountLabels] = await Promise.all([
        listBoundedWriters(authClient, { space: channel.uri, maxRepos: MAX_CHANNEL_WRITERS }),
        listBoundedRecords(authClient, {
          space: channel.uri,
          repo: summary.authorityDid,
          collection: ATPROTO_SPACE_COLLECTION.label,
          maxRecords: MAX_AUTHORITY_RECORD_SCAN,
        }),
        listBoundedRecords(memClient, {
          space: membersUri,
          repo: summary.authorityDid,
          collection: ATPROTO_SPACE_COLLECTION.label,
          maxRecords: MAX_AUTHORITY_RECORD_SCAN,
        }),
      ]);
      return {
        repoScan: scannedWriters,
        rawChannelLabels: scannedChannelLabels,
        rawAccountLabels: scannedAccountLabels,
      };
    },
  );
  if (rawChannelLabels.truncated || rawAccountLabels.truncated) {
    throw new Error("Moderation label scan exceeded authority record bounds; refusing fail-open read.");
  }
  if (repoScan.truncated) throw new Error("Channel writer count exceeds the v1 envelope.");
  const repos = repoScan.writers;

  const nowMs = deps.now ? deps.now() : Date.now();
  const channelLabels = projectActiveLabels(
    rawChannelLabels.records.map((r) => ({ repoDid: summary.authorityDid, rkey: r.rkey, value: r.value })),
    { groupDid: summary.authorityDid, spaceUri: channel.uri, nowMs },
  );
  const accountLabels = projectActiveLabels(
    rawAccountLabels.records.map((r) => ({ repoDid: summary.authorityDid, rkey: r.rkey, value: r.value })),
    { groupDid: summary.authorityDid, spaceUri: membersUri, nowMs },
  );
  const isWithheld = (uri: string, repo: string, cid?: string) =>
    isTakendown(accountLabels, repo) || isTakendown(channelLabels, uri, cid || undefined);

  const decorateMessage = (msg: IndependentMessage): IndependentMessage => {
    const recVals = labelsForResource(channelLabels, msg.uri, msg.cid).map((l) => l.val);
    const accVals = labelsForResource(accountLabels, msg.repo).map((l) => l.val);
    const allVals = [...new Set([...recVals, ...accVals])].sort();
    const hidden = isHidden(channelLabels, msg.uri, msg.cid) || isHidden(accountLabels, msg.repo);
    return {
      ...msg,
      ...(hidden ? { hidden: true } : {}),
      ...(allVals.length > 0 ? { labels: allVals } : {}),
    };
  };

  const finishPage = async (selectedMessages: IndependentMessage[]): Promise<IndependentChannelPage> => {
    const messages = selectedMessages.map(decorateMessage);
    const { reactions, truncated } = await readIndependentReactions(
      deps,
      credential,
      channel.uri,
      summary.authorityDid,
      repos.filter((repo) => !setAside.has(repo.repo) && !isTakendown(accountLabels, repo.repo)),
      messages,
      channelLabels,
      readWriter,
    );
    const degradedReasons = [
      ...[...setAside].slice(0, MAX_LISTED_SET_ASIDE).map(([did, reason]) => `Messages or reactions from ${did} may be missing: ${reason}`),
      ...(setAside.size > MAX_LISTED_SET_ASIDE ? [`${setAside.size - MAX_LISTED_SET_ASIDE} more writers' messages or reactions may be missing.`] : []),
      ...(truncated ? [`Reaction history exceeds the ${MAX_CHANNEL_REACTION_RECORDS}-record channel sync limit.`] : []),
    ];
    return { messages, reactions, degraded: degradedReasons.length > 0, degradedReasons };
  };

  const states = repos.map((repo) => ({
    repo,
    cursor: undefined as string | undefined,
    finished: false,
    seenCursors: new Set<string>(),
    seenRkeys: new Set<string>(),
    oldestRkey: undefined as string | undefined,
  }));
  const records: IndependentMessage[] = [];
  const byUri = new Map<string, IndependentMessage>();
  const parentReads = new Map<string, Promise<{ uri: string; value: Record<string, unknown> } | null>>();
  const getParent = (repo: string, rkey: string) => {
    const uri = spaceRecordUri(channel.uri, repo, COLLECTION.message, rkey);
    if (isTakendown(accountLabels, repo) || isTakendown(channelLabels, uri)) {
      return Promise.resolve(null);
    }
    let result = parentReads.get(uri);
    if (!result) {
      result = (async () => {
        const parent = await credential.client(await deps.resolvePds(repo)).query<GetRecord.OutputSchema>(
          "com.atproto.space.getRecord",
          {
            space: channel.uri,
            repo,
            collection: COLLECTION.message,
            rkey,
          },
        );
        if (isTakendown(channelLabels, parent.uri, parent.cid)) return null;
        return { uri: parent.uri, value: parent.value };
      })().catch(() => null);
      parentReads.set(uri, result);
    }
    return result;
  };

  let scanned = 0;
  let pageRequests = 0;
  while (true) {
    const survivingRecords = records.filter((r) => !isWithheld(r.uri, r.repo, r.cid));
    const selected = await selectValidChannelMessages(survivingRecords, {
      authorityDid: summary.authorityDid,
      spaceUri: channel.uri,
      limit,
      getParent,
    });
    const selectedWithCid = selected.messages.map((m) => byUri.get(m.uri) ?? m);
    const cutoff = selectedWithCid.length >= limit ? selectedWithCid[limit - 1]?.rkey : undefined;
    const candidates = states.filter((state) => !state.finished && (!cutoff || !state.oldestRkey || state.oldestRkey >= cutoff));
    if (selectedWithCid.length >= limit && candidates.length === 0) return finishPage(selectedWithCid);
    if (candidates.length === 0) return finishPage(selectedWithCid);

    const remaining = MAX_CHANNEL_RECORD_SCAN - scanned;
    const pageLimit = Math.min(100, Math.floor(remaining / candidates.length));
    if (pageLimit < 1) {
      if (pageRequests + candidates.length > MAX_CHANNEL_RECORD_PAGES) {
        throw new Error("Channel pagination exceeded the bounded page request limit.");
      }
      pageRequests += candidates.length;
      const lookahead = (await mapLimited(candidates, 8, (state) => readWriter(state.repo.repo, async () => {
        if (state.cursor) state.seenCursors.add(state.cursor);
        const page = await credential.client(await deps.resolvePds(state.repo.repo)).query<ListRecords.OutputSchema>(
          "com.atproto.space.listRecords",
          {
            space: channel.uri,
            repo: state.repo.repo,
            collection: COLLECTION.message,
            cursor: state.cursor,
            limit: 1,
          },
        );
        assertBoundedRecordPage(page, { collection: COLLECTION.message, limit: 1, cursor: state.cursor, seenCursors: state.seenCursors, space: channel.uri, repo: state.repo.repo });
        return { state, page };
      }).then((read) => { if (!read) state.finished = true; return read; }))).flatMap((read) => (read ? [read] : []));
      const lookaheadRecordCount = lookahead.reduce((count, { page }) => count + page.records.length, 0);
      if (lookaheadRecordCount > remaining) throw new Error("Channel history exceeds the bounded 20,000-record scan limit.");
      for (const { state, page } of lookahead) {
        for (const record of page.records) {
          if (!record.value) throw new Error("PDS record page contains a malformed record.");
          if (state.seenRkeys.has(record.rkey)) throw new Error("PDS record pagination returned a duplicate record key.");
          state.seenRkeys.add(record.rkey);
          const item: IndependentMessage = {
            uri: spaceRecordUri(channel.uri, state.repo.repo, COLLECTION.message, record.rkey),
            rkey: record.rkey,
            repo: state.repo.repo,
            ...(record.cid ? { cid: record.cid } : {}),
            value: record.value,
          };
          records.push(item);
          byUri.set(item.uri, item);
        }
        scanned += page.records.length;
        const pageOldest = page.records.reduce<string | undefined>((oldest, record) => (!oldest || record.rkey < oldest ? record.rkey : oldest), undefined);
        if (pageOldest && (!state.oldestRkey || pageOldest < state.oldestRkey)) state.oldestRkey = pageOldest;
        state.cursor = page.cursor;
        if (page.cursor) state.seenCursors.add(page.cursor);
        else state.finished = true;
      }
      continue;
    }

    if (pageRequests + candidates.length > MAX_CHANNEL_RECORD_PAGES) {
      throw new Error("Channel pagination exceeded the bounded page request limit.");
    }
    pageRequests += candidates.length;
    const pages = (await mapLimited(candidates, 8, (state) => readWriter(state.repo.repo, async () => {
      if (state.cursor) state.seenCursors.add(state.cursor);
      const page = await credential.client(await deps.resolvePds(state.repo.repo)).query<ListRecords.OutputSchema>(
        "com.atproto.space.listRecords",
        {
          space: channel.uri,
          repo: state.repo.repo,
          collection: COLLECTION.message,
          cursor: state.cursor,
          limit: pageLimit,
        },
      );
      assertBoundedRecordPage(page, { collection: COLLECTION.message, limit: pageLimit, cursor: state.cursor, seenCursors: state.seenCursors, space: channel.uri, repo: state.repo.repo });
      return { state, page };
    }).then((read) => { if (!read) state.finished = true; return read; }))).flatMap((read) => (read ? [read] : []));
    for (const { state, page } of pages) {
      for (const record of page.records) {
        if (!record.value) throw new Error("PDS record page contains a malformed record.");
        if (state.seenRkeys.has(record.rkey)) throw new Error("PDS record pagination returned a duplicate record key.");
        state.seenRkeys.add(record.rkey);
        const item: IndependentMessage = {
          uri: spaceRecordUri(channel.uri, state.repo.repo, COLLECTION.message, record.rkey),
          rkey: record.rkey,
          repo: state.repo.repo,
          ...(record.cid ? { cid: record.cid } : {}),
          value: record.value,
        };
        records.push(item);
        byUri.set(item.uri, item);
      }
      scanned += page.records.length;
      const pageOldest = page.records.reduce<string | undefined>((oldest, record) => (!oldest || record.rkey < oldest ? record.rkey : oldest), undefined);
      if (pageOldest && (!state.oldestRkey || pageOldest < state.oldestRkey)) state.oldestRkey = pageOldest;
      state.cursor = page.cursor;
      if (page.cursor) state.seenCursors.add(page.cursor);
      else state.finished = true;
    }
  }
}

async function readIndependentReactions(
  deps: IndependentDeps,
  credential: SpaceCredential,
  space: string,
  authorityDid: string,
  repos: WriterWrite[],
  messages: IndependentMessage[],
  channelLabels: readonly ActiveSpaceLabel[],
  readWriter: <T>(did: string, run: () => Promise<T>) => Promise<T | null>,
): Promise<{ reactions: IndependentReaction[]; truncated: boolean }> {
  const knownMessages = new Set(messages.map((message) => message.uri));
  const reactions: IndependentReaction[] = [];
  const result = (truncated: boolean) => ({
    reactions: reactions.sort((left, right) => left.uri.localeCompare(right.uri)),
    truncated,
  });
  const seenRkeys = new Map<string, Set<string>>();
  let scanned = 0;
  let pageRequests = 0;
  for (const repo of repos) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      if (pageRequests >= MAX_CHANNEL_REACTION_PAGES) {
        throw new Error("Channel reaction pagination exceeded the bounded page request limit.");
      }
      pageRequests += 1;
      if (cursor) seenCursors.add(cursor);
      const remaining = MAX_CHANNEL_REACTION_RECORDS - scanned;
      const limit = Math.min(100, remaining > 0 ? remaining + 1 : 1);
      const page = await readWriter(repo.repo, async () => {
        const read = await credential.client(await deps.resolvePds(repo.repo)).query<ListRecords.OutputSchema>(
          "com.atproto.space.listRecords",
          {
            space,
            repo: repo.repo,
            collection: COLLECTION.reaction,
            cursor,
            limit,
          },
        );
        assertBoundedRecordPage(read, { collection: COLLECTION.reaction, limit, cursor, seenCursors, space, repo: repo.repo });
        return read;
      });
      if (!page) break;
      const overflow = page.records.length > remaining;
      const rows = overflow ? page.records.slice(0, remaining) : page.records;
      const repoRkeys = seenRkeys.get(repo.repo) ?? new Set<string>();
      seenRkeys.set(repo.repo, repoRkeys);
      for (const record of rows) {
        if (!record.value) throw new Error("PDS record page contains a malformed reaction.");
        if (repoRkeys.has(record.rkey)) throw new Error("PDS reaction pagination returned a duplicate record key.");
        repoRkeys.add(record.rkey);
        const uri = spaceRecordUri(space, repo.repo, COLLECTION.reaction, record.rkey);
        if (isTakendown(channelLabels, uri, record.cid)) continue;
        if (typeof record.value.subject !== "string" || !knownMessages.has(record.value.subject)) continue;
        if (
          !validateSpaceRecord(COLLECTION.reaction, record.value, {
            authorityDid,
            spaceUri: space,
            repoDid: repo.repo,
            rkey: record.rkey,
            knownMessages,
          }).valid
        ) {
          continue;
        }
        const recVals = labelsForResource(channelLabels, uri, record.cid).map((l) => l.val);
        const sortedVals = [...new Set(recVals)].sort();
        reactions.push({
          uri,
          rkey: record.rkey,
          repo: repo.repo,
          ...(record.cid ? { cid: record.cid } : {}),
          value: record.value,
          ...(sortedVals.length > 0 ? { labels: sortedVals } : {}),
        });
      }
      scanned += rows.length;
      if (overflow) return result(true);
      cursor = page.cursor ?? undefined;
      if (!cursor) break;
    }
  }
  return result(false);
}
