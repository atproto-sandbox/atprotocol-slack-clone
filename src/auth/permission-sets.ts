import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as GetServiceAuth from "@/lexicons/api/types/com/atproto/server/getServiceAuth";
import { sessionClient } from "@/atproto/client";
import { isSkey } from "@/protocol/keys";

export const SLACK_SPACE_TYPES = {
  workspace: "org.slack.workspace",
  inbox: "org.slack.inbox",
  channel: "org.slack.channel",
  dmInbox: "org.slack.dm.inbox",
  dmConversation: "org.slack.dm.conversation",
} as const;

export const SLACK_COLLECTIONS = {
  workspaceProfile: "org.slack.workspace.profile",
  directory: "org.slack.directory",
  workspaceRoster: "org.slack.workspace.roster",
  admin: "org.slack.admin",
  acceptance: "org.slack.acceptance",
  joinRequest: "org.slack.joinRequest",
  joinDecision: "org.slack.joinDecision",
  message: "org.slack.channel.message",
  reaction: "org.slack.channel.reaction",
  channelRoster: "org.slack.channel.roster",
  dmRequest: "org.slack.dm.request",
  dmHeader: "org.slack.dm.header",
  dmMessage: "org.slack.dm.message",
  dmReaction: "org.slack.dm.reaction",
} as const;

// listSpaces needs read_self across authorities before an invited user knows
// which workspace authority to request a narrower read scope from.
export const WORKSPACE_DISCOVERY_SCOPE =
  `space:${SLACK_SPACE_TYPES.workspace}?authority=*&collection=${SLACK_COLLECTIONS.acceptance}&action=read_self`;

// The DM permission set requested by a browser-held OAuth session (M3). The
// server's own OAuth session never requests these: DM tokens live only in the
// browser (IndexedDB), never on this server, per docs/plans/direct-messages.md
// section 3.4. Grammar (manage=, authority=*, collection=) verified against
// ../atproto-spaces-phase0/packages/oauth/oauth-scopes/src/scopes/space-permission.ts.
export const DM_BROWSER_SCOPES: readonly string[] = [
  "atproto",
  // Send, re-put (backoff retry), and withdraw a request into any recipient's
  // inbox. Collection-restricted so the same grant cannot write anything else.
  `space:${SLACK_SPACE_TYPES.dmInbox}?authority=*&collection=${SLACK_COLLECTIONS.dmRequest}&action=create&action=update&action=delete`,
  // The user's own inbox: create it, read it and its member list, switch its
  // request policy (updateSpace), and manage its allowlist (putMember/removeMember).
  `space:${SLACK_SPACE_TYPES.dmInbox}?authority=self&action=read&manage=create&manage=update`,
  // Asking any inbox for a credential, so a sender can tell "no inbox" (SpaceNotFound) from "inbox exists" (UserNotAuthorized:
  // the member list is the real read gate) before a putRecord that the PDS accepts either way.
  `space:${SLACK_SPACE_TYPES.dmInbox}?authority=*&action=read`,
  // The user's own conversation halves: create, write every DM record type,
  // manage membership, and delete the half outright.
  `space:${SLACK_SPACE_TYPES.dmConversation}?authority=self&collection=${SLACK_COLLECTIONS.dmHeader}&collection=${SLACK_COLLECTIONS.dmMessage}&collection=${SLACK_COLLECTIONS.dmReaction}&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
  // Any participant's half, read only: getDelegationToken for a half this
  // session does not own, and listSpaces(type=conversation) across authorities
  // (an unfiltered listing needs a wildcard grant). `read` implies `read_self`.
  `space:${SLACK_SPACE_TYPES.dmConversation}?authority=*&action=read`,
] as const;

export type SpaceAction = "read" | "read_self" | "create" | "update" | "delete";

export function memberSpaceScope(options: {
  spaceType: string;
  authorityDid: string;
  skey: string;
  action: SpaceAction;
  collection?: string;
  additionalActions?: readonly SpaceAction[];
}): string {
  if (options.spaceType === SLACK_SPACE_TYPES.dmInbox || options.spaceType === SLACK_SPACE_TYPES.dmConversation) {
    throw new Error("DM space types are never granted through the server's member scope builder.");
  }
  if (!isSkey(options.skey)) throw new Error("Invalid space key.");
  const params = [
    `authority=${options.authorityDid}`,
    `skey=${options.skey}`,
    ...(options.collection ? [`collection=${options.collection}`] : []),
    `action=${options.action}`,
    ...(options.additionalActions ?? []).map((action) => `action=${action}`),
  ];
  return `space:${options.spaceType}?${params.join("&")}`;
}

export function operatorMethodScope(method: string, serviceRef: string): string {
  // RPC scope values are query parameters. Preserve percent escapes inside a
  // DID (for example did:web:localhost%3A3000) while escaping the fragment
  // separator as the query parameter delimiter.
  const audience = serviceRef.replaceAll("%", "%25").replace("#", "%23");
  return `rpc:${method}?aud=${audience}`;
}

export function workspaceAuthorityScopes(): string[] {
  const allAuthorityRecords = [
    SLACK_COLLECTIONS.workspaceProfile,
    SLACK_COLLECTIONS.directory,
    SLACK_COLLECTIONS.workspaceRoster,
    SLACK_COLLECTIONS.admin,
  ];
  const channels = [SLACK_COLLECTIONS.channelRoster];
  return [
    `space:${SLACK_SPACE_TYPES.workspace}?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update`,
    `space:${SLACK_SPACE_TYPES.workspace}?authority=self&skey=*&collection=${allAuthorityRecords.join("&collection=")}&action=create&action=update&action=delete`,
    `space:${SLACK_SPACE_TYPES.inbox}?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update`,
    `space:${SLACK_SPACE_TYPES.inbox}?authority=self&skey=*&collection=${SLACK_COLLECTIONS.joinDecision}&action=create&action=update&action=delete`,
    `space:${SLACK_SPACE_TYPES.channel}?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update`,
    ...channels.map((collection) => `space:${SLACK_SPACE_TYPES.channel}?authority=self&skey=*&collection=${collection}&action=create&action=update&action=delete`),
  ];
}

export const OPERATOR_METHODS = [
  "org.slack.operator.execute",
  "org.slack.operator.getOperation",
  "org.slack.operator.listInboxWriters",
] as const;

export const OPERATOR_LEAVE_METHODS = ["org.slack.operator.execute"] as const;

export function permissionScopeFor(
  action: string,
  input: { workspaceDid: string; workspaceSkey?: string; skey?: string; serviceRef?: string },
): string[] {
  const { workspaceDid, skey } = input;
  switch (action) {
    case "workspaceRead":
      return [memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey ?? "workspace", action: "read" })];
    case "channelRead":
      if (!skey) throw new Error("A channel key is required.");
      return [memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.channel, authorityDid: workspaceDid, skey, action: "read" })];
    case "acceptanceWrite":
      return [memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey ?? "workspace", collection: SLACK_COLLECTIONS.acceptance, action: "create", additionalActions: ["update"] })];
    case "requestJoin":
      return [memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.inbox, authorityDid: workspaceDid, skey: input.workspaceSkey ?? "workspace", collection: SLACK_COLLECTIONS.joinRequest, action: "create", additionalActions: ["update", "delete"] })];
    case "joinWorkspace":
      if (!input.workspaceSkey) throw new Error("A workspace key is required.");
      return [
        memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey, action: "read" }),
        memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey, collection: SLACK_COLLECTIONS.acceptance, action: "create", additionalActions: ["update"] }),
      ];
    case "channelWrite":
      if (!skey) throw new Error("A channel key is required.");
      if (!isSkey(skey)) throw new Error("Invalid space key.");
      return [`space:${SLACK_SPACE_TYPES.channel}?authority=${workspaceDid}&skey=${skey}&collection=${SLACK_COLLECTIONS.message}&collection=${SLACK_COLLECTIONS.reaction}&action=create&action=update&action=delete`];
    case "channelAccess":
      if (!skey) throw new Error("A channel key is required.");
      return [
        memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.channel, authorityDid: workspaceDid, skey, action: "read" }),
        ...[SLACK_COLLECTIONS.message, SLACK_COLLECTIONS.reaction].map((collection) =>
          memberSpaceScope({ spaceType: SLACK_SPACE_TYPES.channel, authorityDid: workspaceDid, skey, collection, action: "create", additionalActions: ["update", "delete"] }),
        ),
      ];
    case "operatorAdmin":
      if (!input.serviceRef) throw new Error("The operator service reference is not configured.");
      return [operatorMethodsScope(OPERATOR_METHODS, input.serviceRef)];
    case "operatorLeave":
      if (!input.serviceRef || !input.workspaceSkey) throw new Error("The workspace and operator service reference are required.");
      return OPERATOR_LEAVE_METHODS.map((method) => operatorMethodScope(method, input.serviceRef!));
    case "workspaceAuthority":
      return workspaceAuthorityScopes();
    default:
      throw new Error("Unknown permission request.");
  }
}

function operatorMethodsScope(methods: readonly string[], serviceRef: string): string {
  const audience = serviceRef.replaceAll("%", "%25").replace("#", "%23");
  return `rpc?${methods.map((method) => `lxm=${method}`).join("&")}&aud=${audience}`;
}

export async function requestOperatorServiceAuth(
  session: OAuthSession,
  serviceRef: string,
  method: (typeof OPERATOR_METHODS)[number],
): Promise<string> {
  const result = await sessionClient(session).query<GetServiceAuth.OutputSchema>(
    "com.atproto.server.getServiceAuth",
    { aud: serviceRef, lxm: method },
  );
  return result.token;
}
