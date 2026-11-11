import { OperatorRemoteError, type OperationView } from "@/client/operator-client";
import { operatorAs } from "./engine";
import { eventually } from "./ui";
import type { Actor, ApiCall, AppWorld } from "./world";

// The browser's own calls to the operator's `execute` (an XRPC procedure at the app's origin until R7), as the operator
// answered them. An answer is `{ operation }`, or an XRPC error `{ error: code, message }`.

export const OPERATOR_EXECUTE = "/xrpc/new.flock.operator.execute";
export const OPERATOR_CREATE_WORKSPACE = "/xrpc/new.flock.operator.createWorkspace";
export const OPERATOR_AUTHORITY_FLOW = "/xrpc/new.flock.operator.startAuthorityFlow";

export type Executed = { status: number; operationId: string; request: Record<string, unknown>; operation?: OperationView; code?: string; error?: string };

/** The browser's own calls to one operator method (`path`), from its `since`th XRPC call on. */
export function operatorCalls(actor: Actor, path: string, since = 0): ApiCall[] {
  return actor.xrpc.slice(since).filter((call) => call.path === path);
}

/** The operations a person submitted, as the browser called `execute` for them; the app's own reconcile is not one of them. */
export function executeCalls(actor: Actor, since = 0): ApiCall[] {
  return operatorCalls(actor, OPERATOR_EXECUTE, since).filter((call) => (JSON.parse(call.requestBody) as { request?: { kind?: string } }).request?.kind !== "reconcileWorkspace");
}

/** An operator answer, with the request it answered; `error` is the operator's message and `code` its XRPC error name. */
export function decodeExecuted(status: number, requestBody: string, responseBody: string): Executed {
  const request = JSON.parse(requestBody) as { operationId: string; request: Record<string, unknown> };
  const body = (responseBody ? JSON.parse(responseBody) : {}) as { operation?: OperationView; error?: string; message?: string };
  return { status, operationId: request.operationId, request: request.request, operation: body.operation, code: body.error, error: body.message ?? body.error };
}

/** Does `act` (a click in the page) and returns the operator's answer to the `execute` call it caused. */
export async function submitAndWait(actor: Actor, act: () => Promise<void>): Promise<Executed> {
  const before = actor.xrpc.length;
  await act();
  const call = await eventually(() => executeCalls(actor, before)[0], { what: "the operator reply", timeoutMs: 120_000 });
  return decodeExecuted(call.status, call.requestBody, call.responseBody);
}

/** The same call made in Node through the operator client, as `actor`'s browser makes it, for a body the page would not send. */
export async function executeAs(world: AppWorld, actor: Actor, body: { workspace: string; operationId: string; request: Record<string, unknown> }): Promise<Executed> {
  try {
    const { operation } = await operatorAs(world, actor).execute(body);
    return { status: 200, operationId: body.operationId, request: body.request, operation };
  } catch (error) {
    if (!(error instanceof OperatorRemoteError)) throw error;
    return { status: error.status, operationId: body.operationId, request: body.request, code: error.code, error: error.message };
  }
}
