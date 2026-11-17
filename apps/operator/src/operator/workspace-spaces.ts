import type { OAuthSession } from "@atproto/oauth-client-node";
import { ensureMemberListSpace, putAuthorityRecord } from "../atproto/space-ops";
import { extSpaceSkeyFor, getExtension, type ExtensionId } from "@flock/protocol/extensions";
import { inboxUri, stableHash } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";

// A workspace's spaces and its first records, the same for every kind that creates a workspace (`createWorkspace`, and the
// `bootstrapWorkspace` rows begun before it). Each kind names its own steps around these actions.

/** Refuses a workspace name the app does not create, before anything else is asked of the account. */
export function assertWorkspaceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(name.trim())) {
    throw new Error("Workspace name must be 1 to 60 plain-text characters.");
  }
}

/** The workspace's key, derived from its name, so a retry of the same creation lands on the same spaces. */
export function workspaceKey(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
  return `${slug.slice(0, 42)}-${stableHash(name).slice(0, 10)}`;
}

export function generalKey(workspaceSkey: string): string {
  return `${workspaceSkey}-general`;
}

export async function createWorkspaceSpace(session: OAuthSession, skey: string): Promise<void> {
  await ensureMemberListSpace(session, SPACE_TYPE.workspace, skey);
}

export async function createInboxSpace(session: OAuthSession, skey: string): Promise<void> {
  if (await ensureMemberListSpace(session, SPACE_TYPE.inbox, skey) !== inboxUri(session.did, skey)) throw new Error("Inbox URI did not match the workspace key.");
}

export async function createGeneralChannelSpace(session: OAuthSession, skey: string): Promise<void> {
  await ensureMemberListSpace(session, SPACE_TYPE.channel, generalKey(skey));
}

export async function writeWorkspaceProfile(session: OAuthSession, workspace: string, name: string): Promise<void> {
  await putAuthorityRecord(session, workspace, COLLECTION.workspaceProfile, "self", { name, createdAt: new Date().toISOString() });
}

export async function writeGeneralDirectory(session: OAuthSession, workspace: string, skey: string): Promise<void> {
  const general = generalKey(skey);
  await putAuthorityRecord(session, workspace, COLLECTION.directory, general, { skey: general, name: "general", visibility: "public" });
}

export async function ensureExtensionSpace(session: OAuthSession, workspaceSkey: string, extId: ExtensionId): Promise<string> {
  const manifest = getExtension(extId);
  return ensureMemberListSpace(session, manifest.spaceType, extSpaceSkeyFor(workspaceSkey, extId));
}
