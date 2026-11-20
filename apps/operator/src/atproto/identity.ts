import { IdResolver } from "@atproto/identity";
import { UpstreamResponseTooLargeError } from "@flock/protocol/bounded-json";
import { cacheKemKeys, DID_DOCUMENT_TTL_MS, kemKeyFromDidDocument } from "@flock/protocol/atproto/kem-key";
import { getConfig } from "@flock/deployment/config";
import { assertSafeEndpoint, isLoopbackHost, safeFetch } from "@flock/net/safe-fetch";

let resolver: IdResolver | undefined;
const MAX_IDENTITY_RESOLVER_RESPONSE_BYTES = 256 * 1024;

/** The operator reaches its own loopback hosts only in loopback development (or the acceptance suites), as the network rule says. */
const loopbackDevelopment = () => (process.env.NODE_ENV !== "production" || process.env.ATPROTO_ACCEPTANCE_TEST === "true") &&
  isLoopbackHost(getConfig().operatorUrl.hostname);

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

/**
 * The account's `#atproto` signing did:key, cached for ten minutes and bypassed on `forceRefresh` after key rotation.
 */
export const resolveSigningKey = cacheKemKeys(
  (did, forceRefresh) => getIdResolver().did.resolveAtprotoKey(did, forceRefresh),
  { ttlMs: DID_DOCUMENT_TTL_MS, maxEntries: MAX_CACHED_KEM_KEYS },
);

export async function assertSafePdsEndpoint(endpoint: string): Promise<void> {
  await assertSafeEndpoint(endpoint, loopbackDevelopment);
}

/** Every request the operator sends to a host someone else named goes through here (`@flock/net/safe-fetch`). */
export const fetchValidatedEndpoint = safeFetch(loopbackDevelopment);

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
