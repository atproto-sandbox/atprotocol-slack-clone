import { parseSpaceDeletedNotification, parseWriteNotification } from "../atproto/write-notification";
import { isDid } from "@flock/protocol/keys";
import { NOTICE_METHOD, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { AuthorityReauthorizationRequiredError, authorityFlowUrl, restoreAuthorityGrant } from "./authority-grant";
import { AUTHORITY_APPROVAL_REQUIRED, OperatorAuthError, operatorHttpFailure } from "./errors";
import { FeedRequestError, getChanges, parseFollow } from "./feed";
import { getActorOperation, OperationBusyError, OperationConflictError } from "./journal";
import { CreationNotAuthorizedError } from "./creation-authorization";
import { assertCreationAdmissible, createWorkspace, WorkspaceExistsError } from "./kinds/create-workspace";
import { assertWorkspaceName } from "./workspace-spaces";
import { dropMemberList } from "./member-access";
import { AdminMutationsPausedError, assertAdminMutationsEnabled } from "./mutations-paused";
import { purgeSpaceNotifications, recordWriteNotification } from "./notices";
import { executeOperatorOperation, listInboxWriters } from "./operations";
import { registrationDeps } from "./registrations";
import { authenticateOperatorRequest, requireActiveWorkspaceAdmin, requireWorkspaceActorForOperation } from "./security";
import { authenticateSpaceNotification } from "./space-notification";
import { listStalledWork } from "./stalled";
import { assertOperatorWorkspaceWithinEnvelope } from "./workspace-envelope";

// The operator's XRPC methods, apart from how a call reaches them: each takes what a call carries and returns its output or
// throws. The server (`server.ts`) registers them with the app's lexicons, which check the parameters and the input, and
// turns a failure into an XRPC error with `describeFailure`.

/** What a call to one of the operator's methods carries. */
export type MethodCall = {
  /** The `authorization` header: a service token from the caller's own host. */
  authorization: string | undefined;
  params: Readonly<Record<string, unknown>>;
  body: unknown;
  /**
   * Aborted when the caller goes away. Only waiting may stop on it (the change feed's long poll): a method that writes must
   * not pass it on, or a write whose caller left would stop half-applied.
   */
  signal: AbortSignal;
};

/** A refusal with the XRPC status and error name it answers with. */
export class MethodError extends Error {
  constructor(readonly status: number, readonly error: string, message: string) {
    super(message);
    this.name = "MethodError";
  }
}

export type OperatorMethodDefinition = {
  type: "query" | "procedure";
  /** The largest JSON body the method reads. */
  jsonLimit?: number;
  /** What a failure the method does not name answers with: its message as a bad request, or an internal error. */
  unexpected: "InvalidRequest" | "InternalServerError";
  /** The method's output, or nothing for a method whose lexicon declares none (the notices). */
  serve(call: MethodCall): Promise<object | undefined>;
};

const OPERATION_ID = /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/;

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

/** An admin's read of a workspace: the caller authenticated and an active admin, and the workspace within the envelope where the method needs it. */
async function asWorkspaceAdmin<T>(call: MethodCall, method: string, action: (actor: Awaited<ReturnType<typeof requireActiveWorkspaceAdmin>>) => Promise<T>): Promise<T> {
  const did = await authenticateOperatorRequest(call.authorization, method);
  const actor = await requireActiveWorkspaceAdmin(stringParam(call, "workspace"), did, { allowDegradedLookup: method === OPERATOR_METHOD.getOperation });
  if (method === OPERATOR_METHOD.listInboxWriters) await assertOperatorWorkspaceWithinEnvelope(actor);
  return action(actor);
}

const AUTHORIZATION_REQUIRED = "Workspace setup needs the workspace account's approval first: start the authority flow, then retry with the same operation id.";

/** The workspace account a request names, or the caller's own. */
function authorityOf(body: Record<string, unknown>, caller: string): string {
  if (body.authority === undefined) return caller;
  if (typeof body.authority !== "string" || !isDid(body.authority)) throw new MethodError(400, "InvalidRequest", "The workspace account must be a DID.");
  return body.authority;
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
      if (typeof body.workspace !== "string" || typeof body.operationId !== "string" || !OPERATION_ID.test(body.operationId)) {
        throw new MethodError(400, "InvalidRequest", "Workspace URI and protocol TID operation ID are required.");
      }
      const actor = await requireWorkspaceActorForOperation(body.workspace, did, body.request);
      await assertOperatorWorkspaceWithinEnvelope(actor);
      const operation = await executeOperatorOperation(actor, body.operationId, body.request, registrationDeps);
      if (operation.authorizationRequired) {
        throw new MethodError(AUTHORITY_APPROVAL_REQUIRED.status, AUTHORITY_APPROVAL_REQUIRED.name, AUTHORITY_APPROVAL_REQUIRED.message);
      }
      return { operation };
    },
  },
  [OPERATOR_METHOD.getOperation]: {
    type: "query",
    unexpected: "InvalidRequest",
    async serve(call) {
      const operationId = stringParam(call, "operationId");
      if (!OPERATION_ID.test(operationId)) throw new MethodError(400, "InvalidRequest", "Operation ID must be a protocol TID.");
      return asWorkspaceAdmin(call, OPERATOR_METHOD.getOperation, async (actor) => {
        const operation = getActorOperation(actor, operationId);
        if (!operation) throw new MethodError(400, "InvalidRequest", "Operation not found.");
        return { operation };
      });
    },
  },
  [OPERATOR_METHOD.listInboxWriters]: {
    type: "query",
    unexpected: "InvalidRequest",
    serve: (call) => asWorkspaceAdmin(call, OPERATOR_METHOD.listInboxWriters, listInboxWriters),
  },
  [OPERATOR_METHOD.listStalledOperations]: {
    type: "query",
    unexpected: "InvalidRequest",
    serve: (call) => asWorkspaceAdmin(call, OPERATOR_METHOD.listStalledOperations, async (actor) => {
      const { operations, registrations, truncated } = listStalledWork(actor.workspace.authorityDid, actor.workspace.uri);
      // The lexicon has no null: an operation without an error leaves the field out.
      return { operations: operations.map(({ error, ...operation }) => (error === null ? operation : { ...operation, error })), registrations, truncated };
    }),
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
  [OPERATOR_METHOD.createWorkspace]: {
    type: "procedure",
    unexpected: "InvalidRequest",
    async serve(call) {
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.createWorkspace);
      assertAdminMutationsEnabled();
      const body = objectBody(call, ["name", "operationId", "authority"], "The request takes a workspace name, an operation ID and, optionally, the workspace account.");
      if (typeof body.name !== "string" || typeof body.operationId !== "string") {
        throw new MethodError(400, "InvalidRequest", "A workspace name and operation ID are required.");
      }
      assertWorkspaceName(body.name);
      const authority = authorityOf(body, did);
      try {
        assertCreationAdmissible({ authorityDid: authority, creator: did, name: body.name, operationId: body.operationId });
      } catch (error) {
        if (error instanceof CreationNotAuthorizedError) throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
        throw error;
      }
      let grant;
      try {
        grant = await restoreAuthorityGrant(authority);
      } catch (error) {
        if (error instanceof AuthorityReauthorizationRequiredError) throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
        throw error;
      }
      let result;
      try {
        result = await createWorkspace(grant, { creator: did, name: body.name, operationId: body.operationId }, registrationDeps);
      } catch (error) {
        if (error instanceof OperationConflictError) throw new MethodError(409, "OperationIdConflict", error.message);
        // Someone other than the workspace account, with no approval for this workspace: the same answer as a missing grant,
        // so the web app's one path (approve, return, retry the same operation) serves both.
        if (error instanceof CreationNotAuthorizedError) throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
        if (error instanceof WorkspaceExistsError) throw new MethodError(409, "WorkspaceExists", error.message);
        throw error;
      }
      if (result.authorizationRequired) throw new MethodError(403, "AuthorizationRequired", AUTHORIZATION_REQUIRED);
      const { operationId, workspace, channel, state, completedSteps, error } = result;
      return { operationId, workspace, channel, state, completedSteps, ...(error ? { error } : {}) };
    },
  },
  [OPERATOR_METHOD.startAuthorityFlow]: {
    type: "procedure",
    jsonLimit: 4 * 1024,
    unexpected: "InvalidRequest",
    async serve(call) {
      const did = await authenticateOperatorRequest(call.authorization, OPERATOR_METHOD.startAuthorityFlow);
      const body = objectBody(call, ["purpose", "name", "authority"], "The request takes a purpose, to create a workspace its name, and optionally the workspace account.");
      const authority = authorityOf(body, did);
      if (body.purpose === "reauthorize" && body.name === undefined) return { url: authorityFlowUrl(did, authority, null).toString() };
      if (body.purpose !== "createWorkspace" || typeof body.name !== "string") {
        throw new MethodError(400, "InvalidRequest", "The purpose is createWorkspace with a workspace name, or reauthorize without one.");
      }
      assertWorkspaceName(body.name);
      return { url: authorityFlowUrl(did, authority, body.name.trim()).toString() };
    },
  },
  [NOTICE_METHOD.notifyWrite]: {
    type: "procedure",
    jsonLimit: 8 * 1024,
    unexpected: "InternalServerError",
    async serve(call) {
      const notification = parseWriteNotification(call.body);
      if (!notification) throw new MethodError(400, "InvalidRequest", "Invalid space write notification.");
      await authenticateSpaceNotification(call.authorization, NOTICE_METHOD.notifyWrite, notification.space);
      recordWriteNotification(notification);
      return undefined;
    },
  },
  /**
   * The space authority says a registered space was deleted: its notices and registration go, and so does the member list
   * the change feed answers from. Applying it twice changes nothing; the registration is dropped with the notices, so a retry
   * of an already-applied notice is refused, which loses nothing.
   */
  [NOTICE_METHOD.notifySpaceDeleted]: {
    type: "procedure",
    jsonLimit: 8 * 1024,
    unexpected: "InternalServerError",
    async serve(call) {
      const notification = parseSpaceDeletedNotification(call.body);
      if (!notification) throw new MethodError(400, "InvalidRequest", "Invalid space deletion notification.");
      await authenticateSpaceNotification(call.authorization, NOTICE_METHOD.notifySpaceDeleted, notification.space);
      purgeSpaceNotifications(notification.space);
      dropMemberList(notification.space);
      return undefined;
    },
  },
};

/** An XRPC error; `unnamed` marks a failure no method names, which the server logs. */
export type Failure = { status: number; error: string; message: string; unnamed?: true };

/** The XRPC error a method's failure answers with. */
export function describeFailure(error: unknown, unexpected: OperatorMethodDefinition["unexpected"]): Failure {
  const message = (error instanceof Error ? error.message : "The operator request failed.").slice(0, 500);
  if (error instanceof MethodError) return { status: error.status, error: error.error, message };
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
