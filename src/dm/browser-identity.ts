import { readUpstreamJson } from "@/lib/bounded-json";
import { isDid } from "@/protocol/keys";

export type BrowserIdentityConfig = { plcUrl: string; loopback: boolean };

const DID_DOCUMENT_TTL_MS = 10 * 60 * 1000;
const MAX_DID_DOCUMENT_BYTES = 256 * 1024;

type DidDocument = {
  id?: unknown;
  service?: Array<{ id?: unknown; serviceEndpoint?: unknown }>;
  alsoKnownAs?: unknown;
};

type CacheEntry = { document: DidDocument; expiresAt: number };

const documentCache = new Map<string, CacheEntry>();

export function clearBrowserIdentityCache(): void {
  documentCache.clear();
}

/**
 * Resolves the account's PDS endpoint from its DID document (`#atproto_pds`),
 * for `did:plc` through the configured PLC directory and for `did:web` through
 * `/.well-known/did.json`. Endpoints must be `https:`, or `http:` on a loopback
 * host while the app itself runs on loopback development. Every fetch blocks
 * redirects and reads a bounded body.
 */
export async function resolvePds(did: string, config: BrowserIdentityConfig): Promise<string> {
  const document = await resolveDidDocument(did, config);
  const service = findService(document, did, "#atproto_pds");
  if (typeof service.serviceEndpoint !== "string" || service.serviceEndpoint.length === 0) {
    throw new Error("The DID document has no usable #atproto_pds service endpoint.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(service.serviceEndpoint);
  } catch {
    throw new Error("The DID document contains an invalid PDS endpoint.");
  }
  assertSafeHttpUrl(endpoint, config.loopback);
  return endpoint.origin;
}

/** The account's handle from `alsoKnownAs` (`at://handle`), for display only. */
export async function resolveHandle(did: string, config: BrowserIdentityConfig): Promise<string | null> {
  const document = await resolveDidDocument(did, config);
  if (!Array.isArray(document.alsoKnownAs)) return null;
  for (const entry of document.alsoKnownAs) {
    if (typeof entry !== "string" || !entry.startsWith("at://")) continue;
    const handle = entry.slice("at://".length);
    if (handle.length > 0 && handle.length <= 253 && /^[A-Za-z0-9.-]+$/.test(handle)) return handle;
  }
  return null;
}

async function resolveDidDocument(did: string, config: BrowserIdentityConfig): Promise<DidDocument> {
  if (!isDid(did)) throw new TypeError("Invalid DID.");
  const now = Date.now();
  const cached = documentCache.get(did);
  if (cached && cached.expiresAt > now) return cached.document;
  const url = didDocumentUrl(did, config);
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/did+ld+json,application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Could not resolve ${did} (${response.status}).`);
  }
  const document = await readUpstreamJson<DidDocument>(response, MAX_DID_DOCUMENT_BYTES);
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("The DID document is not a JSON object.");
  }
  if (typeof document.id === "string" && document.id !== did) {
    throw new Error("The DID document does not match the requested DID.");
  }
  documentCache.set(did, { document, expiresAt: now + DID_DOCUMENT_TTL_MS });
  return document;
}

function didDocumentUrl(did: string, config: BrowserIdentityConfig): URL {
  if (did.startsWith("did:plc:")) {
    let base: URL;
    try {
      base = new URL(config.plcUrl);
    } catch {
      throw new Error("The PLC directory URL is invalid.");
    }
    assertSafeHttpUrl(base, config.loopback);
    const url = new URL(`${base.origin}${base.pathname.replace(/\/$/, "")}/${did}`);
    assertSafeHttpUrl(url, config.loopback);
    return url;
  }
  if (did.startsWith("did:web:")) {
    const methodSpecificId = did.slice("did:web:".length);
    const segments = methodSpecificId.split(":").map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new Error("The did:web identifier is malformed.");
      }
    });
    if (segments.length !== 1) throw new Error("did:web identifiers with path segments are not supported.");
    const host = segments[0]!;
    if (host.length === 0 || host !== host.trim()) throw new Error("The did:web host is malformed.");
    let probe: URL;
    try {
      probe = new URL(`https://${host}/.well-known/did.json`);
    } catch {
      throw new Error("The did:web host is malformed.");
    }
    if (probe.host !== host || probe.username || probe.password || probe.pathname !== "/.well-known/did.json") {
      throw new Error("The did:web host is malformed.");
    }
    const useHttp = config.loopback && isLoopbackHostname(probe.hostname);
    const url = new URL(`${useHttp ? "http" : "https"}://${host}/.well-known/did.json`);
    assertSafeHttpUrl(url, config.loopback);
    return url;
  }
  throw new Error("Only did:plc and did:web identities can be resolved.");
}

function findService(document: DidDocument, did: string, fragment: string): { serviceEndpoint?: unknown } {
  const services = Array.isArray(document.service) ? document.service : [];
  const service = services.find((entry) => entry.id === fragment || entry.id === `${did}${fragment}`);
  if (!service) throw new Error(`The DID document has no ${fragment} service entry.`);
  return service;
}

function assertSafeHttpUrl(url: URL, loopback: boolean): void {
  const loopbackTarget = isLoopbackHostname(url.hostname);
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("The identity endpoint URL contains unsafe components.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && loopbackTarget)) {
    throw new Error("Identity endpoints must use HTTPS outside loopback development.");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
