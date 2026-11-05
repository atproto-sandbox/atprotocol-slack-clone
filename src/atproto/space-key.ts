import { formatDidKey, type Keypair } from "@atproto/crypto";

/**
 * A P-256 key that binds one space credential (`cnf.kid`) and signs every request made with it. The signature
 * format itself belongs to `@atproto/space` (`createSpaceSigHeaders`); this only supplies the key.
 */
export type SpaceKey = Keypair;

/** A fresh key whose private half never leaves WebCrypto, so the same code runs in Node and in the browser. */
export async function generateSpaceKey(): Promise<SpaceKey> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const did = formatDidKey("ES256", new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
  return {
    jwtAlg: "ES256",
    did: () => did,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes as BufferSource)),
  };
}
