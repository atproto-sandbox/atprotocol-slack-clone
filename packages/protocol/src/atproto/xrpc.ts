import { readUpstreamJson } from "../bounded-json";

export type XrpcParams = Record<string, string | number | boolean | readonly string[] | undefined>;
export type XrpcRequestOptions = { signal?: AbortSignal; headers?: Readonly<Record<string, string>> };
export type AtprotoFetchHandler = (path: string, init: RequestInit) => Promise<Response>;
export const MAX_XRPC_RESPONSE_BYTES = 8 * 1024 * 1024;

export class AtprotoClient {
  constructor(private readonly fetchHandler: AtprotoFetchHandler) {}

  async query<TOutput>(
    method: string,
    params: XrpcParams = {},
    options?: XrpcRequestOptions,
  ): Promise<TOutput> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) query.append(key, item);
      } else {
        query.set(key, String(value));
      }
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<TOutput>(`/xrpc/${method}${suffix}`, {
      method: "GET",
      ...(options?.headers ? { headers: { ...options.headers } } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  async procedure<TInput, TOutput>(
    method: string,
    input: TInput,
    params: XrpcParams = {},
    options?: XrpcRequestOptions,
  ): Promise<TOutput> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<TOutput>(`/xrpc/${method}${suffix}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify(input),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    if (init.signal?.aborted) {
      throw init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    const response = await this.fetchHandler(path, init);
    const body = await readUpstreamJson(response, MAX_XRPC_RESPONSE_BYTES);
    if (!response.ok) {
      const detail = body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `XRPC request failed (${response.status}).`;
      const code = body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "XrpcError";
      throw new XrpcError(response.status, detail, code);
    }
    return body as T;
  }
}

export class XrpcError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "XrpcError";
  }
}

/** The PDS rejected the call because the session's OAuth grant does not cover it (HTTP 403, `ScopeMissingError`). */
export function isScopeMissingError(error: unknown): boolean {
  return error instanceof XrpcError && error.status === 403 && error.code === "ScopeMissingError";
}

/** `createSpace` found a live space with the same owner, type and key: the pinned PDS answers 400 `SpaceAlreadyExists`. */
export function isSpaceAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SpaceAlreadyExists";
}

export function isMissingXrpcResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("status" in error && error.status === 404) return true;
  return "code" in error && (error.code === "RecordNotFound" || error.code === "RepoNotFound");
}

/** Whether the PDS rejected a pagination cursor as malformed or stale (`InvalidCursor`). */
export function isInvalidCursorError(error: unknown): boolean {
  return error instanceof XrpcError && error.code === "InvalidCursor";
}

/** Whether an account-authenticated management call was refused because the authority account is taken down or deactivated. */
export function isAccountSuspendedError(error: unknown): boolean {
  return error instanceof XrpcError && (error.code === "AccountTakedown" || error.code === "AccountDeactivated");
}
