import type { OAuthSession } from "@atproto/oauth-client-node";
import { fetchValidatedEndpoint, resolveKemKey, resolvePds } from "./identity";
import { sessionClient } from "./client";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import {
  isSpaceDeleted,
  mintSpaceCredentialWith,
  SpaceCredential,
  SpaceCredentialError,
  type SpaceCredentialDeps,
  type SpaceNotifyTarget,
} from "@flock/protocol/atproto/space-credential-core";

export { isSpaceDeleted, SpaceCredential, SpaceCredentialError, type SpaceNotifyTarget };

/** The transports a server-held session reads spaces with: its own client, SSRF-guarded fetch and DID resolution. */
export function sessionCredentialDeps(session: OAuthSession): SpaceCredentialDeps {
  return { memberClient: sessionClient(session), resolvePds, resolveKemKey, fetchEndpoint: fetchValidatedEndpoint, generateKey: generateSpaceKey };
}

export async function mintSpaceCredential(
  session: OAuthSession,
  space: string,
  opts?: { notify?: SpaceNotifyTarget; clientAttestation?: string },
): Promise<SpaceCredential> {
  return mintSpaceCredentialWith(sessionCredentialDeps(session), space, opts);
}
