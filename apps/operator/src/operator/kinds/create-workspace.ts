import type { OAuthSession } from "@atproto/oauth-client-node";
import {
  channelUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  isDid,
  isTid,
  SELF_SKEY,
  workspaceUri,
} from "@flock/protocol/keys";
import { spaceExists } from "../../atproto/space-ops";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import {
  consumeCreationAuthorization,
  CreationNotAuthorizedError,
  hasCreationAuthorization,
  restoreCreationAuthorization,
} from "../creation-authorization";
import {
  OperationRejectedError,
  operationRowExists,
  othersHaveUnfinishedOperation,
  runJournaledOperation,
  type JournalAdmission,
  type OperationContext,
  type OperationView,
} from "../journal";
import { assertAdminMutationsEnabled } from "../mutations-paused";
import { afterOperation, type RegistrationDeps } from "../registrations";
import { defaultRoleKeys, putMembershipRoles, readGroupGovernanceState } from "../workspace-state";
import {
  assertWorkspaceName,
  createGeneralChannelSpace,
  createInboxSpace,
  createWorkspaceSpace,
  ensureGroupProfileName,
  generalKey,
  writeGeneralDirectory,
} from "../workspace-spaces";
import type { OperationKind, OperatorRequest } from "./kind";

export class WorkspaceExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceExistsError";
  }
}

export type WorkspaceCreation = {
  operationId: string;
  groupDid: string;
  workspace: string;
  channel: string;
  state: string;
  completedSteps: string[];
  takenOverBy?: string;
  error?: string;
  authorizationRequired?: true;
};

export const createWorkspaceKind: OperationKind = {
  kind: "createWorkspace",
  required: ["name", "creator"],
  optional: ["joinPolicy", "publicMeta"],
  actor: "creator",
  submittedThrough: "createWorkspace",
  steps: [
    "workspace-space",
    "inbox-space",
    "general-channel-space",
    "workspace-profile",
    "creator-workspace",
    "creator-inbox",
    "creator-general",
    "creator-roster",
    "creator-admin",
    "general-directory",
  ],
  validate: (request) => assertWorkspaceName(String(request.name)),
  run: (actor, context, request) => runCreation(actor, context, request),
  createsSpaces: (actor) => [
    groupMetaUri(actor.workspace.authorityDid),
    groupMembersUri(actor.workspace.authorityDid),
    actor.workspace.uri,
    inboxUri(actor.workspace.authorityDid, actor.workspace.skey),
    channelUri(actor.workspace.authorityDid, generalKey(actor.workspace.skey)),
  ],
};

export async function createWorkspace(
  grant: OAuthSession,
  input: {
    creator: string;
    name: string;
    operationId: string;
    joinPolicy?: "open" | "approval" | "invite";
    publicMeta?: boolean;
  },
  registration?: RegistrationDeps,
): Promise<WorkspaceCreation> {
  assertAdminMutationsEnabled();
  assertWorkspaceName(input.name);
  if (!isTid(input.operationId)) throw new Error("Operation ID must be a protocol TID.");
  if (!isDid(input.creator)) throw new Error("The creator must be a DID.");
  if (input.creator === grant.did) {
    throw new OperationRejectedError("Creator must be a personal account DID distinct from the group DID.");
  }
  const name = input.name.trim();
  const workspace = parseWorkspaceRef(workspaceUri(grant.did, SELF_SKEY));
  const actor: OperatorActor = { did: input.creator, session: grant, canRecoverOperations: true, workspace };
  const request: OperatorRequest = {
    kind: createWorkspaceKind.kind,
    name,
    creator: input.creator,
    ...(input.joinPolicy !== undefined ? { joinPolicy: input.joinPolicy } : {}),
    ...(input.publicMeta !== undefined ? { publicMeta: input.publicMeta } : {}),
  };
  const view = await runJournaledOperation(
    actor,
    input.operationId,
    request,
    createWorkspaceKind.steps,
    (context) => runCreation(actor, context, request),
    { admission: creationAdmission(actor, name, input.operationId) },
  );
  if (registration) await afterOperation(actor, createWorkspaceKind, request, view, registration);
  return creationResult(actor, input.operationId, view);
}

export function assertCreationAdmissible(input: {
  authorityDid: string;
  creator: string;
  name: string;
  operationId: string;
}): void {
  if (input.creator === input.authorityDid) {
    throw new OperationRejectedError("Creator must be a personal account DID distinct from the group DID.");
  }
  if (operationRowExists(input.authorityDid, input.creator, input.operationId)) return;
  const authorization = {
    authorityDid: input.authorityDid,
    initiatorDid: input.creator,
    name: input.name.trim(),
  };
  if (!hasCreationAuthorization(authorization, input.operationId, Math.floor(Date.now() / 1000))) {
    throw new CreationNotAuthorizedError();
  }
}

export function creationAdmission(actor: OperatorActor, name: string, operationId: string): JournalAdmission {
  const { authorityDid, uri } = actor.workspace;
  const verify = async () => {
    if (await spaceExists(actor.session, uri)) {
      throw new WorkspaceExistsError(
        "A Flock workspace already exists inside this OpenSocial group; ask its admins to invite you.",
      );
    }
  };
  const claim = () => {
    if (othersHaveUnfinishedOperation(authorityDid, uri, actor.did)) {
      throw new WorkspaceExistsError(
        "This workspace is already being set up under this group; ask whoever is creating it to add you.",
      );
    }
  };
  if (actor.did === authorityDid) return { verify, admit: claim };
  const authorization = { authorityDid, initiatorDid: actor.did, name };
  return {
    verify,
    admit: (now) => {
      claim();
      consumeCreationAuthorization(authorization, operationId, now);
    },
    restore: (now) => restoreCreationAuthorization(authorization, operationId, now),
  };
}

async function runCreation(
  actor: OperatorActor,
  context: OperationContext,
  request: OperatorRequest,
): Promise<void> {
  const { session } = actor;
  const { uri: workspace, skey, authorityDid } = actor.workspace;
  const name = String(request.name);
  const creator = String(request.creator);
  const joinPolicy =
    request.joinPolicy === "open" || request.joinPolicy === "approval" || request.joinPolicy === "invite"
      ? request.joinPolicy
      : undefined;
  const publicMeta = typeof request.publicMeta === "boolean" ? request.publicMeta : undefined;
  if (creator === authorityDid) {
    throw new OperationRejectedError("Group DID cannot be a human creator.");
  }
  await context.step("workspace-space", () => createWorkspaceSpace(session, skey));
  await context.step("inbox-space", () => createInboxSpace(session, skey));
  await context.step("general-channel-space", () => createGeneralChannelSpace(session, skey));
  await context.step("workspace-profile", () =>
    ensureGroupProfileName(
      session,
      name,
      joinPolicy !== undefined || publicMeta !== undefined
        ? {
            ...(joinPolicy !== undefined ? { joinPolicy } : {}),
            ...(publicMeta !== undefined ? { publicMeta } : {}),
          }
        : undefined,
    ),
  );
  // Preserve legacy step names as no-op markers only when replaying pre-R13 rows; new runs record `creator-admin` + `general-directory`.
  if (context.completedSteps.includes("creator-workspace")) {
    await context.step("creator-workspace", async () => {});
  }
  if (context.completedSteps.includes("creator-inbox")) {
    await context.step("creator-inbox", async () => {});
  }
  if (context.completedSteps.includes("creator-general")) {
    await context.step("creator-general", async () => {});
  }
  if (context.completedSteps.includes("creator-roster")) {
    await context.step("creator-roster", async () => {});
  }
  await context.step("creator-admin", async () => {
    const state = await readGroupGovernanceState(session, authorityDid);
    const existing = state.memberships.get(creator);
    if (existing && existing.roles.includes("admin")) return;
    const defaults = defaultRoleKeys(state);
    const roles = [...new Set(["admin", ...(existing?.roles ?? defaults)])];
    await putMembershipRoles(session, authorityDid, creator, roles);
  });
  await context.step("general-directory", () => writeGeneralDirectory(session, workspace, skey));
}

export function creationResult(actor: OperatorActor, operationId: string, view: OperationView): WorkspaceCreation {
  return {
    operationId,
    groupDid: actor.workspace.authorityDid,
    workspace: actor.workspace.uri,
    channel: channelUri(actor.workspace.authorityDid, generalKey(actor.workspace.skey)),
    state: view.state,
    completedSteps: view.completedSteps,
    ...(view.takenOverBy ? { takenOverBy: view.takenOverBy } : {}),
    ...(view.error ? { error: view.error } : {}),
    ...(view.authorizationRequired ? { authorizationRequired: true as const } : {}),
  };
}
