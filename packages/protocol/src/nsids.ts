// Every NSID this app defines or governs, built from canonical namespace constants. No other non-test source module spells
// `new.flock.*` literally: they import these constants (enforced by `registry.test.ts`).

export const NAMESPACE = "new.flock";
export const ATGRP_NAMESPACE = "org.atgrp";

type Nsid<Name extends string> = `${typeof NAMESPACE}.${Name}`;
type AtgrpNsid<Name extends string> = `${typeof ATGRP_NAMESPACE}.${Name}`;

function nsid<Name extends string>(name: Name): Nsid<Name> {
  return `${NAMESPACE}.${name}`;
}

function atgrpNsid<Name extends string>(name: Name): AtgrpNsid<Name> {
  return `${ATGRP_NAMESPACE}.${name}`;
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

export const ATGRP_SPACE_TYPE = {
  meta: atgrpNsid("meta"),
  members: atgrpNsid("members"),
  inbox: atgrpNsid("inbox"),
} as const;

export const ALL_SPACE_TYPE = {
  ...SPACE_TYPE,
  groupMeta: ATGRP_SPACE_TYPE.meta,
  groupMembers: ATGRP_SPACE_TYPE.members,
  groupInbox: ATGRP_SPACE_TYPE.inbox,
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

/** Atmosphere Groups (`org.atgrp.*`) records that live in spaces. */
export const ATGRP_COLLECTION = {
  about: atgrpNsid("about"),
  config: atgrpNsid("config"),
  rule: atgrpNsid("rule"),
  labeler: atgrpNsid("labeler"),
  space: atgrpNsid("space"),
  role: atgrpNsid("role"),
  membership: atgrpNsid("membership"),
  confirmation: atgrpNsid("confirmation"),
  invite: atgrpNsid("invite"),
} as const;

/** Standard ATProto records published inside spaces. */
export const ATPROTO_SPACE_COLLECTION = {
  spacePolicy: "com.atproto.space.policy",
  label: "com.atproto.label.record",
} as const;

export const ATGRP_POLICY = atgrpNsid("policy");

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
  groupDeclaration: atgrpNsid("declaration"),
} as const;

/** Open-object extension field keys stamped on `org.atgrp.membership` and `org.atgrp.confirmation`. */
export const FLOCK_EXTENSION_FIELD = {
  incarnation: nsid("incarnation"),
  generation: nsid("generation"),
  admittedSpaceRev: nsid("admittedSpaceRev"),
  afterWriterRev: nsid("afterWriterRev"),
} as const;

export const FLOCK_PERMISSION_SET = {
  member: nsid("permissions.member"),
} as const;

export const ATGRP_PERMISSION_SET = {
  authParticipate: atgrpNsid("authParticipate"),
  authManageBasic: atgrpNsid("authManageBasic"),
  authManageMembers: atgrpNsid("authManageMembers"),
  authModerate: atgrpNsid("authModerate"),
  authManageAdmin: atgrpNsid("authManageAdmin"),
} as const;

export const ATGRP_METHOD = {
  requestJoin: atgrpNsid("requestJoin"),
  cancelJoinRequest: atgrpNsid("cancelJoinRequest"),
  leaveGroup: atgrpNsid("leaveGroup"),
  listJoinRequests: atgrpNsid("listJoinRequests"),
  denyJoinRequest: atgrpNsid("denyJoinRequest"),
  modSubmitReport: atgrpNsid("mod.submitReport"),
  modSubmitAppeal: atgrpNsid("mod.submitAppeal"),
  modQuerySubjects: atgrpNsid("mod.querySubjects"),
  modQuerySubjectHistory: atgrpNsid("mod.querySubjectHistory"),
  modQuerySelfHistory: atgrpNsid("mod.querySelfHistory"),
  modUpdateSubject: atgrpNsid("mod.updateSubject"),
} as const;

/** Known report reason tokens from `org.atgrp.mod.defs#reasonType`. */
export const ATGRP_MOD_REASON = {
  spam: `${ATGRP_NAMESPACE}.mod.defs#reasonSpam`,
  violation: `${ATGRP_NAMESPACE}.mod.defs#reasonViolation`,
  misleading: `${ATGRP_NAMESPACE}.mod.defs#reasonMisleading`,
  nsfw: `${ATGRP_NAMESPACE}.mod.defs#reasonNsfw`,
  rude: `${ATGRP_NAMESPACE}.mod.defs#reasonRude`,
  other: `${ATGRP_NAMESPACE}.mod.defs#reasonOther`,
} as const;

/** Moderation history event `$type` values from `org.atgrp.mod.defs`. */
export const ATGRP_MOD_EVENT_TYPE = {
  report: `${ATGRP_NAMESPACE}.mod.defs#reportEvent`,
  appeal: `${ATGRP_NAMESPACE}.mod.defs#appealEvent`,
  status: `${ATGRP_NAMESPACE}.mod.defs#statusEvent`,
  tag: `${ATGRP_NAMESPACE}.mod.defs#tagEvent`,
  label: `${ATGRP_NAMESPACE}.mod.defs#labelEvent`,
  eject: `${ATGRP_NAMESPACE}.mod.defs#ejectEvent`,
} as const;

/** Flock-owned group host coordination methods (outside `org.atgrp.*`). */
export const FLOCK_GROUP_METHOD = {
  abortMigration: nsid("group.abortMigration"),
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
export type AtgrpSpaceType = (typeof ATGRP_SPACE_TYPE)[keyof typeof ATGRP_SPACE_TYPE];
export type AnySpaceType = SpaceType | AtgrpSpaceType;
export type Collection = (typeof COLLECTION)[keyof typeof COLLECTION];
export type AtgrpCollection = (typeof ATGRP_COLLECTION)[keyof typeof ATGRP_COLLECTION];
export type AtprotoSpaceCollection = (typeof ATPROTO_SPACE_COLLECTION)[keyof typeof ATPROTO_SPACE_COLLECTION];
export type BlockType = (typeof BLOCK_TYPE)[keyof typeof BLOCK_TYPE];
export type OperatorMethod = (typeof OPERATOR_METHOD)[keyof typeof OPERATOR_METHOD];
export type AtgrpMethod = (typeof ATGRP_METHOD)[keyof typeof ATGRP_METHOD];
export type FlockGroupMethod = (typeof FLOCK_GROUP_METHOD)[keyof typeof FLOCK_GROUP_METHOD];
export type NoticeMethod = (typeof NOTICE_METHOD)[keyof typeof NOTICE_METHOD];
