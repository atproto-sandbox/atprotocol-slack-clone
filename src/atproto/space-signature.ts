import { formatDidKey } from "@atproto/crypto";
import { toBase64 } from "@atproto/lex-data";

const SIGNATURE_LABEL = "atproto-space";

export type SpaceKey = {
  did(): string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
};

export type SpaceSignatureOptions = { authorization: string; audience?: string };

export async function generateSpaceKey(): Promise<SpaceKey> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const did = formatDidKey("ES256", new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
  return {
    did: () => did,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes as BufferSource)),
  };
}

/**
 * The headers for a space request, in the shape the PDS verifies. With an
 * audience the signature covers the credential and the audience; without one
 * it covers the delegation token and names the signing key in `keyid`.
 */
export async function createSpaceSigHeaders(key: SpaceKey, { authorization, audience }: SpaceSignatureOptions): Promise<Record<string, string>> {
  const signatureInput = audience === undefined
    ? `("authorization");keyid="${key.did()}"`
    : `("authorization" "atproto-space-audience")`;
  const lines = [`"authorization": ${authorization.trim()}`];
  if (audience !== undefined) lines.push(`"atproto-space-audience": ${audience.trim()}`);
  lines.push(`"@signature-params": ${signatureInput}`);
  const signature = await key.sign(new TextEncoder().encode(lines.join("\n")));
  return {
    authorization,
    ...(audience === undefined ? {} : { "atproto-space-audience": audience }),
    "signature-input": `${SIGNATURE_LABEL}=${signatureInput}`,
    signature: `${SIGNATURE_LABEL}=:${toBase64(signature)}:`,
  };
}
