import { P256_JWT_ALG, formatDidKey, multibaseToBytes } from "@atproto/crypto";
import { SpaceMacError, isP256DidKey } from "@atproto/space";

/**
 * How long what a DID document said (its PDS host, its `#atproto_kem` key) is trusted before it is read again, wherever this
 * app holds it: the browser's documents, the server's KEM keys and the engine's store. A failed MAC reads the key again at once.
 */
export const DID_DOCUMENT_TTL_MS = 10 * 60 * 1000;

export class KemKeyError extends Error {
  constructor(did: string, reason: string) {
    super(`${did} has no usable #atproto_kem key: ${reason}. A syncer cannot read its space repos without one.`);
    this.name = "KemKeyError";
  }
}

/**
 * The `did:key` of the account's `#atproto_kem` verification method, the key a syncer derives a shared secret
 * against to request a MAC from the account's repo host. Pure, so the server (IdResolver) and the browser
 * (its own DID document fetch) read the key the same way. A PLC-backed document may carry the key either as a
 * `Multikey` (the multibase already includes the curve prefix, so it is the `did:key` suffix) or as the older
 * `EcdsaSecp256r1VerificationKey2019` (the multibase is the bare compressed point).
 */
export function kemKeyFromDidDocument(did: string, document: { verificationMethod?: unknown }): string {
  const methods: unknown[] = Array.isArray(document.verificationMethod) ? document.verificationMethod : [];
  const method = methods.find((entry): entry is { id: string; type?: unknown; publicKeyMultibase?: unknown } =>
    typeof entry === "object" && entry !== null && "id" in entry && (entry.id === `${did}#atproto_kem` || entry.id === "#atproto_kem"));
  if (!method) throw new KemKeyError(did, "the DID document lists no #atproto_kem verification method");
  if (typeof method.publicKeyMultibase !== "string") throw new KemKeyError(did, "the method has no publicKeyMultibase");
  let didKey: string;
  try {
    if (method.type === "Multikey") didKey = `did:key:${method.publicKeyMultibase}`;
    else if (method.type === "EcdsaSecp256r1VerificationKey2019") didKey = formatDidKey(P256_JWT_ALG, multibaseToBytes(method.publicKeyMultibase));
    else throw new KemKeyError(did, `the method type ${String(method.type)} is not a P-256 key type`);
  } catch (error) {
    if (error instanceof KemKeyError) throw error;
    throw new KemKeyError(did, "the key could not be decoded");
  }
  if (!isP256DidKey(didKey)) throw new KemKeyError(did, "the key is not a P-256 key");
  return didKey;
}

/**
 * Whether a read failed because the author's repo cannot be authenticated: the account publishes no usable `#atproto_kem`
 * key, or the host's MAC does not verify. Such a repo is set aside; it must not take down a read of other people's data.
 */
export function isUnverifiableRepo(error: unknown): boolean {
  return error instanceof KemKeyError || error instanceof SpaceMacError;
}

export type KemKeyResolver = (did: string, forceRefresh: boolean) => Promise<string>;

/**
 * Remembers resolved KEM keys so a MAC read does not cost a DID-document fetch. A key can rotate, so the remembered key
 * expires, and the caller refreshes it explicitly when a MAC fails to verify (`forceRefresh`). The cache is bounded: the
 * oldest entry goes first.
 */
export function cacheKemKeys(
  load: KemKeyResolver,
  options: { ttlMs: number; maxEntries: number; now?: () => number },
): KemKeyResolver {
  const now = options.now ?? Date.now;
  const keys = new Map<string, { key: string; expiresAt: number }>();
  return async (did, forceRefresh) => {
    const cached = keys.get(did);
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.key;
    const key = await load(did, forceRefresh);
    keys.delete(did);
    keys.set(did, { key, expiresAt: now() + options.ttlMs });
    while (keys.size > options.maxEntries) keys.delete(keys.keys().next().value!);
    return key;
  };
}
