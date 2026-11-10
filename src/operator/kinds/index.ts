import { archiveChannelKind } from "./archive-channel";
import { bootstrapWorkspaceKind } from "./bootstrap-workspace";
import { createChannelKind } from "./create-channel";
import { decideJoinRequestKind } from "./decide-join-request";
import { inviteMemberKind } from "./invite-member";
import type { OperationKind } from "./kind";
import { leaveChannelKind } from "./leave-channel";
import { reconcileWorkspaceKind } from "./reconcile-workspace";
import { leaveWorkspaceKind, removeMemberKind } from "./remove-member";
import { setAdminKind } from "./set-admin";
import { transitionChannelKind } from "./transition-channel";

/** Every persisted operation kind, by name. The journal replays rows through this table. */
export const OPERATION_KINDS: Readonly<Record<string, OperationKind>> = Object.fromEntries([
  bootstrapWorkspaceKind, inviteMemberKind, removeMemberKind, setAdminKind, createChannelKind, transitionChannelKind,
  archiveChannelKind, decideJoinRequestKind, leaveWorkspaceKind, leaveChannelKind, reconcileWorkspaceKind,
].map((kind) => [kind.kind, kind]));

export function operationKind(name: unknown): OperationKind | undefined {
  return typeof name === "string" && Object.hasOwn(OPERATION_KINDS, name) ? OPERATION_KINDS[name] : undefined;
}
