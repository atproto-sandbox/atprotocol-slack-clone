import { listBoundedRecords, listBoundedWriters } from "@flock/protocol/atproto/record-pages";
import { groupMembersUri, groupMetaUri } from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, ATGRP_COLLECTION } from "@flock/protocol/nsids";
import { canonicalAtgrpPolicyKey } from "@flock/protocol/registry";
import {
  assertWorkspaceWithinEnvelope,
  extractGroupSpacePolicyRecord,
  summarizeWorkspace,
  WORKSPACE_ENVELOPE,
} from "@flock/protocol/workspace-summary";
import { sessionClient } from "../atproto/client";
import { resolvePds } from "../atproto/identity";
import { mintSpaceCredential } from "../atproto/space-credential";
import type { OperatorActor } from "./actor";
import { readGroupGovernanceState } from "./workspace-state";

const MAX_MEMBERS_SPACE_WRITERS = 2_000;

/**
 * Refuses admin changes while the group/workspace is outside the supported v1 envelope or has truncated/malformed
 * authority records, judged from the group's own OpenSocial (`meta/self`, `members/self`, space policies, labels,
 * writer set) and Flock (`workspace/self`) records.
 */
export async function assertOperatorWorkspaceWithinEnvelope(actor: OperatorActor): Promise<void> {
  const { uri, authorityDid: groupDid } = actor.workspace;
  const client = sessionClient(actor.session);
  const metaSpace = groupMetaUri(groupDid);
  const membersSpace = groupMembersUri(groupDid);
  const scan = (space: string, collection: string, maxRecords: number) =>
    listBoundedRecords(client, { space, repo: groupDid, collection, maxRecords });

  const [
    abouts,
    configs,
    metaPolicyScan,
    roles,
    memberships,
    membersPolicyScan,
    accountLabelScan,
    membersWriterScan,
    directory,
    installs,
    extInstalls,
    wsPolicyScan,
    governance,
  ] = await Promise.all([
    scan(metaSpace, ATGRP_COLLECTION.about, 1),
    scan(metaSpace, ATGRP_COLLECTION.config, 1),
    scan(metaSpace, ATPROTO_SPACE_COLLECTION.spacePolicy, 1),
    scan(membersSpace, ATGRP_COLLECTION.role, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(membersSpace, ATGRP_COLLECTION.membership, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(membersSpace, ATPROTO_SPACE_COLLECTION.spacePolicy, 1),
    scan(membersSpace, ATPROTO_SPACE_COLLECTION.label, WORKSPACE_ENVELOPE.authorityRecordScan),
    (async () => {
      const [membersCred, groupPds] = await Promise.all([
        mintSpaceCredential(actor.session, membersSpace),
        resolvePds(groupDid),
      ]);
      return listBoundedWriters(membersCred.client(groupPds), {
        space: membersSpace,
        maxRepos: MAX_MEMBERS_SPACE_WRITERS,
      });
    })(),
    scan(uri, COLLECTION.directory, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(uri, COLLECTION.appInstall, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(uri, COLLECTION.extInstall, WORKSPACE_ENVELOPE.authorityRecordScan),
    scan(uri, ATPROTO_SPACE_COLLECTION.spacePolicy, 1),
    readGroupGovernanceState(actor.session, groupDid),
  ]);

  const corePolicyScans = new Map([
    [metaSpace, metaPolicyScan],
    [membersSpace, membersPolicyScan],
    [uri, wsPolicyScan],
  ]);
  const otherOwnSpaces = [...governance.spacePolicies.keys()].filter((spUri) => !corePolicyScans.has(spUri));
  const otherPolicyScans = await mapLimited(otherOwnSpaces, 8, async (spUri) => ({
    spUri,
    polScan: await scan(spUri, ATPROTO_SPACE_COLLECTION.spacePolicy, 1),
  }));
  for (const { spUri, polScan } of otherPolicyScans) {
    corePolicyScans.set(spUri, polScan);
  }

  const combinedSpacePolicies = new Map(governance.spacePolicies);
  let invalidPolicyScan = governance.invalidSpacePolicyUris.length > 0;
  for (const [spUri, polScan] of corePolicyScans.entries()) {
    const extracted = extractGroupSpacePolicyRecord(groupDid, spUri, polScan);
    const livePolicy = governance.spacePolicies.get(spUri);
    if (
      !extracted.valid ||
      !extracted.policy ||
      !livePolicy ||
      canonicalAtgrpPolicyKey(extracted.policy) !== canonicalAtgrpPolicyKey(livePolicy)
    ) {
      invalidPolicyScan = true;
    } else {
      combinedSpacePolicies.set(spUri, extracted.policy);
    }
  }

  const summary = summarizeWorkspace(uri, groupDid, {
    abouts,
    configs,
    roles,
    memberships,
    directory,
    installs,
    extInstalls,
    spacePolicies: combinedSpacePolicies,
  });
  if (!summary) throw new Error("Workspace could not be read or contains invalid group records.");

  const degradedReasons = [
    ...summary.degradedReasons,
    ...(invalidPolicyScan && !summary.degradedReasons.some((r) => r.includes("Space policy records"))
      ? ["Space policy records contain malformed or missing entries; workspace access governance may be incomplete."]
      : []),
    ...(membersWriterScan.truncated
      ? [
          `Members space writer set exceeds the ${MAX_MEMBERS_SPACE_WRITERS}-repo scan limit; member acceptance state may be incomplete.`,
        ]
      : []),
    ...(accountLabelScan.truncated
      ? [
          `Account moderation label records exceed the ${WORKSPACE_ENVELOPE.authorityRecordScan}-record scan limit; the member list is withheld.`,
        ]
      : []),
  ];
  assertWorkspaceWithinEnvelope({ degradedReasons });
}
