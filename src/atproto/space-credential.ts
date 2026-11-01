import type { OAuthSession } from "@atproto/oauth-client-node";
import { fetchValidatedEndpoint, resolveKemKey, resolvePds } from "./identity";
import { sessionClient } from "./client";
import { generateSpaceKey } from "./space-key";
import { mintSpaceCredentialWith, SpaceCredential, SpaceCredentialError } from "./space-credential-core";

export { SpaceCredential, SpaceCredentialError };

export async function mintSpaceCredential(session: OAuthSession, space: string): Promise<SpaceCredential> {
  return mintSpaceCredentialWith(
    {
      memberClient: sessionClient(session),
      resolvePds,
      resolveKemKey,
      fetchEndpoint: fetchValidatedEndpoint,
      generateKey: generateSpaceKey,
    },
    space,
  );
}
