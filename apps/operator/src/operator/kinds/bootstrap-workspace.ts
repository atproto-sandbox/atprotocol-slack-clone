import { channelUri, groupMembersUri, groupMetaUri, inboxUri, SELF_SKEY } from "@flock/protocol/keys";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import {
  assertWorkspaceName,
  createGeneralChannelSpace,
  createInboxSpace,
  createWorkspaceSpace,
  ensureGroupProfileName,
  generalKey,
  writeGeneralDirectory,
} from "../workspace-spaces";
import type { OperationKind } from "./kind";

/**
 * Legacy pre-R8 authority bootstrap handler retained strictly for journal replay compatibility.
 */
export const bootstrapWorkspaceKind: OperationKind = {
  kind: "bootstrapWorkspace",
  required: ["name"],
  actor: "authority",
  submittedThrough: "createWorkspace",
  steps: [
    "workspace-space",
    "inbox-space",
    "general-channel-space",
    "workspace-profile",
    "owner-roster",
    "owner-admin",
    "general-directory",
  ],
  validate: (request) => assertWorkspaceName(String(request.name)),
  run: (actor, context, request) => runBootstrap(actor, context, String(request.name)),
  createsSpaces: (actor) => [
    groupMetaUri(actor.workspace.authorityDid),
    groupMembersUri(actor.workspace.authorityDid),
    actor.workspace.uri,
    inboxUri(actor.workspace.authorityDid, actor.workspace.skey),
    channelUri(actor.workspace.authorityDid, generalKey(actor.workspace.skey)),
  ],
};

async function runBootstrap(actor: OperatorActor, context: OperationContext, name: string): Promise<void> {
  const { session } = actor;
  const { uri: workspace, skey } = actor.workspace;
  if (skey !== SELF_SKEY) {
    throw new OperationRejectedError("OpenSocial workspace space key must be 'self'.");
  }
  await context.step("workspace-space", () => createWorkspaceSpace(session, skey));
  await context.step("inbox-space", () => createInboxSpace(session, skey));
  await context.step("general-channel-space", () => createGeneralChannelSpace(session, skey));
  await context.step("workspace-profile", () => ensureGroupProfileName(session, name));
  await context.step("owner-roster", async () => {});
  await context.step("owner-admin", async () => {});
  await context.step("general-directory", () => writeGeneralDirectory(session, workspace, skey));
}
