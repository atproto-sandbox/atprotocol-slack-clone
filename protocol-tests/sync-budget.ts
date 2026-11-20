import { CredentialCache } from "@flock/client/credentials";
import { MemoryStore } from "@flock/client/memory-store";
import { SyncCore } from "@flock/client/sync";
import { COLLECTION } from "@flock/protocol/nsids";
import { actorTransport, startPdsNetwork, type NetworkActor, type PdsNetwork } from "./support/pds-network";
import { createChannel, deleteMessage, MESSAGES_PER_WRITER, percentile, Probe, provision, writeMessage, WRITER_COUNTS } from "./support/sync-dataset";

// K4 of `.ai/plans/platform-refactor.md`, rerun through the engine for R4's gate: the upstream cost of the sync core
// (refresh a writer between two revision reads; `listWriters` with the stored `spaceRev` as the hint) for one reader, at 20,
// 100 and 200 writers, measured in Node against the pinned PDS network. A browser over HTTP/1.1 opens at most
// six connections per origin, so every request here waits for one of six slots per host to emulate that limit. Each run
// writes one message, checks the reader read it, and deletes it again, so every first open reads the same dataset. The
// delay before the authority lists a new write (what a change-feed tick waits on) is reported separately from the
// reader's own cost.
//
// Run: ATPROTO_PINNED_CHECKOUT=../atproto-spaces-r12 node --import tsx protocol-tests/sync-budget.ts [runs]

const PAGE = 100;
const PER_ORIGIN_CONNECTIONS = 6;
const RUNS = Number(process.argv[2] ?? 10);

type Calls = Map<string, number>;
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
      const probe = new Probe(pds, reader, space);
      for (let run = 0; run < RUNS; run += 1) {
        const client = new EngineSync(pds, reader, space);
        results["first open"].push(await client.measure(() => client.open()));
        await client.assertHolds(writers.slice(0, count).map((writer) => writer.did), MESSAGES_PER_WRITER);
        results.reopen.push(await client.measure(() => client.open()));
        const writer = writers[run % count]!;
        const before = await probe.waitForCurrentRevision(writer.did);
        const written = performance.now();
        const rkey = await writeMessage(writer, space, `run ${run}`);
        await probe.waitForNotice(writer.did, before);
        noticeDelays.push(performance.now() - written);
        results["one new message"].push(await client.measure(() => client.open()));
        if (!(await client.holds(writer.did, rkey))) throw new Error(`The reopen after a new message did not read it (${writer.did}/${rkey}).`);
        // Restore the dataset, so every run's first open reads the same records.
        await deleteMessage(writer, space, rkey);
        await probe.waitForCurrentRevision(writer.did);
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
    // R4's gate: within the truth interval a reopen costs the same number of upstream calls at every writer count.
    const reopenCalls = new Set(report.filter((row) => row.phase === "reopen").map((row) => row.calls));
    if (reopenCalls.size !== 1) throw new Error(`A reopen's call count depends on the writer count: ${[...reopenCalls].join(", ")}.`);
    process.stdout.write(`\nGATE reopen calls are the same at every writer count: ${[...reopenCalls][0]}\n`);
  } finally {
    await pds.close();
  }
}

/**
 * The engine's sync core reading the channel's latest 100 messages with reactions alongside, every request counted and held
 * to six connections per origin. A fresh instance is a new session (its first open checks every writer); the same instance
 * again is a reopen, which within the truth interval asks the authority once and only the writers it names.
 */
class EngineSync {
  private readonly calls: Calls = new Map();
  private readonly limits = new Map<string, Semaphore>();
  private readonly store = new MemoryStore();
  private readonly core: SyncCore;

  constructor(private readonly pds: PdsNetwork, reader: NetworkActor, private readonly space: string) {
    const transport = actorTransport(pds, reader, { fetchVia: (request) => this.counted(request) });
    this.core = new SyncCore({ transport, credentials: new CredentialCache(transport), store: this.store });
  }

  async measure(run: () => Promise<void>): Promise<Measurement> {
    this.calls.clear();
    const started = performance.now();
    await run();
    const ms = performance.now() - started;
    const byMethod = Object.fromEntries([...this.calls.entries()].sort());
    return { calls: [...this.calls.values()].reduce((sum, value) => sum + value, 0), byMethod, ms };
  }

  async open(): Promise<void> {
    const writers = await this.core.writers(this.space);
    const page = await this.core.read({
      sources: writers.map((writer) => ({ space: this.space, repo: writer.did })),
      window: COLLECTION.message,
      alongside: [COLLECTION.reaction],
      limit: PAGE,
      select: async (candidates, limit) => candidates.slice(0, limit),
    });
    if (!page.complete) throw new Error("The engine's read of the fixed dataset was not complete.");
  }

  async holds(did: string, rkey: string): Promise<boolean> {
    return (await this.store.getRecord(this.space, did, COLLECTION.message, rkey)) !== undefined;
  }

  /** Every writer of the fixed dataset was read, with all of its messages: the measured open read the whole dataset. */
  async assertHolds(dids: readonly string[], messagesPerWriter: number): Promise<void> {
    const counts = await this.store.counts(this.space, COLLECTION.message);
    const short = dids.filter((did) => counts.get(did) !== messagesPerWriter);
    if (counts.size !== dids.length || short.length > 0) {
      throw new Error(`The open read ${counts.size} of ${dids.length} writers; ${short.length} without all ${messagesPerWriter} messages.`);
    }
  }

  private async counted(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.startsWith("/xrpc/") ? url.pathname.slice("/xrpc/".length) : `${url.origin === new URL(this.pds.plcUrl).origin ? "plc" : url.origin} resolve`;
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    let limit = this.limits.get(url.origin);
    if (!limit) {
      limit = new Semaphore(PER_ORIGIN_CONNECTIONS);
      this.limits.set(url.origin, limit);
    }
    return limit.run(async () => {
      const response = await fetch(request);
      // Hold the slot until the body is read, as a browser connection is.
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    });
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

await main();
