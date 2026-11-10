import { kemKeyFromDidDocument } from "@/atproto/kem-key";
import { generateSpaceKey } from "@/atproto/space-key";
import { mintSpaceCredentialWith, type SpaceCredential } from "@/atproto/space-credential-core";
import { AtprotoClient } from "@/atproto/xrpc";
import { bearerSession, startPdsNetwork, type NetworkActor, type PdsNetwork } from "./support/pds-network";

// K4 of `.ai/plans/platform-refactor.md`: the upstream cost of the planned sync (refresh a writer between two revision
// reads; `listRepos` with the stored `spaceRev` as the hint) for one reader, at 20, 100 and 200 writers. It is a
// prototype of the R4 sync core, measured in Node against the pinned PDS network. A browser over HTTP/1.1 opens at most
// six connections per origin, so every request here waits for one of six slots per host to emulate that limit. Each run
// writes one message, checks the reader read it, and deletes it again, so every first open reads the same dataset. The
// delay before the authority lists a new write (what a change-feed tick waits on) is reported separately from the
// reader's own cost.
//
// Run: ATPROTO_PINNED_CHECKOUT=../atproto-spaces-phase3 node --import tsx protocol-tests/sync-budget.ts [runs]

const WRITER_COUNTS = [20, 100, 200] as const;
const MESSAGES_PER_WRITER = 5;
const PAGE = 100;
const PER_ORIGIN_CONNECTIONS = 6;
const RUNS = Number(process.argv[2] ?? 10);

type Calls = Map<string, number>;
type WriterState = { syncedRev: string; coverage: string | null; messageKeys: ReadonlySet<string> };
type Measurement = { calls: number; byMethod: Record<string, number>; ms: number };

async function main(): Promise<void> {
  const pds = await startPdsNetwork("sync-budget");
  try {
    const { authority, reader, writers } = await provision(pds, Math.max(...WRITER_COUNTS));
    const report: Array<{ writers: number; phase: string; median: number; p95: number; calls: number; byMethod: Record<string, number> }> = [];
    for (const count of WRITER_COUNTS) {
      const space = await createChannel(pds, authority, reader, writers.slice(0, count), `budget-${count}`);
      const results: Record<"first open" | "reopen" | "one new message", Measurement[]> = { "first open": [], reopen: [], "one new message": [] };
      const noticeDelays: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const client = new PrototypeSync(pds, reader, space);
        results["first open"].push(await client.measure(() => client.open()));
        client.assertHolds(writers.slice(0, count).map((writer) => writer.did), MESSAGES_PER_WRITER);
        results.reopen.push(await client.measure(() => client.reopen()));
        const writer = writers[run % count]!;
        const written = performance.now();
        const rkey = await writeMessage(writer, space, `run ${run}`);
        await client.waitForNotice(writer.did);
        noticeDelays.push(performance.now() - written);
        results["one new message"].push(await client.measure(() => client.reopen()));
        if (!client.holds(writer.did, rkey)) throw new Error(`The reopen after a new message did not read it (${writer.did}/${rkey}).`);
        // Restore the dataset, so every run's first open reads the same records.
        await deleteMessage(writer, space, rkey);
        await client.waitForCurrentRevision(writer.did);
      }
      const delays = [...noticeDelays].sort((left, right) => left - right);
      process.stdout.write(`${count} writers, write notice reaches the authority (25 ms polling): median ${percentile(delays, 0.5).toFixed(0)} ms, p95 ${percentile(delays, 0.95).toFixed(0)} ms\n`);
      for (const [phase, measurements] of Object.entries(results)) {
        const counts = new Set(measurements.map((measurement) => measurement.calls));
        if (counts.size !== 1) throw new Error(`${count} writers, ${phase}: call counts differ between runs (${[...counts].join(", ")}).`);
        const times = measurements.map((measurement) => measurement.ms).sort((left, right) => left - right);
        report.push({
          writers: count,
          phase,
          median: percentile(times, 0.5),
          p95: percentile(times, 0.95),
          calls: measurements[0]!.calls,
          byMethod: measurements[0]!.byMethod,
        });
        process.stdout.write(`${count} writers, ${phase}: median ${percentile(times, 0.5).toFixed(0)} ms, p95 ${percentile(times, 0.95).toFixed(0)} ms, ${measurements[0]!.calls} calls ${JSON.stringify(measurements[0]!.byMethod)}\n`);
      }
    }
    process.stdout.write(`\n| writers | phase | calls | median ms | p95 ms |\n|---|---|---|---|---|\n`);
    for (const row of report) process.stdout.write(`| ${row.writers} | ${row.phase} | ${row.calls} | ${row.median.toFixed(0)} | ${row.p95.toFixed(0)} |\n`);
  } finally {
    await pds.close();
  }
}

/**
 * The planned refresh: read the writer's revision at its host (MAC-verified), list its messages newest-first down to one
 * page and its reactions in full, read the revision again, and keep the result only if both reads agree. Hints come from
 * `listRepos` with the stored space revision; a reopen with no hint asks no writer.
 */
class PrototypeSync {
  private readonly calls: Calls = new Map();
  private readonly limits = new Map<string, Semaphore>();
  private readonly writers = new Map<string, WriterState>();
  private credential: SpaceCredential | undefined;
  private spaceRev: string | undefined;
  private readonly documents = new Map<string, Promise<{ verificationMethod?: unknown }>>();

  constructor(private readonly pds: PdsNetwork, private readonly reader: NetworkActor, private readonly space: string) {}

  async measure(run: () => Promise<void>): Promise<Measurement> {
    this.calls.clear();
    const started = performance.now();
    await run();
    const ms = performance.now() - started;
    const byMethod = Object.fromEntries([...this.calls.entries()].sort());
    return { calls: [...this.calls.values()].reduce((sum, value) => sum + value, 0), byMethod, ms };
  }

  async open(): Promise<void> {
    const repos = await this.listRepos(undefined);
    await Promise.all(repos.map((repo) => this.refresh(repo.did)));
  }

  async reopen(): Promise<void> {
    const changed = await this.listRepos(this.spaceRev);
    await Promise.all(changed.filter((repo) => this.writers.get(repo.did)?.syncedRev !== repo.repoRev).map((repo) => this.refresh(repo.did)));
  }

  async waitForNotice(did: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const authority = (await this.credentialFor()).client(await this.hostFor(this.authorityDid()));
      const listed = await authority.query<{ repos: Array<{ did: string; repoRev: string }> }>("com.atproto.space.listRepos", { space: this.space, cursor: this.spaceRev, limit: 1000 });
      if (listed.repos.some((repo) => repo.did === did)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The authority never listed the writer's new revision.");
  }

  holds(did: string, rkey: string): boolean {
    return this.writers.get(did)?.messageKeys.has(rkey) ?? false;
  }

  /** Every writer of the fixed dataset was read, with all of its messages: the measured open read the whole dataset. */
  assertHolds(dids: readonly string[], messagesPerWriter: number): void {
    const short = dids.filter((did) => this.writers.get(did)?.messageKeys.size !== messagesPerWriter);
    if (this.writers.size !== dids.length || short.length > 0) {
      throw new Error(`The open read ${this.writers.size} of ${dids.length} writers; ${short.length} without all ${messagesPerWriter} messages.`);
    }
  }

  /** Waits until the authority reports the writer's current revision (read at the writer's own host), not merely the writer. */
  async waitForCurrentRevision(did: string): Promise<void> {
    const host = (await this.credentialFor()).client(await this.hostFor(did));
    const current = (await host.query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: this.space, repo: did })).commit.rev;
    const authority = (await this.credentialFor()).client(await this.hostFor(this.authorityDid()));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const listed = await authority.query<{ repos: Array<{ did: string; repoRev: string }> }>("com.atproto.space.listRepos", { space: this.space, limit: 1000 });
      const reported = listed.repos.find((repo) => repo.did === did)?.repoRev;
      if (reported !== undefined && reported >= current) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The authority never reported ${did}'s current revision.`);
  }

  private async listRepos(cursor: string | undefined): Promise<Array<{ did: string; repoRev: string; spaceRev: string }>> {
    const authority = (await this.credentialFor()).client(await this.hostFor(this.authorityDid()));
    const repos: Array<{ did: string; repoRev: string; spaceRev: string }> = [];
    let next = cursor;
    for (;;) {
      const page = await authority.query<{ repos: Array<{ did: string; repoRev: string; spaceRev: string }>; cursor?: string }>("com.atproto.space.listRepos", { space: this.space, limit: 1000, cursor: next });
      repos.push(...page.repos);
      if (page.repos.length < 1000 || !page.cursor) break;
      next = page.cursor;
    }
    const latest = repos.map((repo) => repo.spaceRev).sort().at(-1);
    if (latest) this.spaceRev = latest;
    // Most recently active writers first: an ordering, never a cut-off.
    return repos.sort((left, right) => right.repoRev.localeCompare(left.repoRev));
  }

  private async refresh(did: string): Promise<void> {
    const client = (await this.credentialFor()).client(await this.hostFor(did));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await client.query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: this.space, repo: did });
      const [messages] = await Promise.all([
        client.query<{ records: Array<{ rkey: string }> }>("com.atproto.space.listRecords", { space: this.space, repo: did, collection: "org.slack.channel.message", limit: PAGE }),
        client.query<{ records: Array<{ rkey: string }> }>("com.atproto.space.listRecords", { space: this.space, repo: did, collection: "org.slack.channel.reaction", limit: PAGE }),
      ]);
      const after = await client.query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space: this.space, repo: did });
      if (before.commit.rev === after.commit.rev) {
        this.writers.set(did, { syncedRev: after.commit.rev, coverage: messages.records.at(-1)?.rkey ?? null, messageKeys: new Set(messages.records.map((record) => record.rkey)) });
        return;
      }
    }
    throw new Error(`Writer ${did} kept changing.`);
  }

  private async credentialFor(): Promise<SpaceCredential> {
    if (this.credential && this.credential.expiresAt - this.credential.renewBeforeMs > Date.now()) return this.credential;
    this.credential = await mintSpaceCredentialWith({
      memberClient: new AtprotoClient(async (path, init) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${this.reader.accessJwt}`);
        return this.counted(new Request(new URL(path, this.reader.pds.url), { ...init, headers, redirect: "error" }), (request) => fetch(request));
      }),
      resolvePds: (did) => this.hostFor(did),
      resolveKemKey: async (did, forceRefresh) => kemKeyFromDidDocument(did, await this.didDocument(did, forceRefresh)),
      fetchEndpoint: (request) => this.counted(request, (inner) => fetch(inner)),
      generateKey: generateSpaceKey,
    }, this.space);
    return this.credential;
  }

  private async counted(request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.startsWith("/xrpc/") ? url.pathname.slice("/xrpc/".length) : `${url.origin === new URL(this.pds.plcUrl).origin ? "plc" : url.origin} resolve`;
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    let limit = this.limits.get(url.origin);
    if (!limit) {
      limit = new Semaphore(PER_ORIGIN_CONNECTIONS);
      this.limits.set(url.origin, limit);
    }
    return limit.run(async () => {
      const response = await send(request);
      // Hold the slot until the body is read, as a browser connection is.
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    });
  }

  private authorityDid(): string {
    return this.space.slice("at://".length).split("/")[0]!;
  }

  private async hostFor(did: string): Promise<string> {
    const document = await this.didDocument(did, false) as { service?: Array<{ id?: string; serviceEndpoint?: unknown }> };
    const endpoint = document.service?.find((service) => service.id === "#atproto_pds" || service.id === `${did}#atproto_pds`)?.serviceEndpoint;
    if (typeof endpoint !== "string") throw new Error(`No PDS in the DID document of ${did}.`);
    return endpoint;
  }

  /** One resolution per DID per session, through the PLC directory's own six connections, as a browser resolves. */
  private didDocument(did: string, forceRefresh: boolean): Promise<{ verificationMethod?: unknown }> {
    const cached = this.documents.get(did);
    if (cached && !forceRefresh) return cached;
    const resolved = this.counted(new Request(new URL(`/${encodeURIComponent(did)}`, this.pds.plcUrl)), (request) => fetch(request))
      .then(async (response) => {
        if (!response.ok) throw new Error(`PLC answered ${response.status} for ${did}.`);
        return await response.json() as { verificationMethod?: unknown };
      });
    this.documents.set(did, resolved);
    resolved.catch(() => this.documents.delete(did));
    return resolved;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

async function provision(pds: PdsNetwork, count: number): Promise<{ authority: NetworkActor; reader: NetworkActor; writers: NetworkActor[] }> {
  const authority = await pds.createActor("budgetowner", 0);
  const reader = await pds.createActor("budgetreader", 1);
  const writers: NetworkActor[] = [];
  for (let index = 0; index < count; index += 1) writers.push(await pds.createActor(`bw${index}`, (index % 2) as 0 | 1));
  return { authority, reader, writers };
}

async function createChannel(pds: PdsNetwork, authority: NetworkActor, reader: NetworkActor, writers: NetworkActor[], skey: string): Promise<string> {
  const [{ ensureMemberListSpace, putSpaceMember }, { mapLimited }] = await Promise.all([import("@/atproto/space-ops"), import("@/lib/map-limited")]);
  const owner = bearerSession(authority) as never;
  const space = await ensureMemberListSpace(owner, "org.slack.channel", skey);
  await putSpaceMember(owner, space, reader.did, true, true);
  await mapLimited(writers, 8, (writer) => putSpaceMember(owner, space, writer.did, true, true));
  await mapLimited(writers, 8, async (writer) => {
    for (let index = 0; index < MESSAGES_PER_WRITER; index += 1) await writeMessage(writer, space, `seed ${index}`);
  });
  // Wait until the authority reports every writer at its final seeded revision, so each run measures the same dataset.
  const probe = new PrototypeSync(pds, reader, space);
  for (const writer of writers) await probe.waitForCurrentRevision(writer.did);
  return space;
}

async function writeMessage(writer: NetworkActor, space: string, text: string): Promise<string> {
  const { tidNow } = await import("@/protocol/keys");
  const rkey = tidNow();
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.createRecord", {
    space, repo: writer.did, collection: "org.slack.channel.message", rkey,
    record: { $type: "org.slack.channel.message", text, createdAt: new Date().toISOString() },
  });
  return rkey;
}

async function deleteMessage(writer: NetworkActor, space: string, rkey: string): Promise<void> {
  await new AtprotoClient(bearerSession(writer).fetchHandler).procedure("com.atproto.space.deleteRecord", {
    space, repo: writer.did, collection: "org.slack.channel.message", rkey,
  });
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;
}

await main();
