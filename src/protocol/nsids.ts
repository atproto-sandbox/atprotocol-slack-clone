// Every NSID this app defines, built from one namespace. No other source module spells an NSID: they import these (a test
// enforces it), so renaming the namespace is this one constant plus the lexicon documents.

export const NAMESPACE = "org.slack";

type Nsid<Name extends string> = `${typeof NAMESPACE}.${Name}`;

function nsid<Name extends string>(name: Name): Nsid<Name> {
  return `${NAMESPACE}.${name}`;
}

export const SPACE_TYPE = {
  workspace: nsid("workspace"),
  inbox: nsid("inbox"),
  channel: nsid("channel"),
  dmInbox: nsid("dm.inbox"),
  dmConversation: nsid("dm.conversation"),
} as const;

/** Records that live in a space. */
export const COLLECTION = {
  workspaceProfile: nsid("workspace.profile"),
  directory: nsid("directory"),
  workspaceRoster: nsid("workspace.roster"),
  admin: nsid("admin"),
  acceptance: nsid("acceptance"),
  joinRequest: nsid("joinRequest"),
  joinDecision: nsid("joinDecision"),
  message: nsid("channel.message"),
  reaction: nsid("channel.reaction"),
  channelRoster: nsid("channel.roster"),
  dmRequest: nsid("dm.request"),
  dmHeader: nsid("dm.header"),
  dmMessage: nsid("dm.message"),
  dmReaction: nsid("dm.reaction"),
} as const;

/** Records that live in an account's own public repo. */
export const REPO_COLLECTION = {
  dmDeclaration: nsid("dm.declaration"),
} as const;

export const OPERATOR_METHOD = {
  execute: nsid("operator.execute"),
  getOperation: nsid("operator.getOperation"),
  listInboxWriters: nsid("operator.listInboxWriters"),
} as const;

export type SpaceType = (typeof SPACE_TYPE)[keyof typeof SPACE_TYPE];
export type Collection = (typeof COLLECTION)[keyof typeof COLLECTION];
export type OperatorMethod = (typeof OPERATOR_METHOD)[keyof typeof OPERATOR_METHOD];
