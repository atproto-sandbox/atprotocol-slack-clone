import { mintSpaceCredentialWith } from "@/atproto/space-credential-core";
import { AtprotoClient } from "@/atproto/xrpc";
import { actorTransport, bearerSession, type NetworkActor, type PdsNetwork } from "./pds-network";

// K4's fixed dataset (`.ai/plans/platform-refactor.md`): a channel per writer count, five messages per writer, and the
// uncounted reads that wait for the authority to list each write. Shared by the engine's measurement in Node
// (`protocol-tests/sync-budget.ts`) and the real client's in a browser (`protocol-tests/browser/sync-budget.ts`).

export const WRITER_COUNTS = [20, 100, 200] as const;
export const MESSAGES_PER_WRITER = 5;

/** Uncounted reads the harness uses to wait for the authority, outside what is measured. */
export class Probe {
  constructor(private readonly pds: PdsNetwork, private readonly reader: NetworkActor, private readonly space: string) {}

  /** Waits until the authority lists the writer at a revision newer than the one given. */
  async waitForNotice(did: string, after: string | null): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const reported = await this.reported(did);
      if (reported !== null && (after === null || reported > after)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The authority never listed the writer's new revision.");
  }

  /** Waits until the authority reports the writer's current revision, read at the writer's own host. */
  async waitForCurrentRevision(did: string): Promise<string> {
    const transport = actorTransport(this.pds, this.reader);
    const credential = await mintSpaceCredentialWith(transport, this.space);
    const current = (await credential.client(await transport.resolvePds(did)).query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: this.space, repo: did })).commit.rev;
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
    const authority = credential.client(await transport.resolvePds(this.space.slice("at://".length).split("/")[0]!));
    const listed = await authority.query<{ repos: Array<{ did: string; repoRev: string }> }>("com.atproto.space.listRepos", { space: this.space, limit: 1000 });
    return listed.repos.find((repo) => repo.did === did)?.repoRev ?? null;
  }
}

export async function provision(pds: PdsNetwork, count: number): Promise<{ authority: NetworkActor; reader: NetworkActor; writers: NetworkActor[] }> {
  const authority = await pds.createActor("budgetowner", 0);
  const reader = await pds.createActor("budgetreader", 1);
  const writers: NetworkActor[] = [];
  for (let index = 0; index < count; index += 1) writers.push(await pds.createActor(`bw${index}`, (index % 2) as 0 | 1));
  return { authority, reader, writers };
}

export async function createChannel(pds: PdsNetwork, authority: NetworkActor, reader: NetworkActor, writers: NetworkActor[], skey: string): Promise<string> {
  const [{ ensureMemberListSpace, putSpaceMember }, { mapLimited }] = await Promise.all([import("@/atproto/space-ops"), import("@/lib/map-limited")]);
  const owner = bearerSession(authority) as never;
  const space = await ensureMemberListSpace(owner, "new.flock.channel", skey);
  await putSpaceMember(owner, space, reader.did, true, true);
  await mapLimited(writers, 8, (writer) => putSpaceMember(owner, space, writer.did, true, true));
  await mapLimited(writers, 8, async (writer) => {
    for (let index = 0; index < MESSAGES_PER_WRITER; index += 1) await writeMessage(writer, space, `seed ${index}`);
  });
  // Wait until the authority reports every writer at its final seeded revision, so each run measures the same dataset.
  const probe = new Probe(pds, reader, space);
  for (const writer of writers) await probe.waitForCurrentRevision(writer.did);
  return space;
}

export async function writeMessage(writer: NetworkActor, space: string, text: string): Promise<string> {
  const { tidNow } = await import("@/protocol/keys");
  const rkey = tidNow();
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.createRecord", {
    space, repo: writer.did, collection: "new.flock.channel.message", rkey,
    record: { $type: "new.flock.channel.message", text, createdAt: new Date().toISOString() },
  });
  return rkey;
}

export async function deleteMessage(writer: NetworkActor, space: string, rkey: string): Promise<void> {
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.deleteRecord", {
    space, repo: writer.did, collection: "new.flock.channel.message", rkey,
  });
}

export function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}
