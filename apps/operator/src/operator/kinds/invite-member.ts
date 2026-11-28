import type * as GetRecord from "@flock/protocol/lexicons/api/types/com/atproto/space/getRecord";
import { personalInboxUri } from "@flock/protocol/keys";
import { ATGRP_COLLECTION } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { sessionClient } from "../../atproto/client";
import { putAuthorityRecord } from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import {
  defaultRoleKeys,
  humanMemberDids,
  putMembershipRoles,
  readGroupGovernanceState,
} from "../workspace-state";
import type { OperationKind, OperatorRequest } from "./kind";

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const inviteMemberKind: OperationKind = {
  kind: "inviteMember",
  required: ["subject"],
  optional: ["expiresAt"],
  actor: "admin",
  submittedThrough: "execute",
  steps: [
    "member-workspace",
    "member-inbox-writer",
    "member-app-inbox-{app}",
    "member-public-channel-{skey}",
    "member-ext-{extId}",
    "member-workspace-roster",
    "member-invite-record",
    "member-state-verified",
  ],
  run: (actor, context, request) =>
    inviteMember(actor, context, request as OperatorRequest & { subject: string; expiresAt?: string }),
};

async function inviteMember(
  actor: OperatorActor,
  context: OperationContext,
  request: OperatorRequest & { subject: string; expiresAt?: string },
): Promise<void> {
  const groupDid = actor.workspace.authorityDid;
  const subject = request.subject;
  if (subject === groupDid) {
    throw new OperationRejectedError("The group account cannot be invited as a human member.");
  }

  const isExpiringInvitation = request.expiresAt !== undefined;
  if (isExpiringInvitation) {
    const expMs =
      typeof request.expiresAt === "string" && ISO_DATETIME_RE.test(request.expiresAt)
        ? Date.parse(request.expiresAt)
        : Number.NaN;
    if (
      typeof request.expiresAt !== "string" ||
      !Number.isFinite(expMs) ||
      (!context.completedSteps.includes("member-invite-record") && expMs <= Date.now())
    ) {
      throw new OperationRejectedError("Invitation expiresAt must be a valid future datetime.");
    }
  }

  const state = await readGroupGovernanceState(actor.session, groupDid);
  if (state.knownAppSubjects.has(subject)) {
    throw new OperationRejectedError("An installed app is not invited as a person; change its access instead.");
  }

  if (
    isExpiringInvitation &&
    !context.completedSteps.includes("member-invite-record") &&
    state.memberships.has(subject)
  ) {
    throw new OperationRejectedError("Account is already a member of this workspace.");
  }

  const currentHumans = humanMemberDids(state, groupDid);
  if (!currentHumans.has(subject) && currentHumans.size >= WORKSPACE_ENVELOPE.members) {
    throw new OperationRejectedError(`Workspace member limit reached (${WORKSPACE_ENVELOPE.members}).`);
  }

  const defaults = defaultRoleKeys(state);
  if (defaults.length === 0) {
    throw new OperationRejectedError("NoDefaultRole");
  }

  if (isExpiringInvitation) {
    const expiresAt = request.expiresAt!;
    await context.step("member-invite-record", async () => {
      await putAuthorityRecord(
        actor.session,
        personalInboxUri(subject),
        ATGRP_COLLECTION.invite,
        context.operationId,
        {
          createdAt: new Date().toISOString(),
          expiresAt,
        },
      );
    });
  } else {
    // Direct Membership Grant mode: single O(1) `putRecord(membership)` write in `members/self` grants access across all public channels & extensions!
    await context.step("member-workspace", async () => {
      const latest = await readGroupGovernanceState(actor.session, groupDid);
      if (latest.memberships.has(subject)) return;
      await putMembershipRoles(actor.session, groupDid, subject, defaults);
    });
  }

  // Legacy step replay markers (no-ops under OpenSocial flat union RBAC):
  if (context.completedSteps.includes("member-inbox-writer")) {
    await context.step("member-inbox-writer", async () => {});
  }
  for (const prev of context.completedSteps) {
    if (prev.startsWith("member-app-inbox-")) {
      const app = prev.slice("member-app-inbox-".length);
      await context.step(`member-app-inbox-${app}`, async () => {});
    } else if (prev.startsWith("member-public-channel-")) {
      const skey = prev.slice("member-public-channel-".length);
      await context.step(`member-public-channel-${skey}`, async () => {});
    } else if (prev.startsWith("member-ext-")) {
      const extId = prev.slice("member-ext-".length);
      await context.step(`member-ext-${extId}`, async () => {});
    }
  }
  if (context.completedSteps.includes("member-workspace-roster")) {
    await context.step("member-workspace-roster", async () => {});
  }

  await context.step("member-state-verified", async () => {
    const latest = await readGroupGovernanceState(actor.session, groupDid);
    if (isExpiringInvitation) {
      const stored = await sessionClient(actor.session).query<GetRecord.OutputSchema>(
        "com.atproto.space.getRecord",
        {
          space: personalInboxUri(subject),
          repo: groupDid,
          collection: ATGRP_COLLECTION.invite,
          rkey: context.operationId,
        },
      );
      if (!stored.value) {
        throw new Error("Group invitation record has not converged.");
      }
      if (latest.memberships.has(subject)) {
        throw new OperationRejectedError("Expiring invitation must not grant immediate membership.");
      }
    } else if (!latest.memberships.has(subject)) {
      throw new Error("Group membership record has not converged.");
    }
  });
}
