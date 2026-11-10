import { isNotificationAccepted } from "@/operator/notices";
import { requireSpaceAuthority } from "@/protocol/keys";
import { OperatorAuthError } from "./errors";
import { authenticateOperatorRequest, unverifiedBearerIssuer } from "./security";

/**
 * Authenticates a notice from a space authority (`notifyWrite`, `notifySpaceDeleted`): the app must have registered for the space,
 * and the service authorization must come from the space's own authority. Every refusal (unregistered space, missing or bad
 * authorization, a signer who is not the authority) carries the same message. Before any DID is resolved the token's claimed
 * issuer must already be the space's authority, and the space must be one the app registered, so the only DID this server ever
 * resolves for a notice is the space's own authority's, and only for a space it follows: a stranger can neither make it resolve
 * DIDs of their choosing nor learn which spaces it follows. A transient failure to verify is not a refusal and passes through,
 * so the authority retries.
 */
export async function authenticateSpaceNotification(
  request: Request,
  method: string,
  space: string,
  authenticate: (request: Request, method: string) => Promise<string> = authenticateOperatorRequest,
): Promise<void> {
  const refusal = new OperatorAuthError("Notification is not authorized.");
  if (unverifiedBearerIssuer(request) !== requireSpaceAuthority(space)) throw refusal;
  if (!isNotificationAccepted(space)) throw refusal;
  let issuer: string;
  try {
    issuer = await authenticate(request, method);
  } catch (error) {
    throw error instanceof OperatorAuthError ? refusal : error;
  }
  if (issuer !== requireSpaceAuthority(space)) throw refusal;
}
