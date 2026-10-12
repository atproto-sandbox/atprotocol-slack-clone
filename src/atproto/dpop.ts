import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

const SIGNING_ALGORITHM = "ES256";

export type DpopKey = {
  readonly bareJwk: Record<string, unknown> | undefined;
  readonly algorithms: readonly string[];
  createJwt(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string>;
};

export async function createSpaceDpopProof(
  key: DpopKey,
  options: { htm: string; htu: string; credential?: string },
): Promise<string> {
  const jwk = key.bareJwk;
  if (!jwk || !key.algorithms.includes(SIGNING_ALGORITHM)) {
    throw new Error("A space DPoP key must be an asymmetric ES256 key.");
  }
  const header = {
    alg: SIGNING_ALGORITHM,
    typ: "dpop+jwt",
    jwk,
  };
  const payload = {
    jti: bytesToHex(randomBytes(16)),
    htm: options.htm,
    htu: normalizeHtu(options.htu),
    ...(options.credential
      ? { ath: base64UrlEncode(sha256(utf8ToBytes(options.credential))) }
      : {}),
    iat: Math.floor(Date.now() / 1000),
  };
  return key.createJwt(header, payload);
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalizeHtu(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}
