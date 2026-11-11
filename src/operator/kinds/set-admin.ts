import { listSpaceMembers, putSpaceMember } from "@/atproto/space-ops";
import { inboxUri, subjectKey } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import { OperationRejectedError, type OperationContext } from "../journal";
import type { OperatorActor } from "../actor";
import { activeAdmins, getOwnerRecord, writeRoster } from "../workspace-state";
import type { OperationKind } from "./kind";

export const setAdminKind: OperationKind = {
  kind: "setAdmin",
  required: ["subject", "active"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["write-admin-active", "grant-inbox-read", "remove-inbox-read", "write-admin-inactive", "admin-state-verified"],
  endsOwnRole: (request, actorDid) => request.subject === actorDid && request.active === false,
  run: (actor, context, request) => setAdmin(actor, context, request.subject as string, request.active as boolean),
};

async function setAdmin(actor: OperatorActor, context: OperationContext, subject: string, active: boolean): Promise<void> {
  if (subject === actor.workspace.authorityDid) throw new OperationRejectedError("The workspace authority's bootstrap admin state cannot be changed.");
  const roster = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.workspaceRoster, subjectKey(subject));
  if (active) {
    const workspaceMember = (await listSpaceMembers(actor.session, actor.workspace.uri)).some((member) =>
      member.did === subject && member.read && member.write);
    if (roster?.active !== true || !workspaceMember) {
      throw new OperationRejectedError("Only an active workspace member can become an admin.");
    }
  }
  const admins = await activeAdmins(actor);
  if (!active && admins.has(subject) && admins.size <= 1) throw new OperationRejectedError("The last active admin cannot be demoted.");
  const inbox = inboxUri(actor.workspace.authorityDid, actor.workspace.skey);
  if (active) {
    await context.step("write-admin-active", () => writeRoster(actor, actor.workspace.uri, subject, true, COLLECTION.admin));
    await context.step("grant-inbox-read", () => putSpaceMember(actor.session, inbox, subject, true, true));
  } else {
    await context.step("remove-inbox-read", () => putSpaceMember(actor.session, inbox, subject, false, true));
    await context.step("write-admin-inactive", () => writeRoster(actor, actor.workspace.uri, subject, false, COLLECTION.admin));
  }
  await context.step("admin-state-verified", async () => {
    const current = await getOwnerRecord(actor.session, actor.workspace.uri, COLLECTION.admin, subjectKey(subject));
    const member = (await listSpaceMembers(actor.session, inbox)).find((entry) => entry.did === subject);
    if (current?.active !== active || (active && (!member?.read || !member.write)) || (!active && member?.read)) {
      throw new Error("Admin state has not converged with inbox membership.");
    }
  });
}
