import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup } from "node:dns/promises";
import { IdResolver } from "@atproto/identity";
import { Agent, fetch as undiciFetch } from "undici";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { cacheKemKeys, DID_DOCUMENT_TTL_MS, kemKeyFromDidDocument } from "./kem-key";
import { getConfig } from "@/lib/config";

let resolver: IdResolver | undefined;
const SAFE_DNS_TTL_MS = 30_000;
const checkedPdsHosts = new Map<string, { expiresAt: number; addresses: Array<{ address: string; family: number }> }>();
const pinnedPdsAgents = new Map<string, { agent: Agent; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
const MAX_PINNED_PDS_AGENTS = 128;
const MAX_IDENTITY_RESOLVER_RESPONSE_BYTES = 256 * 1024;
const nonPublicAddresses = makeNonPublicAddressList();

export function getIdResolver(): IdResolver {
  const plcUrl = getConfig().plcDirectoryUrl;
  const localTestDirectory = process.env.NODE_ENV === "test" && plcUrl.protocol === "http:" && isLoopbackHost(plcUrl.hostname);
  resolver ??= new IdResolver({
    plcUrl: plcUrl.toString(),
    // The pinned multi-PDS fixture owns a loopback PLC directory. Production
    // identity and PDS lookups share the app's DNS-pinned, redirect-blocking
    // fetch path.
    fetch: localTestDirectory ? globalThis.fetch : fetchIdResolverEndpoint,
  });
  return resolver;
}

export async function resolvePds(did: string): Promise<string> {
  const { pds } = await getIdResolver().did.resolveAtprotoData(did);
  await assertSafePdsEndpoint(pds);
  return pds;
}

const MAX_CACHED_KEM_KEYS = 1_024;

/**
 * The account's `#atproto_kem` did:key, remembered for ten minutes (the browser keeps DID documents as long). `forceRefresh`
 * resolves it again, for a MAC that failed after a key rotation.
 */
export const resolveKemKey = cacheKemKeys(async (did, forceRefresh) => {
  const document = await getIdResolver().did.resolve(did, forceRefresh);
  if (!document) throw new Error(`Could not resolve ${did}.`);
  return kemKeyFromDidDocument(did, document);
}, { ttlMs: DID_DOCUMENT_TTL_MS, maxEntries: MAX_CACHED_KEM_KEYS });

export async function assertSafePdsEndpoint(endpoint: string): Promise<void> {
  await resolveSafePdsEndpoint(endpoint);
}

export async function fetchValidatedEndpoint(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const requestUrl = new URL(request.url);
  if (requestUrl.username || requestUrl.password || requestUrl.hash) {
    throw new Error("The request contains an unsafe remote endpoint.");
  }
  const endpoint = await resolveSafePdsEndpoint(requestUrl.origin);
  const dispatcher = getPinnedAgent(endpoint.url, endpoint.addresses);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const response = await undiciFetch(request.url, {
    method: request.method,
    headers: request.headers as unknown as HeadersInit,
    ...(body ? { body } : {}),
    redirect: "error",
    signal: request.signal,
    dispatcher,
  });
  return new Response(response.body as unknown as BodyInit, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers as unknown as HeadersInit,
  });
}

export async function fetchIdResolverEndpoint(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetchValidatedEndpoint(input, init);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(MAX_IDENTITY_RESOLVER_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseTooLargeError(MAX_IDENTITY_RESOLVER_RESPONSE_BYTES);
  }
  if (!response.body) return response;

  let received = 0;
  const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_IDENTITY_RESOLVER_RESPONSE_BYTES) {
        controller.error(new UpstreamResponseTooLargeError(MAX_IDENTITY_RESOLVER_RESPONSE_BYTES));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function resolveSafePdsEndpoint(endpoint: string): Promise<{
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}> {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("The DID document contains an invalid PDS endpoint."); }
  const appUrl = getConfig().appUrl;
  const localDevelopment = (process.env.NODE_ENV !== "production" || process.env.ATPROTO_ACCEPTANCE_TEST === "true") &&
    isLoopbackHost(appUrl.hostname);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localTarget = isLoopbackHost(hostname);
  if ((url.protocol !== "https:" && !(localDevelopment && localTarget && url.protocol === "http:")) ||
      !hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("The DID document contains an unsafe PDS endpoint.");
  }
  if (!localDevelopment && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
    throw new Error("The DID document contains a non-public PDS endpoint.");
  }

  const cacheKey = `${hostname}:${url.port}`;
  const cached = checkedPdsHosts.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { url, addresses: cached.addresses };
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => {
    const family = isIP(address);
    return family === 0 || nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6") &&
      !(localDevelopment && isLoopbackHost(address));
  })) {
    throw new Error("The DID document contains a PDS endpoint that resolves to a non-public address.");
  }
  const safeAddresses = addresses.map(({ address, family }) => ({ address, family: family || isIP(address) }));
  if (checkedPdsHosts.size >= 512) {
    const expired = [...checkedPdsHosts].filter(([, entry]) => entry.expiresAt <= Date.now()).map(([key]) => key);
    for (const key of expired) checkedPdsHosts.delete(key);
    if (checkedPdsHosts.size >= 512) checkedPdsHosts.delete(checkedPdsHosts.keys().next().value as string);
  }
  checkedPdsHosts.set(cacheKey, { expiresAt: Date.now() + SAFE_DNS_TTL_MS, addresses: safeAddresses });
  return { url, addresses: safeAddresses };
}

function getPinnedAgent(url: URL, addresses: Array<{ address: string; family: number }>): Agent {
  const key = `${url.origin}|${addresses.map(({ address, family }) => `${family}:${address}`).join(",")}`;
  const existing = pinnedPdsAgents.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.agent;
  if (existing) retirePinnedAgent(key, existing);
  while (pinnedPdsAgents.size >= MAX_PINNED_PDS_AGENTS) {
    const oldest = pinnedPdsAgents.entries().next().value as [string, { agent: Agent; expiresAt: number; timer: ReturnType<typeof setTimeout> }] | undefined;
    if (!oldest) break;
    retirePinnedAgent(oldest[0], oldest[1]);
  }

  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  const agent = new Agent({
    connect: { lookup: lookupPinned },
    connectTimeout: 10_000,
    autoSelectFamily: true,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000,
  });
  const expiresAt = Date.now() + SAFE_DNS_TTL_MS;
  const timer = setTimeout(() => {
    const current = pinnedPdsAgents.get(key);
    if (current?.agent === agent) retirePinnedAgent(key, current);
  }, SAFE_DNS_TTL_MS);
  timer.unref?.();
  pinnedPdsAgents.set(key, { agent, expiresAt, timer });
  return agent;
}

function retirePinnedAgent(key: string, entry: { agent: Agent; timer: ReturnType<typeof setTimeout> }): void {
  if (pinnedPdsAgents.get(key)?.agent === entry.agent) pinnedPdsAgents.delete(key);
  clearTimeout(entry.timer);
  void entry.agent.close().catch(() => {});
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".localhost")) return true;
  const parts = normalized.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 127;
}

function makeNonPublicAddressList(): BlockList {
  const blocked = new BlockList();
  for (const [address, prefix, family] of [
    ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
    ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
    ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
    ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
    ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"], ["::", 128, "ipv6"],
    ["::1", 128, "ipv6"], ["::ffff:0:0", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"],
    ["100::", 64, "ipv6"], ["2001:db8::", 32, "ipv6"], ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
  ] as const) blocked.addSubnet(address, prefix, family);
  return blocked;
}
