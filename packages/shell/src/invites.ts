import { memberspacePolicy, readMemberspacePolicy } from "@flock/protocol/atproto/space-policy";
import { isMissingXrpcResource, isSpaceAlreadyExists, XrpcError, type AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { isDid, personalInboxUri, SELF_SKEY } from "@flock/protocol/keys";
import { ATGRP_SPACE_TYPE } from "@flock/protocol/nsids";

export class IncompatibleInvitesSpacePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleInvitesSpacePolicyError";
  }
}

export type InvitesSpaceDeps = {
  readonly did: string;
  readonly memberClient: AtprotoClient;
};

const inFlightByViewer = new Map<string, Promise<string>>();

/**
 * Idempotently provisions and verifies the viewer's personal `org.atgrp.inbox/self` space:
 * - Serialized across tabs via `navigator.locks` (`flock-desk-invites-provision:<viewerDid>`) when available,
 *   and single-flight deduplicated in-memory per `viewerDid`.
 * - Fails closed with `IncompatibleInvitesSpacePolicyError` unless ALL four invariants hold:
 *   1. `settings.publicWrite === true`
 *   2. `settings.publicRead === false`
 *   3. `settings.allowedApps === undefined` (rejects even `[]`)
 *   4. `(memberPage.members?.length ?? 0) === 0`
 */
export function ensureInvitesSpace(deps: InvitesSpaceDeps): Promise<string> {
  const viewerDid = deps.did;
  if (!isDid(viewerDid)) {
    return Promise.reject(new TypeError("Invalid viewer DID."));
  }

  const existingInFlight = inFlightByViewer.get(viewerDid);
  if (existingInFlight) return existingInFlight;

  const invitesSpace = personalInboxUri(viewerDid);

  const execute = async (): Promise<string> => {
    let existing: { policy: unknown };
    try {
      existing = await deps.memberClient.query<{ policy: unknown }>("com.atproto.space.getSpace", {
        space: invitesSpace,
      });
    } catch (error) {
      const isSpaceNotFound =
        isMissingXrpcResource(error) || (error instanceof XrpcError && error.code === "SpaceNotFound");
      if (!isSpaceNotFound) throw error;
      try {
        await deps.memberClient.procedure("com.atproto.space.createSpace", {
          spaceType: ATGRP_SPACE_TYPE.inbox,
          skey: SELF_SKEY,
          policy: memberspacePolicy({ publicWrite: true }),
        });
      } catch (createErr) {
        if (!isSpaceAlreadyExists(createErr)) throw createErr;
      }
      existing = await deps.memberClient.query<{ policy: unknown }>("com.atproto.space.getSpace", {
        space: invitesSpace,
      });
    }

    const memberPage = await deps.memberClient.query<{ members?: unknown[] }>(
      "com.atproto.memberspace.listMembers",
      {
        space: invitesSpace,
        limit: 1,
      },
    );

    const settings = readMemberspacePolicy(existing.policy);
    if (
      !settings ||
      settings.publicWrite !== true ||
      settings.publicRead !== false ||
      settings.allowedApps !== undefined ||
      (memberPage.members?.length ?? 0) !== 0
    ) {
      throw new IncompatibleInvitesSpacePolicyError(
        "Personal org.atgrp.inbox/self space has an incompatible policy or non-empty member list.",
      );
    }

    return invitesSpace;
  };

  const runWithLock = async (): Promise<string> => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks && typeof locks.request === "function") {
      return (await locks.request(`flock-desk-invites-provision:${viewerDid}`, { mode: "exclusive" }, execute)) as string;
    }
    return execute();
  };

  const promise = runWithLock().finally(() => {
    if (inFlightByViewer.get(viewerDid) === promise) {
      inFlightByViewer.delete(viewerDid);
    }
  });
  inFlightByViewer.set(viewerDid, promise);
  return promise;
}
