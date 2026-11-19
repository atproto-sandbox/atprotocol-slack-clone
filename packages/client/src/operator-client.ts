import { readUpstreamJson } from "@flock/protocol/bounded-json";
import type { ExtensionId } from "@flock/protocol/extensions";
import { tidNow } from "@flock/protocol/keys";
import { OPERATOR_METHOD, type OperatorMethod } from "@flock/protocol/nsids";
import { transportNow, type ClientTransport } from "./transport";

const MAX_OPERATOR_RESPONSE_BYTES = 1024 * 1024;
/**
 * A long-poll token is asked for this long, a minute under the operator's fifteen so a clock a little ahead of the PDS's is
 * not refused, and reused across polls until a minute before it runs out.
 */
const CHANGES_TOKEN_SECONDS = 14 * 60;
const TOKEN_RENEW_BEFORE_SECONDS = 60;
export const DEFAULT_DM_NOTIFY_TIMEOUT_MS = 10_000;

export function createTimeoutSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal | null,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Operation timed out after ${timeoutMs}ms.`, "TimeoutError"));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: controller.signal, cleanup };
}

export function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type ChangesAnswer = { head: string; changed: Array<{ space: string; cursor: string }>; denied: string[]; reset: string[] };

export type CreatedWorkspace = { operationId: string; workspace: string; channel: string; state: string; completedSteps: string[]; error?: string };

export type StalledWork = {
  operations: Array<{ actor: string; operationId: string; state: string; error?: string; updatedAt: string }>;
  registrations: Array<{ space: string; failures: number; error?: string; nextAttemptAt?: string; expiredAt?: string }>;
  truncated: boolean;
};

export type OperationView = {
  operationId: string;
  /** Lowercase hexadecimal SHA-256 of the canonical request JSON, as the operator's execute lexicon defines it. */
  requestHash: string;
  state: string;
  completedSteps: string[];
  error?: string;
  updatedAt: string;
};

export type OperatorService = {
  /** The operator's DID and service fragment, the audience of every service token: `did:web:…#atproto_flock_operator`. */
  serviceRef: string;
  /** The XRPC base URL that DID's service entry names. */
  endpoint: string;
};

export type DmCredentialProof = {
  authorization: string;
  signatureInput: string;
  signature: string;
};

export type DmNotifyTargetInput = {
  space: string;
  credential: string;
  proof: DmCredentialProof;
};

export type DmNotifyTarget = {
  endpoint: string;
  token: string;
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
/** What an authority flow is for, and for which workspace account (the caller's own when absent). */
export type AuthorityFlowRequest = ({ purpose: "createWorkspace"; name: string } | { purpose: "reauthorize" }) & { authority?: string };

export type OperatorExecuteRequest =
  | { kind: "inviteMember"; subject: string }
  | { kind: "removeMember"; subject: string }
  | { kind: "setAdmin"; subject: string; active: boolean }
  | { kind: "createChannel"; skey: string; name: string; visibility: "public" | "private"; members?: string[] }
  | { kind: "transitionChannel"; skey: string; visibility: "public" | "private"; members?: string[] }
  | { kind: "archiveChannel"; skey: string }
  | { kind: "decideJoinRequest"; request: string; requestId: string; decision: "approve" | "deny" }
  | { kind: "leaveWorkspace" }
  | { kind: "leaveChannel"; skey: string }
  | { kind: "reconcileWorkspace" }
  | { kind: "installApp"; subject: string; channels: Array<{ skey: string; write: boolean }> }
  | { kind: "updateAppAccess"; subject: string; channels: Array<{ skey: string; write: boolean }> }
  | { kind: "uninstallApp"; subject: string }
  | { kind: "enableExtension"; extId: ExtensionId }
  | { kind: "disableExtension"; extId: ExtensionId };

export class OperatorClient {
  private changesToken: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly transport: ClientTransport,
    private readonly service: OperatorService,
    private readonly options: {
      onWorkspaceMutated?: (workspaceUri: string) => Promise<void> | void;
      notifyTimeoutMs?: number;
    } = {},
  ) {}

  get serviceRef(): string {
    return this.service.serviceRef;
  }

  get operatorServiceRef(): string {
    return this.service.serviceRef;
  }

  /** Which followed spaces changed since their cursors, waiting up to about 25 seconds; `signal` ends the wait. */
  getChanges(follow: ReadonlyArray<{ space: string; after: string }>, signal?: AbortSignal): Promise<ChangesAnswer> {
    return this.call(OPERATOR_METHOD.getChanges, { input: { follow } }, signal);
  }

  /** Requests a stateless per-caller PDS webhook notification target for a DM space after proving credential possession. */
  async getDmNotifyTarget(input: DmNotifyTargetInput, signal?: AbortSignal): Promise<DmNotifyTarget> {
    const timeoutMs = this.options.notifyTimeoutMs ?? DEFAULT_DM_NOTIFY_TIMEOUT_MS;
    const { signal: composedSignal, cleanup } = createTimeoutSignal(timeoutMs, signal);
    try {
      return await this.call(OPERATOR_METHOD.getDmNotifyTarget, { input }, composedSignal);
    } finally {
      cleanup();
    }
  }

  /** Creates the workspace `name` for the caller, under `authority` (a dedicated workspace account's DID) or their own account. */
  createWorkspace(input: { name: string; operationId: string; authority?: string }): Promise<CreatedWorkspace> {
    return this.call(OPERATOR_METHOD.createWorkspace, { input });
  }

  /**
   * The operator URL to open, as a top-level navigation, to grant it authority over a workspace account's workspaces: the
   * caller's own, or `authority`'s, which only someone who signs in as that account can approve.
   */
  startAuthorityFlow(input: AuthorityFlowRequest): Promise<{ url: string }> {
    return this.call(OPERATOR_METHOD.startAuthorityFlow, { input });
  }

  listStalledOperations(workspace: string): Promise<StalledWork> {
    return this.call(OPERATOR_METHOD.listStalledOperations, { params: { workspace } });
  }

  async execute(input: { workspace: string; operationId: string; request: OperatorExecuteRequest | Record<string, unknown> }): Promise<{ operation: OperationView }> {
    const result = await this.call<{ operation: OperationView }>(OPERATOR_METHOD.execute, { input });
    await this.options.onWorkspaceMutated?.(input.workspace);
    return result;
  }

  enableExtension(workspace: string, extId: ExtensionId, operationId = tidNow()): Promise<{ operation: OperationView }> {
    return this.execute({ workspace, operationId, request: { kind: "enableExtension", extId } });
  }

  disableExtension(workspace: string, extId: ExtensionId, operationId = tidNow()): Promise<{ operation: OperationView }> {
    return this.execute({ workspace, operationId, request: { kind: "disableExtension", extId } });
  }

  getOperation(workspace: string, operationId: string): Promise<{ operation: OperationView }> {
    return this.call(OPERATOR_METHOD.getOperation, { params: { workspace, operationId } });
  }

  listInboxWriters(workspace: string): Promise<{ writers: string[] }> {
    return this.call(OPERATOR_METHOD.listInboxWriters, { params: { workspace } });
  }

  private async call<T>(method: OperatorMethod, input: { input?: unknown; params?: Record<string, string> }, signal?: AbortSignal): Promise<T> {
    const token = await this.token(method, signal);
    const base = new URL(this.service.endpoint);
    base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
    const url = new URL(`xrpc/${method}`, base);
    for (const [name, value] of Object.entries(input.params ?? {})) url.searchParams.set(name, value);
    const response = await raceWithSignal(
      this.transport.fetchEndpoint(new Request(url, {
        method: input.input === undefined ? "GET" : "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(input.input === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.input === undefined ? {} : { body: JSON.stringify(input.input) }),
      })),
      signal,
    );
    const body = await raceWithSignal(
      readUpstreamJson<T & { error?: string; message?: string }>(response, MAX_OPERATOR_RESPONSE_BYTES),
      signal,
    );
    const failure = operatorResponseFailure(response.status, response.ok, body);
    if (failure) {
      // A refused token is not reused.
      if (method === OPERATOR_METHOD.getChanges && failure.status === 403) this.changesToken = undefined;
      throw failure;
    }
    return body as T;
  }

  /** A service token for one method: a fresh one per call, except the long poll's, which lasts fifteen minutes and is reused. */
  private async token(method: OperatorMethod, signal?: AbortSignal): Promise<string> {
    const nowSeconds = Math.floor(transportNow(this.transport) / 1000);
    if (method !== OPERATOR_METHOD.getChanges) return this.serviceAuth(method, undefined, signal);
    if (this.changesToken && this.changesToken.expiresAt - nowSeconds > TOKEN_RENEW_BEFORE_SECONDS) return this.changesToken.token;
    const expiresAt = nowSeconds + CHANGES_TOKEN_SECONDS;
    const token = await this.serviceAuth(method, expiresAt, signal);
    this.changesToken = { token, expiresAt };
    return token;
  }

  private async serviceAuth(method: OperatorMethod, exp?: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    const { token } = await raceWithSignal(
      this.transport.memberClient.query<{ token: string }>("com.atproto.server.getServiceAuth", {
        aud: this.service.serviceRef, lxm: method, ...(exp === undefined ? {} : { exp: String(exp) }),
      }),
      signal,
    );
    return token;
  }
}
