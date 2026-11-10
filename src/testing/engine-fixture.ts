import { memberspacePolicy } from "@/atproto/space-policy";
import { CredentialCache } from "@/client/credentials";
import { MemoryStore } from "@/client/memory-store";
import type { SyncStore } from "@/client/store";
import { SyncCore, type SyncOptions, type WindowResult } from "@/client/sync";
import type { ClientTransport } from "@/client/transport";
import { acceptanceRecordKey, channelUri, subjectKey } from "@/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";
import type { FakeNetwork } from "./fake-network";

// Test-only helpers for the engine on the fake network: an account's transport, a channel with members, keys, and a
// sync core reading a channel's messages with its reactions alongside.

export const AUTHORITY = "did:plc:authority";

export function transportFor(network: FakeNetwork, did: string): ClientTransport {
  if (!network.hasAccount(did)) network.createAccount(did, "pds1");
  return {
    did, memberClient: network.clientFor(did), resolvePds: network.resolvePds, resolveKemKey: network.resolveKemKey,
    fetchEndpoint: network.fetchEndpoint, generateKey: network.generateKey, now: network.now,
  };
}

/** A channel space of `authority`, with every member able to read and write. */
export async function createChannel(network: FakeNetwork, skey: string, members: readonly string[], authority = AUTHORITY): Promise<string> {
  if (!network.hasAccount(authority)) network.createAccount(authority, "pds1");
  const owner = network.clientFor(authority);
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.channel, skey, policy: memberspacePolicy() });
  const space = channelUri(authority, skey);
  for (const member of members) {
    if (!network.hasAccount(member)) network.createAccount(member, member.endsWith("2") ? "pds2" : "pds1");
    await owner.procedure("com.atproto.memberspace.putMember", { space, did: member, read: true, write: true });
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

export async function writeMessage(network: FakeNetwork, did: string, space: string, n: number, text = `message ${n}`): Promise<string> {
  await network.writeAs(did, space, COLLECTION.message, key(n), { text, createdAt: "2026-11-10T12:00:00.000Z" });
  return key(n);
}

export function syncFor(network: FakeNetwork, did: string, input: { store?: SyncStore; options?: Partial<SyncOptions> } = {}): { core: SyncCore; store: SyncStore } {
  const transport = transportFor(network, did);
  const store = input.store ?? new MemoryStore();
  return { core: new SyncCore({ transport, credentials: new CredentialCache(transport), store, options: input.options }), store };
}

/** Opens a channel (its writer set) and reads one page of messages, with reactions held alongside; every record is shown. */
export async function readChannel(core: SyncCore, space: string, input: { limit?: number; before?: { key: string; uri: string } } = {}): Promise<WindowResult> {
  const writers = await core.writers(space);
  return core.read({
    sources: writers.map((writer) => ({ space, repo: writer.did })),
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
  workspace: string;
  inbox: string;
  channels: Record<string, string>;
};

/**
 * A workspace as the operator leaves it: the workspace, inbox and channel spaces, the authority's profile, roster, admin,
 * directory and private-roster records, and member lists with the bits each role gets. Members have accepted (written
 * their acceptance record), so discovery finds the workspace for them.
 */
export async function createWorkspace(network: FakeNetwork, input: {
  members: readonly string[];
  admins?: readonly string[];
  channels: ReadonlyArray<{ skey: string; visibility: "public" | "private" | "transitioning" | "archived"; members?: readonly string[] }>;
  skey?: string;
  authority?: string;
}): Promise<WorkspaceFixture> {
  const authority = input.authority ?? AUTHORITY;
  const skey = input.skey ?? "acme";
  if (!network.hasAccount(authority)) network.createAccount(authority, "pds1");
  const owner = network.clientFor(authority);
  const create = async (spaceType: string, spaceKey: string) =>
    (await owner.procedure<unknown, { uri: string }>("com.atproto.space.createSpace", { spaceType, skey: spaceKey, policy: memberspacePolicy() })).uri;
  const putMember = (space: string, did: string, read: boolean, write: boolean) =>
    owner.procedure("com.atproto.memberspace.putMember", { space, did, read, write });
  const workspace = await create(SPACE_TYPE.workspace, skey);
  const inbox = await create(SPACE_TYPE.inbox, skey);
  const admins = new Set([authority, ...(input.admins ?? [])]);
  const updatedAt = "2026-11-10T12:00:00.000Z";
  await network.writeAs(authority, workspace, COLLECTION.workspaceProfile, "self", { name: `Workspace ${skey}`, createdAt: updatedAt });
  for (const did of [authority, ...input.members]) {
    if (!network.hasAccount(did)) network.createAccount(did, did.endsWith("2") ? "pds2" : "pds1");
    await network.writeAs(authority, workspace, COLLECTION.workspaceRoster, subjectKey(did), { subject: did, active: true, updatedAt });
    if (admins.has(did)) await network.writeAs(authority, workspace, COLLECTION.admin, subjectKey(did), { subject: did, active: true, updatedAt });
    if (did === authority) continue;
    await putMember(workspace, did, true, true);
    await putMember(inbox, did, admins.has(did), true);
  }
  const channels: Record<string, string> = {};
  for (const channel of input.channels) {
    const channelSkey = `${skey}-${channel.skey}`;
    const space = await create(SPACE_TYPE.channel, channelSkey);
    channels[channel.skey] = space;
    await network.writeAs(authority, workspace, COLLECTION.directory, channelSkey, { skey: channelSkey, name: channel.skey, visibility: channel.visibility });
    const members = channel.visibility === "private" ? channel.members ?? [] : input.members;
    for (const did of members) {
      await putMember(space, did, true, true);
      if (channel.visibility === "private") await network.writeAs(authority, space, COLLECTION.channelRoster, subjectKey(did), { subject: did, active: true, updatedAt });
    }
  }
  for (const did of input.members) {
    await network.writeAs(did, workspace, COLLECTION.acceptance, acceptanceRecordKey(workspace), { workspace, createdAt: updatedAt });
  }
  return { workspace, inbox, channels };
}
