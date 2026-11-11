import { OperatorRemoteError, type OperationView } from "@flock/client/operator-client";
import { operationView, type OperationState } from "@flock/operator/operator/journal";
import { operatorAs } from "./engine";
import { eventually } from "./ui";
import type { Actor, ApiCall, AppWorld } from "./world";

// The browser's own calls to the operator's `execute` (an XRPC procedure at the operator's own origin), as the operator
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

/**
 * An operator answer as the page received it, with the request it answered; `error` is the operator's message and `code` its
 * XRPC error name. A call recorded without its body has no answer to decode.
 */
export function decodeExecuted(call: ApiCall): Executed {
  if (call.body !== "recorded") throw new Error(`The operator's reply to execute (HTTP ${call.status}) was recorded without its body (${call.body}): ${call.requestBody}`);
  const request = JSON.parse(call.requestBody) as { operationId: string; request: Record<string, unknown> };
  const body = (call.responseBody ? JSON.parse(call.responseBody) : {}) as { operation?: OperationView; error?: string; message?: string };
  return { status: call.status, operationId: request.operationId, request: request.request, operation: body.operation, code: body.error, error: body.message ?? body.error };
}

/**
 * The operator's answer to one recorded `execute` call. Chromium can drop a response body before the recorder reads it, and
 * Playwright reports that as a page that navigated away. For an operation the operator accepted, its journal record
 * (`journaled`, read from the app's database, so for any actor) is the answer then: the same view, as of the read. A refusal
 * whose body was dropped has no record to fall back on.
 */
export function answerOf(call: ApiCall, journaled: (operationId: string) => OperationView | undefined): Executed {
  if (call.body === "recorded" || call.status !== 200) return decodeExecuted(call);
  const { operationId, request } = JSON.parse(call.requestBody) as { operationId: string; request: Record<string, unknown> };
  const operation = journaled(operationId);
  if (!operation) throw new Error(`The operator accepted execute but its reply was recorded without its body (${call.body}), and the journal has no operation ${operationId}.`);
  return { status: call.status, operationId, request, operation };
}

/** The operator's journal record of an operation in `world`'s app database, as the operator answers with it. */
export function journaledOperation(world: AppWorld, operationId: string): OperationView | undefined {
  return world.withAppDatabase((db) => {
    const row = db.prepare("SELECT request_hash, state, steps_json, error, updated_at FROM operation WHERE operation_id = ?").get(operationId) as
      { request_hash: string; state: OperationState; steps_json: string; error: string | null; updated_at: number } | undefined;
    return row && operationView(operationId, row.request_hash, row.state, JSON.parse(row.steps_json) as string[], row.error, row.updated_at);
  });
}

/** Does `act` (a click in the page) and returns the operator's answer to the `execute` call it caused (`answerOf`). */
export async function submitAndWait(world: AppWorld, actor: Actor, act: () => Promise<void>): Promise<Executed> {
  const before = actor.xrpc.length;
  await act();
  const call = await eventually(() => executeCalls(actor, before)[0], { what: "the operator reply", timeoutMs: 120_000 });
  return answerOf(call, (operationId) => journaledOperation(world, operationId));
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
