import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { isScopeMissingError } from "@flock/protocol/atproto/xrpc";

export type AcceptFailure = { status: number; code: "not_a_member" | "workspace_unavailable" | "permission_not_granted"; error: string };

/** Turns the PDS's refusal to issue a workspace credential into something the invitee can act on. */
export function acceptFailure(error: unknown): AcceptFailure | null {
  if (isScopeMissingError(error)) {
    return { status: 403, code: "permission_not_granted", error: "Permission was not granted, so joining didn't go through. Sign out, sign in again approving every requested permission, then join." };
  }
  if (!(error instanceof SpaceCredentialError)) return null;
  // The reference authority gives a user the policy does not authorize the same answer it gives for a space that does not
  // exist, so it cannot say which. AccountNotAuthorized and NotAuthorized stay handled for authorities that tell the two apart.
  if (error.code === "AccountNotAuthorized" || error.code === "NotAuthorized") {
    return { status: 403, code: "not_a_member", error: "You haven't been added to this workspace yet. Ask an admin to invite your account, then open the invite link again." };
  }
  if (error.code === "SpaceNotFound") {
    return { status: 404, code: "workspace_unavailable", error: "We couldn't open that workspace. It may not exist, or you may not have been added to it yet. Ask an admin to invite your account, then open the invite link again." };
  }
  if (error.code === "SpaceDeleted") {
    return { status: 404, code: "workspace_unavailable", error: "That workspace was deleted." };
  }
  return null;
}
