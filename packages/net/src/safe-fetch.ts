import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

// How a server process reaches a host that someone else named (a PDS endpoint or a did:web host in a DID document): over https
// to a public address only, unless loopback development allows its own loopback hosts. The address checked is the address
// connected to (the DNS answer is pinned for 30 seconds), no redirect is followed, and a request is given up a minute after it
// began, however slowly its host answers. The operator and a Node app (`@flock/client/node`) both reach other hosts this way.

export type SafeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Whether loopback hosts (and plain http to them) are allowed: loopback development only. It is asked at every request. */
export type LoopbackPolicy = () => boolean;

export type BoundedSafeFetchOptions = {
  deadlineMs: number;
  maxResponseBytes: number;
  allowedContentTypes?: readonly string[];
};

export class UpstreamContentTypeError extends Error {
  readonly status = 502;
  readonly code = "UpstreamContentTypeError";

  constructor(message: string) {
    super(message);
    this.name = "UpstreamContentTypeError";
  }
}

export class UpstreamResponseTooLargeError extends Error {
  readonly status = 502;
  readonly code = "UpstreamResponseTooLargeError";

  constructor(message: string) {
    super(message);
    this.name = "UpstreamResponseTooLargeError";
  }
}

export const BOUNDED_FETCH_PROFILES = {
  oauthMetadata: {
    deadlineMs: 5_000,
    maxResponseBytes: 262_144,
    allowedContentTypes: ["application/json"],
  },
  didAndJwks: {
    deadlineMs: 5_000,
    maxResponseBytes: 262_144,
    allowedContentTypes: ["application/json", "application/did+ld+json", "application/jwk-set+json"],
  },
  xrpcNotice: {
    deadlineMs: 10_000,
    maxResponseBytes: 65_536,
    allowedContentTypes: ["application/json", "text/plain"],
  },
  migrationInfo: {
    deadlineMs: 10_000,
    maxResponseBytes: 262_144,
    allowedContentTypes: ["application/json"],
  },
  migrationManifest: {
    deadlineMs: 15_000,
    maxResponseBytes: 4_194_304,
    allowedContentTypes: ["application/json"],
  },
} as const satisfies Record<string, BoundedSafeFetchOptions>;

const SAFE_DNS_TTL_MS = 30_000;
const MAX_CHECKED_HOSTS = 512;
const MAX_PINNED_AGENTS = 128;
const RESPONSE_TIMEOUT_MS = 60_000;
const checkedHosts = new Map<string, { expiresAt: number; addresses: Array<{ address: string; family: number }> }>();
const pinnedAgents = new Map<string, { agent: Agent; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
const nonPublicAddresses = makeNonPublicAddressList();

/** Refuses an endpoint this process may not reach: see the module's rule. */
export async function assertSafeEndpoint(endpoint: string, allowLoopback: LoopbackPolicy): Promise<void> {
  await resolveSafeEndpoint(endpoint, allowLoopback());
}

/** A fetch that reaches only endpoints this process may reach, at the address it checked, given up `deadlineMs` after it began. */
export function safeFetch(allowLoopback: LoopbackPolicy, deadlineMs = RESPONSE_TIMEOUT_MS): SafeFetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const requestUrl = new URL(request.url);
    if (requestUrl.username || requestUrl.password || requestUrl.hash) {
      throw new Error("The request contains an unsafe remote endpoint.");
    }
    const endpoint = await resolveSafeEndpoint(requestUrl.origin, allowLoopback());
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: request.headers as unknown as HeadersInit,
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]),
      dispatcher: pinnedAgent(endpoint.url, endpoint.addresses),
    });
    return new Response(response.body as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as unknown as HeadersInit,
    });
  };
}

function normalizeMimeType(headerValue: string | null): string {
  if (!headerValue) return "";
  return headerValue.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * SSRF-safe fetch with end-to-end header+body deadline, MIME media-type gate before body read,
 * Content-Length pre-check, and streaming decompressed byte-cap enforcement.
 */
export function boundedSafeFetch(
  allowLoopback: LoopbackPolicy,
  options: BoundedSafeFetchOptions,
): SafeFetch {
  const allowedSet =
    options.allowedContentTypes && options.allowedContentTypes.length > 0
      ? new Set(options.allowedContentTypes.map((ct) => ct.trim().toLowerCase()))
      : null;

  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const requestUrl = new URL(request.url);
    if (requestUrl.username || requestUrl.password || requestUrl.hash) {
      throw new Error("The request contains an unsafe remote endpoint.");
    }
    const endpoint = await resolveSafeEndpoint(requestUrl.origin, allowLoopback());
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
    const combinedSignal = AbortSignal.any([request.signal, deadlineSignal]);

    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: request.headers as unknown as HeadersInit,
      ...(body ? { body } : {}),
      redirect: "error",
      signal: combinedSignal,
      dispatcher: pinnedAgent(endpoint.url, endpoint.addresses),
    });

    const contentLengthRaw = response.headers.get("content-length");
    if (contentLengthRaw !== null && contentLengthRaw.trim() !== "") {
      const contentLength = Number(contentLengthRaw);
      if (Number.isFinite(contentLength) && contentLength > options.maxResponseBytes) {
        void response.body?.cancel().catch(() => {});
        throw new UpstreamResponseTooLargeError(
          `Upstream response Content-Length (${contentLength}) exceeds maxResponseBytes (${options.maxResponseBytes}).`,
        );
      }
    }

    const isEmptyStatus =
      response.status === 204 ||
      response.status === 304 ||
      contentLengthRaw?.trim() === "0";
    const mime = normalizeMimeType(response.headers.get("content-type"));

    if (allowedSet && response.ok && !isEmptyStatus) {
      // Allow empty chunked 200 responses only when content-type is omitted AND first read yields EOF;
      // reject immediately whenever a non-matching Content-Type is declared, or if content-type is missing on non-empty body.
      if (mime !== "" && !allowedSet.has(mime)) {
        void response.body?.cancel().catch(() => {});
        throw new UpstreamContentTypeError(
          `Upstream response Content-Type ${JSON.stringify(mime)} is not in allowed types [${[...allowedSet].join(", ")}].`,
        );
      }
    }

    if (!response.body) {
      if (allowedSet && !isEmptyStatus && mime === "") {
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers as unknown as HeadersInit,
        });
      }
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as unknown as HeadersInit,
      });
    }

    const rawStream = response.body as unknown as ReadableStream<Uint8Array>;
    const reader = rawStream.getReader();
    let totalBytes = 0;
    let sawNonEmptyChunk = false;

    const boundedStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (combinedSignal.aborted) {
          const reason = combinedSignal.reason ?? new DOMException("The operation timed out.", "TimeoutError");
          await reader.cancel(reason).catch(() => {});
          controller.error(reason);
          return;
        }
        let onAbort: (() => void) | undefined;
        try {
          const readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                const reason = combinedSignal.reason ?? new DOMException("The operation timed out.", "TimeoutError");
                void reader.cancel(reason).catch(() => {});
                reject(reason);
              };
              combinedSignal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
          if (readResult.done) {
            controller.close();
            return;
          }
          const chunk = readResult.value;
          if (chunk.byteLength > 0 && !sawNonEmptyChunk) {
            sawNonEmptyChunk = true;
            if (allowedSet && mime === "") {
              const err = new UpstreamContentTypeError(
                `Upstream response with non-empty body is missing required Content-Type [${[...allowedSet].join(", ")}].`,
              );
              await reader.cancel(err).catch(() => {});
              controller.error(err);
              return;
            }
          }
          totalBytes += chunk.byteLength;
          if (totalBytes > options.maxResponseBytes) {
            const err = new UpstreamResponseTooLargeError(
              `Upstream response body exceeded maxResponseBytes (${options.maxResponseBytes}).`,
            );
            await reader.cancel(err).catch(() => {});
            controller.error(err);
            return;
          }
          controller.enqueue(chunk);
        } catch (err) {
          await reader.cancel(err).catch(() => {});
          controller.error(err);
        } finally {
          if (onAbort) combinedSignal.removeEventListener("abort", onAbort);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    });

    return new Response(boundedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as unknown as HeadersInit,
    });
  };
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".localhost")) return true;
  const parts = normalized.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
}

async function resolveSafeEndpoint(endpoint: string, loopbackAllowed: boolean): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("The DID document contains an invalid PDS endpoint."); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localTarget = isLoopbackHost(hostname);
  if ((url.protocol !== "https:" && !(loopbackAllowed && localTarget && url.protocol === "http:")) ||
      !hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("The DID document contains an unsafe PDS endpoint.");
  }
  if (!loopbackAllowed && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
    throw new Error("The DID document contains a non-public PDS endpoint.");
  }

  const cacheKey = `${loopbackAllowed}|${hostname}:${url.port}`;
  const cached = checkedHosts.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { url, addresses: cached.addresses };
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => {
    const family = isIP(address);
    return family === 0 || nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6") && !(loopbackAllowed && isLoopbackHost(address));
  })) {
    throw new Error("The DID document contains a PDS endpoint that resolves to a non-public address.");
  }
  const safeAddresses = addresses.map(({ address, family }) => ({ address, family: family || isIP(address) }));
  if (checkedHosts.size >= MAX_CHECKED_HOSTS) {
    for (const [key, entry] of checkedHosts) if (entry.expiresAt <= Date.now()) checkedHosts.delete(key);
    if (checkedHosts.size >= MAX_CHECKED_HOSTS) checkedHosts.delete(checkedHosts.keys().next().value as string);
  }
  checkedHosts.set(cacheKey, { expiresAt: Date.now() + SAFE_DNS_TTL_MS, addresses: safeAddresses });
  return { url, addresses: safeAddresses };
}

function pinnedAgent(url: URL, addresses: Array<{ address: string; family: number }>): Agent {
  const key = `${url.origin}|${addresses.map(({ address, family }) => `${family}:${address}`).join(",")}`;
  const existing = pinnedAgents.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.agent;
  if (existing) retirePinnedAgent(key, existing);
  while (pinnedAgents.size >= MAX_PINNED_AGENTS) {
    const oldest = pinnedAgents.entries().next().value as [string, { agent: Agent; expiresAt: number; timer: ReturnType<typeof setTimeout> }] | undefined;
    if (!oldest) break;
    retirePinnedAgent(oldest[0], oldest[1]);
  }
  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  const agent = new Agent({
    connect: { lookup: lookupPinned },
    connectTimeout: 10_000,
    // Every request carries its own deadline (`safeFetch`), which is the one that applies: a fixed limit here would end a
    // request its caller gave longer, as an error the operator's journal retries under the workspace lock.
    headersTimeout: 0,
    bodyTimeout: 0,
    autoSelectFamily: true,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000,
  });
  const expiresAt = Date.now() + SAFE_DNS_TTL_MS;
  const timer = setTimeout(() => {
    const current = pinnedAgents.get(key);
    if (current?.agent === agent) retirePinnedAgent(key, current);
  }, SAFE_DNS_TTL_MS);
  timer.unref?.();
  pinnedAgents.set(key, { agent, expiresAt, timer });
  return agent;
}

function retirePinnedAgent(key: string, entry: { agent: Agent; timer: ReturnType<typeof setTimeout> }): void {
  if (pinnedAgents.get(key)?.agent === entry.agent) pinnedAgents.delete(key);
  clearTimeout(entry.timer);
  void entry.agent.close().catch(() => {});
}

function makeNonPublicAddressList(): BlockList {
  const blocked = new BlockList();
  for (const [address, prefix, family] of [
    ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
    ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
    ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
    ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
    ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"], ["192.88.99.0", 24, "ipv4"],
    ["::", 96, "ipv6"], ["::ffff:0:0", 96, "ipv6"], ["64:ff9b::", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"],
    ["100::", 64, "ipv6"], ["2001::", 32, "ipv6"], ["2001:2::", 48, "ipv6"], ["2001:db8::", 32, "ipv6"],
    ["2002::", 16, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
  ] as const) blocked.addSubnet(address, prefix, family);
  return blocked;
}
