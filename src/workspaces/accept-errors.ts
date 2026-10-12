import { SpaceCredentialError } from "@/atproto/space-credential-core";
import { isScopeMissingError } from "@/atproto/xrpc";

export type AcceptFailure = { status: number; code: "not_a_member" | "workspace_unavailable" | "permission_not_granted"; error: string };

/** Turns the PDS's refusal to issue a workspace credential into something the invitee can act on. */
export function acceptFailure(error: unknown): AcceptFailure | null {
  if (isScopeMissingError(error)) {
    return { status: 403, code: "permission_not_granted", error: "Permission was not granted, so joining didn't go through. Try joining again." };
  }
  if (!(error instanceof SpaceCredentialError)) return null;
  if (error.code === "UserNotAuthorized") {
    return { status: 403, code: "not_a_member", error: "You haven't been added to this workspace yet. Ask an admin to invite your account, then open the invite link again." };
  }
  if (error.code === "SpaceNotFound" || error.code === "SpaceDeleted") {
    return { status: 404, code: "workspace_unavailable", error: "That workspace doesn't exist or was deleted." };
  }
  return null;
}
