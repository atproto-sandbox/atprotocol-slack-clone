import { readUpstreamJson } from "@/lib/bounded-json";
import { OPERATOR_METHOD, type OperatorMethod } from "@/protocol/nsids";
import type { ClientTransport } from "./transport";

const MAX_OPERATOR_RESPONSE_BYTES = 1024 * 1024;

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
  constructor(private readonly transport: ClientTransport, private readonly service: OperatorService) {}

  execute(input: { workspace: string; operationId: string; request: Record<string, unknown> }): Promise<{ operation: OperationView }> {
    return this.call(OPERATOR_METHOD.execute, { input });
  }

  getOperation(workspace: string, operationId: string): Promise<{ operation: OperationView }> {
    return this.call(OPERATOR_METHOD.getOperation, { params: { workspace, operationId } });
  }

  listInboxWriters(workspace: string): Promise<{ writers: string[] }> {
    return this.call(OPERATOR_METHOD.listInboxWriters, { params: { workspace } });
  }

  private async call<T>(method: OperatorMethod, input: { input?: unknown; params?: Record<string, string> }): Promise<T> {
    const { token } = await this.transport.memberClient.query<{ token: string }>("com.atproto.server.getServiceAuth", { aud: this.service.serviceRef, lxm: method });
    const base = new URL(this.service.endpoint);
    base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
    const url = new URL(`xrpc/${method}`, base);
    for (const [name, value] of Object.entries(input.params ?? {})) url.searchParams.set(name, value);
    const response = await this.transport.fetchEndpoint(new Request(url, {
      method: input.input === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(input.input === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.input === undefined ? {} : { body: JSON.stringify(input.input) }),
    }));
    const body = await readUpstreamJson<T & { error?: string; message?: string }>(response, MAX_OPERATOR_RESPONSE_BYTES);
    const failure = operatorResponseFailure(response.status, response.ok, body);
    if (failure) throw failure;
    return body as T;
  }
}
