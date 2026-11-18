import { putAuthorityRecord } from "../../atproto/space-ops";
import { channelUri, inboxUri, subjectKey } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import type { OperationKind } from "./kind";
import {
  assertWorkspaceName, createGeneralChannelSpace, createInboxSpace, createWorkspaceSpace, generalKey, workspaceKey,
  writeGeneralDirectory, writeWorkspaceProfile,
} from "../workspace-spaces";

/**
 * Creates a workspace for its authority: the three spaces, the profile, the authority's roster and admin records, #general.
 * No longer issued (`createWorkspace` replaced it, R8); its handler stays for rows begun before, which resume through it.
 */
export const bootstrapWorkspaceKind: OperationKind = {
  kind: "bootstrapWorkspace",
  required: ["name"],
  actor: "authority",
  submittedThrough: "createWorkspace",
  steps: ["workspace-space", "inbox-space", "general-channel-space", "workspace-profile", "owner-roster", "owner-admin", "general-directory"],
  validate: (request) => assertWorkspaceName(String(request.name)),
  run: (actor, context, request) => runBootstrap(actor, context, String(request.name)),
  createsSpaces: (actor) => [actor.workspace.uri, inboxUri(actor.workspace.authorityDid, actor.workspace.skey), channelUri(actor.workspace.authorityDid, generalKey(actor.workspace.skey))],
};

async function runBootstrap(actor: OperatorActor, context: OperationContext, name: string): Promise<void> {
  const { session } = actor;
  const { uri: workspace, skey } = actor.workspace;
  if (workspaceKey(name) !== skey) throw new OperationRejectedError("A workspace's key must be the one derived from its name.");
  await context.step("workspace-space", () => createWorkspaceSpace(session, skey));
  await context.step("inbox-space", () => createInboxSpace(session, skey));
  await context.step("general-channel-space", () => createGeneralChannelSpace(session, skey));
  await context.step("workspace-profile", () => writeWorkspaceProfile(session, workspace, name));
  await context.step("owner-roster", async () => {
    await putAuthorityRecord(session, workspace, COLLECTION.workspaceRoster, subjectKey(session.did), { subject: session.did, active: true, updatedAt: new Date().toISOString() });
  });
  await context.step("owner-admin", async () => {
    await putAuthorityRecord(session, workspace, COLLECTION.admin, subjectKey(session.did), { subject: session.did, active: true, updatedAt: new Date().toISOString() });
  });
  await context.step("general-directory", () => writeGeneralDirectory(session, workspace, skey));
}
