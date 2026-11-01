import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import { sessionClient } from "@/atproto/client";
import { listBoundedRecords } from "@/atproto/record-pages";
import { isUnverifiableRepo } from "@/atproto/kem-key";
import { isMissingXrpcResource, type AtprotoClient } from "@/atproto/xrpc";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { resolvePds } from "@/atproto/identity";
import { ensureMemberListSpace, listSpaceMembers, putAuthorityRecord, putSpaceMember, removeSpaceMember } from "@/atproto/space-ops";
import { channelUri, decisionRecordKey, parseSpaceRecordUri, requestRecordKey, subjectKey } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { bootstrapWorkspace } from "@/workspaces/bootstrap";
import { WorkspaceEnvelopeError } from "@/workspaces/read-model";
import { assertAdminMutationsEnabled } from "./mutations-paused";
import type { OperationContext, OperationView } from "./journal";
import { auditOperationEvent, listRecoverableOperations, OperationBusyError, OperationRejectedError, runJournaledOperation } from "./journal";
import type { OperatorActor } from "./security";

export type OperatorRequest = Record<string, unknown> & { kind: string };

const MAX_AUTHORITY_RECORD_SCAN = 1_000;

export async function executeOperatorOperation(
  actor: OperatorActor,
  operationId: string,
  rawRequest: unknown,
): Promise<OperationView> {
  assertAdminMutationsEnabled();
  const operation = validateOperatorRequest(rawRequest, actor);
  const current = (row: { actor: string; operationId: string }) => row.actor === actor.did && row.operationId === operationId;
  const pending = listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri).filter((row) => !current(row));
  if (actor.canRecoverOperations) await resumeRecoverableOperations(actor, operationId);
  else if (pending.length > 0) throw new OperationBusyError("Pending admin operations must be recovered by an active admin before member leave can proceed.");
  return runJournaledOperation(actor, operationId, operation, async (context) => {
    await executeByKind(actor, context, operation);
  });
}

async function resumeRecoverableOperations(actor: OperatorActor, currentOperationId: string): Promise<void> {
  const pending = savedWorkspaceOperations(listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri), actor, currentOperationId);
  for (const row of pending) {
    try {
      if (!row.request) throw new Error("Journaled operation request is unreadable.");
      if (row.request.kind === "bootstrapWorkspace") {
        if (actor.did !== actor.workspace.authorityDid || row.actor !== actor.workspace.authorityDid || typeof row.request.name !== "string") {
          throw new Error("Workspace bootstrap can only be resumed by the workspace authority.");
        }
        await bootstrapWorkspace(actor.session, { name: row.request.name, operationId: row.operationId });
        continue;
      }
      // The row was created only after this actor passed service-auth and PDS
      // role checks. The current admin authorizes recovery; the original DID
      // remains the operation and audit principal even if removal was partial.
      const priorActor = { ...actor, did: row.actor };
      const priorRequest = validateOperatorRequest(row.request, priorActor);
      await runJournaledOperation(priorActor, row.operationId, priorRequest, async (context) => {
        await executeByKind(priorActor, context, priorRequest);
      });
    } catch (error) {
      // Leave the row pending for an active admin to inspect; never reconcile around it.
      auditOperationEvent(actor, row.operationId, "operationResumeFailed", { originalActor: row.actor, error: error instanceof Error ? error.message : "Unknown error" });
    }
  }
  // Unreadable rows cannot be replayed or cleared in-app; they stay visible in the
  // audit log and stalled-operation alert instead of wedging every admin action.
  const remaining = savedWorkspaceOperations(listRecoverableOperations(actor.workspace.authorityDid, actor.workspace.uri), actor, currentOperationId)
    .filter((row) => row.request !== null);
  if (remaining.length > 0) {
    throw new Error(`Pending workspace operations could not be resumed (${remaining.map((row) => row.operationId).join(", ")}); membership reconciliation was skipped.`);
  }
}

export function savedWorkspaceOperations(
  rows: Array<{ actor: string; operationId: string; requestJson: string }>,
  actor: Pick<OperatorActor, "did" | "workspace">,
  currentOperationId: string,
): Array<{ actor: string; operationId: string; request: Record<string, unknown> | null }> {
  return rows
    .filter((row) => !(row.actor === actor.did && row.operationId === currentOperationId))
    .flatMap((row) => {
      let saved: unknown;
      try { saved = JSON.parse(row.requestJson); }
      catch { return [{ actor: row.actor, operationId: row.operationId, request: null }]; }
      if (isPlainObject(saved) && saved.workspace !== actor.workspace.uri) return [];
      const request = isPlainObject(saved) && isPlainObject(saved.request) ? saved.request : null;
      return [{ actor: row.actor, operationId: row.operationId, request }];
    });
}

export async function listInboxWriters(actor: OperatorActor): Promise<{ inbox: string; writers: string[]; checkedAt: string }> {
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const members = await listSpaceMembers(actor.session, inbox);
  return { inbox, writers: members.filter((member) => member.write).map((member) => member.did).sort(), checkedAt: new Date().toISOString() };
}

export function validateOperatorRequest(value: unknown, actor: OperatorActor): OperatorRequest {
  if (!isPlainObject(value)) throw new Error("Operation request must be an object.");
  const kind = value.kind;
  if (typeof kind !== "string") throw new Error("Operation kind is required.");
  const fieldSets: Record<string, { required: string[]; optional?: string[] }> = {
    inviteMember: { required: ["kind", "subject"] },
    removeMember: { required: ["kind", "subject"] },
    setAdmin: { required: ["kind", "subject", "active"] },
    createChannel: { required: ["kind", "skey", "name", "visibility"], optional: ["members"] },
    transitionChannel: { required: ["kind", "skey", "visibility"], optional: ["members"] },
    archiveChannel: { required: ["kind", "skey"] },
    decideJoinRequest: { required: ["kind", "request", "requestId", "decision"] },
    leaveWorkspace: { required: ["kind"] },
    leaveChannel: { required: ["kind", "skey"] },
    reconcileWorkspace: { required: ["kind"] },
  };
  const shape = fieldSets[kind];
  if (!shape) throw new Error("Unsupported operation kind.");
  const allowed = new Set([...(shape.required), ...(shape.optional ?? []), "$type"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || shape.required.some((key) => !(key in value))) {
    throw new Error("Operation has missing or unexpected fields.");
  }
  if (value.$type !== undefined && value.$type !== "org.slack.operator.execute#operationRequest") throw new Error("Invalid operation type.");
  if ("subject" in value && !isDid(value.subject)) throw new Error("Invalid subject DID.");
  if ("active" in value && typeof value.active !== "boolean") throw new Error("Admin state must be boolean.");
  if ("skey" in value && !isSkey(value.skey)) throw new Error("Invalid channel key.");
  if ("name" in value && (typeof value.name !== "string" || value.name.trim().length < 1 || Array.from(value.name).length > 80)) throw new Error("Channel name must contain 1 to 80 characters.");
  if ("visibility" in value && value.visibility !== "public" && value.visibility !== "private") throw new Error("Invalid channel visibility.");
  if ("members" in value && (!Array.isArray(value.members) || value.members.length > 200 || !value.members.every(isDid) || new Set(value.members).size !== value.members.length)) {
    throw new Error("Channel members must be at most 200 unique DIDs.");
  }
  if ("request" in value && (typeof value.request !== "string" || !parseJoinRequestUri(value.request, actor.workspace.authorityDid, inboxUri(actor.workspace.authorityDid, actor.workspace.skey)))) throw new Error("Invalid join request URI.");
  if ("requestId" in value && (typeof value.requestId !== "string" || !isTid(value.requestId))) throw new Error("Invalid request generation.");
  if ("decision" in value && value.decision !== "approve" && value.decision !== "deny") throw new Error("Invalid join decision.");
  if (kind === "transitionChannel" && value.visibility === "private" && !Array.isArray(value.members)) throw new Error("Private transition requires the selected member list.");
  return value as OperatorRequest;
}

async function executeByKind(actor: OperatorActor, context: OperationContext, operation: OperatorRequest): Promise<void> {
  switch (operation.kind) {
    case "inviteMember":
      return inviteMember(actor, context, operation.subject as string);
    case "removeMember":
      return removeMember(actor, context, operation.subject as string);
    case "setAdmin":
      return setAdmin(actor, context, operation.subject as string, operation.active as boolean);
    case "createChannel":
      return createChannel(actor, context, operation as OperatorRequest & { skey: string; name: string; visibility: "public" | "private"; members?: string[] });
    case "transitionChannel":
      return transitionChannel(actor, context, operation as OperatorRequest & { skey: string; visibility: "public" | "private"; members?: string[] });
    case "archiveChannel":
      return archiveChannel(actor, context, operation.skey as string);
    case "decideJoinRequest":
      return decideJoinRequest(actor, context, operation as OperatorRequest & { request: string; requestId: string; decision: "approve" | "deny" });
    case "leaveWorkspace":
      return removeMember(actor, context, actor.did);
    case "leaveChannel":
      return leaveChannel(actor, context, operation.skey as string);
    case "reconcileWorkspace":
      return reconcileWorkspace(actor, context);
  }
}

async function inviteMember(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority is already an implicit member.");
  const workspace = actor.workspace.uri;
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const channels = await directoryRecords(actor);
  const publicChannels = channels.filter((record) => record.value.visibility === "public");
  const current = await activeRoster(actor);
  if (!current.has(subject) && current.size >= 200) throw new OperationRejectedError("Workspace member limit reached (200).");

  await context.step("member-workspace", () => putSpaceMember(actor.session, workspace, subject, true, true));
  await context.step("member-inbox-writer", () => putSpaceMember(actor.session, inbox, subject, false, true));
  for (const channel of publicChannels) {
    const space = channelUri(actor.workspace.authorityDid, channel.value.skey);
    await context.step(`member-public-channel-${channel.value.skey}`, () => putSpaceMember(actor.session, space, subject, true, true));
  }
  await context.step("member-workspace-roster", async () => {
    await writeRoster(actor, workspace, subject, true);
  });
  await context.step("member-state-verified", async () => {
    await assertMembership(actor, workspace, subject, true, true);
    await assertMembership(actor, inbox, subject, false, true);
    for (const channel of publicChannels) await assertMembership(actor, channelUri(actor.workspace.authorityDid, channel.value.skey), subject, true, true);
  });
}

async function removeMember(actor: OperatorActor, context: OperationContext, subject: string): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority cannot be removed.");
  const admins = await activeAdmins(actor);
  const subjectIsEffectiveAdmin = admins.has(subject);
  const subjectHasActiveAdminRecord = await hasActiveAdminRecord(actor, subject);
  if (subjectIsEffectiveAdmin && admins.size <= 1) throw new OperationRejectedError("The last active admin cannot leave or be removed.");
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const channels = await directoryRecords(actor);
  const workspace = actor.workspace.uri;
  await context.step("remove-inbox-membership", () => removeSpaceMember(actor.session, inbox, subject));
  for (const channel of channels) {
    const channelSpace = channelUri(actor.workspace.authorityDid, channel.value.skey);
    await context.step(`remove-channel-${channel.value.skey}`, async () => {
      await removeSpaceMember(actor.session, channelSpace, subject);
      if (channel.value.visibility === "private") await writeRoster(actor, channelSpace, subject, false, "org.slack.channel.roster");
    });
  }
  await context.step("remove-workspace-membership", () => removeSpaceMember(actor.session, workspace, subject));
  await context.step("deactivate-workspace-roster", () => writeRoster(actor, workspace, subject, false));
  if (subjectHasActiveAdminRecord) await context.step("deactivate-admin", () => writeRoster(actor, workspace, subject, false, "org.slack.admin"));
  await context.step("removal-verified", async () => {
    await assertNoMembership(actor, inbox, subject);
    await assertNoMembership(actor, workspace, subject);
    for (const channel of channels) await assertNoMembership(actor, channelUri(actor.workspace.authorityDid, channel.value.skey), subject);
  });
}

async function setAdmin(actor: OperatorActor, context: OperationContext, subject: string, active: boolean): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority's bootstrap admin state cannot be changed.");
  const roster = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.workspace.roster", subjectKey(subject));
  if (active) {
    const workspaceMember = (await listSpaceMembers(actor.session, actor.workspace.uri)).some((member) =>
      member.did === subject && member.read && member.write);
    if (roster?.active !== true || !workspaceMember) {
      throw new OperationRejectedError("Only an active workspace member can become an admin.");
    }
  }
  const admins = await activeAdmins(actor);
  if (!active && admins.has(subject) && admins.size <= 1) throw new OperationRejectedError("The last active admin cannot be demoted.");
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  if (active) {
    await context.step("write-admin-active", () => writeRoster(actor, actor.workspace.uri, subject, true, "org.slack.admin"));
    await context.step("grant-inbox-read", () => putSpaceMember(actor.session, inbox, subject, true, true));
  } else {
    await context.step("remove-inbox-read", () => putSpaceMember(actor.session, inbox, subject, false, true));
    await context.step("write-admin-inactive", () => writeRoster(actor, actor.workspace.uri, subject, false, "org.slack.admin"));
  }
  await context.step("admin-state-verified", async () => {
    const current = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.admin", subjectKey(subject));
    const member = (await listSpaceMembers(actor.session, inbox)).find((entry) => entry.did === subject);
    if (current?.active !== active || (active && (!member?.read || !member.write)) || (!active && member?.read)) {
      throw new Error("Admin state has not converged with inbox membership.");
    }
  });
}

async function createChannel(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { skey: string; name: string; visibility: "public" | "private"; members?: string[] },
): Promise<void> {
  const channels = await directoryRecords(actor);
  const skey = `${actor.workspace.skey}-${operation.skey}`;
  if (skey.length > 128) throw new OperationRejectedError("Channel key is too long for this workspace.");
  const existing = channels.find((record) => record.value.skey === skey);
  if (existing && (existing.value.name !== operation.name.trim() || existing.value.visibility !== operation.visibility)) {
    throw new OperationRejectedError("Channel key already belongs to a different channel.");
  }
  const activeChannelCount = channels.filter(({ value }) => value.visibility !== "archived").length;
  if (!existing && activeChannelCount >= 100) throw new OperationRejectedError("Workspace channel limit reached (100).");
  const workspaceMembers = await currentWorkspaceMembers(actor);
  const selected = operation.visibility === "public" ? [...workspaceMembers] : (operation.members ?? []);
  if (operation.visibility === "private" && selected.some((did) => !workspaceMembers.has(did))) throw new OperationRejectedError("Private channels can include only active workspace members.");
  const space = channelUri(actor.workspace.authorityDid, skey);
  await context.step("channel-space", async () => { await ensureMemberListSpace(actor.session, "org.slack.channel", skey); });
  for (const did of selected) {
    if (did === actor.workspace.authorityDid) continue;
    await context.step(`channel-member-${did}`, () => putSpaceMember(actor.session, space, did, true, true));
    if (operation.visibility === "private") {
      await context.step(`channel-roster-${did}`, () => writeRoster(actor, space, did, true, "org.slack.channel.roster"));
    }
  }
  await context.step("channel-directory", () => putAuthorityRecord(actor.session, actor.workspace.uri, "org.slack.directory", skey, {
    skey, name: operation.name.trim(), visibility: operation.visibility,
  }).then(() => undefined));
  await context.step("channel-membership-verified", async () => {
    for (const did of selected) if (did !== actor.workspace.authorityDid) await assertMembership(actor, space, did, true, true);
  });
}

async function transitionChannel(
  actor: OperatorActor,
  context: OperationContext,
  operation: OperatorRequest & { skey: string; visibility: "public" | "private"; members?: string[] },
): Promise<void> {
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.directory", operation.skey);
  if (!directory || typeof directory.name !== "string") throw new OperationRejectedError("Channel does not exist.");
  if (directory.visibility === "archived") throw new OperationRejectedError("Archived channels cannot change visibility.");
  const space = channelUri(actor.workspace.authorityDid, operation.skey);
  const activeMembers = await currentWorkspaceMembers(actor);
  const selected = operation.visibility === "public" ? [...activeMembers] : (operation.members ?? []);
  if (operation.visibility === "private" && selected.some((did) => !activeMembers.has(did))) throw new OperationRejectedError("Private channels can include only active workspace members.");
  await context.step("channel-set-transitioning", async () => {
    await putAuthorityRecord(actor.session, actor.workspace.uri, "org.slack.directory", operation.skey, {
      skey: operation.skey, name: directory.name, visibility: "transitioning",
    });
  });
  const currentMembers = await listSpaceMembers(actor.session, space);
  const desired = new Set(selected.filter((did) => did !== actor.workspace.authorityDid));
  if (operation.visibility === "public") {
    for (const did of desired) await context.step(`channel-public-add-${did}`, () => putSpaceMember(actor.session, space, did, true, true));
  }
  for (const member of currentMembers) {
    if (!desired.has(member.did)) await context.step(`channel-remove-${member.did}`, () => removeSpaceMember(actor.session, space, member.did));
  }
  if (operation.visibility === "private") {
    const roster = await activePrivateRoster(actor, space);
    for (const did of roster) if (!desired.has(did)) {
      await context.step(`channel-roster-inactive-${did}`, () => writeRoster(actor, space, did, false, "org.slack.channel.roster"));
    }
    for (const did of selected) {
      if (did === actor.workspace.authorityDid) continue;
      await context.step(`channel-private-add-${did}`, () => putSpaceMember(actor.session, space, did, true, true));
      await context.step(`channel-roster-active-${did}`, () => writeRoster(actor, space, did, true, "org.slack.channel.roster"));
    }
  }
  await context.step("channel-visibility-verified", async () => {
    const actual = (await listSpaceMembers(actor.session, space)).filter((member) => member.did !== actor.workspace.authorityDid);
    const actualByDid = new Map(actual.map((member) => [member.did, member]));
    if (actualByDid.size !== desired.size || actualByDid.size !== actual.length || [...desired].some((did) => {
      const member = actualByDid.get(did);
      return !member || !member.read || !member.write;
    })) {
      throw new Error("Channel member list has not converged.");
    }
    if (operation.visibility === "private") {
      const currentRoster = await activePrivateRoster(actor, space);
      const desiredRoster = new Set(selected.filter((did) => did !== actor.workspace.authorityDid));
      if (currentRoster.size !== desiredRoster.size || [...desiredRoster].some((did) => !currentRoster.has(did))) {
        throw new Error("Private channel roster has not converged.");
      }
    }
  });
  await context.step("channel-set-final-visibility", () => putAuthorityRecord(actor.session, actor.workspace.uri, "org.slack.directory", operation.skey, {
    skey: operation.skey, name: directory.name, visibility: operation.visibility,
  }).then(() => undefined));
}

async function archiveChannel(actor: OperatorActor, context: OperationContext, skey: string): Promise<void> {
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.directory", skey);
  if (!directory || typeof directory.name !== "string") throw new OperationRejectedError("Channel does not exist.");
  if (directory.visibility === "archived") return;
  const space = channelUri(actor.workspace.authorityDid, skey);
  await context.step("channel-archive-transition", () => putAuthorityRecord(actor.session, actor.workspace.uri, "org.slack.directory", skey, {
    skey, name: directory.name, visibility: "transitioning",
  }).then(() => undefined));
  const members = await listSpaceMembers(actor.session, space);
  for (const member of members) {
    await context.step(`channel-archive-remove-${member.did}`, () => removeSpaceMember(actor.session, space, member.did));
  }
  for (const did of await activePrivateRoster(actor, space)) {
    await context.step(`channel-archive-roster-${did}`, () => writeRoster(actor, space, did, false, "org.slack.channel.roster"));
  }
  await context.step("channel-archive-verified", async () => {
    if ((await listSpaceMembers(actor.session, space)).length !== 0) throw new Error("Channel members remain after archive.");
    if ((await activePrivateRoster(actor, space)).size !== 0) throw new Error("Private channel roster remains active after archive.");
  });
  await context.step("channel-archive-final", () => putAuthorityRecord(actor.session, actor.workspace.uri, "org.slack.directory", skey, {
    skey, name: directory.name, visibility: "archived",
  }).then(() => undefined));
}

async function leaveChannel(actor: OperatorActor, context: OperationContext, skey: string): Promise<void> {
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.directory", skey);
  if (!directory || directory.visibility !== "private") throw new OperationRejectedError("Only an active private channel can be left.");
  if (actor.did === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority cannot leave its own channel.");
  const space = channelUri(actor.workspace.authorityDid, skey);
  await context.step("leave-channel-membership", () => removeSpaceMember(actor.session, space, actor.did));
  await context.step("leave-channel-roster", () => writeRoster(actor, space, actor.did, false, "org.slack.channel.roster"));
  await context.step("leave-channel-verified", () => assertNoMembership(actor, space, actor.did));
}

async function reconcileWorkspace(actor: OperatorActor, context: OperationContext): Promise<void> {
  const workspace = actor.workspace.uri;
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  const members = await activeRoster(actor);
  const admins = await activeAdmins(actor);
  await reconcileSpace(actor, context, "workspace", workspace, new Map([...members].map((did) => [did, { read: true, write: true }])));
  await reconcileSpace(actor, context, "inbox", inbox, new Map([...members].map((did) => [did, { read: admins.has(did), write: true }])));
  const channels = (await directoryRecords(actor)).sort((left, right) => left.value.skey.localeCompare(right.value.skey));
  for (const channel of channels) {
    const space = channelUri(actor.workspace.authorityDid, channel.value.skey);
    if (channel.value.visibility === "transitioning") continue;
    if (channel.value.visibility === "archived") {
      await reconcileSpace(actor, context, `archived-${channel.value.skey}`, space, new Map());
      for (const did of await activePrivateRoster(actor, space)) {
        await context.step(`archived-${channel.value.skey}-deactivate-roster-${did}`, () => writeRoster(actor, space, did, false, "org.slack.channel.roster"));
      }
      continue;
    }
    let desiredDids: Set<string>;
    if (channel.value.visibility === "public") desiredDids = members;
    else {
      const privateRoster = await activePrivateRoster(actor, space);
      desiredDids = new Set([...privateRoster].filter((did) => members.has(did)));
      for (const did of privateRoster) if (!members.has(did)) {
        await context.step(`channel-${channel.value.skey}-deactivate-stale-roster-${did}`, () => writeRoster(actor, space, did, false, "org.slack.channel.roster"));
      }
    }
    await reconcileSpace(actor, context, `channel-${channel.value.skey}`, space, new Map([...desiredDids].map((did) => [did, { read: true, write: true }])));
  }
}

async function reconcileSpace(
  actor: OperatorActor,
  context: OperationContext,
  label: string,
  space: string,
  desired: Map<string, { read: boolean; write: boolean }>,
): Promise<void> {
  const current = await listSpaceMembers(actor.session, space);
  const authorityDid = actor.workspace.authorityDid;
  const desiredNonOwner = new Map([...desired].filter(([did]) => did !== authorityDid));
  for (const [did, access] of desiredNonOwner) {
    const existing = current.find((member) => member.did === did);
    if (existing?.read !== access.read || existing?.write !== access.write) {
      await context.step(`${label}-set-${did}`, () => putSpaceMember(actor.session, space, did, access.read, access.write));
    }
  }
  for (const member of current) {
    if (member.did !== authorityDid && !desiredNonOwner.has(member.did)) {
      await context.step(`${label}-remove-${member.did}`, () => removeSpaceMember(actor.session, space, member.did));
    }
  }
  await context.step(`${label}-verified`, async () => {
    const actual = (await listSpaceMembers(actor.session, space)).filter((member) => member.did !== authorityDid);
    if (actual.length !== desiredNonOwner.size || [...desiredNonOwner].some(([did, access]) => {
      const member = actual.find((entry) => entry.did === did);
      return !member || member.read !== access.read || member.write !== access.write;
    })) throw new Error(`Membership reconciliation has not converged for ${label}.`);
  });
}

async function activePrivateRoster(actor: OperatorActor, space: string): Promise<Set<string>> {
  const rows = await listOwnerRecords(actor.session, space, "org.slack.channel.roster");
  const members = new Set(rows.flatMap((row) => row.value && validateSpaceRecord("org.slack.channel.roster", row.value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: space, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
  }).valid && row.value.active === true && typeof row.value.subject === "string" ? [row.value.subject] : []));
  if (members.size > 200) throw new WorkspaceEnvelopeError("Private-channel roster exceeds 200 active members.");
  return members;
}

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
  const directory = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.directory", channelSkey);
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
    await context.step("join-request-inactive-deactivate-roster", () => writeRoster(actor, channelSpace, parsed.repo, false, "org.slack.channel.roster"));
    throw new OperationRejectedError("Only an active workspace member can be approved for a private channel.");
  };
  if (operation.decision === "approve") {
    await context.step("join-request-channel-membership", async () => { await ensureApprovalEligible(); await putSpaceMember(actor.session, channelSpace, parsed.repo, true, true); });
    await context.step("join-request-private-roster", async () => { await ensureApprovalEligible(); await writeRoster(actor, channelSpace, parsed.repo, true, "org.slack.channel.roster"); });
  }
  await context.step("join-request-decision", async () => {
    if (operation.decision === "approve") await ensureApprovalEligible();
    else await ensureRequestCurrent();
    await putAuthorityRecord(actor.session, inbox, "org.slack.joinDecision", decisionKey, {
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
      await writeRoster(actor, channelSpace, repoDid, baseline.rosterActive, "org.slack.channel.roster");
    }
  });
}

function joinRequestBaseline(steps: string[]): { membership: "none" | string; rosterActive: boolean } | null {
  const marker = steps.find((step) => step.startsWith("join-request-baseline-"));
  const match = /^join-request-baseline-(none|[01]{2})-([01])$/.exec(marker ?? "");
  if (!match) return null;
  return { membership: match[1], rosterActive: match[2] === "1" };
}

async function readJoinRequest(session: OAuthSession, inbox: string, repoDid: string, rkey: string, authorityDid: string): Promise<Record<string, unknown> | null> {
  const credential = await mintSpaceCredential(session, inbox);
  return readJoinRequestRecord(credential.client(await resolvePds(repoDid)), inbox, repoDid, rkey, authorityDid);
}

/**
 * The requester's join request, or null when there is no current one to act on. A repo that cannot be authenticated (no
 * usable `#atproto_kem` key, or a MAC that does not verify) reads as null: the decision is rejected and any partial approval
 * is undone, instead of the journal keeping the operation pending and every later admin operation replaying the same failure.
 */
export async function readJoinRequestRecord(
  client: Pick<AtprotoClient, "query">,
  inbox: string,
  repoDid: string,
  rkey: string,
  authorityDid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await client.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space: inbox, repo: repoDid, collection: "org.slack.joinRequest", rkey,
    });
    return validateSpaceRecord("org.slack.joinRequest", result.value, {
      authorityDid, spaceUri: inbox, repoDid, rkey,
    }).valid ? result.value : null;
  } catch (error) {
    if (isNotFound(error) || isUnverifiableRepo(error)) return null;
    throw error;
  }
}

async function directoryRecords(actor: OperatorActor): Promise<Array<{ rkey: string; value: Record<string, unknown> & { skey: string; name: string; visibility: string } }>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, "org.slack.directory");
  const channels = rows.filter((row): row is typeof row & { value: Record<string, unknown> & { skey: string; name: string; visibility: string } } =>
    Boolean(row.value && validateSpaceRecord("org.slack.directory", row.value, {
      authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
    }).valid) && typeof row.value?.skey === "string" && typeof row.value.name === "string" && typeof row.value.visibility === "string",
  );
  if (channels.filter(({ value }) => value.visibility !== "archived").length > 100) {
    throw new WorkspaceEnvelopeError("The active channel count exceeds 100 channels.");
  }
  return channels;
}

async function activeRoster(actor: OperatorActor): Promise<Set<string>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, "org.slack.workspace.roster", MAX_AUTHORITY_RECORD_SCAN);
  const members = new Set(rows.flatMap((row) => row.value && validateSpaceRecord("org.slack.workspace.roster", row.value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
  }).valid && row.value.active === true && typeof row.value.subject === "string" ? [row.value.subject] : []));
  if (members.size > 200) throw new WorkspaceEnvelopeError("The active workspace roster exceeds 200 members.");
  return members;
}

async function currentWorkspaceMembers(actor: OperatorActor): Promise<Set<string>> {
  const [roster, pdsMembers] = await Promise.all([
    activeRoster(actor),
    listSpaceMembers(actor.session, actor.workspace.uri),
  ]);
  assertWorkspaceRosterMatchesPds(roster, pdsMembers, actor.workspace.authorityDid);
  return roster;
}

export function assertWorkspaceRosterMatchesPds(
  roster: ReadonlySet<string>,
  pdsMembers: ReadonlyArray<{ did: string; read: boolean; write: boolean }>,
  authorityDid: string,
): void {
  for (const did of roster) {
    if (did === authorityDid) continue;
    const member = pdsMembers.find((entry) => entry.did === did);
    if (!member || !member.read || !member.write) {
      throw new OperationRejectedError("Workspace roster has not converged with PDS membership.");
    }
  }
  for (const member of pdsMembers) {
    if (member.did === authorityDid || (!member.read && !member.write)) continue;
    if (!roster.has(member.did) || !member.read || !member.write) {
      throw new OperationRejectedError("Workspace roster has not converged with PDS membership.");
    }
  }
}

async function activeAdmins(actor: OperatorActor): Promise<Set<string>> {
  const rows = await listOwnerRecords(actor.session, actor.workspace.uri, "org.slack.admin");
  const members = await activeRoster(actor);
  const workspaceMembers = new Set((await listSpaceMembers(actor.session, actor.workspace.uri))
    .filter((member) => member.read && member.write).map((member) => member.did));
  const admins = new Set(rows.flatMap((row) => row.value && validateSpaceRecord("org.slack.admin", row.value, {
    authorityDid: actor.workspace.authorityDid, spaceUri: actor.workspace.uri, repoDid: actor.workspace.authorityDid, rkey: row.rkey,
  }).valid && row.value.active === true && typeof row.value.subject === "string" && members.has(row.value.subject) &&
    (row.value.subject === actor.workspace.authorityDid || workspaceMembers.has(row.value.subject)) ? [row.value.subject] : []));
  if (admins.size === 0) throw new Error("Workspace has no active admin record.");
  if (admins.size > 200) throw new WorkspaceEnvelopeError("The active admin count exceeds 200 members.");
  return admins;
}

async function hasActiveAdminRecord(actor: OperatorActor, subject: string): Promise<boolean> {
  const record = await getOwnerRecord(actor.session, actor.workspace.uri, "org.slack.admin", subjectKey(subject));
  return record?.subject === subject && record.active === true;
}

async function listOwnerRecords(
  session: OAuthSession,
  space: string,
  collection: string,
  maxRecords = MAX_AUTHORITY_RECORD_SCAN,
): Promise<Array<{ rkey: string; value: Record<string, unknown> }>> {
  const result = await listBoundedRecords(sessionClient(session), { space, repo: session.did, collection, maxRecords });
  if (result.truncated) {
    throw new WorkspaceEnvelopeError(`The ${collection} record scan exceeds its ${maxRecords}-record limit; operator state may be incomplete.`);
  }
  return result.records;
}

async function getOwnerRecord(session: OAuthSession, space: string, collection: string, rkey: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await sessionClient(session).query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
      space, repo: session.did, collection, rkey,
    });
    return validateSpaceRecord(collection, result.value, {
      authorityDid: session.did, spaceUri: space, repoDid: session.did, rkey,
    }).valid ? result.value : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeRoster(actor: OperatorActor, space: string, did: string, active: boolean, collection = "org.slack.workspace.roster"): Promise<void> {
  await putAuthorityRecord(actor.session, space, collection, subjectKey(did), { subject: did, active, updatedAt: new Date().toISOString() });
}

async function assertMembership(actor: OperatorActor, space: string, did: string, read: boolean, write: boolean): Promise<void> {
  const member = (await listSpaceMembers(actor.session, space)).find((entry) => entry.did === did);
  if (!member || member.read !== read || member.write !== write) throw new Error("PDS membership has not converged to the requested state.");
}

async function assertNoMembership(actor: OperatorActor, space: string, did: string): Promise<void> {
  if ((await listSpaceMembers(actor.session, space)).some((entry) => entry.did === did)) throw new Error("PDS membership removal has not converged.");
}

function parseJoinRequestUri(uri: string, authorityDid: string, inbox: string): { repo: string; rkey: string } | null {
  const parsed = parseSpaceRecordUri(uri, inbox, "org.slack.joinRequest");
  return !parsed || parsed.repo === authorityDid ? null : parsed;
}

function inboxUri(authorityDid: string, workspaceSkey: string): string {
  return `at://${authorityDid}/space/org.slack.inbox/${workspaceSkey}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isDid(value: unknown): value is string {
  return typeof value === "string" && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
}

function isSkey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/.test(value);
}

function isTid(value: unknown): value is string {
  return typeof value === "string" && /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(value);
}

function isNotFound(error: unknown): boolean {
  return isMissingXrpcResource(error);
}
