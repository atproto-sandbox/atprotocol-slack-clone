import { mintSpaceCredentialWith } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import { groupMembersUri, requireSpaceAuthority, tidNow } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import {
  acceptGroupMembership,
  actorTransport,
  bearerSession,
  createOpenSocialGroup,
  type NetworkActor,
  type PdsNetwork,
} from "./pds-network";

// K4's fixed dataset on OpenSocial groups: a channel per writer count, five messages per writer, and the
// uncounted reads that wait for the Group Host authority to list each write. Shared by the engine's measurement in Node
// (`protocol-tests/sync-budget.ts`) and the real client's in a browser (`protocol-tests/browser/sync-budget.ts`).

export const WRITER_COUNTS = [20, 100, 200] as const;
export const MESSAGES_PER_WRITER = 5;

const groupByOwnerDid = new WeakMap<PdsNetwork, Map<string, Promise<{ groupDid: string; workspace: string }>>>();

/** Uncounted reads the harness uses to wait for the Group Host authority, outside what is measured. */
export class Probe {
  constructor(
    private readonly pds: PdsNetwork,
    private readonly reader: NetworkActor,
    private readonly space: string,
  ) {}

  async waitForNotice(did: string, after: string | null): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const reported = await this.reported(did);
      if (reported !== null && (after === null || reported > after)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The authority never listed the writer's new revision.");
  }

  async waitForCurrentRevision(did: string): Promise<string> {
    const transport = actorTransport(this.pds, this.reader);
    const credential = await mintSpaceCredentialWith(transport, this.space);
    const current = (
      await credential
        .client(await transport.resolvePds(did))
        .query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: this.space, repo: did })
    ).commit.rev;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const reported = await this.reported(did);
      if (reported !== null && reported >= current) return current;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The authority never reported ${did}'s current revision.`);
  }

  private async reported(did: string): Promise<string | null> {
    const transport = actorTransport(this.pds, this.reader);
    const credential = await mintSpaceCredentialWith(transport, this.space);
    const authority = credential.client(await transport.resolvePds(requireSpaceAuthority(this.space)));
    const listed = await authority.query<{ repos: Array<{ $type?: string; repo: string; repoRev?: string }> }>(
      "com.atproto.space.listWriters",
      { space: this.space, limit: 1000 },
    );
    return listed.repos.find((entry) => entry.$type === "com.atproto.space.defs#repoWrite" && entry.repo === did)?.repoRev ?? null;
  }
}

export async function provision(
  pds: PdsNetwork,
  count: number,
): Promise<{ authority: NetworkActor; reader: NetworkActor; writers: NetworkActor[] }> {
  const authority = await pds.createActor("budgetowner", 0);
  const reader = await pds.createActor("budgetreader", 1);
  const writers: NetworkActor[] = [];
  for (let index = 0; index < count; index += 1) {
    writers.push(await pds.createActor(`bw${index}`, (index % 2) as 0 | 1));
  }
  return { authority, reader, writers };
}

export async function ensureBudgetGroup(
  pds: PdsNetwork,
  authority: NetworkActor,
  name = "Budget",
): Promise<{ groupDid: string; workspace: string }> {
  let perOwner = groupByOwnerDid.get(pds);
  if (!perOwner) {
    perOwner = new Map();
    groupByOwnerDid.set(pds, perOwner);
  }
  let cached = perOwner.get(authority.did);
  if (!cached) {
    cached = (async () => {
      const [{ restoreAuthorityGrant }, { createWorkspace }] = await Promise.all([
        import("@flock/operator/operator/authority-grant"),
        import("@flock/operator/operator/kinds/create-workspace"),
      ]);
      const createdGroup = await createOpenSocialGroup(pds, authority, { name });
      const ownerSession = await restoreAuthorityGrant(createdGroup.groupDid);
      await createWorkspace(ownerSession, {
        creator: authority.did,
        name,
        operationId: tidNow(),
      });
      return { groupDid: createdGroup.groupDid, workspace: createdGroup.workspace };
    })();
    perOwner.set(authority.did, cached);
  }
  return cached;
}

const admittedMembersByGroup = new Map<string, Set<string>>();

export async function createChannel(
  pds: PdsNetwork,
  authority: NetworkActor,
  reader: NetworkActor,
  writers: NetworkActor[],
  skey: string,
  workspaceName = "Budget",
): Promise<string> {
  const [{ restoreAuthorityGrant }, { ensureOpenSocialSpace, putAuthorityRecord }, { defaultPublicChannelPolicy }, { mapLimited }] =
    await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/atproto/space-ops"),
      import("@flock/operator/operator/workspace-spaces"),
      import("@flock/protocol/map-limited"),
    ]);

  const { groupDid, workspace } = await ensureBudgetGroup(pds, authority, workspaceName);
  const owner = await restoreAuthorityGrant(groupDid);
  const membersSpace = groupMembersUri(groupDid);

  let admitted = admittedMembersByGroup.get(groupDid);
  if (!admitted) {
    admitted = new Set([authority.did]);
    admittedMembersByGroup.set(groupDid, admitted);
  }

  const neededActors = [reader, ...writers].filter((actor) => !admitted.has(actor.did));
  if (neededActors.length > 0) {
    const nowIso = new Date().toISOString();
    await mapLimited(neededActors, 16, async (actor) => {
      await putAuthorityRecord(owner, membersSpace, OPENSOCIAL_COLLECTION.membership, actor.did, {
        roles: ["member"],
        createdAt: nowIso,
      });
      if (actor.did === reader.did) {
        await acceptGroupMembership(pds, actor, groupDid);
      }
      admitted!.add(actor.did);
    });
  }

  const space = await ensureOpenSocialSpace(owner, SPACE_TYPE.channel, skey, defaultPublicChannelPolicy());
  await putAuthorityRecord(owner, workspace, COLLECTION.directory, skey, {
    skey,
    name: skey,
    visibility: "public",
  });

  await mapLimited(writers, 8, async (writer) => {
    for (let index = 0; index < MESSAGES_PER_WRITER; index += 1) {
      await writeMessage(writer, space, `seed ${index}`);
    }
  });
  const probe = new Probe(pds, reader, space);
  for (const writer of writers) await probe.waitForCurrentRevision(writer.did);
  return space;
}

export async function writeMessage(writer: NetworkActor, space: string, text: string): Promise<string> {
  const rkey = tidNow();
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.createRecord", {
    space,
    repo: writer.did,
    collection: "new.flock.channel.message",
    rkey,
    record: { $type: "new.flock.channel.message", text, createdAt: new Date().toISOString() },
  });
  return rkey;
}

export async function deleteMessage(writer: NetworkActor, space: string, rkey: string): Promise<void> {
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.deleteRecord", {
    space,
    repo: writer.did,
    collection: "new.flock.channel.message",
    rkey,
  });
}

export function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}
