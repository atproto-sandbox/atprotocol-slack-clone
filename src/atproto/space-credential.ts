import { JoseKey } from "@atproto/jwk-jose";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { fetchValidatedEndpoint, resolvePds } from "./identity";
import { sessionClient } from "./client";
import { mintSpaceCredentialWith, SpaceCredential, SpaceCredentialError } from "./space-credential-core";

export { SpaceCredential, SpaceCredentialError };

export async function mintSpaceCredential(session: OAuthSession, space: string): Promise<SpaceCredential> {
  return mintSpaceCredentialWith(
    {
      memberClient: sessionClient(session),
      resolvePds,
      fetchEndpoint: fetchValidatedEndpoint,
      generateKey: () => JoseKey.generate(["ES256"]),
    },
    space,
  );
}
