/**
 * Every Slack space is governed by `com.atproto.memberspace.policy`: the authority's member list decides who may
 * read and whose writes are tracked. Only the DM inbox opens its write side to anyone (`publicWrite`), so a
 * stranger can send a request. This is the single owner of the policy object this app sends and reads back.
 */
export const MEMBERSPACE_POLICY = "com.atproto.memberspace.policy" as const;

export type MemberspacePolicy = { $type: typeof MEMBERSPACE_POLICY; publicRead: boolean; publicWrite: boolean };

/** The policy to send to `createSpace`/`updateSpace`. `updateSpace` replaces the whole policy, so always send all of it. */
export function memberspacePolicy(options: { publicWrite?: boolean } = {}): MemberspacePolicy {
  return { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: options.publicWrite ?? false };
}

export type MemberspaceSettings = {
  publicRead: boolean;
  publicWrite: boolean;
  allowedApps: readonly string[] | undefined;
  publishPolicy: boolean;
  publishMembers: boolean;
};

/** The settings of a policy `getSpace` reported, with the authority's defaults (all false) filled in; null for any other policy type. */
export function readMemberspacePolicy(policy: unknown): MemberspaceSettings | null {
  if (typeof policy !== "object" || policy === null || (policy as { $type?: unknown }).$type !== MEMBERSPACE_POLICY) return null;
  const fields = policy as Record<string, unknown>;
  return {
    publicRead: fields.publicRead === true,
    publicWrite: fields.publicWrite === true,
    allowedApps: Array.isArray(fields.allowedApps) ? fields.allowedApps.filter((app): app is string => typeof app === "string") : undefined,
    publishPolicy: fields.publishPolicy === true,
    publishMembers: fields.publishMembers === true,
  };
}

/** Whether a reported policy is exactly the member-list-only policy this app creates (no public side, no app allow-list, nothing published). */
export function isMemberListOnly(policy: unknown): boolean {
  const settings = readMemberspacePolicy(policy);
  return settings !== null && !settings.publicRead && !settings.publicWrite && settings.allowedApps === undefined && !settings.publishPolicy && !settings.publishMembers;
}

/**
 * The policy to send to `updateSpace` to change only `publicWrite`. `updateSpace` replaces the whole policy, and another client
 * may have set an app allow-list or published records on this space, so every other field is kept; `publicRead` stays off
 * because an inbox is never readable by anyone but its members. Refuses a policy that is not a memberspace.
 */
export function withPublicWrite(current: unknown, publicWrite: boolean): Record<string, unknown> {
  if (readMemberspacePolicy(current) === null) throw new Error("The space is governed by an unexpected policy; its settings were not changed.");
  return { ...(current as Record<string, unknown>), $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite };
}
