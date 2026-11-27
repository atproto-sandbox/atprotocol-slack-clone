import { CredentialCache } from "../credentials";
import { MemoryStore } from "../memory-store";
import type { SyncStore } from "../store";
import { SyncCore, type SyncOptions, type WindowResult } from "../sync";
import type { ClientTransport } from "../transport";
import {
  channelRoleKey,
  channelUri,
  groupMembersUri,
  inboxUri,
  parseSpaceUri,
  SELF_SKEY,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_POLICY,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import type { FakeNetwork } from "@flock/testing/fake-network";

// Test-only helpers for the engine on the fake network: an account's transport, an OpenSocial group channel with members,
// keys, and a sync core reading a channel's messages with its reactions alongside.

export const AUTHORITY = "did:plc:authorityaaaaaaaaaaaaaaa";

export function plcDidForLabel(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z2-7]/g, "").slice(0, 18);
  return `did:plc:grp${cleaned.padEnd(21, "a")}`;
}

export function transportFor(network: FakeNetwork, did: string): ClientTransport {
  if (!network.hasAccount(did)) network.createAccount(did, "pds1");
  return {
    did,
    memberClient: network.clientFor(did),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: network.fetchEndpoint,
    generateKey: network.generateKey,
    now: network.now,
  };
}

async function ensureGroupOnNetwork(
  network: FakeNetwork,
  groupDid: string,
  opts: { name?: string; joinPolicy?: "open" | "approval" | "invite"; publicMeta?: boolean } = {},
): Promise<void> {
  if (!network.hasAccount(groupDid)) {
    await network.createGroupAccount(groupDid, {
      name: opts.name ?? "Group",
      joinPolicy: opts.joinPolicy ?? "invite",
      publicMeta: opts.publicMeta ?? true,
    });
    return;
  }
  const membersSpace = groupMembersUri(groupDid);
  const owner = network.clientFor(groupDid);
  const existing = await owner
    .query("com.atproto.space.getSpace", { space: membersSpace })
    .then(() => true, () => false);
  if (!existing) {
    await network.createGroupAccount(groupDid, {
      name: opts.name ?? "Group",
      joinPolicy: opts.joinPolicy ?? "invite",
      publicMeta: opts.publicMeta ?? true,
    });
  }
}

/** A channel space of OpenSocial group `authority`, with every listed member able to read and write via `channel-<skey>` role. */
export async function createChannel(
  network: FakeNetwork,
  skey: string,
  members: readonly string[],
  authority = AUTHORITY,
): Promise<string> {
  await ensureGroupOnNetwork(network, authority);
  const owner = network.clientFor(authority);
  const membersSpace = groupMembersUri(authority);
  const roleKey = channelRoleKey(skey);
  const createdAt = "2026-11-10T12:00:00.000Z";

  // Ensure at least one human member exists before governance role writes so post-governance human custody checks pass.
  for (const member of members) {
    if (!network.hasAccount(member)) network.createAccount(member, member.endsWith("2") ? "pds2" : "pds1");
    if (member === authority) continue;
    const exists = await owner
      .query("com.atproto.space.getRecord", {
        space: membersSpace,
        repo: authority,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: member,
      })
      .then(() => true, () => false);
    if (!exists) {
      await owner.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: authority,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: member,
        record: {
          $type: OPENSOCIAL_COLLECTION.membership,
          roles: ["member"],
          createdAt,
        },
      });
    }
  }

  await owner.procedure("com.atproto.space.putRecord", {
    space: membersSpace,
    repo: authority,
    collection: OPENSOCIAL_COLLECTION.role,
    rkey: roleKey,
    record: {
      $type: OPENSOCIAL_COLLECTION.role,
      displayName: `#${skey} member`,
    },
  });

  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [{ role: roleKey, read: true, write: true }],
    },
  });

  const space = channelUri(authority, skey);
  for (const member of members) {
    if (member === authority) continue;
    const prev = await owner
      .query<{ value: { roles?: string[] } }>("com.atproto.space.getRecord", {
        space: membersSpace,
        repo: authority,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: member,
      })
      .then((res) => res.value.roles ?? ["member"], () => ["member"]);
    const nextRoles = [...new Set([...prev, roleKey])];
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: authority,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: member,
      record: {
        $type: OPENSOCIAL_COLLECTION.membership,
        roles: nextRoles,
        createdAt,
      },
    });
  }
  return space;
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** A record key whose order follows `n`: key(2) sorts after key(1). */
export function key(n: number): string {
  let rest = n;
  let tid = "";
  for (let i = 0; i < 13; i++) {
    tid = TID_ALPHABET[rest % 32]! + tid;
    rest = Math.floor(rest / 32);
  }
  return tid;
}

export async function writeMessage(
  network: FakeNetwork,
  did: string,
  space: string,
  n: number,
  text = `message ${n}`,
): Promise<string> {
  await network.writeAs(did, space, COLLECTION.message, key(n), { text, createdAt: "2026-11-10T12:00:00.000Z" });
  return key(n);
}

export function syncFor(
  network: FakeNetwork,
  did: string,
  input: { store?: SyncStore; options?: Partial<SyncOptions> } = {},
): { core: SyncCore; store: SyncStore } {
  const transport = transportFor(network, did);
  const store = input.store ?? new MemoryStore();
  return {
    core: new SyncCore({ transport, credentials: new CredentialCache(transport), store, options: input.options }),
    store,
  };
}

/** Opens a channel (its writer set) and reads one page of messages, with reactions held alongside; every record is shown. */
export async function readChannel(
  core: SyncCore,
  space: string,
  input: { limit?: number; before?: { key: string; uri: string } } = {},
): Promise<WindowResult> {
  const authorityDid = parseSpaceUri(space)?.authorityDid;
  const writers = await core.writers(space);
  return core.read({
    sources: writers.filter((writer) => writer.did !== authorityDid).map((writer) => ({ space, repo: writer.did })),
    window: COLLECTION.message,
    alongside: [COLLECTION.reaction],
    limit: input.limit ?? 10,
    before: input.before,
    select: async (candidates, limit) => candidates.slice(0, limit),
  });
}

/** The calls the network served while `run` ran, by method. */
export async function countCalls(network: FakeNetwork, run: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = new Map(network.calls);
  await run();
  const counted: Record<string, number> = {};
  for (const [method, count] of network.calls) {
    const delta = count - (before.get(method) ?? 0);
    if (delta > 0) counted[method] = delta;
  }
  return counted;
}

export type WorkspaceFixture = {
  groupDid: string;
  workspace: string;
  inbox: string;
  meta: string;
  members: string;
  channels: Record<string, string>;
};

/**
 * An OpenSocial Flock workspace as the operator leaves it: `meta/self`, `members/self`, `workspace/self`, `inbox/self`,
 * and channel spaces with `group.opensocial.policy` RBAC, `membership/<did>`, and member-authored `acceptance/self`.
 */
export async function createWorkspace(
  network: FakeNetwork,
  input: {
    members: readonly string[];
    admins?: readonly string[];
    moderators?: readonly string[];
    pendingMembers?: readonly string[];
    channels: ReadonlyArray<{
      skey: string;
      visibility: "public" | "private" | "transitioning" | "archived";
      members?: readonly string[];
    }>;
    name?: string;
    skey?: string;
    authority?: string;
    joinPolicy?: "open" | "approval" | "invite";
    publicMeta?: boolean;
  },
): Promise<WorkspaceFixture> {
  const label = input.skey ?? "acme";
  const groupDid = input.authority ?? (input.skey && input.skey !== SELF_SKEY ? plcDidForLabel(input.skey) : AUTHORITY);
  const displayName = input.name ?? `Workspace ${label}`;

  await network.createGroupAccount(groupDid, {
    name: displayName,
    joinPolicy: input.joinPolicy ?? "invite",
    publicMeta: input.publicMeta ?? true,
  });

  const owner = network.clientFor(groupDid);
  const workspace = workspaceUri(groupDid);
  const inbox = inboxUri(groupDid, SELF_SKEY);
  const membersSpace = groupMembersUri(groupDid);
  const metaSpace = `at:space/${groupDid}/group.opensocial.meta/self`;

  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });

  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.inbox,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", write: true },
      ],
    },
  });

  const admins = new Set(input.admins ?? []);
  const moderators = new Set(input.moderators ?? []);
  const pendingSet = new Set(input.pendingMembers ?? []);
  const allHumanMembers = [...new Set([...input.members, ...pendingSet])].filter((did) => did !== groupDid);
  const createdAt = "2026-11-10T12:00:00.000Z";

  const privateRolesByMember = new Map<string, string[]>();
  const channels: Record<string, string> = {};

  for (const channel of input.channels) {
    const channelSkey = channel.skey;
    const privRole = channelRoleKey(channelSkey);
    if (channel.visibility === "private") {
      await owner.procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.role,
        rkey: privRole,
        record: {
          $type: OPENSOCIAL_COLLECTION.role,
          displayName: `#${channelSkey} member`,
        },
      });
      for (const did of channel.members ?? []) {
        const list = privateRolesByMember.get(did) ?? [];
        list.push(privRole);
        privateRolesByMember.set(did, list);
      }
    }

    const policy =
      channel.visibility === "archived"
        ? {
            $type: OPENSOCIAL_POLICY,
            publicRead: false,
            unlisted: true,
            grants: [],
          }
        : channel.visibility === "private"
          ? {
              $type: OPENSOCIAL_POLICY,
              publicRead: false,
              unlisted: true,
              grants: [{ role: privRole, read: true, write: true }],
            }
          : {
              $type: OPENSOCIAL_POLICY,
              publicRead: false,
              unlisted: false,
              grants: [
                { role: "admin", read: true, write: true },
                { role: "moderator", read: true, write: true },
                { role: "member", read: true, write: true },
              ],
            };

    await owner.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.channel,
      skey: channelSkey,
      policy,
    });
    channels[channel.skey] = channelUri(groupDid, channelSkey);
    await network.writeAs(groupDid, workspace, COLLECTION.directory, channelSkey, {
      skey: channelSkey,
      name: channel.skey,
      visibility: channel.visibility,
    });
  }

  for (const did of allHumanMembers) {
    if (!network.hasAccount(did)) network.createAccount(did, did.endsWith("2") ? "pds2" : "pds1");
    const roles = new Set<string>(["member"]);
    if (admins.has(did)) roles.add("admin");
    if (moderators.has(did)) roles.add("moderator");
    for (const pr of privateRolesByMember.get(did) ?? []) roles.add(pr);

    await owner.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: {
        $type: OPENSOCIAL_COLLECTION.membership,
        roles: [...roles],
        createdAt,
      },
    });

    if (!pendingSet.has(did)) {
      const memRec = await owner.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: membersSpace,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: did,
      });
      const inc = memRec.value[FLOCK_EXTENSION_FIELD.incarnation];
      await network.writeAs(did, membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY, {
        createdAt,
        ...(typeof inc === "string" ? { [FLOCK_EXTENSION_FIELD.incarnation]: inc } : {}),
      });
    }
  }

  return { groupDid, workspace, inbox, meta: metaSpace, members: membersSpace, channels };
}
