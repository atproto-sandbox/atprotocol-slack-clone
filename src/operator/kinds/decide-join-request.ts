import { listSpaceMembers, putAuthorityRecord, putSpaceMember, removeSpaceMember } from "@/atproto/space-ops";
import { channelUri, decisionRecordKey, inboxUri, requestRecordKey } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import {
  activePrivateRoster, activeRoster, assertMembership, directoryRecords, getOwnerRecord, parseJoinRequestUri, readJoinRequest, writeRoster,
} from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

export const decideJoinRequestKind: OperationKind = {
  kind: "decideJoinRequest",
  required: ["request", "requestId", "decision"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "join-request-baseline-{state}", "join-request-inactive-revoke-membership", "join-request-inactive-deactivate-roster",
    "join-request-channel-membership", "join-request-private-roster", "join-request-decision", "join-request-approved-membership-verified",
    "join-request-stale-restore-membership", "join-request-stale-restore-roster",
  ],
  run: (actor, context, request) => decideJoinRequest(actor, context, request as OperatorRequest & { request: string; requestId: string; decision: "approve" | "deny" }),
};

async function decideJoinRequest(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { request: string; requestId: string; decision: "approve" | "deny" },
): Promise<void> {
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const parsed = parseJoinRequestUri(operation.request, actor.workspace.authorityDid, inbox);
  if (!parsed) throw new OperationRejectedError("Join request must refer to this workspace inbox.");
  const matchingChannels = (await directoryRecords(actor)).filter((record) =>
    requestRecordKey(channelUri(actor.workspace.authorityDid, record.value.skey), parsed.repo) === parsed.rkey);
  if (matchingChannels.length !== 1) throw new OperationRejectedError("Join request key is not canonical for this workspace.");
  const channelSkey = matchingChannels[0].value.skey;
  const channelSpace = channelUri(actor.workspace.authorityDid, channelSkey);
  const request = await readJoinRequest(actor.session, inbox, parsed.repo, parsed.rkey, actor.workspace.authorityDid);
  const requestIsCurrent = request?.requestId === operation.requestId && request.channelSkey === channelSkey;
  if (!requestIsCurrent) {
    await cleanupStaleJoinApproval(actor, context, operation.decision, parsed.repo, channelSpace);
    throw new OperationRejectedError("Join request generation is no longer current.");
  }
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.directory, channelSkey);
  if (!directory || directory.visibility !== "private") throw new OperationRejectedError("Join requests are valid only for an active private channel.");
  const decisionKey = decisionRecordKey(operation.request);
  if (operation.decision === "approve" && !joinRequestBaseline(context.completedSteps)) {
    const [member, roster] = await Promise.all([
      listSpaceMembers(actor.session, channelSpace).then((members) => members.find((entry) => entry.did === parsed.repo)),
      activePrivateRoster(actor, channelSpace),
    ]);
    const membership = member ? `${Number(member.read)}${Number(member.write)}` : "none";
    await context.step(`join-request-baseline-${membership}-${Number(roster.has(parsed.repo))}`, async () => {});
  }
  const ensureRequestCurrent = async () => {
    const latest = await readJoinRequest(actor.session, inbox, parsed.repo, parsed.rkey, actor.workspace.authorityDid);
    if (latest?.requestId === operation.requestId && latest.channelSkey === channelSkey) return;
    await cleanupStaleJoinApproval(actor, context, operation.decision, parsed.repo, channelSpace);
    throw new OperationRejectedError("Join request generation is no longer current.");
  };
  const ensureApprovalEligible = async () => {
    await ensureRequestCurrent();
    const [roster, workspaceMembers] = await Promise.all([
      activeRoster(actor),
      listSpaceMembers(actor.session, actor.workspace.uri),
    ]);
    const isWorkspaceMember = roster.has(parsed.repo) && workspaceMembers.some((member) =>
      member.did === parsed.repo && member.read && member.write);
    if (isWorkspaceMember) return;
    await context.step("join-request-inactive-revoke-membership", () => removeSpaceMember(actor.session, channelSpace, parsed.repo));
    await context.step("join-request-inactive-deactivate-roster", () => writeRoster(actor, channelSpace, parsed.repo, false, COLLECTION.channelRoster));
    throw new OperationRejectedError("Only an active workspace member can be approved for a private channel.");
  };
  if (operation.decision === "approve") {
    await context.step("join-request-channel-membership", async () => { await ensureApprovalEligible(); await putSpaceMember(actor.session, channelSpace, parsed.repo, true, true); });
    await context.step("join-request-private-roster", async () => { await ensureApprovalEligible(); await writeRoster(actor, channelSpace, parsed.repo, true, COLLECTION.channelRoster); });
  }
  await context.step("join-request-decision", async () => {
    if (operation.decision === "approve") await ensureApprovalEligible();
    else await ensureRequestCurrent();
    await putAuthorityRecord(actor.session, inbox, COLLECTION.joinDecision, decisionKey, {
      request: operation.request, requestId: operation.requestId, decision: operation.decision, updatedAt: new Date().toISOString(),
    });
  });
  if (operation.decision === "approve") await context.step("join-request-approved-membership-verified", async () => {
    await ensureApprovalEligible();
    await assertMembership(actor, channelSpace, parsed.repo, true, true);
  });
}

async function cleanupStaleJoinApproval(
  actor: OperatorActor,
  context: OperationContext,
  decision: "approve" | "deny",
  repoDid: string,
  channelSpace: string,
): Promise<void> {
  const baseline = joinRequestBaseline(context.completedSteps);
  if (decision !== "approve" || !baseline) return;
  await context.step("join-request-stale-restore-membership", async () => {
    const current = (await listSpaceMembers(actor.session, channelSpace)).find((member) => member.did === repoDid);
    if (baseline.membership === "none") {
      if (current) await removeSpaceMember(actor.session, channelSpace, repoDid);
    } else {
      const read = baseline.membership[0] === "1";
      const write = baseline.membership[1] === "1";
      if (!current || current.read !== read || current.write !== write) {
        await putSpaceMember(actor.session, channelSpace, repoDid, read, write);
      }
    }
  });
  await context.step("join-request-stale-restore-roster", async () => {
    const currentlyActive = (await activePrivateRoster(actor, channelSpace)).has(repoDid);
    if (currentlyActive !== baseline.rosterActive) {
      await writeRoster(actor, channelSpace, repoDid, baseline.rosterActive, COLLECTION.channelRoster);
    }
  });
}

function joinRequestBaseline(steps: string[]): { membership: "none" | string; rosterActive: boolean } | null {
  const marker = steps.find((step) => step.startsWith("join-request-baseline-"));
  const match = /^join-request-baseline-(none|[01]{2})-([01])$/.exec(marker ?? "");
  if (!match) return null;
  return { membership: match[1], rosterActive: match[2] === "1" };
}
