import type { Keypair } from "@atproto/crypto";
import {
  COMMIT_MAC_PROFILE,
  MAC_COVERED_HEADER,
  RECORD_MAC_PROFILE,
  LtHash,
  RepoCommit,
  SpaceKemError,
  SpaceMacError,
  SpaceRepoVerificationError,
  SpaceSignatureError,
  createCommitMacHeaders,
  createRecordMacHeaders,
  createSpaceSigHeaders,
  encapsulate,
  formatMacRequest,
  isP256DidKey,
  parseMacRequest,
  serializeRecord,
  verifyCommit,
  verifyCommitMac,
  verifyCredentialSig,
  verifyRecord,
  verifyRecordMac,
  verifyRepoStar,
  writeRepoStar,
  type MacProfile,
  type RepoOp,
  type SpaceCommit,
  type VerifyMacParams,
} from "@atproto/space";
import { StarParseError } from "@atproto/star";
import { fromBase64, parseCid, parseCidSafe, toBase64, validateCidString, type Cid } from "@atproto/lex-data";
import { jsonToLex, lexToJson } from "@atproto/lexicon";
import type * as GetDelegationToken from "../lexicons/api/types/com/atproto/space/getDelegationToken";
import type * as ListRecords from "../lexicons/api/types/com/atproto/space/listRecords";
import { UpstreamResponseTooLargeError, readUpstreamJson, readUpstreamText } from "../bounded-json";
import { isDid, parseSpaceUri, spaceRecordUri, type Did } from "../keys";
import { assertBoundedRecordPage } from "./record-pages";
import type { SpaceKey } from "./space-key";
import { AtprotoClient, isScopeMissingError, MAX_XRPC_RESPONSE_BYTES, XrpcError } from "./xrpc";

/** Byte length of an unencoded LtHash set-hash state (`new LtHash().state().byteLength`). */
export const LTHASH_STATE_BYTES = new LtHash().state().byteLength;

export {
  COMMIT_MAC_PROFILE,
  MAC_COVERED_HEADER,
  RECORD_MAC_PROFILE,
  LtHash,
  RepoCommit,
  SpaceKemError,
  SpaceMacError,
  SpaceRepoVerificationError,
  SpaceSignatureError,
  StarParseError,
  createCommitMacHeaders,
  createRecordMacHeaders,
  createSpaceSigHeaders,
  formatMacRequest,
  parseMacRequest,
  parseCid,
  parseCidSafe,
  verifyCommit,
  verifyCommitMac,
  verifyCredentialSig,
  verifyRecord,
  verifyRecordMac,
  writeRepoStar,
  type Cid,
  type MacProfile,
  type RepoOp,
  type SpaceCommit,
  type VerifyMacParams,
};

/** The PDS default lifetime of a space credential; the protocol ceiling is one hour. */
export const SPACE_CREDENTIAL_LIFETIME_MS = 10 * 60 * 1000;
/** A cached credential is replaced once less than this remains of its lifetime. */
export const SPACE_CREDENTIAL_RENEW_BEFORE_MS = SPACE_CREDENTIAL_LIFETIME_MS / 6;
/** The protocol ceiling on a credential's lifetime. */
const SPACE_CREDENTIAL_MAX_LIFETIME_MS = 60 * 60 * 1000;
const AUTHORIZE_SPACE_SYNC = "/xrpc/com.atproto.space.authorizeSpaceSync";

export type SpaceNotifyTarget = {
  endpoint: string;
  token: string;
};

export type SpaceCredentialExchangeResult = {
  credential: string;
  spaceRev?: string;
};

export type TimestampedSpaceSignatureOptions = {
  authorization: string;
  audience: string;
  keypair: SpaceKey | Keypair;
  createdSec: number;
};

function paddedBase64(bytes: Uint8Array): string {
  const base64 = toBase64(bytes);
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

/**
 * Signs an RFC 9421 proof-of-possession header set covering `("authorization" "atproto-space-audience")`
 * with a signed `;created=<unixSec>` freshness parameter and `tag="atproto-space-credential"`, compatible
 * with `@atproto/space`'s `verifyCredentialSig`.
 */
export async function createTimestampedSpaceSigHeaders(opts: TimestampedSpaceSignatureOptions): Promise<{
  headers: Record<string, string>;
}> {
  if (!Number.isSafeInteger(opts.createdSec) || opts.createdSec <= 0) {
    throw new RangeError("createdSec must be a positive safe integer.");
  }
  if (!isP256DidKey(opts.keypair.did())) {
    throw new SpaceSignatureError("signature key must be a P-256 did:key");
  }
  if (typeof opts.authorization !== "string" || !opts.authorization.trim() || /[\r\n]/.test(opts.authorization)) {
    throw new SpaceSignatureError('missing or malformed "authorization" field');
  }
  if (typeof opts.audience !== "string" || !opts.audience.trim() || /[\r\n]/.test(opts.audience)) {
    throw new SpaceSignatureError('missing or malformed "atproto-space-audience" field');
  }

  const signatureParams =
    `("authorization" "atproto-space-audience");created=${opts.createdSec};tag="atproto-space-credential"`;
  const base =
    `"authorization": ${opts.authorization.trim()}\n` +
    `"atproto-space-audience": ${opts.audience.trim()}\n` +
    `"@signature-params": ${signatureParams}`;
  const sigBytes = await opts.keypair.sign(starPathEncoder.encode(base));
  return {
    headers: {
      authorization: opts.authorization,
      "atproto-space-audience": opts.audience,
      "signature-input": `sig=${signatureParams}`,
      signature: `sig=:${paddedBase64(sigBytes)}:`,
    },
  };
}

/**
 * The reads this app makes that a repo host only serves to a space credential together with a MAC request, and the
 * MAC profile each answers with. `getRepo` also requires a `COMMIT_MAC_PROFILE` MAC and is handled by
 * `SpaceCredential.fetchVerifiedRepoStar`. Every `listRepoOps` page carries `commit` and verifies its RFC 9421 MAC.
 */
const MAC_PROFILES: Readonly<Record<string, MacProfile>> = {
  "com.atproto.space.getRecord": RECORD_MAC_PROFILE,
  "com.atproto.space.getLatestCommit": COMMIT_MAC_PROFILE,
  "com.atproto.space.listRepoOps": COMMIT_MAC_PROFILE,
};

export class RepoStarLimitError extends UpstreamResponseTooLargeError {
  constructor(
    readonly kind: "bytes" | "records",
    readonly limit: number,
    readonly actual?: number,
  ) {
    super(limit);
    this.name = "RepoStarLimitError";
    this.message = kind === "bytes"
      ? `STAR archive exceeds the ${limit}-byte limit.`
      : `STAR archive exceeds the ${limit}-record limit.`;
  }
}

export type VerifiedRepoStarRecord = {
  collection: string;
  rkey: string;
  cid: string;
  record: Record<string, unknown>;
};

export type VerifiedRepoStar = {
  commit: SpaceCommit;
  setHash: Uint8Array;
  commitDigest: Uint8Array;
  records: VerifiedRepoStarRecord[];
};

/** The author's `#atproto_kem` did:key; `forceRefresh` bypasses cached DID documents after a failed MAC (the key may have rotated). */
export type ResolveKemKey = (did: string, forceRefresh: boolean) => Promise<string>;

export type SpaceCredentialDeps = {
  memberClient: AtprotoClient;
  resolvePds(did: string): Promise<string>;
  resolveKemKey: ResolveKemKey;
  fetchEndpoint(request: Request): Promise<Response>;
  generateKey(): Promise<SpaceKey>;
  now?: () => number;
};

export class SpaceCredentialError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 410, readonly code?: string) {
    super(message);
    this.name = "SpaceCredentialError";
  }
}

/**
 * Whether the authority reported the space deleted. A syncer that missed the deletion notice learns of it when its credential
 * renewal fails with `SpaceDeleted` (status 410), and then drops every copy it holds.
 */
export function isSpaceDeleted(error: unknown): boolean {
  return error instanceof SpaceCredentialError && error.code === "SpaceDeleted";
}

/**
 * Whether a failure means this account can no longer read the space, so whatever it cached from the space must be
 * dropped: the credential was refused or the space was deleted. `exchangeSpaceCredential` reports every refusal to issue a
 * credential as 401 or 403, including the `SpaceNotFound` the reference authority gives a user the policy does not
 * authorize, so a removed member's refusal lands here. A record read that returns 404 is only a missing record, and a
 * `ScopeMissingError` from the account's own host means the session lacks an OAuth scope, not that the space refused it.
 */
export function isAccessLost(error: unknown): boolean {
  if (isScopeMissingError(error)) return false;
  return isSpaceDeleted(error) || (typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403));
}

/**
 * Whether a repo host refused the credential itself (expired by its clock, or minted for another audience), as opposed to refusing the
 * reader access to the space. A cached credential the host refuses is useless, so its holder drops it and mints another.
 */
export function isCredentialRefused(error: unknown): boolean {
  return error instanceof XrpcError && (error.status === 401 || error.code === "InvalidCredential" || error.code === "BadSpaceAudience");
}

export type SpaceCredentialInit = {
  space: string;
  token: string;
  key: SpaceKey;
  spaceRev?: string;
  notify?: SpaceNotifyTarget;
  fetchEndpoint: (request: Request) => Promise<Response>;
  resolveKemKey: ResolveKemKey;
  expiresAt?: number;
  renewBeforeMs?: number;
};

export class SpaceCredential {
  readonly space: string;
  readonly token: string;
  readonly key: SpaceKey;
  readonly spaceRev?: string;
  readonly notify?: SpaceNotifyTarget;
  readonly expiresAt: number;
  /** How long before `expiresAt` a holder should stop reusing the credential and mint another. */
  readonly renewBeforeMs: number;
  private readonly fetchEndpoint: (request: Request) => Promise<Response>;
  private readonly resolveKemKey: ResolveKemKey;

  constructor(init: SpaceCredentialInit) {
    this.space = init.space;
    this.token = init.token;
    this.key = init.key;
    this.spaceRev = init.spaceRev;
    this.notify = init.notify;
    this.fetchEndpoint = init.fetchEndpoint;
    this.resolveKemKey = init.resolveKemKey;
    this.expiresAt = init.expiresAt ?? Date.now() + SPACE_CREDENTIAL_LIFETIME_MS;
    this.renewBeforeMs = init.renewBeforeMs ?? SPACE_CREDENTIAL_RENEW_BEFORE_MS;
  }

  /** Alias for `key`, matching the `@atproto/space` `keypair` option naming. */
  get keypair(): SpaceKey {
    return this.key;
  }

  /**
   * A client whose every request is signed for this credential. Reads that a repo host serves only with a MAC
   * (`getRecord`, `getLatestCommit`, `listRepoOps`) also ask for one and are verified here, so no caller can use an
   * unauthenticated commit or record.
   */
  client(service: string | URL): AtprotoClient {
    const authorization = `Atproto-Space-Credential ${this.token}`;
    const key = this.key;
    const authorityDid = parseSpaceUri(this.space)?.authorityDid;
    if (!authorityDid) throw new Error("Invalid permissioned space URI.");
    const base = service instanceof URL ? service : new URL(service);
    return new AtprotoClient(async (path, init) => {
      const request = new Request(new URL(path, base), { ...init, redirect: "error" });
      const repo = requestedRepo(request);
      const audience = (repo ?? authorityDid) as Parameters<typeof createSpaceSigHeaders>[0]["audience"];
      const { headers } = await createSpaceSigHeaders({ authorization, audience, keypair: key });
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
      const macProfile = MAC_PROFILES[xrpcMethod(request)];
      if (!macProfile) return this.fetchEndpoint(request);
      if (!repo) throw new Error(`${xrpcMethod(request)} needs a repo DID.`);
      return this.fetchWithVerifiedMac(request, macProfile, repo);
    });
  }

  /**
   * Downloads and cryptographically verifies a binary STAR archive from `com.atproto.space.getRepo`, enforcing
   * `maxBytes` and `maxRecords` during streaming and staging entries until `verifyRepoStar`'s EOF `repo.matches(commit)`
   * succeeds.
   */
  async fetchVerifiedRepoStar(
    service: string | URL,
    input: { space: string; repo: string; maxBytes: number; maxRecords: number; signal?: AbortSignal },
  ): Promise<VerifiedRepoStar> {
    if (!isDid(input.repo)) throw new TypeError("com.atproto.space.getRepo needs a repo DID.");
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
      throw new RangeError("STAR maxBytes must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 0) {
      throw new RangeError("STAR maxRecords must be a non-negative safe integer.");
    }
    if (input.signal?.aborted) throw abortReason(input.signal);

    const base = service instanceof URL ? service : new URL(service);
    const url = new URL("/xrpc/com.atproto.space.getRepo", base);
    url.searchParams.set("space", input.space);
    url.searchParams.set("repo", input.repo);
    const authorization = `Atproto-Space-Credential ${this.token}`;

    for (const forceRefresh of [false, true]) {
      const kemKey = await this.resolveKemKey(input.repo, forceRefresh);
      let encapsulated: Awaited<ReturnType<typeof encapsulate>>;
      try {
        encapsulated = await encapsulate(kemKey as Parameters<typeof encapsulate>[0]);
      } catch (error) {
        if (error instanceof SpaceKemError && !forceRefresh) continue;
        throw error;
      }
      const { keyShare, sharedSecret } = encapsulated;
      const attemptController = new AbortController();
      const onAbort = () => attemptController.abort(input.signal?.reason);
      if (input.signal) {
        if (input.signal.aborted) throw abortReason(input.signal);
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const sig = await createSpaceSigHeaders({
          authorization,
          audience: input.repo as Parameters<typeof createSpaceSigHeaders>[0]["audience"],
          keypair: this.key,
        });
        const headers = new Headers(sig.headers);
        headers.set("accept", "application/vnd.dasl.star");
        headers.set("accept-signature", formatMacRequest(COMMIT_MAC_PROFILE, keyShare));
        const request = new Request(url, { method: "GET", redirect: "error", headers, signal: attemptController.signal });
        const response = await this.fetchEndpoint(request);
        if (!response.ok) throw await xrpcErrorFromResponse(response);

        const contentLength = response.headers.get("content-length");
        if (contentLength !== null && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(input.maxBytes)) {
          await response.body?.cancel().catch(() => undefined);
          attemptController.abort();
          throw new RepoStarLimitError("bytes", input.maxBytes);
        }

        let verifiedRepo: Awaited<ReturnType<typeof verifyRepoStar>>;
        try {
          verifiedRepo = await verifyRepoStar(
            boundedByteStream(response.body, input.maxBytes, attemptController),
            {
              space: input.space as SpaceCommit["space"],
              repo: input.repo as SpaceCommit["repo"],
              keyShare,
              sharedSecret,
              headers: response.headers,
            },
          );
        } catch (error) {
          if (error instanceof SpaceMacError && !forceRefresh) {
            await response.body?.cancel().catch(() => undefined);
            attemptController.abort(error);
            continue;
          }
          attemptController.abort(error);
          throw error;
        }

        const staged: VerifiedRepoStarRecord[] = [];
        const repoCommit = new RepoCommit();
        try {
          for await (const entry of verifiedRepo.records) {
            if (staged.length >= input.maxRecords) {
              throw new RepoStarLimitError("records", input.maxRecords);
            }
            repoCommit.add(entry.collection, entry.rkey, entry.cid);
            staged.push({
              collection: entry.collection,
              rkey: entry.rkey,
              cid: entry.cid.toString(),
              record: lexToJson(entry.record) as Record<string, unknown>,
            });
          }
          if (verifiedRepo.commit.data.byteLength !== 32 || !repoCommit.matches(verifiedRepo.commit)) {
            throw new SpaceRepoVerificationError("records do not match the commit data");
          }
          return {
            commit: verifiedRepo.commit,
            setHash: repoCommit.setHash.state(),
            commitDigest: new Uint8Array(verifiedRepo.commit.data),
            records: staged,
          };
        } catch (error) {
          attemptController.abort(error);
          throw error;
        } finally {
          await disposeVerifiedRepo(verifiedRepo);
        }
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new SpaceMacError(`com.atproto.space.getRepo for ${input.repo} failed MAC verification; the response is not trusted.`);
  }

  /**
   * A fresh ephemeral key share per attempt (never reused, retries included). A response that fails MAC verification
   * is retried once against a freshly resolved DID document, since the author may have rotated `#atproto_kem`.
   */
  private async fetchWithVerifiedMac(request: Request, profile: MacProfile, repo: string): Promise<Response> {
    for (const forceRefresh of [false, true]) {
      const kemKey = await this.resolveKemKey(repo, forceRefresh);
      let encapsulated: Awaited<ReturnType<typeof encapsulate>>;
      try {
        encapsulated = await encapsulate(kemKey as Parameters<typeof encapsulate>[0]);
      } catch (error) {
        if (error instanceof SpaceKemError && !forceRefresh) continue;
        throw error;
      }
      const { keyShare, sharedSecret } = encapsulated;
      const attempt = request.clone();
      attempt.headers.set("accept-signature", formatMacRequest(profile, keyShare));
      const response = await this.fetchEndpoint(attempt);
      if (!response.ok) return response;
      // The body is read once, within the bound, and handed on as a replay: reading a clone of a stream the caller has not
      // started on would leave an oversized body waiting on the other branch forever.
      const text = await readUpstreamText(response, MAX_XRPC_RESPONSE_BYTES);
      if (text === null) {
        if (!forceRefresh) continue;
        throw new SpaceMacError(`${xrpcMethod(request)} for ${repo} failed MAC verification; the response is not trusted.`);
      }
      try {
        await verifyMacResponse(response.headers, text, request, profile, repo, keyShare, sharedSecret);
        return replayed(response, text);
      } catch (error) {
        if (error instanceof SpaceMacError && !forceRefresh) continue;
        throw error;
      }
    }
    throw new SpaceMacError(`${xrpcMethod(request)} for ${repo} failed MAC verification; the response is not trusted.`);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function disposeVerifiedRepo(repo: { records: AsyncGenerator<unknown> }): Promise<void> {
  await repo.records.return?.(undefined).catch(() => undefined);
  const symbol = (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for("Symbol.asyncDispose");
  const fn = (repo as unknown as Record<symbol, (() => Promise<void>) | undefined>)[symbol];
  if (typeof fn === "function") await fn.call(repo).catch(() => undefined);
}

async function xrpcErrorFromResponse(response: Response): Promise<XrpcError> {
  const body = await readUpstreamJson(response, MAX_XRPC_RESPONSE_BYTES);
  const detail = body && typeof body === "object" && "message" in body && typeof body.message === "string"
    ? body.message
    : `XRPC request failed (${response.status}).`;
  const code = body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error
    : "XrpcError";
  return new XrpcError(response.status, detail, code);
}

async function* boundedByteStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  abortController: AbortController,
): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  let totalBytes = 0;
  let canceled = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        canceled = true;
        await reader.cancel().catch(() => undefined);
        abortController.abort();
        throw new RepoStarLimitError("bytes", maxBytes, totalBytes);
      }
      yield value;
    }
  } finally {
    if (!canceled) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type VerifiedRecordCidResult = { ok: true; byteLength: number } | { ok: false };

export type VerifiedBoundedRecord = {
  collection: string;
  rkey: string;
  cid: string;
  parsedCid: Cid;
  value: Record<string, unknown>;
  byteLength: number;
};

/**
 * Returns the canonical DRISL CBOR byte length of a JSON record value.
 */
export async function serializedRecordBytes(
  collection: string,
  rkey: string,
  recordValue: Record<string, unknown>,
): Promise<number> {
  const lexValue = jsonToLex(recordValue as Parameters<typeof jsonToLex>[0]) as Parameters<typeof serializeRecord>[2];
  const { bytes } = await serializeRecord(
    collection as Parameters<typeof serializeRecord>[0],
    rkey as Parameters<typeof serializeRecord>[1],
    lexValue,
  );
  return bytes.byteLength;
}

/**
 * Verifies a JSON record value against an expected CID string by converting XRPC JSON -> Lex (`jsonToLex`),
 * computing canonical DRISL `serializeRecord`, comparing against `parseCid(expectedCid)`, and returning its
 * serialized byte length on success.
 */
export async function verifyRecordCidWithSize(
  collection: string,
  rkey: string,
  recordValue: Record<string, unknown>,
  expectedCid: string,
): Promise<VerifiedRecordCidResult> {
  if (typeof collection !== "string" || collection.length === 0 || typeof rkey !== "string" || rkey.length === 0) {
    return { ok: false };
  }
  if (typeof recordValue !== "object" || recordValue === null || Array.isArray(recordValue)) {
    return { ok: false };
  }
  if (!validateCidString(expectedCid)) return { ok: false };
  const expected = parseCidSafe(expectedCid);
  if (!expected) return { ok: false };
  try {
    const lexValue = jsonToLex(recordValue as Parameters<typeof jsonToLex>[0]) as Parameters<typeof serializeRecord>[2];
    const { cid, bytes } = await serializeRecord(
      collection as Parameters<typeof serializeRecord>[0],
      rkey as Parameters<typeof serializeRecord>[1],
      lexValue,
    );
    return cid.equals(expected) ? { ok: true, byteLength: bytes.byteLength } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Verifies a JSON record value against an expected CID string by converting XRPC JSON -> Lex (`jsonToLex`),
 * computing canonical DRISL `serializeRecord`, and comparing against `parseCid(expectedCid)`.
 */
export async function verifyRecordCid(
  collection: string,
  rkey: string,
  recordValue: Record<string, unknown>,
  expectedCid: string,
): Promise<boolean> {
  return (await verifyRecordCidWithSize(collection, rkey, recordValue, expectedCid)).ok;
}

const MAX_VERIFIED_RECORD_PAGES = 128;

const PLACEHOLDER_TID_REV = "2222222222222";
const STAR_COMMIT_VERSION = 1;
const COMMIT_DIGEST_BYTE_LENGTH = 32;
const starPathEncoder = new TextEncoder();

/** Returns the shortest unsigned LEB128 varint byte length used by `@atproto/car`'s `encodeVarInt` / STAR framing. */
export function varintByteLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Varint value must be a non-negative safe integer.");
  }
  let n = value;
  let bytes = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 128);
    bytes += 1;
  }
  return bytes;
}

/** Exact STAR archive byte length of an empty repo (`STAR_MAGIC` + varint + CBOR metadata + `0x00` EOF byte). */
export async function starHeaderBytes(commit: SpaceCommit): Promise<number> {
  let total = 0;
  for await (const chunk of writeRepoStar(commit, [])) {
    total += chunk.byteLength;
  }
  return total;
}

/** Exact STAR per-record entry byte length (`0x01` control byte + `varint(keyLen) + keyBytes + varint(valLen) + valLen`). */
export function starEntryBytes(collection: string, rkey: string, valueByteLength: number): number {
  const keyByteLength = starPathEncoder.encode(`${collection}/${rkey}`).byteLength;
  return 1 + varintByteLength(keyByteLength) + keyByteLength + varintByteLength(valueByteLength) + valueByteLength;
}

/** Exact STAR archive byte length matching `@atproto/space`'s `writeRepoStar(commit, records)`. */
export async function computeStarArchiveBytes(
  commit: SpaceCommit,
  entries: ReadonlyArray<{ collection: string; rkey: string; byteLength: number }>,
): Promise<number> {
  let total = await starHeaderBytes(commit);
  for (const entry of entries) {
    total += starEntryBytes(entry.collection, entry.rkey, entry.byteLength);
  }
  return total;
}

function defaultStarHeaderCommit(space: string, repo: string): SpaceCommit {
  return {
    ver: STAR_COMMIT_VERSION,
    space: space as SpaceCommit["space"],
    repo: repo as SpaceCommit["repo"],
    rev: PLACEHOLDER_TID_REV,
    data: new Uint8Array(COMMIT_DIGEST_BYTE_LENGTH),
  };
}

/**
 * Pages `com.atproto.space.listRecords` for one repo while verifying every record's CID and enforcing
 * aggregate `maxRecords` and exact STAR archive byte `maxBytes` caps page-by-page so oversized repos abort
 * immediately with `RepoStarLimitError` before fetching additional pages.
 */
export async function listVerifiedBoundedRecords(
  client: AtprotoClient,
  input: { space: string; repo: string; collection?: string; maxRecords: number; maxBytes: number; commit?: SpaceCommit },
): Promise<{ records: VerifiedBoundedRecord[]; totalBytes: number; recordsBytes: number }> {
  if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 0) {
    throw new RangeError("Verified record limit must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new RangeError("Verified byte limit must be a non-negative safe integer.");
  }

  const records: VerifiedBoundedRecord[] = [];
  const seenCursors = new Set<string>();
  const seenKeys = new Set<string>();
  const headerBytes = await starHeaderBytes(input.commit ?? defaultStarHeaderCommit(input.space, input.repo));
  let recordsBytes = 0;
  let totalBytes = headerBytes;
  let pages = 0;
  let cursor: string | undefined;
  if (totalBytes > input.maxBytes) {
    throw new RepoStarLimitError("bytes", input.maxBytes, totalBytes);
  }

  do {
    const remaining = input.maxRecords - records.length;
    const limit = input.maxRecords === 0 ? 1 : Math.min(500, remaining);
    if (++pages > MAX_VERIFIED_RECORD_PAGES) {
      throw new Error("PDS record pagination exceeded the bounded page limit.");
    }
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space: input.space,
      repo: input.repo,
      ...(input.collection !== undefined ? { collection: input.collection } : {}),
      excludeValues: false,
      limit,
      cursor,
    });
    if (cursor) seenCursors.add(cursor);
    assertBoundedRecordPage(page, {
      collection: input.collection,
      excludeValues: false,
      limit,
      cursor,
      seenCursors,
      space: input.space,
      repo: input.repo,
    });
    for (const entry of page.records) {
      const key = `${entry.collection}/${entry.rkey}`;
      if (seenKeys.has(key)) throw new Error("PDS record pagination returned a duplicate record key.");
      seenKeys.add(key);
      if (records.length >= input.maxRecords) {
        throw new RepoStarLimitError("records", input.maxRecords);
      }
      if (typeof entry.cid !== "string" || entry.cid.length === 0) {
        throw new SpaceMacError(`Missing CID for ${entry.collection}/${entry.rkey} from ${input.repo}.`);
      }
      const parsedCid = parseCidSafe(entry.cid);
      const value = entry.value as Record<string, unknown>;
      const verified = parsedCid
        ? await verifyRecordCidWithSize(entry.collection, entry.rkey, value, entry.cid)
        : { ok: false as const };
      if (!parsedCid || !verified.ok) {
        throw new SpaceMacError(`Record ${entry.collection}/${entry.rkey} for ${input.repo} failed CID verification.`);
      }
      const entryBytes = starEntryBytes(entry.collection, entry.rkey, verified.byteLength);
      recordsBytes += entryBytes;
      totalBytes += entryBytes;
      if (totalBytes > input.maxBytes) {
        throw new RepoStarLimitError("bytes", input.maxBytes, totalBytes);
      }
      records.push({
        collection: entry.collection,
        rkey: entry.rkey,
        cid: entry.cid,
        parsedCid,
        value,
        byteLength: verified.byteLength,
      });
    }
    cursor = page.cursor;
    if (cursor) seenCursors.add(cursor);
  } while (cursor && records.length < input.maxRecords);

  if (cursor && input.maxRecords > 0) {
    if (++pages > MAX_VERIFIED_RECORD_PAGES) {
      throw new Error("PDS record pagination exceeded the bounded page limit.");
    }
    const page = await client.query<ListRecords.OutputSchema>("com.atproto.space.listRecords", {
      space: input.space,
      repo: input.repo,
      ...(input.collection !== undefined ? { collection: input.collection } : {}),
      excludeValues: false,
      limit: 1,
      cursor,
    });
    assertBoundedRecordPage(page, {
      collection: input.collection,
      excludeValues: false,
      limit: 1,
      cursor,
      seenCursors,
      space: input.space,
      repo: input.repo,
    });
    if (page.records.some((entry) => seenKeys.has(`${entry.collection}/${entry.rkey}`))) {
      throw new Error("PDS record pagination returned a duplicate record key.");
    }
    if (page.records.length > 0) {
      throw new RepoStarLimitError("records", input.maxRecords);
    }
  }

  return { records, totalBytes, recordsBytes };
}

/** The response a caller sees once its body has been read and verified. The length and encoding headers described the wire bytes. */
function replayed(response: Response, text: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

/** A request for one repo is addressed to that repo's host; a space-wide request, to the space authority. */
function requestedRepo(request: Request): Did | undefined {
  const repo = request.method === "GET" ? new URL(request.url).searchParams.get("repo") : null;
  return isDid(repo) ? repo : undefined;
}

function xrpcMethod(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/xrpc\//, "");
}

async function verifyMacResponse(
  headers: Headers,
  text: string,
  request: Request,
  profile: MacProfile,
  repo: string,
  keyShare: string,
  sharedSecret: Uint8Array,
): Promise<void> {
  const params = new URL(request.url).searchParams;
  const space = params.get("space") ?? "";
  const method = xrpcMethod(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SpaceRepoVerificationError(`${method} for ${repo} returned invalid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SpaceRepoVerificationError(`${method} for ${repo} returned a non-object JSON payload.`);
  }

  if (method === "com.atproto.space.listRepoOps") {
    const page = parsed as { ops?: unknown };
    if (!Array.isArray(page.ops)) {
      throw new SpaceRepoVerificationError(`com.atproto.space.listRepoOps for ${repo} returned a non-array ops list.`);
    }
  }

  const macParams: VerifyMacParams = {
    keyShare: keyShare as VerifyMacParams["keyShare"],
    sharedSecret,
    headers,
  };

  if (profile === RECORD_MAC_PROFILE) {
    const record = parsed as { uri?: unknown; cid?: unknown; value?: unknown };
    if (
      typeof record.uri !== "string"
      || typeof record.cid !== "string"
      || typeof record.value !== "object"
      || record.value === null
      || Array.isArray(record.value)
    ) {
      throw new SpaceRepoVerificationError(`com.atproto.space.getRecord for ${repo} is missing uri, cid, or value.`);
    }
    let uri: string;
    try {
      uri = spaceRecordUri(space, repo, params.get("collection") ?? "", params.get("rkey") ?? "");
    } catch {
      throw new SpaceRepoVerificationError(`com.atproto.space.getRecord request for ${repo} had invalid URI parameters.`);
    }
    // The host stored the record in its Lexicon form (a `$link` is a CID, a `$bytes` is bytes) and answers in JSON, so the
    // value is converted back before its encoding is compared with the CID.
    const value = jsonToLex(record.value as Parameters<typeof jsonToLex>[0]) as Parameters<typeof verifyRecord>[0]["value"];
    await verifyRecord(
      { uri: record.uri, cid: record.cid, value },
      { ...macParams, uri: uri as Parameters<typeof verifyRecord>[1]["uri"] },
    );
    return;
  }

  const commit = commitFromJson((parsed as { commit?: unknown }).commit);
  if (!commit) {
    throw new SpaceRepoVerificationError(`${method} for ${repo} is missing a commit.`);
  }
  verifyCommit(commit, {
    ...macParams,
    space: space as SpaceCommit["space"],
    repo: repo as SpaceCommit["repo"],
  });
}

function commitFromJson(value: unknown): SpaceCommit | null {
  if (typeof value !== "object" || value === null) return null;
  const commit = value as { ver?: unknown; repo?: unknown; space?: unknown; rev?: unknown; data?: unknown };
  const encoded = (commit.data as { $bytes?: unknown } | undefined)?.$bytes;
  if (typeof commit.ver !== "number" || typeof commit.repo !== "string" || typeof commit.space !== "string" || typeof commit.rev !== "string" || typeof encoded !== "string") return null;
  try {
    return { ver: commit.ver, repo: commit.repo, space: commit.space, rev: commit.rev, data: fromBase64(encoded) } as SpaceCommit;
  } catch {
    return null;
  }
}

/**
 * How long the authority made a credential last, from its own `iat` and `exp`, because the authority chooses the lifetime (ten
 * minutes by default, an hour at most) and a shorter one would otherwise be presented after it expired. Both claims come from the
 * issuer's clock, so the difference does not depend on the holder's, which a browser's often gets wrong; the holder adds it to its own
 * now. The token is read as its holder, never verified, and only to schedule renewal. `null` when it is not a JWT with a positive
 * lifetime within the protocol ceiling, and the default lifetime applies.
 */
export function credentialLifetimeMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const claims = payload ? (JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { iat?: unknown; exp?: unknown }) : undefined;
    if (typeof claims?.iat !== "number" || typeof claims.exp !== "number") return null;
    const lifetime = (claims.exp - claims.iat) * 1000;
    return Number.isFinite(lifetime) && lifetime > 0 && lifetime <= SPACE_CREDENTIAL_MAX_LIFETIME_MS ? lifetime : null;
  } catch {
    return null;
  }
}

export async function mintSpaceCredentialWith(
  deps: SpaceCredentialDeps,
  space: string,
  opts?: { notify?: SpaceNotifyTarget; clientAttestation?: string; signal?: AbortSignal },
): Promise<SpaceCredential> {
  const parsed = parseSpaceUri(space);
  if (!parsed) throw new Error("Invalid permissioned space URI.");
  if (opts?.signal?.aborted) throw abortReason(opts.signal);
  const delegation = await deps.memberClient.query<GetDelegationToken.OutputSchema>(
    "com.atproto.space.getDelegationToken",
    { space },
    opts?.signal ? { signal: opts.signal } : undefined,
  );
  if (opts?.signal?.aborted) throw abortReason(opts.signal);
  const authorityPds = await deps.resolvePds(parsed.authorityDid);
  if (opts?.signal?.aborted) throw abortReason(opts.signal);
  const key = await deps.generateKey();
  if (opts?.signal?.aborted) throw abortReason(opts.signal);
  const { credential, spaceRev } = await exchangeSpaceCredential({
    authorityPds,
    delegationToken: delegation.token,
    ...(opts?.clientAttestation !== undefined ? { clientAttestation: opts.clientAttestation } : {}),
    ...(opts?.notify !== undefined ? { notify: opts.notify } : {}),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    space,
    key,
    fetchEndpoint: deps.fetchEndpoint,
  });
  const lifetime = credentialLifetimeMs(credential) ?? SPACE_CREDENTIAL_LIFETIME_MS;
  return new SpaceCredential({
    space,
    token: credential,
    key,
    ...(spaceRev !== undefined ? { spaceRev } : {}),
    ...(opts?.notify !== undefined ? { notify: opts.notify } : {}),
    fetchEndpoint: deps.fetchEndpoint,
    resolveKemKey: deps.resolveKemKey,
    expiresAt: (deps.now ?? Date.now)() + lifetime,
    // A credential shorter than six renewal margins renews proportionally earlier instead of never being reused.
    renewBeforeMs: Math.min(SPACE_CREDENTIAL_RENEW_BEFORE_MS, lifetime / 6),
  });
}

const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set(
  ["AccountNotAuthorized", "NotAuthorized", "AppNotAuthorized", "SpaceNotFound", "SpaceDeleted"],
);

export type ExchangeSpaceCredentialInput = {
  authorityPds: string;
  space: string;
  fetchEndpoint: (request: Request) => Promise<Response>;
  delegationToken?: string;
  clientAttestation?: string;
  notify?: SpaceNotifyTarget;
  signal?: AbortSignal;
} & ({ key: SpaceKey; credentialKey?: string } | { key?: SpaceKey; credentialKey: string });

export async function exchangeSpaceCredential(
  input: ExchangeSpaceCredentialInput,
): Promise<SpaceCredentialExchangeResult> {
  if (input.signal?.aborted) throw abortReason(input.signal);
  const credentialKey = input.credentialKey ?? input.key?.did();
  if (!credentialKey) {
    throw new Error("exchangeSpaceCredential requires credentialKey or key.");
  }
  const endpoint = new URL(AUTHORIZE_SPACE_SYNC, input.authorityPds);
  const requestBody: Record<string, unknown> = {
    space: input.space,
    credentialKey,
    ...(input.delegationToken !== undefined ? { delegationToken: input.delegationToken } : {}),
    ...(input.clientAttestation !== undefined ? { clientAttestation: input.clientAttestation } : {}),
    ...(input.notify !== undefined ? { notify: input.notify } : {}),
  };
  const request = new Request(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const response = await input.fetchEndpoint(request);
  const body = await readUpstreamJson<{ credential?: unknown; spaceRev?: unknown; message?: unknown; error?: unknown }>(response, 64 * 1024);
  if (!response.ok || typeof body?.credential !== "string" || body.credential.length === 0) {
    const message = typeof body?.message === "string" ? body.message : `Space credential exchange failed (${response.status}).`;
    const code = typeof body?.error === "string" ? body.error : undefined;
    // The PDS reports credential-exchange denials as HTTP 400 with a protocol-specific error code. Normalize
    // each refusal to 410 (SpaceDeleted) or 401/403 so callers recognize lost access cleanly. RegistrationNotConfirmed,
    // RepoTakendown, RepoDeactivated, InvalidDelegationToken, and InvalidClientAttestation stay XrpcError(400) so
    // non-access errors do not masquerade as access loss.
    if (response.status === 401 || response.status === 403 || (response.status === 400 && code !== undefined && CREDENTIAL_REFUSALS.has(code))) {
      const status = code === "SpaceDeleted" ? 410 : response.status === 401 ? 401 : 403;
      throw new SpaceCredentialError(message, status, code);
    }
    throw new XrpcError(response.status, message, code ?? "CredentialExchangeFailed");
  }
  const spaceRev = typeof body.spaceRev === "string" && body.spaceRev.length > 0 ? body.spaceRev : undefined;
  return { credential: body.credential, ...(spaceRev !== undefined ? { spaceRev } : {}) };
}
