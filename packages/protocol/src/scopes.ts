import { COLLECTION, OPERATOR_METHOD, REPO_COLLECTION, SPACE_TYPE, type SpaceType } from "./nsids";
import { authorityCollections, memberCollections } from "./registry";

// The OAuth scopes the app asks for, built from the registry: the one browser grant (the member set, the operator methods
// and the DM set), and the workspace authority grant.

// The DM permission set, part of the one browser grant (M3): DM tokens live only in the browser (IndexedDB), never on this
// server, per .ai/plans/direct-messages.md section 3.4. Grammar (manage=, authority=*, collection=) verified against
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

export const OPERATOR_METHODS = Object.values(OPERATOR_METHOD);

/**
 * The one grant a person gives the app in the browser (R6), requested once at sign-in: read every workspace, inbox and
 * channel of any authority, with each space's member list as the gate (D5); write the collections a member writes there;
 * call the operator's methods; and the DM set. Built from the registry, so a collection added there is asked for here.
 */
export function memberGrantScopes(serviceRef: string): string[] {
  return [
    ...DM_BROWSER_SCOPES,
    ...[SPACE_TYPE.workspace, SPACE_TYPE.inbox, SPACE_TYPE.channel].flatMap((spaceType) => [memberReadScope(spaceType), memberWriteScope(spaceType)]),
    operatorMethodsScope(OPERATOR_METHODS, serviceRef),
  ];
}

export function operatorMethodsScope(methods: readonly string[], serviceRef: string): string {
  const audience = serviceRef.replaceAll("%", "%25").replace("#", "%23");
  return `rpc?${methods.map((method) => `lxm=${method}`).join("&")}&aud=${audience}`;
}

/**
 * The grant an app asks its own account for: read the workspace and channel spaces of any authority (its installs' member
 * lists decide which), write a channel's messages and reactions, follow its spaces through the operator, and publish its
 * declaration. No inbox and no DMs: an app is no person. Built from the registry, as the person's grant is.
 */
export function appGrantScopes(serviceRef: string): string[] {
  return [
    "atproto",
    `repo:${REPO_COLLECTION.appDeclaration}?action=create&action=update`,
    memberReadScope(SPACE_TYPE.workspace),
    memberReadScope(SPACE_TYPE.channel),
    memberWriteScope(SPACE_TYPE.channel),
    operatorMethodsScope([OPERATOR_METHOD.getChanges], serviceRef),
  ];
}

/** Reading a space of this type, of any authority: each space's member list decides which. */
function memberReadScope(spaceType: SpaceType): string {
  return `space:${spaceType}?authority=*&action=read`;
}

/** Writing the collections a member writes in a space of this type. An acceptance is never withdrawn; a join request, a message and a reaction are. */
function memberWriteScope(spaceType: SpaceType): string {
  return `space:${spaceType}?authority=*&collection=${memberCollections(spaceType).join("&collection=")}&action=create&action=update${spaceType === SPACE_TYPE.workspace ? "" : "&action=delete"}`;
}
