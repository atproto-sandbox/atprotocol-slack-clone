import { readUpstreamJson } from "@/lib/bounded-json";

export type XrpcParams = Record<string, string | number | boolean | readonly string[] | undefined>;
export type AtprotoFetchHandler = (path: string, init: RequestInit) => Promise<Response>;
const MAX_XRPC_RESPONSE_BYTES = 8 * 1024 * 1024;

export class AtprotoClient {
  constructor(private readonly fetchHandler: AtprotoFetchHandler) {}

  async query<TOutput>(method: string, params: XrpcParams = {}): Promise<TOutput> {
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
    return this.request<TOutput>(`/xrpc/${method}${suffix}`, { method: "GET" });
  }

  async procedure<TInput, TOutput>(
    method: string,
    input: TInput,
    params: XrpcParams = {},
  ): Promise<TOutput> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<TOutput>(`/xrpc/${method}${suffix}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
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

export function isMissingXrpcResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("status" in error && error.status === 404) return true;
  return "code" in error && (error.code === "RecordNotFound" || error.code === "RepoNotFound");
}
