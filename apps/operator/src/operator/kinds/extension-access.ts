import { listSpaceMembers } from "../../atproto/space-ops";
import { extSpaceUriFor, getExtension } from "@flock/protocol/extensions";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import {
  allExtInstalls,
  diffMemberList,
  expectedExtList,
  listMatches,
  putMissingMembers,
  readExtInstall,
  removeExtraMembers,
  writeExtInstall,
  type ExtInstall,
} from "../membership";
import { ensureExtensionSpace } from "../workspace-spaces";
import { activeRoster, isSpaceNotFound } from "../workspace-state";
import type { OperationKind } from "./kind";

// Extension provisioning lifecycle: enabling creates the extension space first (so a legacy authority grant fails on step 1
// with nothing written), records the install, and grants active roster people read/write access (never apps). Disabling
// marks the install inactive with cleanup incomplete, removes all member access, verifies an empty list, and marks cleanup
// complete so notice registrations can be dropped cleanly.

export const enableExtensionKind: OperationKind = {
  kind: "enableExtension",
  required: ["extId"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["ext-space", "ext-install-record", "ext-members-set", "ext-members-remove", "ext-members-verified"],
  createsSpaces: (actor, request) => {
    const ext = getExtension(String(request.extId));
    return ext ? [extSpaceUriFor(actor.workspace.authorityDid, actor.workspace.skey, ext.id)] : [];
  },
  run: (actor, context, request) => enableExtension(actor, context, String(request.extId)),
};

export const disableExtensionKind: OperationKind = {
  kind: "disableExtension",
  required: ["extId"],
  actor: "admin",
  submittedThrough: "execute",
  steps: ["ext-disable-record", "ext-members-remove", "ext-members-cleared", "ext-cleanup-complete"],
  archivesSpaces: (actor, request) => {
    const ext = getExtension(String(request.extId));
    return ext ? [extSpaceUriFor(actor.workspace.authorityDid, actor.workspace.skey, ext.id)] : [];
  },
  run: (actor, context, request) => disableExtension(actor, context, String(request.extId)),
};

async function enableExtension(
  actor: OperatorActor,
  context: OperationContext,
  rawExtId: string,
  maxExtensions: number = WORKSPACE_ENVELOPE.extensions,
): Promise<void> {
  const manifest = getExtension(rawExtId);
  if (!manifest) throw new OperationRejectedError("Unknown extension.");
  const installs = await allExtInstalls(actor);
  const existing = installs.get(manifest.id) ?? null;
  const activeCount = [...installs.values()].filter((install) => install.active).length;
  if (!existing?.active && activeCount >= maxExtensions) {
    throw new OperationRejectedError(`Workspace extension limit reached (${maxExtensions}).`);
  }
  const space = extSpaceUriFor(actor.workspace.authorityDid, actor.workspace.skey, manifest.id);

  await context.step("ext-space", async () => {
    await ensureExtensionSpace(actor.session, actor.workspace.skey, manifest.id);
  });

  const now = new Date().toISOString();
  const install: ExtInstall = existing?.active
    ? { ...existing, space, cleanupComplete: false, updatedAt: now }
    : { extId: manifest.id, active: true, space, cleanupComplete: false, enabledBy: actor.did, enabledAt: now, updatedAt: now };
  await context.step("ext-install-record", () => writeExtInstall(actor, install));

  const desired = expectedExtList(await activeRoster(actor));
  const authorityDid = actor.workspace.authorityDid;
  const current = await listSpaceMembers(actor.session, space);
  const { toPut, toRemove } = diffMemberList(desired, current, authorityDid);
  if (toPut.length > 0) {
    await context.step("ext-members-set", () => putMissingMembers(actor.session, space, desired, authorityDid));
  }
  if (toRemove.length > 0) {
    await context.step("ext-members-remove", () => removeExtraMembers(actor.session, space, desired, authorityDid));
  }
  await context.step("ext-members-verified", async () => {
    const finalList = toPut.length > 0 || toRemove.length > 0 ? await listSpaceMembers(actor.session, space) : current;
    if (!listMatches(desired, finalList, authorityDid)) {
      throw new Error(`Extension ${manifest.id} member list has not converged with the workspace roster.`);
    }
  });
}

export { enableExtension as enableExtensionWithLimit };

async function disableExtension(actor: OperatorActor, context: OperationContext, rawExtId: string): Promise<void> {
  const manifest = getExtension(rawExtId);
  if (!manifest) throw new OperationRejectedError("Unknown extension.");
  const existing = await readExtInstall(actor, manifest.id);
  if (!existing) throw new OperationRejectedError("This extension is not enabled.");
  if (!existing.active && existing.cleanupComplete) return;

  const space = existing.space;
  const disabledAt = existing.disabledAt ?? new Date().toISOString();
  await context.step("ext-disable-record", () => writeExtInstall(actor, {
    ...existing,
    active: false,
    cleanupComplete: false,
    disabledAt,
  }));

  const authorityDid = actor.workspace.authorityDid;
  let spaceMissing = false;
  let current: Array<{ did: string; read: boolean; write: boolean }> = [];
  try {
    current = await listSpaceMembers(actor.session, space);
  } catch (error) {
    if (isSpaceNotFound(error)) spaceMissing = true;
    else throw error;
  }
  if (!spaceMissing && current.some((member) => member.did !== authorityDid)) {
    await context.step("ext-members-remove", async () => {
      try {
        await removeExtraMembers(actor.session, space, new Map(), authorityDid);
      } catch (error) {
        if (!isSpaceNotFound(error)) throw error;
      }
    });
  }
  if (!spaceMissing) {
    await context.step("ext-members-cleared", async () => {
      try {
        const remaining = await listSpaceMembers(actor.session, space);
        if (!listMatches(new Map(), remaining, authorityDid)) {
          throw new Error(`Extension ${manifest.id} members remain after disable.`);
        }
      } catch (error) {
        if (!isSpaceNotFound(error)) throw error;
      }
    });
  }
  await context.step("ext-cleanup-complete", async () => {
    const latest = await readExtInstall(actor, manifest.id);
    if (!latest || latest.active) return;
    await writeExtInstall(actor, {
      ...latest,
      active: false,
      cleanupComplete: true,
      disabledAt: latest.disabledAt ?? disabledAt,
    });
  });
}
