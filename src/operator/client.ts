import type { OAuthSession } from "@atproto/oauth-client-node";
import type * as Execute from "@/lexicons/api/types/new/flock/operator/execute";
import type * as GetOperation from "@/lexicons/api/types/new/flock/operator/getOperation";
import type * as ListInboxWriters from "@/lexicons/api/types/new/flock/operator/listInboxWriters";
import { assertSafePdsEndpoint, fetchValidatedEndpoint, getIdResolver } from "@/atproto/identity";
import type * as GetServiceAuth from "@/lexicons/api/types/com/atproto/server/getServiceAuth";
import { sessionClient } from "@/atproto/client";
import { OPERATOR_METHODS } from "@/protocol/scopes";
import { getConfig } from "@/lib/config";
import { readUpstreamJson } from "@/lib/bounded-json";
import { operatorHttpFailure } from "./errors";
import { OPERATOR_METHOD } from "@/protocol/nsids";

export async function submitOperation(
  session: OAuthSession,
  input: Execute.InputSchema,
): Promise<Execute.OutputSchema> {
  return operatorRequest(session, OPERATOR_METHOD.execute, input);
}

export async function fetchOperation(
  session: OAuthSession,
  workspace: string,
  operationId: string,
): Promise<GetOperation.OutputSchema> {
  return operatorRequest(session, OPERATOR_METHOD.getOperation, undefined, { workspace, operationId });
}

export async function fetchInboxWriters(session: OAuthSession, workspace: string): Promise<ListInboxWriters.OutputSchema> {
  return operatorRequest(session, OPERATOR_METHOD.listInboxWriters, undefined, { workspace });
}

async function operatorRequest<TInput, TOutput>(
  session: OAuthSession,
  method: (typeof OPERATOR_METHODS)[number],
  input?: TInput,
  params: Record<string, string> = {},
): Promise<TOutput> {
  const config = getConfig();
  const token = await requestOperatorServiceAuth(session, config.operatorServiceRef, method);
  const endpoint = await resolveOperatorEndpoint(config.operatorServiceRef);
  const url = new URL(`xrpc/${method}`, endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchValidatedEndpoint(new Request(url, {
    method: input === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
  const body = await readUpstreamJson<TOutput & { error?: string; message?: string }>(response, 1024 * 1024);
  const failure = operatorResponseFailure(response.status, response.ok, body);
  if (failure) throw failure;
  return body as TOutput;
}

async function resolveOperatorEndpoint(serviceRef: string): Promise<URL> {
  const hash = serviceRef.indexOf("#");
  const did = serviceRef.slice(0, hash);
  const fragment = serviceRef.slice(hash + 1);
  const document = await getIdResolver().did.resolve(did);
  const services = (document as unknown as { service?: Array<{ id?: string; serviceEndpoint?: unknown }> } | null)?.service ?? [];
  const service = services.find((entry) => entry.id === `#${fragment}` || entry.id === serviceRef);
  if (!service || typeof service.serviceEndpoint !== "string") throw new Error("Operator service endpoint is missing from its DID document.");
  const endpoint = new URL(service.serviceEndpoint);
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) {
    throw new Error("Operator service endpoint must use HTTPS outside loopback development.");
  }
  await assertSafePdsEndpoint(endpoint.toString());
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

/** A service token from the caller's own session, bound to the operator's service and to exactly one of its methods. */
export async function requestOperatorServiceAuth(
  session: OAuthSession,
  serviceRef: string,
  method: (typeof OPERATOR_METHODS)[number],
): Promise<string> {
  const result = await sessionClient(session).query<GetServiceAuth.OutputSchema>("com.atproto.server.getServiceAuth", { aud: serviceRef, lxm: method });
  return result.token;
}

export class OperatorRemoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OperatorRemoteError";
  }
}

export function operatorResponseFailure(
  status: number,
  ok: boolean,
  body: { error?: string; message?: string } | null,
): OperatorRemoteError | null {
  if (body === null) return new OperatorRemoteError(502, "InvalidUpstreamResponse", "Operator service returned invalid JSON.");
  if (!ok) return new OperatorRemoteError(status, body.error ?? "OperatorError", body.message ?? `Operator request failed (${status}).`);
  return null;
}

/** The operator holds no usable grant for the workspace's authority; only the authority approving again fixes it. */
export function isAuthorityReauthorizationRequired(error: unknown): boolean {
  return error instanceof OperatorRemoteError && error.code === "AuthoritySessionUnavailable";
}

export function operatorRemoteHttpStatus(error: unknown): number | null {
  if (error instanceof OperatorRemoteError) {
    return Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  }
  return operatorHttpFailure(error)?.status ?? null;
}
