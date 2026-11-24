import { getConfig } from "@flock/deployment/config";
import { isDid, isTid } from "@flock/protocol/keys";
import { NOTICE_METHOD, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { parseConfirmRegistration, parseSpaceUpdateNotification } from "../atproto/write-notification";
import { AuthorityReauthorizationRequiredError, authorityFlowUrl, restoreAuthorityGrant } from "./authority-grant";
import { CreationNotAuthorizedError, findCreationAuthorizationAuthority } from "./creation-authorization";
import { DmRateLimitError, DmWakeIpcError, recordDmWake } from "./dm-feed-wakes";
import { AUTHORITY_APPROVAL_REQUIRED, OperatorAuthError, operatorHttpFailure, WebhookAuthError } from "./errors";
import { FeedRequestError, getChanges, parseFollow } from "./feed";
import {
  findActorOperationWorkspaceDid,
  getActorOperation,
  OperationBusyError,
  OperationConflictError,
} from "./journal";
import { assertCreationAdmissible, createWorkspace, WorkspaceExistsError } from "./kinds/create-workspace";
import { AdminMutationsPausedError, assertAdminMutationsEnabled } from "./mutations-paused";
import { advanceSpaceRev, recordSpaceWake, recordWriteNotification } from "./notices";
import { executeOperatorOperation } from "./operations";
import {
  handleRegistrationExpiredNotice,
  handleSpaceDeletedNotice,
  refreshWorkspaceRegistrations,
  registrationDeps,
} from "./registrations";
import {
  authenticateOperatorRequest,
  requireActiveWorkspaceAdmin,
  requireWorkspaceActorForOperation,
  requireWorkspaceOrLifecycleAdmin,
  verifyDmNotifyCredentialAndProof,
  verifySpaceNotifyCredentialAndProof,
  type DmCredentialProof,
} from "./security";
import {
  authenticateSpaceWebhook,
  deriveDmNotifyToken,
  deriveSpaceNotifyToken,
  operatorNotifyEndpoint,
} from "./space-notification";
import { listStalledWork } from "./stalled";
import { assertOperatorWorkspaceWithinEnvelope } from "./workspace-envelope";
import { assertWorkspaceName } from "./workspace-spaces";

export type MethodCall = {
  authorization: string | undefined;
  params: Readonly<Record<string, unknown>>;
  body: unknown;
  signal: AbortSignal;
};

export class MethodError extends Error {
  constructor(readonly status: number, readonly error: string, message: string) {
    super(message);
    this.name = "MethodError";
  }
}

export type OperatorMethodDefinition = {
  type: "query" | "procedure";
  jsonLimit?: number;
  unexpected: "InvalidRequest" | "InternalServerError";
  serve(call: MethodCall): Promise<object | undefined>;
};

function stringParam(call: MethodCall, name: string): string {
  const value = call.params[name];
  return typeof value === "string" ? value : "";
}

function objectBody(call: MethodCall, allowed: readonly string[], refusal: string): Record<string, unknown> {
  const body = call.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new MethodError(400, "InvalidRequest", refusal);
  }
  return body as Record<string, unknown>;
}

function parseCredentialProof(raw: unknown, methodNsid: string): DmCredentialProof {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MethodError(400, "InvalidRequest", "Credential possession proof is required.");
  }
  const proof = raw as Record<string, unknown>;
  const allowedKeys = new Set(["$type", "authorization", "signatureInput", "signature"]);
  if (Object.keys(proof).some((key) => !allowedKeys.has(key))) {
    throw new MethodError(400, "InvalidRequest", "Unexpected credential proof fields.");
  }
  if (proof.$type !== undefined && proof.$type !== `${methodNsid}#credentialProof`) {
    throw new MethodError(400, "InvalidRequest", "Invalid credential proof type.");
  }
  if (
    typeof proof.authorization !== "string"
    || proof.authorization.length === 0
    || typeof proof.signatureInput !== "string"
    || proof.signatureInput.length === 0
    || typeof proof.signature !== "string"
    || proof.signature.length === 0
  ) {
    throw new MethodError(400, "InvalidRequest", "Credential proof requires authorization, signatureInput, and signature.");
  }
  return {
    authorization: proof.authorization,
    signatureInput: proof.signatureInput,
    signature: proof.signature,
  };
}

async function asWorkspaceAdmin<T>(
  call: MethodCall,
  method: string,
  action: (actor: Awaited<ReturnType<typeof requireActiveWorkspaceAdmin>>) => Promise<T>,
): Promise<T> {
  const did = await authenticateOperatorRequest(call.authorization, method);
  const actor = await requireActiveWorkspaceAdmin(stringParam(call, "workspace"), did, {
    allowDegradedLookup: method === OPERATOR_METHOD.getOperation,
  });
  return action(actor);
}

const AUTHORIZATION_REQUIRED =
  "Workspace setup needs the group account's approval first: start the authority flow, then retry with the same operation id.";

function optionalAuthorityDid(body: Record<string, unknown>): string | null {
  if (body.authority === undefined) return null;
  if (typeof body.authority !== "string" || !isDid(body.authority)) {
    throw new MethodError(400, "InvalidRequest", "The group authority must be a DID.");
  }
  return body.authority;
}

function parseOptionalJoinPolicy(raw: unknown): "open" | "approval" | "invite" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "open" || raw === "approval" || raw === "invite") return raw;
  throw new MethodError(400, "InvalidRequest", "joinPolicy must be 'open', 'approval', or 'invite'.");
}

function parseOptionalPublicMeta(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  throw new MethodError(400, "InvalidRequest", "publicMeta must be a boolean.");
}

export const OPERATOR_METHODS: Readonly<Record<string, OperatorMethodDefinition>> = {
  [OPERATOR_METHOD.execute]: {
    type: "procedure",
    jsonLimit: 256 * 1024,
    unexpected: "InvalidRequest",
    async serve(call) {
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.execute);
      assertAdminMutationsEnabled();
      const body = objectBody(call, ["workspace", "operationId", "request"], "Unexpected operator request fields.");
      if (typeof body.workspace !== "string" || typeof body.operationId !== "string" || !isTid(body.operationId)) {
        throw new MethodError(400, "InvalidRequest", "Workspace URI and protocol TID operation ID are required.");
      }
      const actor = await requireWorkspaceActorForOperation(body.workspace, did, body.operationId, body.request);
      await assertOperatorWorkspaceWithinEnvelope(actor);
      const operation = await executeOperatorOperation(actor, body.operationId, body.request, registrationDeps);
      if (operation.authorizationRequired) {
        throw new MethodError(
          AUTHORITY_APPROVAL_REQUIRED.status,
          AUTHORITY_APPROVAL_REQUIRED.name,
          AUTHORITY_APPROVAL_REQUIRED.message,
        );
      }
      return { operation };
    },
  },
  [OPERATOR_METHOD.getOperation]: {
    type: "query",
    unexpected: "InvalidRequest",
    async serve(call) {
      const operationId = stringParam(call, "operationId");
      if (!isTid(operationId)) throw new MethodError(400, "InvalidRequest", "Operation ID must be a protocol TID.");
      return asWorkspaceAdmin(call, OPERATOR_METHOD.getOperation, async (actor) => {
        const operation = getActorOperation(actor, operationId);
        if (!operation) throw new MethodError(400, "InvalidRequest", "Operation not found.");
        return { operation };
      });
    },
  },
  [OPERATOR_METHOD.listStalledOperations]: {
    type: "query",
    unexpected: "InvalidRequest",
    async serve(call) {
      const refresh =
        call.params.refreshRegistrations === true || call.params.refreshRegistrations === "true";
      if (!refresh) {
        return asWorkspaceAdmin(call, OPERATOR_METHOD.listStalledOperations, async (actor) => {
          const { operations, registrations, truncated } = listStalledWork(
            actor.workspace.authorityDid,
            actor.workspace.uri,
          );
          return {
            operations: operations.map(({ error, ...operation }) =>
              error === null ? operation : { ...operation, error },
            ),
            registrations,
            truncated,
          };
        });
      }
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.listStalledOperations);
      assertAdminMutationsEnabled();
      const actor = await requireWorkspaceOrLifecycleAdmin(stringParam(call, "workspace"), did);
      await refreshWorkspaceRegistrations(actor.session, actor.workspace.uri, registrationDeps);
      const { operations, registrations, truncated } = listStalledWork(
        actor.workspace.authorityDid,
        actor.workspace.uri,
      );
      return {
        operations: operations.map(({ error, ...operation }) =>
          error === null ? operation : { ...operation, error },
        ),
        registrations,
        truncated,
      };
    },
  },
  [OPERATOR_METHOD.getChanges]: {
    type: "procedure",
    jsonLimit: 128 * 1024,
    unexpected: "InternalServerError",
    async serve(call) {
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.getChanges);
      return getChanges(did, parseFollow(call.body), call.signal);
    },
  },
  [OPERATOR_METHOD.getDmNotifyTarget]: {
    type: "procedure",
    jsonLimit: 32 * 1024,
    unexpected: "InvalidRequest",
    async serve(call) {
      const callerDid = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.getDmNotifyTarget);
      const body = objectBody(call, ["space", "credential", "proof"], "The request requires space, credential, and proof.");
      if (typeof body.space !== "string" || typeof body.credential !== "string") {
        throw new MethodError(400, "InvalidRequest", "A DM space URI and space credential are required.");
      }
      const proof = parseCredentialProof(body.proof, OPERATOR_METHOD.getDmNotifyTarget);
      await verifyDmNotifyCredentialAndProof({
        space: body.space,
        callerDid,
        credential: body.credential,
        proof,
      });
      return {
        endpoint: operatorNotifyEndpoint(getConfig().operatorUrl),
        token: deriveDmNotifyToken(body.space, callerDid),
      };
    },
  },
  [OPERATOR_METHOD.getSpaceNotifyTarget]: {
    type: "procedure",
    jsonLimit: 32 * 1024,
    unexpected: "InvalidRequest",
    async serve(call) {
      const callerDid = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.getSpaceNotifyTarget);
      const body = objectBody(call, ["space", "credential", "proof"], "The request requires space, credential, and proof.");
      if (typeof body.space !== "string" || typeof body.credential !== "string") {
        throw new MethodError(400, "InvalidRequest", "A personal invites space URI and space credential are required.");
      }
      const proof = parseCredentialProof(body.proof, OPERATOR_METHOD.getSpaceNotifyTarget);
      await verifySpaceNotifyCredentialAndProof({
        space: body.space,
        callerDid,
        credential: body.credential,
        proof,
      });
      return {
        endpoint: operatorNotifyEndpoint(getConfig().operatorUrl),
        token: deriveSpaceNotifyToken(body.space, callerDid),
      };
    },
  },
  [OPERATOR_METHOD.createWorkspace]: {
    type: "procedure",
    unexpected: "InvalidRequest",
    async serve(call) {
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.createWorkspace);
      assertAdminMutationsEnabled();
      const body = objectBody(
        call,
        ["name", "operationId", "authority", "joinPolicy", "publicMeta"],
        "Unexpected createWorkspace fields.",
      );
      if (typeof body.name !== "string" || typeof body.operationId !== "string" || !isTid(body.operationId)) {
        throw new MethodError(400, "InvalidRequest", "A workspace name and TID operation ID are required.");
      }
      assertWorkspaceName(body.name);
      const joinPolicy = parseOptionalJoinPolicy(body.joinPolicy);
      const publicMeta = parseOptionalPublicMeta(body.publicMeta);

      const nowSec = Math.floor(Date.now() / 1000);
      const resolvedAuthority =
        optionalAuthorityDid(body) ??
        findActorOperationWorkspaceDid(did, body.operationId) ??
        findCreationAuthorizationAuthority(did, body.name.trim(), body.operationId, nowSec);
      if (!resolvedAuthority) {
        throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
      }

      try {
        assertCreationAdmissible({
          authorityDid: resolvedAuthority,
          creator: did,
          name: body.name,
          operationId: body.operationId,
        });
      } catch (error) {
        if (error instanceof CreationNotAuthorizedError) {
          throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
        }
        throw error;
      }

      let grant;
      try {
        grant = await restoreAuthorityGrant(resolvedAuthority);
      } catch (error) {
        if (error instanceof AuthorityReauthorizationRequiredError) {
          throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
        }
        throw error;
      }

      let result;
      try {
        result = await createWorkspace(
          grant,
          {
            creator: did,
            name: body.name,
            operationId: body.operationId,
            ...(joinPolicy ? { joinPolicy } : {}),
            ...(publicMeta !== undefined ? { publicMeta } : {}),
          },
          registrationDeps,
        );
      } catch (error) {
        if (error instanceof OperationConflictError) throw new MethodError(409, "OperationIdConflict", error.message);
        if (error instanceof CreationNotAuthorizedError) {
          throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
        }
        if (error instanceof WorkspaceExistsError) throw new MethodError(409, "WorkspaceExists", error.message);
        throw error;
      }
      if (result.authorizationRequired) throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
      const { operationId, workspace, channel, state, completedSteps, takenOverBy, error } = result;
      return {
        operationId,
        groupDid: resolvedAuthority,
        workspace,
        channel,
        state,
        completedSteps,
        ...(takenOverBy ? { takenOverBy } : {}),
        ...(error ? { error } : {}),
      };
    },
  },
  [OPERATOR_METHOD.startAuthorityFlow]: {
    type: "procedure",
    jsonLimit: 4 * 1024,
    unexpected: "InvalidRequest",
    async serve(call) {
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.startAuthorityFlow);
      const body = objectBody(
        call,
        ["purpose", "name", "authority", "joinPolicy", "publicMeta", "creationKey"],
        "Unexpected startAuthorityFlow fields.",
      );
      const authority = optionalAuthorityDid(body);
      if (body.purpose === "reauthorize") {
        if (body.name !== undefined || !authority) {
          throw new MethodError(
            400,
            "InvalidRequest",
            "reauthorize requires the existing group authority DID and omits name.",
          );
        }
        return { url: authorityFlowUrl(did, authority, { kind: "reauthorize" }).toString() };
      }
      if (body.purpose !== "createWorkspace" || typeof body.name !== "string") {
        throw new MethodError(
          400,
          "InvalidRequest",
          "The purpose is createWorkspace with a workspace name, or reauthorize with an authority DID.",
        );
      }
      assertWorkspaceName(body.name);
      const joinPolicy = parseOptionalJoinPolicy(body.joinPolicy);
      const publicMeta = parseOptionalPublicMeta(body.publicMeta);
      let creationKey: string | undefined;
      if (body.creationKey !== undefined) {
        if (typeof body.creationKey !== "string" || body.creationKey.length < 1 || body.creationKey.length > 128) {
          throw new MethodError(400, "InvalidRequest", "creationKey must be 1 to 128 characters.");
        }
        creationKey = body.creationKey;
      }
      return {
        url: authorityFlowUrl(did, authority, {
          kind: "createWorkspace",
          name: body.name.trim(),
          ...(joinPolicy ? { joinPolicy } : {}),
          ...(publicMeta !== undefined ? { publicMeta } : {}),
          ...(creationKey ? { creationKey } : {}),
        }).toString(),
      };
    },
  },
  [NOTICE_METHOD.confirmRegistration]: {
    type: "procedure",
    jsonLimit: 8 * 1024,
    unexpected: "InternalServerError",
    async serve(call) {
      const confirmation = parseConfirmRegistration(call.body);
      if (!confirmation) throw new MethodError(400, "InvalidRequest", "Invalid registration confirmation.");
      authenticateSpaceWebhook(confirmation.space, confirmation.token);
      return { challenge: confirmation.challenge };
    },
  },
  [NOTICE_METHOD.notifySpaceUpdate]: {
    type: "procedure",
    jsonLimit: 16 * 1024,
    unexpected: "InternalServerError",
    async serve(call) {
      const notification = parseSpaceUpdateNotification(call.body);
      if (!notification) throw new MethodError(400, "InvalidRequest", "Invalid space update notification.");
      const target = authenticateSpaceWebhook(notification.space, notification.token);
      const { space, update } = notification;

      switch (update.kind) {
        case "repoWrite":
          if (target.kind === "dm" || target.kind === "invites") {
            await recordDmWake(target.callerDid, space);
          } else {
            recordWriteNotification({ space, repo: update.repo, repoRev: update.repoRev });
            advanceSpaceRev(space, update.spaceRev);
          }
          return undefined;
        case "repoRemoved":
          if (target.kind === "dm" || target.kind === "invites") {
            await recordDmWake(target.callerDid, space);
          } else {
            recordSpaceWake(space, update.repo, "");
            advanceSpaceRev(space, update.spaceRev);
          }
          return undefined;
        case "registrationExpired":
          if (target.kind === "dm" || target.kind === "invites") {
            throw new WebhookAuthError("Stateless space notification registration expired.");
          }
          handleRegistrationExpiredNotice(space, update.spaceRev);
          return undefined;
        case "spaceDeleted":
          if (target.kind === "dm" || target.kind === "invites") {
            await recordDmWake(target.callerDid, space);
            return undefined;
          }
          await handleSpaceDeletedNotice(space);
          return undefined;
      }
    },
  },
};

export type Failure = { status: number; error: string; message: string; unnamed?: true };

export function describeFailure(error: unknown, unexpected: OperatorMethodDefinition["unexpected"]): Failure {
  const message = (error instanceof Error ? error.message : "The operator request failed.").slice(0, 500);
  if (error instanceof MethodError) return { status: error.status, error: error.error, message };
  if (error instanceof WebhookAuthError) return { status: 400, error: "InvalidRequest", message };
  if (error instanceof DmRateLimitError) return { status: 429, error: "RateLimitExceeded", message };
  if (error instanceof DmWakeIpcError) return { status: 503, error: "Busy", message };
  if (error instanceof AdminMutationsPausedError) return { status: error.status, error: "Paused", message };
  const upstream = operatorHttpFailure(error);
  if (upstream) return { status: upstream.status, error: upstream.name, message: upstream.message.slice(0, 500) };
  if (error instanceof OperatorAuthError) return { status: 403, error: "Unauthorized", message };
  if (error instanceof OperationConflictError) return { status: 409, error: "Conflict", message };
  if (error instanceof OperationBusyError) return { status: 503, error: "Busy", message };
  if (error instanceof WorkspaceEnvelopeError) return { status: error.status, error: "Conflict", message };
  if (error instanceof FeedRequestError) return { status: 400, error: "InvalidRequest", message };
  return unexpected === "InvalidRequest"
    ? { status: 400, error: "InvalidRequest", message, unnamed: true }
    : { status: 500, error: "InternalServerError", message: "The operator request failed.", unnamed: true };
}
