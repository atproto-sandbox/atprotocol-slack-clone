import type { OAuthSession } from "@atproto/oauth-client-node";
import { isMissingXrpcResource } from "@flock/protocol/atproto/xrpc";
import { extSpaceSkeyFor, getExtension, type ExtensionId } from "@flock/protocol/extensions";
import { groupMetaUri, inboxUri, SELF_SKEY } from "@flock/protocol/keys";
import { COLLECTION, ATGRP_COLLECTION, ATGRP_POLICY, REPO_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import type { GroupAtgrpPolicy } from "@flock/protocol/scopes";
import { sessionClient } from "../atproto/client";
import {
  ensureOpenSocialSpace,
  getOpenSocialSpacePolicy,
  putAuthorityRecord,
  updateOpenSocialSpacePolicy,
} from "../atproto/space-ops";

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function countGraphemes(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

/** Validates a group/workspace display name against `org.atgrp.about` & `createWorkspace` limits (1..64 graphemes, <= 640 bytes). */
export function assertWorkspaceName(name: string): void {
  const trimmed = name.trim();
  if (
    trimmed.length < 1 ||
    Buffer.byteLength(trimmed, "utf8") > 640 ||
    countGraphemes(trimmed) > 64 ||
    /[\r\n\t\0]/.test(trimmed)
  ) {
    throw new Error("Workspace name must be 1 to 64 characters without control characters.");
  }
}

export function workspaceKey(...unused: readonly [string?]): string {
  void unused;
  return SELF_SKEY;
}

export function generalKey(workspaceSkey = SELF_SKEY): string {
  return workspaceSkey === SELF_SKEY ? "general" : `${workspaceSkey}-general`;
}

export function defaultWorkspaceSpacePolicy(activeAppRoles: readonly string[] = []): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "moderator", read: true, write: true },
      { role: "member", read: true },
      ...[...new Set(activeAppRoles)].sort().map((role) => ({ role, read: true })),
    ],
  };
}

export function defaultInboxSpacePolicy(): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "moderator", read: true, write: true },
      { role: "member", write: true },
    ],
  };
}

export function defaultPublicChannelPolicy(
  activeAppGrants: ReadonlyArray<{ role: string; write: boolean }> = [],
): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "moderator", read: true, write: true },
      { role: "member", read: true, write: true },
      ...[...activeAppGrants]
        .sort((a, b) => a.role.localeCompare(b.role))
        .map(({ role, write }) => ({ role, read: true, write })),
    ],
  };
}

export function defaultPrivateChannelPolicy(
  channelRole: string,
  activeAppGrants: ReadonlyArray<{ role: string; write: boolean }> = [],
): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: true,
    grants: [
      { role: channelRole, read: true, write: true },
      ...[...activeAppGrants]
        .sort((a, b) => a.role.localeCompare(b.role))
        .map(({ role, write }) => ({ role, read: true, write })),
    ],
  };
}

export function archivedChannelPolicy(): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: true,
    grants: [],
  };
}

export function defaultAppInboxPolicy(appRole: string): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", write: true },
      { role: "moderator", write: true },
      { role: "member", write: true },
      { role: appRole, read: true },
    ],
  };
}

export function disabledAppInboxPolicy(): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: true,
    grants: [],
  };
}

export function defaultExtensionSpacePolicy(): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "moderator", read: true, write: true },
      { role: "member", read: true, write: true },
    ],
  };
}

export function disabledExtensionSpacePolicy(): GroupAtgrpPolicy {
  return {
    $type: ATGRP_POLICY,
    publicRead: false,
    unlisted: true,
    grants: [{ role: "admin", read: true, write: true }],
  };
}

export async function createWorkspaceSpace(session: OAuthSession, skey = SELF_SKEY): Promise<void> {
  await ensureOpenSocialSpace(session, SPACE_TYPE.workspace, skey, defaultWorkspaceSpacePolicy());
}

export async function createInboxSpace(session: OAuthSession, skey = SELF_SKEY): Promise<void> {
  if ((await ensureOpenSocialSpace(session, SPACE_TYPE.inbox, skey, defaultInboxSpacePolicy())) !== inboxUri(session.did, skey)) {
    throw new Error("Inbox URI did not match the workspace key.");
  }
}

export async function createGeneralChannelSpace(session: OAuthSession, skey = SELF_SKEY): Promise<void> {
  await ensureOpenSocialSpace(session, SPACE_TYPE.channel, generalKey(skey), defaultPublicChannelPolicy());
}

export async function ensureGroupProfileName(
  session: OAuthSession,
  name: string,
  options?: { joinPolicy?: "open" | "approval" | "invite"; publicMeta?: boolean },
): Promise<void> {
  const metaSpace = groupMetaUri(session.did);
  const metaPolicy = await getOpenSocialSpacePolicy(session, metaSpace);
  if (!metaPolicy) {
    throw new Error("OpenSocial org.atgrp.meta/self space is missing on the group host.");
  }
  if (options?.publicMeta !== undefined) {
    const client = sessionClient(session);
    const readHasDeclaration = () =>
      client
        .query<{ value?: Record<string, unknown> }>("com.atproto.repo.getRecord", {
          repo: session.did,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
        })
        .then(
          () => true,
          (err: unknown) => {
            if (isMissingXrpcResource(err)) return false;
            throw err;
          },
        );

    const policyNeedsUpdate = (metaPolicy.publicRead === true) !== options.publicMeta;
    const hasDeclaration = policyNeedsUpdate ? !options.publicMeta : await readHasDeclaration();
    if (policyNeedsUpdate || hasDeclaration !== options.publicMeta) {
      await updateOpenSocialSpacePolicy(session, metaSpace, {
        ...metaPolicy,
        publicRead: options.publicMeta,
      });
      const postHasDeclaration = await readHasDeclaration();
      if (options.publicMeta && !postHasDeclaration) {
        await client.procedure("com.atproto.repo.putRecord", {
          repo: session.did,
          collection: REPO_COLLECTION.groupDeclaration,
          rkey: SELF_SKEY,
          record: {
            $type: REPO_COLLECTION.groupDeclaration,
          },
        });
      } else if (!options.publicMeta && postHasDeclaration) {
        await client
          .procedure("com.atproto.repo.deleteRecord", {
            repo: session.did,
            collection: REPO_COLLECTION.groupDeclaration,
            rkey: SELF_SKEY,
          })
          .catch((err: unknown) => {
            if (!isMissingXrpcResource(err)) throw err;
          });
      }
    }
  }
  const existingAbout = await (async () => {
    try {
      const res = await sessionClient(session).query<{ value: Record<string, unknown> }>(
        "com.atproto.space.getRecord",
        { space: metaSpace, repo: session.did, collection: ATGRP_COLLECTION.about, rkey: "self" },
      );
      return res.value;
    } catch {
      return null;
    }
  })();
  if (existingAbout?.displayName !== name) {
    const { joinPolicy: _legacyJoin, createdAt: _legacyCreated, ...restAbout } = existingAbout ?? {};
    void _legacyJoin;
    void _legacyCreated;
    await putAuthorityRecord(session, metaSpace, ATGRP_COLLECTION.about, "self", {
      ...restAbout,
      displayName: name,
    });
  }
  const existingConfig = await (async () => {
    try {
      const res = await sessionClient(session).query<{ value: Record<string, unknown> }>(
        "com.atproto.space.getRecord",
        { space: metaSpace, repo: session.did, collection: ATGRP_COLLECTION.config, rkey: "self" },
      );
      return res.value;
    } catch {
      return null;
    }
  })();
  const joinPolicy =
    options?.joinPolicy ??
    (typeof existingConfig?.joinPolicy === "string" ? existingConfig.joinPolicy : "invite");
  if (existingConfig?.joinPolicy !== joinPolicy) {
    await putAuthorityRecord(session, metaSpace, ATGRP_COLLECTION.config, "self", {
      ...(existingConfig ?? {}),
      joinPolicy,
    });
  }
}

export async function writeGeneralDirectory(session: OAuthSession, workspace: string, skey = SELF_SKEY): Promise<void> {
  const general = generalKey(skey);
  await putAuthorityRecord(session, workspace, COLLECTION.directory, general, {
    skey: general,
    name: "general",
    visibility: "public",
  });
}

export async function ensureExtensionSpace(
  session: OAuthSession,
  workspaceSkey: string,
  extId: ExtensionId,
): Promise<string> {
  const manifest = getExtension(extId);
  return ensureOpenSocialSpace(
    session,
    manifest.spaceType,
    extSpaceSkeyFor(workspaceSkey, extId),
    defaultExtensionSpacePolicy(),
  );
}
