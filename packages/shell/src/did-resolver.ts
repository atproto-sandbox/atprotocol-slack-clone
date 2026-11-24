import { readUpstreamJson } from "@flock/protocol/bounded-json";
import { DID_DOCUMENT_TTL_MS, kemKeyFromDidDocument } from "@flock/protocol/atproto/kem-key";
import { generateSpaceKey, type SpaceKey } from "@flock/protocol/atproto/space-key";
import type { SpaceCredentialDeps } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { isDid } from "@flock/protocol/keys";

const MAX_DID_DOCUMENT_BYTES = 256 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 1_000;

export class UnsafeBrowserEndpointUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBrowserEndpointUrlError";
  }
}

export class DidResolutionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DidResolutionError";
  }
}

type DidDocument = {
  id?: unknown;
  service?: unknown;
  verificationMethod?: unknown;
};

type IPv4Cidr = { net: number; mask: number };
type IPv6Cidr = { net: bigint; shift: bigint };

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function makeIpv4Cidr(addr: string, prefix: number): IPv4Cidr {
  const ip = parseIpv4(addr);
  if (ip === null) throw new Error(`Invalid IPv4 CIDR ${addr}/${prefix}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { net: (ip & mask) >>> 0, mask };
}

function parseIpv6(rawHost: string): bigint | null {
  if (!rawHost.includes(":")) return null;
  const host = rawHost.toLowerCase();
  // Strip zone id if somehow present (rejects scope identifiers safely by failing parse or rejecting before)
  if (host.includes("%")) return null;

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const tokens = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const ipv4 = parseIpv4(tok);
        if (ipv4 === null) return null;
        groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        groups.push(parseInt(tok, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (doubleColonParts.length === 2) {
    const left = parseSide(doubleColonParts[0]!);
    const right = parseSide(doubleColonParts[1]!);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const parsed = parseSide(host);
    if (!parsed || parsed.length !== 8) return null;
    groups = parsed;
  }

  let value = 0n;
  for (const g of groups) {
    value = (value << 16n) | BigInt(g);
  }
  return value;
}

function makeIpv6Cidr(addr: string, prefix: number): IPv6Cidr {
  const ip = parseIpv6(addr);
  if (ip === null) throw new Error(`Invalid IPv6 CIDR ${addr}/${prefix}`);
  const shift = BigInt(128 - prefix);
  return { net: ip >> shift, shift };
}

// Canonical non-public CIDR denylist matching packages/net/src/safe-fetch.ts:344-357.
const NON_PUBLIC_IPV4_CIDRS: readonly IPv4Cidr[] = [
  makeIpv4Cidr("0.0.0.0", 8),
  makeIpv4Cidr("10.0.0.0", 8),
  makeIpv4Cidr("100.64.0.0", 10),
  makeIpv4Cidr("127.0.0.0", 8),
  makeIpv4Cidr("169.254.0.0", 16),
  makeIpv4Cidr("172.16.0.0", 12),
  makeIpv4Cidr("192.0.0.0", 24),
  makeIpv4Cidr("192.0.2.0", 24),
  makeIpv4Cidr("192.88.99.0", 24),
  makeIpv4Cidr("192.168.0.0", 16),
  makeIpv4Cidr("198.18.0.0", 15),
  makeIpv4Cidr("198.51.100.0", 24),
  makeIpv4Cidr("203.0.113.0", 24),
  makeIpv4Cidr("224.0.0.0", 4),
  makeIpv4Cidr("240.0.0.0", 4),
];

const IPV4_LOOPBACK_CIDR = makeIpv4Cidr("127.0.0.0", 8);

const NON_PUBLIC_IPV6_CIDRS: readonly IPv6Cidr[] = [
  makeIpv6Cidr("::", 96),
  makeIpv6Cidr("::ffff:0:0", 96),
  makeIpv6Cidr("64:ff9b::", 96),
  makeIpv6Cidr("64:ff9b:1::", 48),
  makeIpv6Cidr("100::", 64),
  makeIpv6Cidr("2001::", 32),
  makeIpv6Cidr("2001:2::", 48),
  makeIpv6Cidr("2001:db8::", 32),
  makeIpv6Cidr("2002::", 16),
  makeIpv6Cidr("fc00::", 7),
  makeIpv6Cidr("fe80::", 10),
  makeIpv6Cidr("ff00::", 8),
];

const IPV6_LOOPBACK = 1n;
const IPV6_MAPPED_LOOPBACK_CIDR = makeIpv6Cidr("::ffff:127.0.0.0", 104);

function matchesIpv4(ip: number, cidr: IPv4Cidr): boolean {
  return ((ip & cidr.mask) >>> 0) === cidr.net;
}

function matchesIpv6(ip: bigint, cidr: IPv6Cidr): boolean {
  return (ip >> cidr.shift) === cidr.net;
}

export function isExactLoopbackHost(rawHostname: string): boolean {
  const host = rawHostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return matchesIpv4(ipv4, IPV4_LOOPBACK_CIDR);
  const ipv6 = parseIpv6(host);
  if (ipv6 !== null) {
    return ipv6 === IPV6_LOOPBACK || matchesIpv6(ipv6, IPV6_MAPPED_LOOPBACK_CIDR);
  }
  return false;
}

/**
 * Strict browser endpoint URL guard matching the complete canonical non-public CIDR denylist
 * in `packages/net/src/safe-fetch.ts:344-357`:
 * - Forbids embedded credentials, query strings, and fragments in all modes.
 * - Always rejects `*.local`, `*.internal`, and all non-public IPv4/IPv6 ranges (including NAT64,
 *   6to4, Teredo, IPv4-compatible, IPv4-mapped) even when `loopbackAllowed === true`.
 * - When `loopbackAllowed === true`, permits HTTP and local addressing strictly for exact loopback
 *   hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`).
 * - When `loopbackAllowed === false`, rejects loopback hosts as well and requires HTTPS everywhere.
 */
export function assertSafeBrowserEndpointUrl(rawUrl: string | URL, loopbackAllowed: boolean): URL {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new UnsafeBrowserEndpointUrlError("Endpoint URL must be an absolute URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeBrowserEndpointUrlError(`Unsupported endpoint protocol: ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new UnsafeBrowserEndpointUrlError(
      "Endpoint URL must not contain embedded credentials, query strings, or fragments.",
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (!host) {
    throw new UnsafeBrowserEndpointUrlError("Endpoint URL must have a non-empty hostname.");
  }

  // Reject local hostnames in ALL modes.
  if (host === "local" || host.endsWith(".local") || host === "internal" || host.endsWith(".internal")) {
    throw new UnsafeBrowserEndpointUrlError(`Local hostname is forbidden: ${host}`);
  }

  const isLoopback = isExactLoopbackHost(host);
  if (isLoopback) {
    if (!loopbackAllowed) {
      throw new UnsafeBrowserEndpointUrlError(`Loopback endpoint is forbidden outside loopback mode: ${host}`);
    }
    return url;
  }

  // Non-loopback endpoints MUST use HTTPS.
  if (url.protocol !== "https:") {
    throw new UnsafeBrowserEndpointUrlError(`Non-loopback endpoint must use HTTPS: ${url.origin}`);
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) {
    for (const cidr of NON_PUBLIC_IPV4_CIDRS) {
      if (matchesIpv4(ipv4, cidr)) {
        throw new UnsafeBrowserEndpointUrlError(`Non-public IPv4 address is forbidden: ${host}`);
      }
    }
    return url;
  }

  if (url.hostname.startsWith("[") || host.includes(":")) {
    const ipv6 = parseIpv6(host);
    if (ipv6 === null) {
      throw new UnsafeBrowserEndpointUrlError(`Malformed IPv6 address: ${host}`);
    }
    for (const cidr of NON_PUBLIC_IPV6_CIDRS) {
      if (matchesIpv6(ipv6, cidr)) {
        throw new UnsafeBrowserEndpointUrlError(`Non-public IPv6 address is forbidden: ${host}`);
      }
    }
    return url;
  }

  return url;
}

function didDocumentUrl(did: string, plcOrigin: string, loopbackAllowed: boolean): URL {
  if (!isDid(did)) {
    throw new DidResolutionError(`Invalid DID: ${did}`);
  }
  if (did.startsWith("did:plc:")) {
    const url = new URL(`/${encodeURIComponent(did)}`, plcOrigin);
    return assertSafeBrowserEndpointUrl(url, loopbackAllowed);
  }
  if (did.startsWith("did:web:")) {
    const methodSpecific = did.slice("did:web:".length);
    const parts = methodSpecific.split(":");
    const rawHost = parts[0];
    if (!rawHost) {
      throw new DidResolutionError(`Malformed did:web: ${did}`);
    }
    let decodedHost: string;
    try {
      decodedHost = decodeURIComponent(rawHost);
    } catch {
      throw new DidResolutionError(`Malformed percent-encoding in did:web: ${did}`);
    }
    if (/[/?#\\@\s]/.test(decodedHost)) {
      throw new DidResolutionError(`Invalid host in did:web: ${did}`);
    }
    const hostOnly = decodedHost.replace(/:\d+$/, "");
    const scheme = loopbackAllowed && isExactLoopbackHost(hostOnly) ? "http" : "https";
    const pathSegments = parts.slice(1).map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        throw new DidResolutionError(`Malformed path segment in did:web: ${did}`);
      }
    });
    const path = pathSegments.length > 0 ? `/${pathSegments.join("/")}/did.json` : "/.well-known/did.json";
    return assertSafeBrowserEndpointUrl(`${scheme}://${decodedHost}${path}`, loopbackAllowed);
  }
  throw new DidResolutionError(`Unsupported DID method: ${did}`);
}

function extractPdsEndpoint(did: string, doc: DidDocument, loopbackAllowed: boolean): string {
  const services = Array.isArray(doc.service) ? doc.service : [];
  const pdsService = services.find((entry): entry is { id: string; type?: unknown; serviceEndpoint?: unknown } => {
    if (typeof entry !== "object" || entry === null) return false;
    const svc = entry as { id?: unknown; type?: unknown };
    const idMatches = svc.id === "#atproto_pds" || svc.id === `${did}#atproto_pds`;
    return idMatches && (svc.type === undefined || svc.type === "AtprotoPersonalDataServer");
  });
  if (!pdsService || typeof pdsService.serviceEndpoint !== "string") {
    throw new DidResolutionError(`${did} DID document has no #atproto_pds service endpoint.`);
  }
  const safe = assertSafeBrowserEndpointUrl(pdsService.serviceEndpoint, loopbackAllowed);
  if (safe.pathname !== "/" && safe.pathname !== "") {
    throw new UnsafeBrowserEndpointUrlError(`PDS service endpoint must be a bare origin: ${pdsService.serviceEndpoint}`);
  }
  return safe.origin;
}

export type BrowserDidResolver = {
  resolveDocument(did: string, forceRefresh?: boolean): Promise<DidDocument>;
  resolvePds(did: string, forceRefresh?: boolean): Promise<string>;
  resolveKemKey(did: string, forceRefresh: boolean): Promise<string>;
};

export type BrowserDidResolverOptions = {
  plcUrl: string;
  loopbackAllowed: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

export function createBrowserDidResolver(options: BrowserDidResolverOptions): BrowserDidResolver {
  const plcOrigin = assertSafeBrowserEndpointUrl(options.plcUrl, options.loopbackAllowed).origin;
  const fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DID_DOCUMENT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const cache = new Map<string, { doc: DidDocument; expiresAt: number }>();

  const resolveDocument = async (did: string, forceRefresh = false): Promise<DidDocument> => {
    const cached = cache.get(did);
    if (!forceRefresh && cached && cached.expiresAt > now()) {
      return cached.doc;
    }
    const url = didDocumentUrl(did, plcOrigin, options.loopbackAllowed);
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/did+ld+json, application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DidResolutionError(`DID document fetch failed for ${did} (${response.status}).`, response.status);
    }
    const doc = await readUpstreamJson<DidDocument>(response, MAX_DID_DOCUMENT_BYTES);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new DidResolutionError(`DID document for ${did} is not a JSON object.`);
    }
    if (doc.id !== did) {
      throw new DidResolutionError(`DID document id mismatch for ${did} (got ${String(doc.id)}).`);
    }
    cache.delete(did);
    cache.set(did, { doc, expiresAt: now() + ttlMs });
    while (cache.size > maxEntries) {
      cache.delete(cache.keys().next().value!);
    }
    return doc;
  };

  return {
    resolveDocument,
    async resolvePds(did: string, forceRefresh = false): Promise<string> {
      const doc = await resolveDocument(did, forceRefresh);
      return extractPdsEndpoint(did, doc, options.loopbackAllowed);
    },
    async resolveKemKey(did: string, forceRefresh: boolean): Promise<string> {
      const doc = await resolveDocument(did, forceRefresh);
      return kemKeyFromDidDocument(did, doc);
    },
  };
}

export type DeskAuthSession = {
  readonly did: string;
  fetchHandler(path: string, init: RequestInit): Promise<Response>;
};

export type BrowserSpaceCredentialDepsConfig = {
  plcUrl: string;
  loopbackAllowed: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  generateKey?: () => Promise<SpaceKey>;
  didResolver?: BrowserDidResolver;
};

/**
 * Factory returning `SpaceCredentialDeps & { readonly did: string }` — structurally assignable to
 * `@flock/reader/independent`'s `IndependentDeps`, with zero package dependency on `@flock/reader`.
 */
export function createBrowserSpaceCredentialDeps(
  session: DeskAuthSession,
  config: BrowserSpaceCredentialDepsConfig,
): SpaceCredentialDeps & { readonly did: string } {
  const fetchFn = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolver =
    config.didResolver ??
    createBrowserDidResolver({
      plcUrl: config.plcUrl,
      loopbackAllowed: config.loopbackAllowed,
      fetchImpl: fetchFn,
      ...(config.now ? { now: config.now } : {}),
    });

  const memberClient = new AtprotoClient((path, init) => session.fetchHandler(path, init));

  const fetchEndpoint = async (request: Request): Promise<Response> => {
    const parsed = new URL(request.url);
    assertSafeBrowserEndpointUrl(parsed.origin, config.loopbackAllowed);
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
      throw new UnsafeBrowserEndpointUrlError("Endpoint request URL must not contain credentials or fragments.");
    }
    return fetchFn(new Request(request, { redirect: "error" }));
  };

  return {
    did: session.did,
    memberClient,
    resolvePds: (did, forceRefresh) => resolver.resolvePds(did, forceRefresh),
    resolveKemKey: (did, forceRefresh) => resolver.resolveKemKey(did, forceRefresh),
    fetchEndpoint,
    generateKey: config.generateKey ?? generateSpaceKey,
    ...(config.now ? { now: config.now } : {}),
  };
}
