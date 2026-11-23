import { extSpaceUriFor, getExtension } from "@flock/protocol/extensions";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { getOpenSocialSpacePolicy, updateOpenSocialSpacePolicy } from "../../atproto/space-ops";
import type { OperatorActor } from "../actor";
import { OperationRejectedError, type OperationContext } from "../journal";
import { dropMemberList } from "../member-access";
import { allExtInstalls, readExtInstall, writeExtInstall, type ExtInstall } from "../membership";
import { isSpaceNotFound } from "../workspace-state";
import {
  defaultExtensionSpacePolicy,
  disabledExtensionSpacePolicy,
  ensureExtensionSpace,
} from "../workspace-spaces";
import type { OperationKind } from "./kind";

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
    dropMemberList(space);
  });

  const now = new Date().toISOString();
  const install: ExtInstall = existing?.active
    ? { ...existing, space, cleanupComplete: false, updatedAt: now }
    : {
        extId: manifest.id,
        active: true,
        space,
        cleanupComplete: false,
        enabledBy: actor.did,
        enabledAt: now,
        updatedAt: now,
      };
  await context.step("ext-install-record", () => writeExtInstall(actor, install));

  await context.step("ext-members-set", async () => {
    await updateOpenSocialSpacePolicy(actor.session, space, defaultExtensionSpacePolicy());
    dropMemberList(space);
  });

  if (context.completedSteps.includes("ext-members-remove")) {
    await context.step("ext-members-remove", async () => {});
  }

  await context.step("ext-members-verified", async () => {
    const policy = await getOpenSocialSpacePolicy(actor.session, space);
    if (
      !policy ||
      policy.unlisted === true ||
      !policy.grants.some((g) => g.role === "member" && g.read === true && g.write === true)
    ) {
      throw new Error(`Extension ${manifest.id} OpenSocial policy has not converged.`);
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
  await context.step("ext-disable-record", () =>
    writeExtInstall(actor, {
      ...existing,
      active: false,
      cleanupComplete: false,
      disabledAt,
    }),
  );

  await context.step("ext-members-remove", async () => {
    try {
      await updateOpenSocialSpacePolicy(actor.session, space, disabledExtensionSpacePolicy());
      dropMemberList(space);
    } catch (error) {
      if (!isSpaceNotFound(error)) throw error;
    }
  });

  await context.step("ext-members-cleared", async () => {
    try {
      const policy = await getOpenSocialSpacePolicy(actor.session, space);
      if (policy && (policy.grants.some((g) => g.role !== "admin") || policy.unlisted !== true)) {
        throw new Error(`Extension ${manifest.id} grants remain after disable.`);
      }
    } catch (error) {
      if (!isSpaceNotFound(error)) throw error;
    }
  });

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
