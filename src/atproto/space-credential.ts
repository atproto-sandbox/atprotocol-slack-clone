import type { OAuthSession } from "@atproto/oauth-client-node";
import { fetchValidatedEndpoint, resolveKemKey, resolvePds } from "./identity";
import { sessionClient } from "./client";
import { generateSpaceKey } from "./space-key";
import { mintSpaceCredentialWith, SpaceCredential, SpaceCredentialError, type SpaceCredentialDeps } from "./space-credential-core";

export { SpaceCredential, SpaceCredentialError };

/** The transports a server-held session reads spaces with: its own client, SSRF-guarded fetch and DID resolution. */
export function sessionCredentialDeps(session: OAuthSession): SpaceCredentialDeps {
  return { memberClient: sessionClient(session), resolvePds, resolveKemKey, fetchEndpoint: fetchValidatedEndpoint, generateKey: generateSpaceKey };
}

export async function mintSpaceCredential(session: OAuthSession, space: string): Promise<SpaceCredential> {
  return mintSpaceCredentialWith(sessionCredentialDeps(session), space);
}
