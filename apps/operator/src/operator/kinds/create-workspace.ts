import type { OAuthSession } from "@atproto/oauth-client-node";
import { channelUri, inboxUri, isDid, isTid, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { spaceExists } from "../../atproto/space-ops";
import { consumeCreationAuthorization, CreationNotAuthorizedError, hasCreationAuthorization, restoreCreationAuthorization } from "../creation-authorization";
import {
  OperationRejectedError, operationRowExists, othersHaveUnfinishedOperation, runJournaledOperation, type JournalAdmission, type OperationContext,
  type OperationView,
} from "../journal";
import { putListMember } from "../members";
import { assertAdminMutationsEnabled } from "../mutations-paused";
import { afterOperation, type RegistrationDeps } from "../registrations";
import { writeRoster } from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";
import {
  assertWorkspaceName, createGeneralChannelSpace, createInboxSpace, createWorkspaceSpace, generalKey, workspaceKey,
  writeGeneralDirectory, writeWorkspaceProfile,
} from "../workspace-spaces";

/** The workspace exists under its account, or someone else's creation of it is unfinished: it is joined, not created again. */
export class WorkspaceExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceExistsError";
  }
}

export type WorkspaceCreation = {
  operationId: string; workspace: string; channel: string; state: string; completedSteps: string[]; error?: string;
  /** Creation is waiting on the authority to approve its grant, not on a retry. */
  authorizationRequired?: true;
};

/**
 * Creates a workspace under its authority account for its creator (R8): the three spaces and the profile; the creator in the
 * workspace, inbox and #general member lists (the authority account owns them, so a creator that is the authority is not
 * added); the creator's roster and admin records; #general's directory entry. The journal row's actor is the creator and
 * its workspace the authority. Until `creator-admin` is done only its creator (or the operator's own recovery) resumes it.
 */
export const createWorkspaceKind: OperationKind = {
  kind: "createWorkspace",
  required: ["name", "creator"],
  actor: "creator",
  submittedThrough: "createWorkspace",
  steps: [
    "workspace-space", "inbox-space", "general-channel-space", "workspace-profile",
    "creator-workspace", "creator-inbox", "creator-general", "creator-roster", "creator-admin", "general-directory",
  ],
  validate: (request) => assertWorkspaceName(String(request.name)),
  run: (actor, context, request) => runCreation(actor, context, request),
  createsSpaces: (actor) => [actor.workspace.uri, inboxUri(actor.workspace.authorityDid, actor.workspace.skey), channelUri(actor.workspace.authorityDid, generalKey(actor.workspace.skey))],
};

/**
 * Creates (or resumes creating) the workspace named `name` under the authority whose grant this is, for `creator`. A creator
 * other than the authority account needs a creation authorization (`creation-authorization.ts`), consumed as the journal row
 * is inserted; a retry of the same operation finds its row and needs none.
 */
export async function createWorkspace(
  grant: OAuthSession,
  input: { creator: string; name: string; operationId: string },
  registration?: RegistrationDeps,
): Promise<WorkspaceCreation> {
  assertAdminMutationsEnabled();
  assertWorkspaceName(input.name);
  if (!isTid(input.operationId)) throw new Error("Operation ID must be a protocol TID.");
  if (!isDid(input.creator)) throw new Error("The creator must be a DID.");
  const name = input.name.trim();
  const workspace = parseWorkspaceRef(workspaceUri(grant.did, workspaceKey(name)));
  const actor: OperatorActor = { did: input.creator, session: grant, workspace, canRecoverOperations: true };
  const request = { kind: createWorkspaceKind.kind, name, creator: input.creator };
  const view = await runJournaledOperation(actor, input.operationId, request, createWorkspaceKind.steps,
    (context) => createWorkspaceKind.run(actor, context, request), { admission: creationAdmission(actor, name, input.operationId) });
  if (registration) await afterOperation(actor, createWorkspaceKind, request, view, registration);
  return creationResult(actor, input.operationId, view);
}

/**
 * Refuses, before the authority's grant is restored or its workspaces' lock is taken, a creation that neither has an
 * authorization nor is a retry of a creation that had one. The authorization is still consumed atomically as the row is
 * inserted; this only keeps someone with no approval from reaching the account's grant and lock.
 */
export function assertCreationAdmissible(input: { authorityDid: string; creator: string; name: string; operationId: string }): void {
  if (input.creator === input.authorityDid) return;
  if (operationRowExists(input.authorityDid, input.creator, input.operationId)) return;
  const authorization = { authorityDid: input.authorityDid, initiatorDid: input.creator, name: input.name.trim() };
  if (!hasCreationAuthorization(authorization, input.operationId, Math.floor(Date.now() / 1000))) throw new CreationNotAuthorizedError();
}

/**
 * A creation's admission to the journal: a creation makes a new workspace, never joins anyone to one that exists (another
 * creator's, or the account's own). So the workspace's space must not exist, checked once, before anything is written, under
 * the lock every creation under this account takes, so a retry never mistakes the space its own first step made. And its row
 * claims the workspace: while someone else's operation on it is unfinished, no other creation of it is admitted, so a creation
 * that stopped before its first write is never resumed into a workspace another creation made meanwhile. A creator other than
 * the account also consumes their creation authorization as the row is inserted, and has it restored if the row is discarded.
 */
export function creationAdmission(actor: OperatorActor, name: string, operationId: string): JournalAdmission {
  const { authorityDid, uri } = actor.workspace;
  const verify = async () => {
    if (await spaceExists(actor.session, uri)) {
      throw new WorkspaceExistsError("A workspace with this name already exists under this account; ask its admins to add you.");
    }
  };
  const claim = () => {
    if (othersHaveUnfinishedOperation(authorityDid, uri, actor.did)) {
      throw new WorkspaceExistsError("This workspace is already being set up under this account; ask whoever is creating it to add you.");
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

async function runCreation(actor: OperatorActor, context: OperationContext, request: OperatorRequest): Promise<void> {
  const { session } = actor;
  const { uri: workspace, skey, authorityDid } = actor.workspace;
  const name = String(request.name);
  const creator = String(request.creator);
  if (creator !== actor.did) throw new OperationRejectedError("A workspace creation runs as its creator.");
  if (workspaceKey(name) !== skey) throw new OperationRejectedError("A workspace's key must be the one derived from its name.");
  await context.step("workspace-space", () => createWorkspaceSpace(session, skey));
  await context.step("inbox-space", () => createInboxSpace(session, skey));
  await context.step("general-channel-space", () => createGeneralChannelSpace(session, skey));
  await context.step("workspace-profile", () => writeWorkspaceProfile(session, workspace, name));
  if (creator !== authorityDid) {
    await context.step("creator-workspace", () => putListMember(session, workspace, creator, true, true));
    // As an admin: the inbox's join requests are read by admins, and every member may write one.
    await context.step("creator-inbox", () => putListMember(session, inboxUri(authorityDid, skey), creator, true, true));
    await context.step("creator-general", () => putListMember(session, channelUri(authorityDid, generalKey(skey)), creator, true, true));
  }
  await context.step("creator-roster", () => writeRoster(actor, workspace, creator, true));
  await context.step("creator-admin", () => writeRoster(actor, workspace, creator, true, COLLECTION.admin));
  await context.step("general-directory", () => writeGeneralDirectory(session, workspace, skey));
}

export function creationResult(actor: OperatorActor, operationId: string, view: OperationView): WorkspaceCreation {
  return {
    operationId,
    workspace: actor.workspace.uri,
    channel: channelUri(actor.workspace.authorityDid, generalKey(actor.workspace.skey)),
    state: view.state,
    completedSteps: view.completedSteps,
    ...(view.error ? { error: view.error } : {}),
    ...(view.authorizationRequired ? { authorizationRequired: true as const } : {}),
  };
}
