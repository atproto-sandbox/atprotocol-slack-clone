import {
  formatDidKey,
  multibaseToBytes,
  P256_JWT_ALG,
  parseDidKey,
  SECP256K1_JWT_ALG,
  type Keypair,
} from "@atproto/crypto";
import { cidForLex } from "@atproto/lex-cbor";
import type { LexValue } from "@atproto/lex-data";
import {
  assureValidOp,
  assureValidSig,
  didForCreateOp,
  formatAtprotoOp,
  signOperation,
  tombstoneOp,
  type CompatibleOpOrTombstone,
  type Operation,
  type UnsignedOperation,
} from "@did-plc/lib";
import { boundedSafeFetch, BOUNDED_FETCH_PROFILES, type SafeFetch } from "@flock/net/safe-fetch";
import { kemKeyFromDidDocument } from "@flock/protocol/atproto/kem-key";
import { readUpstreamJson } from "@flock/protocol/bounded-json";
import { isDid } from "@flock/protocol/keys";
import { CID } from "multiformats/cid";
import type { GroupHostConfig } from "./config";

export function plcOpRotationKeys(op: CompatibleOpOrTombstone | null | undefined): string[] {
  if (!op || typeof op !== "object" || op.type === "plc_tombstone") return [];
  if (op.type === "plc_operation") {
    return Array.isArray(op.rotationKeys) ? op.rotationKeys.filter((k): k is string => typeof k === "string") : [];
  }
  if (op.type === "create") {
    return [op.recoveryKey, op.signingKey].filter((k): k is string => typeof k === "string");
  }
  return [];
}

export async function plcCidForOp(op: CompatibleOpOrTombstone): Promise<CID> {
  const cborCid = await cidForLex(op as unknown as LexValue);
  return CID.parse(cborCid.toString());
}

export class GroupHostHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "GroupHostHttpError";
  }
}

export type DidDocumentShape = {
  id: string;
  alsoKnownAs?: string[];
  verificationMethod?: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase?: string;
  }>;
  service?: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
};

export function isSupportedPlcRotationDidKey(didKey: unknown): didKey is string {
  if (typeof didKey !== "string" || !didKey.startsWith("did:key:")) return false;
  try {
    const parsed = parseDidKey(didKey);
    return parsed.jwtAlg === "ES256" || parsed.jwtAlg === "ES256K";
  } catch {
    return false;
  }
}

export function normalizeOriginUrl(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (parsed.hostname.toLowerCase() === "localhost" && parsed.protocol === "http:") {
    parsed.hostname = "127.0.0.1";
  }
  return parsed.origin;
}

export async function createGroupGenesisPlcOp(params: {
  signingKey: Keypair;
  kemKey: Keypair;
  rotationKey: Keypair;
  handle: string;
  pdsEndpoint: string;
}): Promise<{ did: string; genesisOp: Operation }> {
  const baseUnsigned = formatAtprotoOp({
    signingKey: params.signingKey.did(),
    handle: params.handle,
    pds: params.pdsEndpoint,
    rotationKeys: [params.rotationKey.did()],
    prev: null,
  });
  const unsignedWithKem: UnsignedOperation = {
    ...baseUnsigned,
    verificationMethods: {
      ...baseUnsigned.verificationMethods,
      atproto_kem: params.kemKey.did(),
    },
  };
  const genesisOp = await signOperation(unsignedWithKem, params.rotationKey);
  const did = await didForCreateOp(genesisOp);
  return { did, genesisOp };
}

export function didWebToUrl(didWeb: string, allowLoopback: boolean): string {
  if (!didWeb.startsWith("did:web:")) {
    throw new GroupHostHttpError(400, "InvalidDid", `Not a did:web identifier: ${didWeb}`);
  }
  const hostPart = decodeURIComponent(didWeb.slice("did:web:".length));
  if (hostPart.includes("/") || hostPart.trim() === "") {
    throw new GroupHostHttpError(400, "InvalidDid", `Unsupported path-based did:web: ${didWeb}`);
  }
  const bareHost = hostPart.split(":")[0]!.toLowerCase();
  const isLocal = bareHost === "localhost" || bareHost === "127.0.0.1";
  if (isLocal && !allowLoopback) {
    throw new GroupHostHttpError(400, "InvalidDid", `Loopback did:web forbidden outside loopback mode: ${didWeb}`);
  }
  const scheme = isLocal ? "http" : "https";
  const targetHost = bareHost === "localhost" ? hostPart.replace(/^localhost/i, "127.0.0.1") : hostPart;
  return `${scheme}://${targetHost}/.well-known/did.json`;
}

export class PlcAndDidResolver {
  private readonly didFetcher: SafeFetch;
  private readonly plcSubmitFetcher: SafeFetch;

  constructor(private readonly config: GroupHostConfig) {
    this.didFetcher =
      config.fetchImpl ?? boundedSafeFetch(() => config.allowLoopback, BOUNDED_FETCH_PROFILES.didAndJwks);
    this.plcSubmitFetcher =
      config.fetchImpl ??
      boundedSafeFetch(() => config.allowLoopback, {
        deadlineMs: 10_000,
        maxResponseBytes: 65_536,
        allowedContentTypes: ["application/json", "text/plain"],
      });
  }

  async resolveDidDocument(did: string): Promise<DidDocumentShape | null> {
    if (!isDid(did)) return null;
    const url = did.startsWith("did:web:")
      ? didWebToUrl(did, this.config.allowLoopback)
      : `${this.config.plcUrl}/${encodeURIComponent(did)}`;
    const res = await this.didFetcher(url, {
      method: "GET",
      headers: { accept: "application/did+ld+json, application/json" },
    });
    if (res.status === 404 || res.status === 410) {
      return null;
    }
    if (!res.ok) {
      throw new GroupHostHttpError(502, "UpstreamDidResolutionFailed", `DID resolution failed (${res.status}) for ${did}`);
    }
    const doc = await readUpstreamJson<DidDocumentShape>(res, BOUNDED_FETCH_PROFILES.didAndJwks.maxResponseBytes);
    if (!doc || doc.id !== did) {
      throw new GroupHostHttpError(502, "InvalidDidDocument", `Invalid DID document for ${did}`);
    }
    return doc;
  }

  extractVerificationMethodDidKey(doc: DidDocumentShape, fragment = "#atproto"): string | null {
    const methods = Array.isArray(doc.verificationMethod) ? doc.verificationMethod : [];
    const target = methods.find(
      (vm) => vm && typeof vm === "object" && (vm.id === fragment || vm.id === `${doc.id}${fragment}`),
    );
    if (!target || typeof target.publicKeyMultibase !== "string" || !target.publicKeyMultibase) return null;
    try {
      if (target.type === "Multikey") {
        return `did:key:${target.publicKeyMultibase}`;
      }
      if (target.type === "EcdsaSecp256r1VerificationKey2019") {
        return formatDidKey(P256_JWT_ALG, multibaseToBytes(target.publicKeyMultibase));
      }
      if (target.type === "EcdsaSecp256k1VerificationKey2019") {
        return formatDidKey(SECP256K1_JWT_ALG, multibaseToBytes(target.publicKeyMultibase));
      }
      return `did:key:${target.publicKeyMultibase}`;
    } catch {
      return null;
    }
  }

  extractKemDidKey(doc: DidDocumentShape): string {
    return kemKeyFromDidDocument(doc.id, doc);
  }

  extractPdsEndpoint(doc: DidDocumentShape): string | null {
    const services = Array.isArray(doc.service) ? doc.service : [];
    const svc = services.find(
      (s) =>
        s &&
        typeof s === "object" &&
        (s.id === "#atproto_pds" || s.id === `${doc.id}#atproto_pds`) &&
        typeof s.serviceEndpoint === "string",
    );
    if (!svc) return null;
    try {
      return normalizeOriginUrl(svc.serviceEndpoint);
    } catch {
      return null;
    }
  }

  hasOpenSocialGroupService(doc: DidDocumentShape, expectedOrigin: string): boolean {
    const services = Array.isArray(doc.service) ? doc.service : [];
    return services.some((s) => {
      if (
        !s ||
        typeof s !== "object" ||
        (s.id !== "#opensocial_group" && s.id !== `${doc.id}#opensocial_group`) ||
        s.type !== "OpenSocialGroupHost" ||
        typeof s.serviceEndpoint !== "string"
      ) {
        return false;
      }
      try {
        return normalizeOriginUrl(s.serviceEndpoint) === expectedOrigin;
      } catch {
        return false;
      }
    });
  }

  async resolveSigningKey(did: string, fragment = "#atproto"): Promise<string> {
    const doc = await this.resolveDidDocument(did);
    if (!doc) {
      throw new GroupHostHttpError(400, "UnresolvableDid", `DID not found or tombstoned: ${did}`);
    }
    const didKey = this.extractVerificationMethodDidKey(doc, fragment);
    if (!didKey) {
      throw new GroupHostHttpError(400, "SigningKeyNotFound", `Verification method ${fragment} missing on ${did}`);
    }
    return didKey;
  }

  async getPlcLastOp(did: string): Promise<CompatibleOpOrTombstone | null> {
    const url = `${this.config.plcUrl}/${encodeURIComponent(did)}/log/last`;
    const res = await this.didFetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new GroupHostHttpError(502, "PlcDirectoryError", `Failed reading PLC /log/last (${res.status}) for ${did}`);
    }
    const op = await readUpstreamJson<CompatibleOpOrTombstone>(res, BOUNDED_FETCH_PROFILES.didAndJwks.maxResponseBytes);
    if (!op) {
      throw new GroupHostHttpError(502, "PlcDirectoryError", `Empty PLC /log/last response for ${did}`);
    }
    return op;
  }

  async submitPlcOperation(did: string, op: unknown): Promise<Response> {
    const url = `${this.config.plcUrl}/${encodeURIComponent(did)}`;
    return this.plcSubmitFetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain",
      },
      body: JSON.stringify(op),
    });
  }

  /**
   * Validates all 7 pinned pre-submission PLC operation invariants (`submitPlcOperation.ts:19-55`)
   * before forwarding to `PLC_URL`.
   */
  async verifyCutoverPlcOperation(params: {
    did: string;
    rawOp: unknown;
    expectedPdsOrigin: string;
    expectedHandle: string;
    expectedSigningDidKey: string;
    expectedKemDidKey: string;
    localRotationDidKey: string;
    sourceLocalRotationKey: string | null;
    preservedSovereignKeys: readonly string[];
  }): Promise<Operation> {
    if (typeof params.rawOp !== "object" || params.rawOp === null) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC operation must be an object.");
    }
    const op = params.rawOp as Operation;
    if (op.type !== "plc_operation") {
      throw new GroupHostHttpError(400, "InvalidRequest", "Operation must be plc_operation (not tombstone).");
    }
    try {
      await assureValidOp(op);
    } catch (err) {
      throw new GroupHostHttpError(400, "InvalidRequest", err instanceof Error ? err.message : "Invalid PLC operation.");
    }

    const lastOp = await this.getPlcLastOp(params.did);
    if (!lastOp || lastOp.type === "plc_tombstone") {
      throw new GroupHostHttpError(400, "InvalidRequest", "Cannot cut over an absent or tombstoned PLC DID.");
    }
    const expectedPrev = (await plcCidForOp(lastOp)).toString();
    if (op.prev !== expectedPrev) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC operation prev CID does not match current PLC head.");
    }

    try {
      await assureValidSig(plcOpRotationKeys(lastOp), op);
    } catch {
      throw new GroupHostHttpError(400, "InvalidSignature", "PLC operation signature is not valid for current rotationKeys.");
    }

    // 1..5 rotationKeys + local rotation key present + retiring source key excluded + sovereign keys preserved
    if (!Array.isArray(op.rotationKeys) || op.rotationKeys.length < 1 || op.rotationKeys.length > 5) {
      throw new GroupHostHttpError(400, "TooManyRotationKeys", "PLC rotationKeys must contain 1 to 5 keys.");
    }
    if (!op.rotationKeys.every(isSupportedPlcRotationDidKey)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "Unsupported PLC rotation key format.");
    }
    if (!op.rotationKeys.includes(params.localRotationDidKey)) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC rotationKeys must include target host rotation key.");
    }
    if (params.sourceLocalRotationKey !== null && op.rotationKeys.includes(params.sourceLocalRotationKey)) {
      throw new GroupHostHttpError(400, "SourceRotationKeyRetained", "PLC rotationKeys must remove retiring source host rotation key.");
    }
    for (const sovKey of params.preservedSovereignKeys) {
      if (!op.rotationKeys.includes(sovKey)) {
        throw new GroupHostHttpError(400, "SovereignRotationKeyDropped", `Preserved sovereign rotation key missing: ${sovKey}`);
      }
    }

    // Pinned PDS service, verificationMethods (#atproto & #atproto_kem), and alsoKnownAs checks
    const pdsSvc = op.services?.atproto_pds;
    if (
      !pdsSvc ||
      pdsSvc.type !== "AtprotoPersonalDataServer" ||
      normalizeOriginUrl(pdsSvc.endpoint) !== params.expectedPdsOrigin
    ) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC atproto_pds service endpoint mismatch.");
    }
    if (op.verificationMethods?.atproto !== params.expectedSigningDidKey) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC #atproto signing key mismatch.");
    }
    if (op.verificationMethods?.atproto_kem !== params.expectedKemDidKey) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC #atproto_kem key mismatch.");
    }
    if (!Array.isArray(op.alsoKnownAs) || op.alsoKnownAs[0] !== `at://${params.expectedHandle}`) {
      throw new GroupHostHttpError(400, "InvalidRequest", "PLC alsoKnownAs[0] handle mismatch.");
    }
    return op;
  }

  /**
   * Executes Step 3 of the 4-state `deleteAccount` machine (`plc_tombstoned`):
   * re-fetches `/log/last` and re-signs (max 3 attempts) ONLY on HTTP 409 conflict or timeout;
   * terminates immediately with `502 PlcTombstoneRejected` on any non-409 4xx!
   */
  async settleDeleteAccountPlcTombstone(params: {
    did: string;
    expectedHostOrigin: string;
    rotationKey: Keypair | null;
  }): Promise<"tombstoned" | "tombstoned_or_absent" | "migrated_remote" | "authority_lost_local_purge"> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lastOp = await this.getPlcLastOp(params.did);
      if (!lastOp || lastOp.type === "plc_tombstone") {
        return "tombstoned_or_absent";
      }
      const pdsEndpoint =
        "services" in lastOp && lastOp.services?.atproto_pds?.endpoint
          ? normalizeOriginUrl(lastOp.services.atproto_pds.endpoint)
          : "service" in lastOp && typeof lastOp.service === "string"
            ? normalizeOriginUrl(lastOp.service)
            : null;
      if (pdsEndpoint !== params.expectedHostOrigin) {
        return "migrated_remote";
      }
      const rotationKeys = plcOpRotationKeys(lastOp);
      if (!params.rotationKey || !rotationKeys.includes(params.rotationKey.did())) {
        return "authority_lost_local_purge";
      }
      const prevCid = await plcCidForOp(lastOp);
      const signedTombstone = await tombstoneOp(prevCid, params.rotationKey);
      let res: Response;
      try {
        res = await this.submitPlcOperation(params.did, signedTombstone);
      } catch (err) {
        if (attempt < 3 && err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          continue;
        }
        throw err;
      }
      if (res.ok) {
        return "tombstoned";
      }
      if (res.status === 409 && attempt < 3) {
        // Stale-prev conflict in @did-plc/server: loop to re-fetch /log/last and re-sign
        continue;
      }
      const bodyText = await res.text().catch(() => "");
      throw new GroupHostHttpError(
        502,
        "PlcTombstoneRejected",
        `PLC directory rejected tombstone (${res.status}): ${bodyText.slice(0, 200)}`,
      );
    }
    throw new GroupHostHttpError(502, "PlcTombstoneRejected", "Exceeded 3 PLC tombstone conflict retries.");
  }
}
