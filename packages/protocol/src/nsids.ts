// Every NSID this app defines or governs, built from canonical namespace constants. No other non-test source module spells
// `new.flock.*` literally: they import these constants (enforced by `registry.test.ts`).

export const NAMESPACE = "new.flock";
export const OPENSOCIAL_NAMESPACE = "group.opensocial";

type Nsid<Name extends string> = `${typeof NAMESPACE}.${Name}`;
type OpenSocialNsid<Name extends string> = `${typeof OPENSOCIAL_NAMESPACE}.${Name}`;

function nsid<Name extends string>(name: Name): Nsid<Name> {
  return `${NAMESPACE}.${name}`;
}

function openSocialNsid<Name extends string>(name: Name): OpenSocialNsid<Name> {
  return `${OPENSOCIAL_NAMESPACE}.${name}`;
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

export const OPENSOCIAL_SPACE_TYPE = {
  meta: openSocialNsid("meta"),
  members: openSocialNsid("members"),
  invites: openSocialNsid("invites"),
} as const;

export const ALL_SPACE_TYPE = {
  ...SPACE_TYPE,
  ...OPENSOCIAL_SPACE_TYPE,
} as const;

/** Flock modality and DM records that live in a space. */
export const COLLECTION = {
  directory: nsid("directory"),
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
  dmRequest: nsid("dm.request"),
  dmHeader: nsid("dm.header"),
  dmMessage: nsid("dm.message"),
  dmReaction: nsid("dm.reaction"),
} as const;

/** OpenSocial atmospheric group records that live in spaces. */
export const OPENSOCIAL_COLLECTION = {
  profile: openSocialNsid("profile"),
  rule: openSocialNsid("rule"),
  labeler: openSocialNsid("labeler"),
  space: openSocialNsid("space"),
  role: openSocialNsid("role"),
  membership: openSocialNsid("membership"),
  acceptance: openSocialNsid("acceptance"),
  invite: openSocialNsid("invite"),
} as const;

/** Standard ATProto records published inside spaces. */
export const ATPROTO_SPACE_COLLECTION = {
  spacePolicy: "com.atproto.space.policy",
  label: "com.atproto.label.record",
} as const;

export const OPENSOCIAL_POLICY = openSocialNsid("policy");

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
  groupDeclaration: openSocialNsid("declaration"),
} as const;

/** Open-object extension field keys stamped on `group.opensocial.membership` and `group.opensocial.acceptance`. */
export const FLOCK_EXTENSION_FIELD = {
  incarnation: nsid("incarnation"),
  generation: nsid("generation"),
  admittedSpaceRev: nsid("admittedSpaceRev"),
  afterWriterRev: nsid("afterWriterRev"),
} as const;

export const FLOCK_PERMISSION_SET = {
  member: nsid("permissions.member"),
} as const;

export const OPENSOCIAL_PERMISSION_SET = {
  authParticipate: openSocialNsid("authParticipate"),
  authManageProfile: openSocialNsid("authManageProfile"),
  authModerate: openSocialNsid("authModerate"),
  authManageGroup: openSocialNsid("authManageGroup"),
} as const;

export const OPENSOCIAL_METHOD = {
  requestJoin: openSocialNsid("requestJoin"),
  cancelJoinRequest: openSocialNsid("cancelJoinRequest"),
  leaveGroup: openSocialNsid("leaveGroup"),
  createReport: openSocialNsid("createReport"),
  listJoinRequests: openSocialNsid("listJoinRequests"),
  denyJoinRequest: openSocialNsid("denyJoinRequest"),
  listModSubjects: openSocialNsid("listModSubjects"),
  getModSubjectHistory: openSocialNsid("getModSubjectHistory"),
  resolveModSubject: openSocialNsid("resolveModSubject"),
} as const;

export const OPERATOR_METHOD = {
  execute: nsid("operator.execute"),
  getOperation: nsid("operator.getOperation"),
  getChanges: nsid("operator.getChanges"),
  createWorkspace: nsid("operator.createWorkspace"),
  startAuthorityFlow: nsid("operator.startAuthorityFlow"),
  listStalledOperations: nsid("operator.listStalledOperations"),
  getDmNotifyTarget: nsid("operator.getDmNotifyTarget"),
  getSpaceNotifyTarget: nsid("operator.getSpaceNotifyTarget"),
} as const;

/** The protocol's notices a space authority sends to a service it registered: the operator receives these. */
export const NOTICE_METHOD = {
  confirmRegistration: "com.atproto.space.confirmRegistration",
  notifySpaceUpdate: "com.atproto.space.notifySpaceUpdate",
} as const;

export type SpaceType = (typeof SPACE_TYPE)[keyof typeof SPACE_TYPE];
export type OpenSocialSpaceType = (typeof OPENSOCIAL_SPACE_TYPE)[keyof typeof OPENSOCIAL_SPACE_TYPE];
export type AnySpaceType = (typeof ALL_SPACE_TYPE)[keyof typeof ALL_SPACE_TYPE];
export type Collection = (typeof COLLECTION)[keyof typeof COLLECTION];
export type OpenSocialCollection = (typeof OPENSOCIAL_COLLECTION)[keyof typeof OPENSOCIAL_COLLECTION];
export type AtprotoSpaceCollection = (typeof ATPROTO_SPACE_COLLECTION)[keyof typeof ATPROTO_SPACE_COLLECTION];
export type BlockType = (typeof BLOCK_TYPE)[keyof typeof BLOCK_TYPE];
export type OperatorMethod = (typeof OPERATOR_METHOD)[keyof typeof OPERATOR_METHOD];
export type OpenSocialMethod = (typeof OPENSOCIAL_METHOD)[keyof typeof OPENSOCIAL_METHOD];
export type NoticeMethod = (typeof NOTICE_METHOD)[keyof typeof NOTICE_METHOD];
