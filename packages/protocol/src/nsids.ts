// Every NSID this app defines, built from one namespace. No other source module spells an NSID: they import these (a test
// enforces it), so renaming the namespace is this one constant plus the lexicon documents.

export const NAMESPACE = "new.flock";

type Nsid<Name extends string> = `${typeof NAMESPACE}.${Name}`;

function nsid<Name extends string>(name: Name): Nsid<Name> {
  return `${NAMESPACE}.${name}`;
}

export const SPACE_TYPE = {
  workspace: nsid("workspace"),
  inbox: nsid("inbox"),
  channel: nsid("channel"),
  appInbox: nsid("app.inbox"),
  dmInbox: nsid("dm.inbox"),
  dmConversation: nsid("dm.conversation"),
  tasks: nsid("ext.tasks"),
} as const;

/** Records that live in a space. */
export const COLLECTION = {
  workspaceProfile: nsid("workspace.profile"),
  directory: nsid("directory"),
  workspaceRoster: nsid("workspace.roster"),
  admin: nsid("admin"),
  acceptance: nsid("acceptance"),
  appInstall: nsid("app.install"),
  appCommand: nsid("app.command"),
  appAction: nsid("app.action"),
  extInstall: nsid("ext.install"),
  taskProject: nsid("ext.tasks.project"),
  taskProjectEdit: nsid("ext.tasks.projectEdit"),
  task: nsid("ext.tasks.task"),
  taskEdit: nsid("ext.tasks.taskEdit"),
  taskComment: nsid("ext.tasks.comment"),
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

/** Block `$type` values on `new.flock.channel.message`. */
export const BLOCK_TYPE = {
  section: `${COLLECTION.message}#section`,
  context: `${COLLECTION.message}#context`,
  divider: `${COLLECTION.message}#divider`,
  actions: `${COLLECTION.message}#actions`,
  button: `${COLLECTION.message}#button`,
} as const;

/** Records that live in an account's own public repo. */
export const REPO_COLLECTION = {
  dmDeclaration: nsid("dm.declaration"),
  appDeclaration: nsid("app.declaration"),
} as const;

export const OPERATOR_METHOD = {
  execute: nsid("operator.execute"),
  getOperation: nsid("operator.getOperation"),
  listInboxWriters: nsid("operator.listInboxWriters"),
  getChanges: nsid("operator.getChanges"),
  createWorkspace: nsid("operator.createWorkspace"),
  startAuthorityFlow: nsid("operator.startAuthorityFlow"),
  listStalledOperations: nsid("operator.listStalledOperations"),
} as const;

/** The protocol's notices a space authority sends to a service it registered: the operator receives these. */
export const NOTICE_METHOD = {
  notifyWrite: "com.atproto.space.notifyWrite",
  notifySpaceDeleted: "com.atproto.space.notifySpaceDeleted",
} as const;

export type SpaceType = (typeof SPACE_TYPE)[keyof typeof SPACE_TYPE];
export type Collection = (typeof COLLECTION)[keyof typeof COLLECTION];
export type BlockType = (typeof BLOCK_TYPE)[keyof typeof BLOCK_TYPE];
export type OperatorMethod = (typeof OPERATOR_METHOD)[keyof typeof OPERATOR_METHOD];
