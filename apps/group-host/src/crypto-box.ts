import { createCipheriv, createDecipheriv, createHash, createHmac, ECDH, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { fromBase64, isCid, parseCid, toBase64, type LexMap, type LexValue } from "@atproto/lex-data";
import type { JwkPrivateKey } from "./config";

// P-256 curve order n
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type ServiceSigningMaterial = {
  activeKeypair: P256Keypair;
  activeKidFragment: string;
  activeJwkKid: string;
  publicJwks: Array<Record<string, unknown>>;
  verificationMethods: Array<{
    id: string;
    type: "Multikey";
    controller: string;
    publicKeyMultibase: string;
  }>;
};

function base64UrlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) {
    acc = (acc << 8n) | BigInt(b);
  }
  return acc;
}

function multibaseFromKeypair(kp: P256Keypair): string {
  // did:key:zDna... -> strip `did:key:`
  const didKey = kp.did();
  return didKey.startsWith("did:key:") ? didKey.slice("did:key:".length) : didKey;
}

function uncompressedPublicCoordsFromKeypair(kp: P256Keypair): { x: string; y: string } {
  // P256Keypair.publicKeyBytes() returns uncompressed 65-byte SEC1 (0x04 || X32 || Y32) or compressed 33-byte;
  // use Node ECDH to convert either cleanly to uncompressed 65-byte point!
  const raw = kp.publicKeyBytes();
  if (raw.byteLength === 65 && raw[0] === 0x04) {
    return {
      x: base64UrlEncode(raw.subarray(1, 33)),
      y: base64UrlEncode(raw.subarray(33, 65)),
    };
  }
  // Convert compressed 33-byte point via Node crypto ECDH
  const uncompressed = ECDH.convertKey(Buffer.from(raw), "prime256v1", undefined, undefined, "uncompressed") as Buffer;
  return {
    x: base64UrlEncode(uncompressed.subarray(1, 33)),
    y: base64UrlEncode(uncompressed.subarray(33, 65)),
  };
}

export class GroupHostCryptoBox {
  private readonly aeadKey: Buffer;
  private readonly cookieKey: Buffer;
  private readonly dpopNonceKey: Buffer;
  private readonly serviceSeedKey: Buffer;

  constructor(encryptionKeyHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      throw new Error("Invalid 32-byte hex GROUP_HOST_ENCRYPTION_KEY.");
    }
    const masterKey = Buffer.from(encryptionKeyHex, "hex");
    const salt = Buffer.from("flock-group-host-hkdf-salt-v1", "utf8");
    this.aeadKey = Buffer.from(hkdfSync("sha256", masterKey, salt, Buffer.from("flock-group-host-aead-v1", "utf8"), 32));
    this.cookieKey = Buffer.from(hkdfSync("sha256", masterKey, salt, Buffer.from("flock-group-host-cookie-v1", "utf8"), 32));
    this.dpopNonceKey = Buffer.from(hkdfSync("sha256", masterKey, salt, Buffer.from("flock-group-host-dpop-nonce-v1", "utf8"), 32));
    this.serviceSeedKey = Buffer.from(
      hkdfSync("sha256", masterKey, salt, Buffer.from("flock-group-host-service-signing-key-v1", "utf8"), 32),
    );
  }

  private buildAad(table: string, rowKey: string, column: string): Buffer {
    return Buffer.from(`${table}\u0000${rowKey}\u0000${column}\u0000v1`, "utf8");
  }

  encryptColumn(table: string, rowKey: string, column: string, plaintext: Uint8Array | string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.aeadKey, iv);
    cipher.setAAD(this.buildAad(table, rowKey, column));
    const inputBuf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
    const ct = Buffer.concat([cipher.update(inputBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
  }

  decryptColumnBytes(table: string, rowKey: string, column: string, encoded: string): Buffer {
    const parts = encoded.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") {
      throw new Error(`Unsupported ciphertext version for ${table}.${column}`);
    }
    const iv = base64UrlDecode(parts[1]!);
    const tag = base64UrlDecode(parts[2]!);
    const ct = base64UrlDecode(parts[3]!);
    if (iv.byteLength !== 12 || tag.byteLength !== 16) {
      throw new Error(`Malformed AES-GCM parameters for ${table}.${column}`);
    }
    const decipher = createDecipheriv("aes-256-gcm", this.aeadKey, iv);
    decipher.setAAD(this.buildAad(table, rowKey, column));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  decryptColumnUtf8(table: string, rowKey: string, column: string, encoded: string): string {
    return this.decryptColumnBytes(table, rowKey, column, encoded).toString("utf8");
  }

  async encryptKeypair(table: string, rowKey: string, column: string, keypair: P256Keypair): Promise<string> {
    const privRaw = await keypair.export();
    const privBytes = typeof privRaw === "string" ? Buffer.from(privRaw, "hex") : privRaw;
    return this.encryptColumn(table, rowKey, column, privBytes);
  }

  async decryptKeypair(table: string, rowKey: string, column: string, encoded: string): Promise<P256Keypair> {
    const privBytes = this.decryptColumnBytes(table, rowKey, column, encoded);
    return P256Keypair.import(privBytes, { exportable: true });
  }

  /**
   * Derives deterministic host service P-256 keypair via rejection-sampled scalar,
   * or loads configured `GROUP_HOST_SERVICE_PRIVATE_JWKS` for zero-downtime overlap rotation.
   */
  async deriveServiceSigningMaterial(
    serviceDid: string,
    configuredJwks?: readonly JwkPrivateKey[],
  ): Promise<ServiceSigningMaterial> {
    if (configuredJwks && configuredJwks.length > 0) {
      const imported: Array<{ kid: string; kp: P256Keypair; pubJwk: Record<string, unknown> }> = [];
      for (const jwk of configuredJwks) {
        const dBytes = base64UrlDecode(jwk.d);
        if (dBytes.byteLength !== 32) {
          throw new Error(`ES256 private scalar d for kid=${jwk.kid} must be 32 bytes.`);
        }
        const kp = await P256Keypair.import(dBytes, { exportable: true });
        imported.push({
          kid: jwk.kid,
          kp,
          pubJwk: {
            kty: "EC",
            crv: "P-256",
            alg: "ES256",
            use: "sig",
            kid: jwk.kid,
            x: jwk.x,
            y: jwk.y,
          },
        });
      }
      const primary = imported[0]!;
      const verificationMethods: ServiceSigningMaterial["verificationMethods"] = [
        {
          id: `${serviceDid}#atproto`,
          type: "Multikey",
          controller: serviceDid,
          publicKeyMultibase: multibaseFromKeypair(primary.kp),
        },
        ...imported.map((entry) => ({
          id: `${serviceDid}#atproto-${entry.kid}`,
          type: "Multikey" as const,
          controller: serviceDid,
          publicKeyMultibase: multibaseFromKeypair(entry.kp),
        })),
      ];
      return {
        activeKeypair: primary.kp,
        activeKidFragment: `#atproto-${primary.kid}`,
        activeJwkKid: primary.kid,
        publicJwks: imported.map((e) => e.pubJwk),
        verificationMethods,
      };
    }

    // Rejection-sample valid P-256 scalar in [1, n - 1]
    let counter = 0;
    let scalarBytes: Buffer;
    while (true) {
      scalarBytes = createHmac("sha256", this.serviceSeedKey)
        .update(`p256-scalar-${counter}`)
        .digest();
      const k = bytesToBigInt(scalarBytes);
      if (k >= 1n && k < P256_ORDER) break;
      counter += 1;
    }
    const kp = await P256Keypair.import(scalarBytes, { exportable: true });
    const coords = uncompressedPublicCoordsFromKeypair(kp);
    const defaultJwkKid = createHash("sha256").update(kp.did()).digest("base64url").slice(0, 16);

    return {
      activeKeypair: kp,
      activeKidFragment: "#atproto",
      activeJwkKid: defaultJwkKid,
      publicJwks: [
        {
          kty: "EC",
          crv: "P-256",
          alg: "ES256",
          use: "sig",
          kid: defaultJwkKid,
          x: coords.x,
          y: coords.y,
        },
      ],
      verificationMethods: [
        {
          id: `${serviceDid}#atproto`,
          type: "Multikey",
          controller: serviceDid,
          publicKeyMultibase: multibaseFromKeypair(kp),
        },
      ],
    };
  }

  /** Rolling 60s-bucketed DPoP nonce valid across `[bucket, bucket - 1, bucket - 2]` (~180s window). */
  createDpopNonce(nowMs = Date.now()): string {
    const bucket = Math.floor(nowMs / 60_000);
    const bucketHex = bucket.toString(16);
    const mac = createHmac("sha256", this.dpopNonceKey).update(`dpop-nonce:${bucketHex}`).digest("base64url");
    return `ghn1.${bucketHex}.${mac}`;
  }

  verifyDpopNonce(nonce: unknown, nowMs = Date.now()): boolean {
    if (typeof nonce !== "string") return false;
    const parts = nonce.split(".");
    if (parts.length !== 3 || parts[0] !== "ghn1") return false;
    const bucket = Number.parseInt(parts[1]!, 16);
    if (!Number.isSafeInteger(bucket)) return false;
    const currentBucket = Math.floor(nowMs / 60_000);
    if (bucket > currentBucket || currentBucket - bucket > 2) return false;
    const expectedMac = createHmac("sha256", this.dpopNonceKey)
      .update(`dpop-nonce:${bucket.toString(16)}`)
      .digest();
    let providedMac: Buffer;
    try {
      providedMac = base64UrlDecode(parts[2]!);
    } catch {
      return false;
    }
    if (providedMac.byteLength !== expectedMac.byteLength) return false;
    return timingSafeEqual(providedMac, expectedMac);
  }

  signCookiePayload(purpose: string, payloadJson: string): string {
    const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
    const mac = createHmac("sha256", this.cookieKey)
      .update(`${purpose}\u0000${payloadB64}`)
      .digest("base64url");
    return `${payloadB64}.${mac}`;
  }

  verifyCookiePayload<T>(purpose: string, cookieValue: unknown): T | null {
    if (typeof cookieValue !== "string") return null;
    const dot = cookieValue.indexOf(".");
    if (dot <= 0 || dot === cookieValue.length - 1) return null;
    const payloadB64 = cookieValue.slice(0, dot);
    const macB64 = cookieValue.slice(dot + 1);
    const expectedMac = createHmac("sha256", this.cookieKey)
      .update(`${purpose}\u0000${payloadB64}`)
      .digest();
    let actualMac: Buffer;
    try {
      actualMac = base64UrlDecode(macB64);
    } catch {
      return null;
    }
    if (actualMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(actualMac, expectedMac)) {
      return null;
    }
    try {
      return JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as T;
    } catch {
      return null;
    }
  }
}

export function sha256HexBytes(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Base64Url(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Converts plain JSON (including `{ "$link": "..." }` and `{ "$bytes": "..." }` and `{ "$type": "blob", ... }`)
 * into `@atproto/lex-data` `LexValue` / `LexMap` for DRISL CBOR (`@atproto/lex-cbor`, `@atproto/repo`, `@atproto/space`)
 * WITHOUT wrapping `{ "$type": "blob" }` in `@atproto/lexicon` v1's `BlobRef` class.
 */
export function plainJsonToLexData(value: unknown): LexValue {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object") {
    return value as LexValue;
  }
  if (value instanceof Uint8Array) return value;
  if (isCid(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => plainJsonToLexData(item));
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj.$link === "string") {
    return parseCid(obj.$link);
  }
  if (keys.length === 1 && typeof obj.$bytes === "string") {
    return fromBase64(obj.$bytes);
  }
  const out: LexMap = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = plainJsonToLexData(v);
    }
  }
  return out;
}

export function plainJsonToLexMap(value: Record<string, unknown>): LexMap {
  return plainJsonToLexData(value) as LexMap;
}

/**
 * Converts decoded `@atproto/lex-data` `LexValue` back into plain JSON (`{ "$link": "..." }` & `{ "$bytes": "..." }`).
 */
export function lexDataToPlainJson(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return { $bytes: toBase64(value) };
  }
  if (isCid(value)) {
    return { $link: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map((item) => lexDataToPlainJson(item));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) {
      out[k] = lexDataToPlainJson(v);
    }
  }
  return out;
}
