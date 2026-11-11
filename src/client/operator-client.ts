import { readUpstreamJson } from "@/lib/bounded-json";
import { OPERATOR_METHOD, type OperatorMethod } from "@/protocol/nsids";
import { transportNow, type ClientTransport } from "./transport";

const MAX_OPERATOR_RESPONSE_BYTES = 1024 * 1024;
/**
 * A long-poll token is asked for this long, a minute under the operator's fifteen so a clock a little ahead of the PDS's is
 * not refused, and reused across polls until a minute before it runs out.
 */
const CHANGES_TOKEN_SECONDS = 14 * 60;
const TOKEN_RENEW_BEFORE_SECONDS = 60;

export type ChangesAnswer = { head: string; changed: Array<{ space: string; cursor: string }>; denied: string[]; reset: string[] };

export type CreatedWorkspace = { operationId: string; workspace: string; channel: string; state: string; completedSteps: string[]; error?: string };

export type StalledWork = {
  operations: Array<{ actor: string; operationId: string; state: string; error?: string; updatedAt: string }>;
  registrations: Array<{ space: string; failures: number; error?: string; nextAttemptAt?: string; expiredAt?: string }>;
  truncated: boolean;
};

export type OperationView = {
  operationId: string;
  state: string;
  completedSteps: string[];
  error?: string;
  updatedAt?: string;
};

export type OperatorService = {
  /** The operator's DID and service fragment, the audience of every service token: `did:web:…#atproto_flock_operator`. */
  serviceRef: string;
  /** The XRPC base URL that DID's service entry names. */
  endpoint: string;
};

export class OperatorRemoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OperatorRemoteError";
  }
}

export function operatorResponseFailure(status: number, ok: boolean, body: { error?: string; message?: string } | null): OperatorRemoteError | null {
  if (body === null) return new OperatorRemoteError(502, "InvalidUpstreamResponse", "Operator service returned invalid JSON.");
  if (!ok) return new OperatorRemoteError(status, body.error ?? "OperatorError", body.message ?? `Operator request failed (${status}).`);
  return null;
}

/**
 * The operator's methods, called with a service token the member's own host issues for that one method and the operator's
 * audience. No cookie and no server session: what a browser, a bot or a test holds is enough.
 */
export class OperatorClient {
  private changesToken: { token: string; expiresAt: number } | undefined;

  constructor(private readonly transport: ClientTransport, private readonly service: OperatorService) {}

  /** Which followed spaces changed since their cursors, waiting up to about 25 seconds; `signal` ends the wait. */
  getChanges(follow: ReadonlyArray<{ space: string; after: string }>, signal?: AbortSignal): Promise<ChangesAnswer> {
    return this.call(OPERATOR_METHOD.getChanges, { input: { follow } }, signal);
  }

  createWorkspace(input: { name: string; operationId: string }): Promise<CreatedWorkspace> {
    return this.call(OPERATOR_METHOD.createWorkspace, { input });
  }

  /** The operator URL to open, as a top-level navigation, to grant it authority over the caller's own workspaces. */
  startAuthorityFlow(input: { purpose: "createWorkspace"; name: string } | { purpose: "reauthorize" }): Promise<{ url: string }> {
    return this.call(OPERATOR_METHOD.startAuthorityFlow, { input });
  }

  listStalledOperations(workspace: string): Promise<StalledWork> {
    return this.call(OPERATOR_METHOD.listStalledOperations, { params: { workspace } });
  }

  execute(input: { workspace: string; operationId: string; request: Record<string, unknown> }): Promise<{ operation: OperationView }> {
    return this.call(OPERATOR_METHOD.execute, { input });
  }

  getOperation(workspace: string, operationId: string): Promise<{ operation: OperationView }> {
    return this.call(OPERATOR_METHOD.getOperation, { params: { workspace, operationId } });
  }

  listInboxWriters(workspace: string): Promise<{ writers: string[] }> {
    return this.call(OPERATOR_METHOD.listInboxWriters, { params: { workspace } });
  }

  private async call<T>(method: OperatorMethod, input: { input?: unknown; params?: Record<string, string> }, signal?: AbortSignal): Promise<T> {
    const token = await this.token(method);
    const base = new URL(this.service.endpoint);
    base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
    const url = new URL(`xrpc/${method}`, base);
    for (const [name, value] of Object.entries(input.params ?? {})) url.searchParams.set(name, value);
    const response = await this.transport.fetchEndpoint(new Request(url, {
      method: input.input === undefined ? "GET" : "POST",
      redirect: "error",
      ...(signal ? { signal } : {}),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(input.input === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.input === undefined ? {} : { body: JSON.stringify(input.input) }),
    }));
    const body = await readUpstreamJson<T & { error?: string; message?: string }>(response, MAX_OPERATOR_RESPONSE_BYTES);
    const failure = operatorResponseFailure(response.status, response.ok, body);
    if (failure) {
      // A refused token is not reused.
      if (method === OPERATOR_METHOD.getChanges && failure.status === 403) this.changesToken = undefined;
      throw failure;
    }
    return body as T;
  }

  /** A service token for one method: a fresh one per call, except the long poll's, which lasts fifteen minutes and is reused. */
  private async token(method: OperatorMethod): Promise<string> {
    const nowSeconds = Math.floor(transportNow(this.transport) / 1000);
    if (method !== OPERATOR_METHOD.getChanges) return this.serviceAuth(method);
    if (this.changesToken && this.changesToken.expiresAt - nowSeconds > TOKEN_RENEW_BEFORE_SECONDS) return this.changesToken.token;
    const expiresAt = nowSeconds + CHANGES_TOKEN_SECONDS;
    const token = await this.serviceAuth(method, expiresAt);
    this.changesToken = { token, expiresAt };
    return token;
  }

  private async serviceAuth(method: OperatorMethod, exp?: number): Promise<string> {
    const { token } = await this.transport.memberClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
      aud: this.service.serviceRef, lxm: method, ...(exp === undefined ? {} : { exp: String(exp) }),
    });
    return token;
  }
}
