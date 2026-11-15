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
    ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"], ["::", 128, "ipv6"],
    ["::1", 128, "ipv6"], ["::ffff:0:0", 96, "ipv6"], ["64:ff9b:1::", 48, "ipv6"],
    ["100::", 64, "ipv6"], ["2001:db8::", 32, "ipv6"], ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
  ] as const) blocked.addSubnet(address, prefix, family);
  return blocked;
}
