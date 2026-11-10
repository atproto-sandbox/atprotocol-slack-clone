import { isSkey } from "./keys";
import { COLLECTION, OPERATOR_METHOD, REPO_COLLECTION, SPACE_TYPE } from "./nsids";
import { authorityCollections } from "./registry";

// The OAuth scopes the app asks for, built from the registry: the member sign-in, the per-space member permissions, the
// operator methods, the browser DM set, and the workspace authority grant.

// listSpaces needs read_self across authorities before an invited user knows
// which workspace authority to request a narrower read scope from.
export const WORKSPACE_DISCOVERY_SCOPE =
  `space:${SPACE_TYPE.workspace}?authority=*&collection=${COLLECTION.acceptance}&action=read_self`;

// What every sign-in asks for: discovery across authorities, and reading the spaces this account is itself the authority of
// (its own workspaces, their inboxes and channels), which it reads as any member reads them. Administering those spaces
// is the operator's job, with the separate authority grant (src/operator/authority-grant.ts), never with a sign-in.
export const MEMBER_SIGN_IN_SCOPES: readonly string[] = [
  WORKSPACE_DISCOVERY_SCOPE,
  ...[SPACE_TYPE.workspace, SPACE_TYPE.inbox, SPACE_TYPE.channel]
    .map((spaceType) => `space:${spaceType}?authority=self&skey=*&action=read_self&action=read`),
];

// The DM permission set requested by a browser-held OAuth session (M3). The
// server's own OAuth session never requests these: DM tokens live only in the
// browser (IndexedDB), never on this server, per .ai/plans/direct-messages.md
// section 3.4. Grammar (manage=, authority=*, collection=) verified against
// the pinned PDS checkout, packages/oauth/oauth-scopes/src/scopes/space-permission.ts.
export const DM_BROWSER_SCOPES: readonly string[] = [
  "atproto",
  // Send, re-put (backoff retry), and withdraw a request into any recipient's
  // inbox. Collection-restricted so the same grant cannot write anything else.
  `space:${SPACE_TYPE.dmInbox}?authority=*&collection=${COLLECTION.dmRequest}&action=create&action=update&action=delete`,
  // The user's own inbox: create it, read it and its member list, switch its
  // request policy (updateSpace), and manage its allowlist (putMember/removeMember).
  `space:${SPACE_TYPE.dmInbox}?authority=self&action=read&manage=create&manage=update`,
  // The public declaration that this account runs an inbox, which a sender reads before writing a request: the space
  // authority answers a stranger asking for the inbox exactly as it answers for a space that does not exist, and the PDS
  // accepts a putRecord into either. The inbox is never deleted by the app, so the declaration is never withdrawn.
  `repo:${REPO_COLLECTION.dmDeclaration}?action=create&action=update`,
  // The user's own conversation halves: create, write every DM record type,
  // manage membership, and delete the half outright.
  `space:${SPACE_TYPE.dmConversation}?authority=self&collection=${COLLECTION.dmHeader}&collection=${COLLECTION.dmMessage}&collection=${COLLECTION.dmReaction}&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
  // Any participant's half, read only: getDelegationToken for a half this
  // session does not own, and listSpaces(type=conversation) across authorities
  // (an unfiltered listing needs a wildcard grant). `read` implies `read_self`.
  `space:${SPACE_TYPE.dmConversation}?authority=*&action=read`,
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
  if (options.spaceType === SPACE_TYPE.dmInbox || options.spaceType === SPACE_TYPE.dmConversation) {
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

/**
 * The workspace authority grant: manage and read its own workspace, inbox and channel spaces, and write the collections the
 * registry says the authority writes in each. The same for every workspace, so one OAuth client serves every authority.
 */
export function workspaceAuthorityScopes(): string[] {
  return [SPACE_TYPE.workspace, SPACE_TYPE.inbox, SPACE_TYPE.channel].flatMap((spaceType) => [
    `space:${spaceType}?authority=self&skey=*&action=read_self&action=read&manage=create&manage=update`,
    `space:${spaceType}?authority=self&skey=*&collection=${authorityCollections(spaceType).join("&collection=")}&action=create&action=update&action=delete`,
  ]);
}

export const OPERATOR_METHODS = [OPERATOR_METHOD.execute, OPERATOR_METHOD.getOperation, OPERATOR_METHOD.listInboxWriters] as const;

export const OPERATOR_LEAVE_METHODS = [OPERATOR_METHOD.execute] as const;

export function permissionScopeFor(
  action: string,
  input: { workspaceDid: string; workspaceSkey?: string; skey?: string; serviceRef?: string },
): string[] {
  const { workspaceDid, skey } = input;
  switch (action) {
    case "workspaceRead":
      return [memberSpaceScope({ spaceType: SPACE_TYPE.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey ?? "workspace", action: "read" })];
    case "channelRead":
      if (!skey) throw new Error("A channel key is required.");
      return [memberSpaceScope({ spaceType: SPACE_TYPE.channel, authorityDid: workspaceDid, skey, action: "read" })];
    case "acceptanceWrite":
      return [memberSpaceScope({ spaceType: SPACE_TYPE.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey ?? "workspace", collection: COLLECTION.acceptance, action: "create", additionalActions: ["update"] })];
    case "requestJoin":
      return [memberSpaceScope({ spaceType: SPACE_TYPE.inbox, authorityDid: workspaceDid, skey: input.workspaceSkey ?? "workspace", collection: COLLECTION.joinRequest, action: "create", additionalActions: ["update", "delete"] })];
    case "joinWorkspace":
      if (!input.workspaceSkey) throw new Error("A workspace key is required.");
      return [
        memberSpaceScope({ spaceType: SPACE_TYPE.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey, action: "read" }),
        memberSpaceScope({ spaceType: SPACE_TYPE.workspace, authorityDid: workspaceDid, skey: input.workspaceSkey, collection: COLLECTION.acceptance, action: "create", additionalActions: ["update"] }),
      ];
    case "channelWrite":
      if (!skey) throw new Error("A channel key is required.");
      if (!isSkey(skey)) throw new Error("Invalid space key.");
      return [`space:${SPACE_TYPE.channel}?authority=${workspaceDid}&skey=${skey}&collection=${COLLECTION.message}&collection=${COLLECTION.reaction}&action=create&action=update&action=delete`];
    case "channelAccess":
      if (!skey) throw new Error("A channel key is required.");
      return [
        memberSpaceScope({ spaceType: SPACE_TYPE.channel, authorityDid: workspaceDid, skey, action: "read" }),
        ...[COLLECTION.message, COLLECTION.reaction].map((collection) =>
          memberSpaceScope({ spaceType: SPACE_TYPE.channel, authorityDid: workspaceDid, skey, collection, action: "create", additionalActions: ["update", "delete"] }),
        ),
      ];
    case "operatorAdmin":
      if (!input.serviceRef) throw new Error("The operator service reference is not configured.");
      return [operatorMethodsScope(OPERATOR_METHODS, input.serviceRef)];
    case "operatorLeave":
      if (!input.serviceRef || !input.workspaceSkey) throw new Error("The workspace and operator service reference are required.");
      return OPERATOR_LEAVE_METHODS.map((method) => operatorMethodScope(method, input.serviceRef!));
    default:
      throw new Error("Unknown permission request.");
  }
}

function operatorMethodsScope(methods: readonly string[], serviceRef: string): string {
  const audience = serviceRef.replaceAll("%", "%25").replace("#", "%23");
  return `rpc?${methods.map((method) => `lxm=${method}`).join("&")}&aud=${audience}`;
}
