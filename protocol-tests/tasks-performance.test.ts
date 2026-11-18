import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createEngine } from "@flock/client/engine";
import type { TasksSpaceView } from "@flock/client/ext/tasks";
import { MemoryStore } from "@flock/client/memory-store";
import { mintSpaceCredentialWith } from "@flock/protocol/atproto/space-credential-core";
import { AtprotoClient } from "@flock/protocol/atproto/xrpc";
import {
  buildEditClosure,
  formatHlc,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ClosureInputOp,
} from "@flock/protocol/entity-merge";
import { spaceRecordUri, subjectKey, tasksSpaceUri, tidNow } from "@flock/protocol/keys";
import { mapLimited } from "@flock/protocol/map-limited";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { readIndependentTasksSpace } from "@flock/reader/independent-tasks";
import { createFixtureTempRoot } from "./fixture-temp";
import { acceptedTimestamps, loadSlurFilter } from "./support/accepted-tid";
import { actorTransport, bearerSession, publishAppLexicons, type NetworkActor } from "./support/pds-network";

const PINNED_CHECKOUT = process.env.ATPROTO_PINNED_CHECKOUT;
const WRITER_COUNT = 50;
const PROJECT_COUNT = 20;
const TASKS_PER_WRITER = 20;
const TASK_COUNT = WRITER_COUNT * TASKS_PER_WRITER;
const REGULAR_EDITS_COUNT = 2_900;
const HOT_TASK_EDITS_COUNT = 100;
const HOT_TASK_WRITERS = 10;
const COMMENT_COUNT = 1_000;
const TOTAL_RECORDS = PROJECT_COUNT + TASK_COUNT + REGULAR_EDITS_COUNT + HOT_TASK_EDITS_COUNT + COMMENT_COUNT;
const PER_ORIGIN_CONNECTIONS = 6;
const MEASURED_RUNS = 3;

const GATE_1_MEDIAN_MS = 15_000;
const GATE_1_MAX_MS = 30_000;
const GATE_2_MEDIAN_MS = 250;
const GATE_3_MEDIAN_MS = 1_500;
const GATE_4_MAX_MS = 5_000;
const GATE_5_MAX_RSS_DELTA_BYTES = 32 * 1024 * 1024;

type TestAgent = {
  com: {
    atproto: {
      server: {
        createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
      };
      space: {
        applyWrites(
          input: Record<string, unknown>,
          options: { headers: { authorization: string } },
        ): Promise<{ data: { results?: unknown[] } }>;
      };
    };
  };
};

type TestPds = { url: string; getAgent(): TestAgent };
type TestNetwork = {
  plc: { url: string };
  pds: TestPds;
  extraPdses: TestPds[];
  lexiconAuthority?: { did: string };
  close(): Promise<void>;
};

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.size) {
      await new Promise<void>((resolveWait) => this.waiting.push(resolveWait));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

class OriginPool {
  private readonly semaphores = new Map<string, Semaphore>();

  async fetch(request: Request): Promise<Response> {
    const origin = new URL(request.url).origin;
    let sem = this.semaphores.get(origin);
    if (!sem) {
      sem = new Semaphore(PER_ORIGIN_CONNECTIONS);
      this.semaphores.set(origin, sem);
    }
    const release = await sem.acquire();
    let response: Response;
    try {
      response = await fetch(request);
    } catch (error) {
      release();
      throw error;
    }
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    const finish = () => release();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

function summarize(samples: readonly number[]): { runs: number; medianMs: number; maxMs: number; samplesMs: number[] } {
  const sorted = [...samples].sort((left, right) => left - right);
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return {
    runs: samples.length,
    medianMs: Math.round(median),
    maxMs: Math.round(sorted[sorted.length - 1]!),
    samplesMs: samples.map((ms) => Math.round(ms)),
  };
}

function countComments(view: TasksSpaceView): number {
  let total = 0;
  for (const list of view.commentsByTask.values()) total += list.length;
  return total;
}

function readVarintAt(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let offset = start;
  for (let i = 0; i < 6; i += 1) {
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (byte < 0x80) return { value, next: offset };
  }
  throw new Error("Invalid STAR varint.");
}

function splitSingleRecordStar(bytes: Uint8Array): { headerBytes: Uint8Array; valFrameBytes: Uint8Array } {
  const metaLen = readVarintAt(bytes, 4);
  const metaEnd = metaLen.next + metaLen.value;
  const keyLen = readVarintAt(bytes, metaEnd);
  const keyEnd = keyLen.next + keyLen.value;
  return {
    headerBytes: bytes.subarray(0, metaEnd),
    valFrameBytes: bytes.subarray(keyEnd),
  };
}

function frameStarItem(item: Uint8Array): Uint8Array {
  const varint: number[] = [];
  let n = item.byteLength;
  while (n >= 0x80) {
    varint.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  varint.push(n);
  const out = new Uint8Array(varint.length + item.byteLength);
  out.set(varint, 0);
  out.set(item, varint.length);
  return out;
}

function createPooledTrackedTransport(
  plcUrl: string,
  reader: NetworkActor,
  options: {
    onResponse?: (ctx: { method: string; space: string | null; repo: string | null; response: Response }) => Promise<Response> | Response;
  } = {},
) {
  const pool = new OriginPool();
  const spaceCalls = new Map<string, Map<string, number>>();
  const globalCalls = new Map<string, number>();

  const transport = actorTransport({ plcUrl }, reader, {
    fetchVia: async (request) => {
      const url = new URL(request.url);
      let method = "";
      let space: string | null = null;
      let repo: string | null = null;
      if (url.pathname.startsWith("/xrpc/")) {
        method = url.pathname.slice("/xrpc/".length);
        globalCalls.set(method, (globalCalls.get(method) ?? 0) + 1);
        space = url.searchParams.get("space");
        repo = url.searchParams.get("repo");
        if (space) {
          let map = spaceCalls.get(space);
          if (!map) {
            map = new Map<string, number>();
            spaceCalls.set(space, map);
          }
          map.set(method, (map.get(method) ?? 0) + 1);
        }
      }
      const response = await pool.fetch(request);
      if (options.onResponse && method) {
        return options.onResponse({ method, space, repo, response });
      }
      return response;
    },
  });

  const delta = (before: Map<string, number>, after: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [method, total] of after) {
      const diff = total - (before.get(method) ?? 0);
      if (diff > 0) out[method] = diff;
    }
    return out;
  };

  const measure = async <T>(
    spaces: readonly string[],
    run: () => Promise<T>,
  ): Promise<{
    result: T;
    elapsedMs: number;
    globalByMethod: Record<string, number>;
    bySpace: Record<string, Record<string, number>>;
  }> => {
    const beforeGlobal = new Map(globalCalls);
    const beforeSpaces = new Map(spaces.map((space) => [space, new Map(spaceCalls.get(space) ?? [])]));
    const started = performance.now();
    const result = await run();
    const elapsedMs = performance.now() - started;
    const bySpace: Record<string, Record<string, number>> = {};
    for (const space of spaces) {
      bySpace[space] = delta(beforeSpaces.get(space)!, spaceCalls.get(space) ?? new Map());
    }
    return {
      result,
      elapsedMs,
      globalByMethod: delta(beforeGlobal, globalCalls),
      bySpace,
    };
  };

  return { transport, measure };
}

async function settled(
  plcUrl: string,
  reader: NetworkActor,
  space: string,
  writers: readonly NetworkActor[],
): Promise<void> {
  const transport = actorTransport({ plcUrl }, reader);
  const credential = await mintSpaceCredentialWith(transport, space);
  const authorityDid = space.slice("at://".length).split("/")[0]!;
  const authority = credential.client(await transport.resolvePds(authorityDid));
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const listed = await authority.query<{ repos: Array<{ did: string; repoRev: string }> }>(
      "com.atproto.space.listRepos",
      { space, limit: 500 },
    );
    const reported = new Map(listed.repos.map((entry) => [entry.did, entry.repoRev]));
    const checks = await mapLimited(writers, PER_ORIGIN_CONNECTIONS, async (writer) => {
      const host = credential.client(await transport.resolvePds(writer.did));
      const rev = await host
        .query<{ commit: { rev: string } }>("com.atproto.space.getLatestCommit", { space, repo: writer.did })
        .then((res) => res.commit.rev, () => null);
      if (rev === null) return true;
      const seenRev = reported.get(writer.did);
      return seenRev !== undefined && seenRev >= rev;
    });
    if (checks.every(Boolean)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Authority never reported all writers at current revisions for ${space}.`);
}

test("D11.13 frozen 50-writer / 1,000-task / 5,020-record Tasks performance envelope and STAR bounds", { timeout: 15 * 60_000 }, async () => {
  assert.ok(PINNED_CHECKOUT, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  const pinnedCheckout = resolve(PINNED_CHECKOUT);
  const fixtureTemp = createFixtureTempRoot("tasks-perf-fixture-");
  const dbDir = mkdtempSync(join(fixtureTemp.path, "tasks-perf-db-"));
  let network: TestNetwork | undefined;

  const prevEnv = {
    NODE_ENV: process.env.NODE_ENV,
    APP_URL: process.env.APP_URL,
    AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY,
    OPERATOR_SERVICE_REF: process.env.OPERATOR_SERVICE_REF,
    PLC_URL: process.env.PLC_URL,
    DATABASE_PATH: process.env.DATABASE_PATH,
  };

  try {
    const { TestNetworkNoAppView } = await import(
      pathToFileURL(join(pinnedCheckout, "packages/dev-env/src/index.ts")).href
    ) as {
      TestNetworkNoAppView: {
        create(options: {
          extraPdses: number;
          lexiconAuthority: boolean;
          pds?: { rateLimitsEnabled?: boolean };
        }): Promise<TestNetwork>;
      };
    };

    network = await TestNetworkNoAppView.create({
      extraPdses: 1,
      lexiconAuthority: true,
      pds: { rateLimitsEnabled: false },
    });
    Object.assign(process.env, {
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1:3000",
      AUTH_ENCRYPTION_KEY: "4c".repeat(32),
      OPERATOR_SERVICE_REF: "did:web:localhost%3A3000#atproto_flock_operator",
      PLC_URL: network.plc.url,
      DATABASE_PATH: join(dbDir, "app.db"),
    });

    await publishAppLexicons(network as never, process.cwd());
    const [{ ensureMemberListSpace, listSpaceMembers, putAuthorityRecord, putSpaceMember }] = await Promise.all([
      import("@flock/operator/atproto/space-ops"),
    ]);

    const hosts = [network.pds, network.extraPdses[0]!] as const;
    const writers: NetworkActor[] = await mapLimited(
      Array.from({ length: WRITER_COUNT }, (_, idx) => idx),
      PER_ORIGIN_CONNECTIONS,
      async (idx) => {
        const host = idx % 2;
        const handle = `tpw${String(idx).padStart(2, "0")}.test${host === 0 ? "" : "2"}`;
        const password = `tpw${idx}-perf-pass`;
        const { data } = await hosts[host].getAgent().com.atproto.server.createAccount({
          handle,
          email: `tpw${idx}@tasks-perf.test`,
          password,
        });
        return { did: data.did, handle, password, accessJwt: data.accessJwt, pds: hosts[host] as never };
      },
    );
    assert.equal(writers.filter((_, idx) => idx % 2 === 0).length, 25);
    assert.equal(writers.filter((_, idx) => idx % 2 === 1).length, 25);

    const authority = writers[0]!;
    const reader = writers[1]!;
    const ownerSession = bearerSession(authority);
    const workspaceSkey = "tasks-perf-50w";
    const workspace = await ensureMemberListSpace(ownerSession as never, SPACE_TYPE.workspace, workspaceSkey);
    const tasksSpace = tasksSpaceUri(authority.did, workspaceSkey);
    const tasksSkey = tasksSpace.split("/").at(-1)!;
    await ensureMemberListSpace(ownerSession as never, SPACE_TYPE.tasks, tasksSkey);

    const nowIso = new Date().toISOString();
    await putAuthorityRecord(ownerSession as never, workspace, COLLECTION.workspaceProfile, "self", {
      name: "Tasks Perf Workspace",
      createdAt: nowIso,
    });
    await putAuthorityRecord(ownerSession as never, workspace, COLLECTION.admin, subjectKey(authority.did), {
      subject: authority.did,
      active: true,
      updatedAt: nowIso,
    });
    await putAuthorityRecord(ownerSession as never, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: authority.did,
      enabledAt: nowIso,
      updatedAt: nowIso,
    });

    await mapLimited(writers, PER_ORIGIN_CONNECTIONS, async (writer) => {
      await putAuthorityRecord(ownerSession as never, workspace, COLLECTION.workspaceRoster, subjectKey(writer.did), {
        subject: writer.did,
        active: true,
        updatedAt: nowIso,
      });
      if (writer.did !== authority.did) {
        await putSpaceMember(ownerSession as never, workspace, writer.did, true, true);
        await putSpaceMember(ownerSession as never, tasksSpace, writer.did, true, true);
      }
    });
    assert.equal((await listSpaceMembers(ownerSession as never, tasksSpace)).length, WRITER_COUNT - 1);

    // Seed exact 5,020 records across 50 writers using applyWrites batches.
    const slurFilter = await loadSlurFilter(pinnedCheckout);
    const baseMs = Date.now() - 120_000;
    const hlcBaseMs = 1_700_000_000_000;
    const stamps = acceptedTimestamps(tidNow, slurFilter, baseMs, TOTAL_RECORDS + 2_500);
    let nextStamp = 0;
    let nextHlc = 0;
    const allocStamp = () => {
      const ms = stamps[nextStamp++]!;
      const rkey = tidNow(ms, 0);
      const hlc = formatHlc({ ms: hlcBaseMs + nextHlc++, counter: 0 });
      return { ms, rkey, hlc, createdAt: new Date(ms).toISOString() };
    };

    const perWriterWrites: Array<Array<Record<string, unknown>>> = Array.from({ length: WRITER_COUNT }, () => []);
    const projectUris: string[] = [];
    for (let p = 0; p < PROJECT_COUNT; p += 1) {
      const writerIdx = p % WRITER_COUNT;
      const writer = writers[writerIdx]!;
      const stamp = allocStamp();
      const uri = spaceRecordUri(tasksSpace, writer.did, COLLECTION.taskProject, stamp.rkey);
      projectUris.push(uri);
      perWriterWrites[writerIdx]!.push({
        $type: "com.atproto.space.applyWrites#create",
        collection: COLLECTION.taskProject,
        rkey: stamp.rkey,
        value: {
          $type: COLLECTION.taskProject,
          name: `Perf Project ${String(p).padStart(2, "0")} — Envelope 32B`,
          description: "Frozen 50-writer perf project",
          color: "#2266cc",
          t: stamp.hlc,
          createdAt: stamp.createdAt,
        },
      });
    }

    type SeedTaskMeta = {
      uri: string;
      writerIdx: number;
      rkey: string;
      ops: ClosureInputOp[];
      lastHlc: string;
    };
    const seededTasks: SeedTaskMeta[] = [];
    for (let w = 0; w < WRITER_COUNT; w += 1) {
      const writer = writers[w]!;
      for (let k = 0; k < TASKS_PER_WRITER; k += 1) {
        const taskIdx = w * TASKS_PER_WRITER + k;
        const stamp = allocStamp();
        const uri = spaceRecordUri(tasksSpace, writer.did, COLLECTION.task, stamp.rkey);
        const project = projectUris[taskIdx % PROJECT_COUNT]!;
        perWriterWrites[w]!.push({
          $type: "com.atproto.space.applyWrites#create",
          collection: COLLECTION.task,
          rkey: stamp.rkey,
          value: {
            $type: COLLECTION.task,
            title: `Perf task ${String(taskIdx).padStart(4, "0")} cross-host sync`,
            description: `Workload task ${String(taskIdx).padStart(4, "0")} payload for verified STAR sync and merge parity.`,
            status: TASK_STATUSES[taskIdx % TASK_STATUSES.length],
            priority: TASK_PRIORITIES[taskIdx % TASK_PRIORITIES.length],
            project,
            assignees: [writer.did],
            labels: ["perf"],
            t: stamp.hlc,
            createdAt: stamp.createdAt,
          },
        });
        seededTasks.push({
          uri,
          writerIdx: w,
          rkey: stamp.rkey,
          ops: [{ repo: writer.did, rkey: stamp.rkey, t: stamp.hlc, isRoot: true }],
          lastHlc: stamp.hlc,
        });
      }
    }

    // 2,900 edits across tasks[1..999] (~300B each)
    for (let e = 0; e < REGULAR_EDITS_COUNT; e += 1) {
      const target = seededTasks[1 + (e % (TASK_COUNT - 1))]!;
      const writerIdx = e % WRITER_COUNT;
      const writer = writers[writerIdx]!;
      const stamp = allocStamp();
      const closure = buildEditClosure({ observedOps: target.ops });
      perWriterWrites[writerIdx]!.push({
        $type: "com.atproto.space.applyWrites#create",
        collection: COLLECTION.taskEdit,
        rkey: stamp.rkey,
        value: {
          $type: COLLECTION.taskEdit,
          subject: target.uri,
          t: stamp.hlc,
          s: closure.s,
          title: `Perf task edit ${String(e).padStart(4, "0")} cross-host`,
          description: `Edited payload #${String(e).padStart(4, "0")} checking 300B CBOR causal edit envelope size.`,
        },
      });
      target.ops.push({ repo: writer.did, rkey: stamp.rkey, t: stamp.hlc, s: closure.s });
      target.lastHlc = stamp.hlc;
    }

    // 100 sequential edits on hot task seededTasks[0] across 10 writers stressing s up to 100 opRefs (~3.8 KiB)
    const hotTask = seededTasks[0]!;
    for (let step = 0; step < HOT_TASK_EDITS_COUNT; step += 1) {
      const writerIdx = step % HOT_TASK_WRITERS;
      const writer = writers[writerIdx]!;
      const stamp = allocStamp();
      const closure = buildEditClosure({ observedOps: hotTask.ops });
      assert.equal(closure.s.length, step + 1);
      assert.equal(closure.sTruncated, false);
      perWriterWrites[writerIdx]!.push({
        $type: "com.atproto.space.applyWrites#create",
        collection: COLLECTION.taskEdit,
        rkey: stamp.rkey,
        value: {
          $type: COLLECTION.taskEdit,
          subject: hotTask.uri,
          t: stamp.hlc,
          s: closure.s,
          title: `Hot task sequential step ${step + 1}`,
        },
      });
      hotTask.ops.push({ repo: writer.did, rkey: stamp.rkey, t: stamp.hlc, s: closure.s });
      hotTask.lastHlc = stamp.hlc;
    }

    // 1,000 comments (1 per task, balanced across writers)
    for (let c = 0; c < COMMENT_COUNT; c += 1) {
      const target = seededTasks[c]!;
      const writerIdx = c % WRITER_COUNT;
      const stamp = allocStamp();
      perWriterWrites[writerIdx]!.push({
        $type: "com.atproto.space.applyWrites#create",
        collection: COLLECTION.taskComment,
        rkey: stamp.rkey,
        value: {
          $type: COLLECTION.taskComment,
          subject: target.uri,
          body: `Perf comment ${String(c).padStart(4, "0")} validating STAR archive throughput.`,
          createdAt: stamp.createdAt,
        },
      });
    }

    const totalSeeded = perWriterWrites.reduce((sum, list) => sum + list.length, 0);
    assert.equal(totalSeeded, TOTAL_RECORDS);

    const seedStarted = performance.now();
    await mapLimited(
      writers.map((writer, idx) => ({ writer, idx })),
      PER_ORIGIN_CONNECTIONS,
      async ({ writer, idx }) => {
        const writes = perWriterWrites[idx]!;
        for (let offset = 0; offset < writes.length; offset += 200) {
          const chunk = writes.slice(offset, offset + 200);
          const res = await (writer.pds as unknown as TestPds).getAgent().com.atproto.space.applyWrites(
            { space: tasksSpace, repo: writer.did, writes: chunk },
            { headers: { authorization: `Bearer ${writer.accessJwt}` } },
          );
          assert.equal(res.data.results?.length, chunk.length);
        }
      },
    );
    await settled(network.plc.url, reader, tasksSpace, writers);
    perWriterWrites.length = 0;
    const seedMs = Math.round(performance.now() - seedStarted);

    // Measure aggregate STAR archive bytes across all 50 writer repos.
    let aggregateStarBytes = 0;
    const starCred = await mintSpaceCredentialWith(actorTransport({ plcUrl: network.plc.url }, reader), tasksSpace);
    const starSizes = await mapLimited(writers, PER_ORIGIN_CONNECTIONS, async (writer) => {
      const star = await starCred.fetchVerifiedRepoStar(writer.pds.url, {
        space: tasksSpace,
        repo: writer.did,
        maxBytes: WORKSPACE_ENVELOPE.maxStarArchiveBytes,
        maxRecords: WORKSPACE_ENVELOPE.maxStarRecords,
      });
      assert.ok(star.records.length > 0);
      const res = await bearerSession(writer).fetchHandler(
        `/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(tasksSpace)}&repo=${encodeURIComponent(writer.did)}`,
        { method: "GET" },
      );
      return (await res.arrayBuffer()).byteLength;
    });
    aggregateStarBytes = starSizes.reduce((a, b) => a + b, 0);
    process.stdout.write(`TASKS_PERF_PROGRESS seeded=${totalSeeded} seedMs=${seedMs} aggregateStarBytes=${aggregateStarBytes}\n`);

    // ── Gate 1: Cold complete Tasks space load (1 warm-up + 3 measured runs) ──
    const gate1SamplesMs: number[] = [];
    let populatedStore = new MemoryStore();
    for (let run = 0; run <= MEASURED_RUNS; run += 1) {
      const store = new MemoryStore();
      const harness = createPooledTrackedTransport(network.plc.url, reader);
      const engine = createEngine(harness.transport, { store, options: { concurrency: PER_ORIGIN_CONNECTIONS } });
      const measured = await harness.measure([workspace, tasksSpace], () => engine.tasks.readSpace(workspace));
      const view = measured.result;
      assert.equal(view.complete, true);
      assert.equal(view.degraded, false);
      assert.equal(view.projects.length, PROJECT_COUNT);
      assert.equal(view.tasks.length, TASK_COUNT);
      assert.equal(countComments(view), COMMENT_COUNT);
      const mergedHot = view.tasks.find((task) => task.uri === hotTask.uri)!;
      assert.equal(mergedHot.closureRefs.length, HOT_TASK_EDITS_COUNT + 1);
      assert.equal(mergedHot.uncertainAncestry, false);
      assert.equal(mergedHot.conflictFinal, true);

      const tasksCalls = measured.bySpace[tasksSpace]!;
      const wsCalls = measured.bySpace[workspace]!;
      assert.equal(tasksCalls["com.atproto.space.listRepos"], 2, "Tasks space makes exact 2 listRepos calls");
      assert.equal(tasksCalls["com.atproto.space.getRepo"], WRITER_COUNT, "Tasks space makes exact 50 STAR getRepo calls");
      assert.equal(tasksCalls["com.atproto.space.getRecord"], undefined, "0 N+1 getRecord calls on Tasks space");
      assert.equal(tasksCalls["com.atproto.space.listRecords"], undefined, "0 listRecords calls on Tasks space");
      assert.equal(tasksCalls["com.atproto.space.listRepoOps"], undefined, "0 listRepoOps calls on cold load");
      assert.equal(tasksCalls["com.atproto.space.getLatestCommit"], undefined, "0 getLatestCommit calls on cold load");
      assert.equal(wsCalls["com.atproto.space.getRepo"], 1, "Workspace snapshot makes 1 STAR getRepo call");
      assert.equal(wsCalls["com.atproto.space.getRecord"], undefined, "0 getRecord calls on workspace snapshot");

      if (run > 0) gate1SamplesMs.push(measured.elapsedMs);
      if (run === MEASURED_RUNS) populatedStore = store;
    }
    const gate1Stats = summarize(gate1SamplesMs);
    assert.ok(gate1Stats.medianMs <= GATE_1_MEDIAN_MS, `Gate 1 median ${gate1Stats.medianMs}ms > ${GATE_1_MEDIAN_MS}ms`);
    assert.ok(gate1Stats.maxMs <= GATE_1_MAX_MS, `Gate 1 max ${gate1Stats.maxMs}ms > ${GATE_1_MAX_MS}ms`);

    // ── Gate 2: Warm reopen within truthIntervalMs (1 warm-up + 3 measured runs) ──
    const gate2SamplesMs: number[] = [];
    for (let run = 0; run <= MEASURED_RUNS; run += 1) {
      const harness = createPooledTrackedTransport(network.plc.url, reader);
      const warmEngine = createEngine(harness.transport, {
        store: populatedStore,
        options: { concurrency: PER_ORIGIN_CONNECTIONS },
      });
      const measured = await harness.measure([workspace, tasksSpace], () => warmEngine.tasks.readSpace(workspace));
      const view = measured.result;
      assert.equal(view.complete, true);
      assert.equal(view.projects.length, PROJECT_COUNT);
      assert.equal(view.tasks.length, TASK_COUNT);
      assert.equal(countComments(view), COMMENT_COUNT);

      const tasksCalls = measured.bySpace[tasksSpace]!;
      const wsCalls = measured.bySpace[workspace]!;
      assert.equal(tasksCalls["com.atproto.space.listRepos"], 2, "Warm reopen makes exact 2 listRepos calls on Tasks space");
      assert.equal(tasksCalls["com.atproto.space.getRepo"], undefined, "0 getRepo writer calls on warm reopen");
      assert.equal(tasksCalls["com.atproto.space.listRepoOps"], undefined, "0 listRepoOps writer calls on warm reopen");
      assert.equal(tasksCalls["com.atproto.space.getLatestCommit"], undefined, "0 getLatestCommit writer calls on warm reopen");
      assert.equal(tasksCalls["com.atproto.space.listRecords"], undefined, "0 listRecords writer calls on warm reopen");
      assert.equal(tasksCalls["com.atproto.space.getRecord"], undefined, "0 getRecord writer calls on warm reopen");
      assert.deepEqual(wsCalls, {}, "0 workspace snapshot calls on warm reopen within truthIntervalMs");

      if (run > 0) gate2SamplesMs.push(measured.elapsedMs);
    }
    const gate2Stats = summarize(gate2SamplesMs);
    assert.ok(gate2Stats.medianMs <= GATE_2_MEDIAN_MS, `Gate 2 median ${gate2Stats.medianMs}ms > ${GATE_2_MEDIAN_MS}ms`);

    // ── Gate 3: Incremental advance (10 new edits across 5 writers via listRepoOps; 1 warm-up + 3 measured runs) ──
    const gate3SamplesMs: number[] = [];
    const incWriters = writers.slice(10, 15);
    for (let run = 0; run <= MEASURED_RUNS; run += 1) {
      await mapLimited(
        incWriters.map((writer, localIdx) => ({ writer, localIdx })),
        PER_ORIGIN_CONNECTIONS,
        async ({ writer, localIdx }) => {
          const writerIdx = 10 + localIdx;
        const writes = [0, 1].map((slot) => {
          const target = seededTasks[1 + writerIdx * 2 + slot]!;
          const stamp = allocStamp();
          const closure = buildEditClosure({ observedOps: target.ops });
          target.ops.push({ repo: writer.did, rkey: stamp.rkey, t: stamp.hlc, s: closure.s });
          target.lastHlc = stamp.hlc;
          return {
            $type: "com.atproto.space.applyWrites#create",
            collection: COLLECTION.taskEdit,
            rkey: stamp.rkey,
            value: {
              $type: COLLECTION.taskEdit,
              subject: target.uri,
              t: stamp.hlc,
              s: closure.s,
              title: `Incremental gate3 run=${run} w=${writerIdx} slot=${slot}`,
            },
          };
        });
        const res = await (writer.pds as unknown as TestPds).getAgent().com.atproto.space.applyWrites(
          { space: tasksSpace, repo: writer.did, writes },
          { headers: { authorization: `Bearer ${writer.accessJwt}` } },
        );
          assert.equal(res.data.results?.length, 2);
        },
      );
      await settled(network.plc.url, reader, tasksSpace, incWriters);

      const harness = createPooledTrackedTransport(network.plc.url, reader);
      const incEngine = createEngine(harness.transport, {
        store: populatedStore,
        options: { concurrency: PER_ORIGIN_CONNECTIONS },
      });
      const measured = await harness.measure([workspace, tasksSpace], () => incEngine.tasks.readSpace(workspace));
      const view = measured.result;
      assert.equal(view.complete, true);
      assert.equal(view.projects.length, PROJECT_COUNT);
      assert.equal(view.tasks.length, TASK_COUNT);
      assert.equal(countComments(view), COMMENT_COUNT);

      const tasksCalls = measured.bySpace[tasksSpace]!;
      assert.equal(tasksCalls["com.atproto.space.listRepos"], 2, "Incremental reopen makes 2 listRepos calls");
      assert.ok((tasksCalls["com.atproto.space.listRepoOps"] ?? 0) <= 5, "At most 5 listRepoOps pages");
      assert.equal(tasksCalls["com.atproto.space.listRepoOps"], 5, "Exact 5 listRepoOps pages for 5 moved writers");
      assert.equal(tasksCalls["com.atproto.space.getRepo"], undefined, "0 getRepo full downloads during incremental advance");

      if (run > 0) gate3SamplesMs.push(measured.elapsedMs);
    }
    const gate3Stats = summarize(gate3SamplesMs);
    assert.ok(gate3Stats.medianMs <= GATE_3_MEDIAN_MS, `Gate 3 median ${gate3Stats.medianMs}ms > ${GATE_3_MEDIAN_MS}ms`);

    // ── Gate 4: Reset / concurrent STAR mutation recovery (clearRecords + mid-STAR race; 1 warm-up + 3 measured runs) ──
    const gate4SamplesMs: number[] = [];
    const gate4Retries: number[] = [];
    for (let run = 0; run <= MEASURED_RUNS; run += 1) {
      const resetWriter = writers[46 + run]!;
      const writerClient = new AtprotoClient(bearerSession(resetWriter).fetchHandler);
      await writerClient.procedure("com.atproto.space.clearRecords", { space: tasksSpace, repo: resetWriter.did });

      const postResetStamp = allocStamp();
      const postResetTitle = `Post-clear task run=${run}`;
      await writerClient.procedure("com.atproto.space.createRecord", {
        space: tasksSpace,
        repo: resetWriter.did,
        collection: COLLECTION.task,
        rkey: postResetStamp.rkey,
        record: {
          $type: COLLECTION.task,
          title: postResetTitle,
          status: "todo",
          priority: "medium",
          t: postResetStamp.hlc,
          createdAt: postResetStamp.createdAt,
        },
      });
      await settled(network.plc.url, reader, tasksSpace, [resetWriter]);

      let getRepoAttempts = 0;
      let racedOnce = false;
      const raceTitle = `Concurrent STAR race task run=${run}`;
      const harness = createPooledTrackedTransport(network.plc.url, reader, {
        onResponse: async ({ method, space, repo, response }) => {
          if (
            method === "com.atproto.space.getRepo" &&
            space === tasksSpace &&
            repo === resetWriter.did &&
            response.ok
          ) {
            getRepoAttempts += 1;
            if (!racedOnce) {
              racedOnce = true;
              const raceStamp = allocStamp();
              await writerClient.procedure("com.atproto.space.createRecord", {
                space: tasksSpace,
                repo: resetWriter.did,
                collection: COLLECTION.task,
                rkey: raceStamp.rkey,
                record: {
                  $type: COLLECTION.task,
                  title: raceTitle,
                  status: "in_progress",
                  priority: "high",
                  t: raceStamp.hlc,
                  createdAt: raceStamp.createdAt,
                },
              });
              // Truncate tail of first STAR response to simulate a mid-stream commit mismatch race.
              const bytes = new Uint8Array(await response.arrayBuffer());
              return new Response(bytes.subarray(0, Math.max(0, bytes.length - 8)), {
                status: 200,
                headers: response.headers,
              });
            }
          }
          return response;
        },
      });

      const resetEngine = createEngine(harness.transport, {
        store: populatedStore,
        options: { concurrency: PER_ORIGIN_CONNECTIONS },
      });
      const measured = await harness.measure([workspace, tasksSpace], () => resetEngine.tasks.readSpace(workspace));
      const view = measured.result;
      assert.equal(view.complete, true);
      assert.equal(view.degraded, false);
      assert.ok(getRepoAttempts >= 2 && getRepoAttempts <= WORKSPACE_ENVELOPE.maxListRecordsRetry, `expected <= 3 STAR attempts, got ${getRepoAttempts}`);
      const resetWriterTasks = view.tasks.filter((task) => task.repo === resetWriter.did);
      assert.equal(resetWriterTasks.length, 2, "old pre-clear tasks dropped and both post-clear tasks recovered");
      assert.deepEqual(
        resetWriterTasks.map((task) => task.title).sort(),
        [raceTitle, postResetTitle].sort(),
      );

      if (run > 0) {
        gate4SamplesMs.push(measured.elapsedMs);
        gate4Retries.push(getRepoAttempts);
      }
    }
    const gate4Stats = summarize(gate4SamplesMs);
    assert.ok(gate4Stats.maxMs <= GATE_4_MAX_MS, `Gate 4 max ${gate4Stats.maxMs}ms > ${GATE_4_MAX_MS}ms`);

    // ── Gate 5: Oversized STAR rejection (> 16 MiB) aborts mid-stream cleanly with RSS delta < 32 MiB and SetAside ──
    const oversizedWriter = writers[45]!;
    const oversizedClient = new AtprotoClient(bearerSession(oversizedWriter).fetchHandler);
    // Create a clean Tasks workspace on the two real PDS instances so Gate 5 isolates oversized STAR rejection RSS
    // from re-cloning/merging the 5,020 cached records of the other 49 writers, while still running end-to-end
    // `engine.tasks.readSpace` and `readIndependentTasksSpace` across real federated PDS hosts.
    const gate5Skey = "tasks-perf-gate5-oversized";
    const gate5Workspace = await ensureMemberListSpace(ownerSession as never, SPACE_TYPE.workspace, gate5Skey);
    const gate5TasksSpace = tasksSpaceUri(authority.did, gate5Skey);
    const gate5TasksSkey = gate5TasksSpace.split("/").at(-1)!;
    await ensureMemberListSpace(ownerSession as never, SPACE_TYPE.tasks, gate5TasksSkey);
    await putAuthorityRecord(ownerSession as never, gate5Workspace, COLLECTION.workspaceProfile, "self", {
      name: "Tasks Perf Gate 5 Workspace",
      createdAt: nowIso,
    });
    await putAuthorityRecord(ownerSession as never, gate5Workspace, COLLECTION.admin, subjectKey(authority.did), {
      subject: authority.did,
      active: true,
      updatedAt: nowIso,
    });
    await putAuthorityRecord(ownerSession as never, gate5Workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: gate5TasksSpace,
      cleanupComplete: false,
      enabledBy: authority.did,
      enabledAt: nowIso,
      updatedAt: nowIso,
    });
    for (const member of [authority, reader, oversizedWriter]) {
      await putAuthorityRecord(ownerSession as never, gate5Workspace, COLLECTION.workspaceRoster, subjectKey(member.did), {
        subject: member.did,
        active: true,
        updatedAt: nowIso,
      });
      if (member.did !== authority.did) {
        await putSpaceMember(ownerSession as never, gate5Workspace, member.did, true, true);
        await putSpaceMember(ownerSession as never, gate5TasksSpace, member.did, true, true);
      }
    }

    const gate5AuthorityClient = new AtprotoClient(bearerSession(authority).fetchHandler);
    const gate5ProjectStamp = allocStamp();
    await gate5AuthorityClient.procedure("com.atproto.space.createRecord", {
      space: gate5TasksSpace,
      repo: authority.did,
      collection: COLLECTION.taskProject,
      rkey: gate5ProjectStamp.rkey,
      record: {
        $type: COLLECTION.taskProject,
        name: "Gate 5 Healthy Project",
        t: gate5ProjectStamp.hlc,
        createdAt: gate5ProjectStamp.createdAt,
      },
    });

    const templateStamp = allocStamp();
    await oversizedClient.procedure("com.atproto.space.createRecord", {
      space: gate5TasksSpace,
      repo: oversizedWriter.did,
      collection: COLLECTION.task,
      rkey: templateStamp.rkey,
      record: {
        $type: COLLECTION.task,
        title: "Oversized template task",
        description: "中".repeat(10_000),
        status: "todo",
        priority: "none",
        t: templateStamp.hlc,
        createdAt: templateStamp.createdAt,
      },
    });
    await settled(network.plc.url, reader, gate5TasksSpace, [authority, oversizedWriter]);

    let oversizedBytesSeen = 0;
    let streamCanceled = false;
    const oversizedStarWrap = ({ method, space, repo, response }: { method: string; space: string | null; repo: string | null; response: Response }) => {
      if (
        method === "com.atproto.space.getRepo" &&
        space === gate5TasksSpace &&
        repo === oversizedWriter.did &&
        response.ok
      ) {
        return (async () => {
          const raw = new Uint8Array(await response.arrayBuffer());
          const { headerBytes, valFrameBytes } = splitSingleRecordStar(raw);
          const encoder = new TextEncoder();
          const targetTotalBytes = WORKSPACE_ENVELOPE.maxStarArchiveBytes + 2 * 1024 * 1024;
          let sent = 0;
          let pairIndex = 0;
          let queue: Uint8Array[] = [headerBytes];
          const CHUNK_BYTES = 64 * 1024;
          const headers = new Headers(response.headers);
          headers.delete("content-length");

          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              while (queue.length === 0 && sent < targetTotalBytes) {
                pairIndex += 1;
                const synthKey = encoder.encode(`new.flock.ext.tasks.task/z${String(pairIndex).padStart(12, "0")}`);
                const keyFrame = frameStarItem(synthKey);
                for (let off = 0; off < keyFrame.length; off += CHUNK_BYTES) {
                  queue.push(keyFrame.subarray(off, off + CHUNK_BYTES));
                }
                for (let off = 0; off < valFrameBytes.length; off += CHUNK_BYTES) {
                  queue.push(valFrameBytes.subarray(off, off + CHUNK_BYTES));
                }
              }
              const chunk = queue.shift();
              if (!chunk) {
                controller.close();
                return;
              }
              sent += chunk.byteLength;
              oversizedBytesSeen += chunk.byteLength;
              controller.enqueue(chunk);
            },
            cancel() {
              streamCanceled = true;
              queue = [];
            },
          });
          return new Response(stream, { status: 200, headers });
        })();
      }
      return response;
    };

    const gate5Harness = createPooledTrackedTransport(network.plc.url, reader, {
      onResponse: oversizedStarWrap,
    });
    const gate5Store = new MemoryStore();
    // Pre-sync the workspace snapshot once so Gate 5 measures only Tasks oversized STAR rejection.
    await createEngine(gate5Harness.transport, {
      store: gate5Store,
      options: { concurrency: PER_ORIGIN_CONNECTIONS },
    })
      .tasks.readSpace(gate5Workspace)
      .catch(() => undefined);

    const gate5SamplesMs: number[] = [];
    const gate5RssDeltas: number[] = [];
    const gate5BytesSeen: number[] = [];
    let lastGate5View!: TasksSpaceView;
    for (let run = 0; run <= MEASURED_RUNS; run += 1) {
      oversizedBytesSeen = 0;
      streamCanceled = false;
      await gate5Store.purgeWriter(gate5TasksSpace, oversizedWriter.did);

      const gate5Engine = createEngine(gate5Harness.transport, {
        store: gate5Store,
        options: { concurrency: PER_ORIGIN_CONNECTIONS },
      });
      const rssBefore = process.memoryUsage().rss;
      let peakRss = rssBefore;
      const sampleRss = setInterval(() => {
        const current = process.memoryUsage().rss;
        if (current > peakRss) peakRss = current;
      }, 10);
      let gate5Measured: Awaited<ReturnType<typeof gate5Harness.measure<TasksSpaceView>>>;
      try {
        gate5Measured = await gate5Harness.measure([gate5Workspace, gate5TasksSpace], () =>
          gate5Engine.tasks.readSpace(gate5Workspace),
        );
      } finally {
        clearInterval(sampleRss);
      }
      const rssAfter = process.memoryUsage().rss;
      if (rssAfter > peakRss) peakRss = rssAfter;
      const rssDeltaBytes = peakRss - rssBefore;
      lastGate5View = gate5Measured.result;

      assert.equal(gate5Measured.result.complete, false, "Oversized STAR marks Tasks read incomplete");
      assert.equal(gate5Measured.result.degraded, true);
      assert.equal(gate5Measured.result.projects.length, 1, "Healthy writer data remains available alongside SetAside");
      assert.equal(
        gate5Measured.result.setAside.some(
          (entry) =>
            entry.did === oversizedWriter.did &&
            entry.permanent === true &&
            entry.reason === "its answer is larger than this app reads",
        ),
        true,
        "Oversized STAR writer is reported in SetAside as permanent",
      );
      assert.equal(streamCanceled, true, "Oversized STAR stream is canceled mid-transfer");
      assert.ok(
        oversizedBytesSeen > WORKSPACE_ENVELOPE.maxStarArchiveBytes &&
          oversizedBytesSeen < WORKSPACE_ENVELOPE.maxStarArchiveBytes + 512 * 1024,
        `Expected mid-stream abort right past 16 MiB, saw ${oversizedBytesSeen} bytes`,
      );
      if (run > 0) {
        gate5SamplesMs.push(gate5Measured.elapsedMs);
        gate5RssDeltas.push(rssDeltaBytes);
        gate5BytesSeen.push(oversizedBytesSeen);
      }
    }
    const maxRssDeltaBytes = Math.max(...gate5RssDeltas);
    const medianRssDeltaBytes = summarize(gate5RssDeltas).medianMs;
    assert.ok(
      maxRssDeltaBytes < GATE_5_MAX_RSS_DELTA_BYTES,
      `Gate 5 max peak RSS delta ${(maxRssDeltaBytes / (1024 * 1024)).toFixed(2)} MiB exceeds 32 MiB`,
    );

    const report = {
      writers: WRITER_COUNT,
      projects: PROJECT_COUNT,
      tasks: TASK_COUNT,
      edits: REGULAR_EDITS_COUNT + HOT_TASK_EDITS_COUNT,
      comments: COMMENT_COUNT,
      totalRecords: TOTAL_RECORDS,
      aggregateStarBytes,
      seedMs,
      gate1ColdLoad: {
        ...gate1Stats,
        tasksListReposCalls: 2,
        tasksGetRepoCalls: WRITER_COUNT,
        tasksGetRecordCalls: 0,
        workspaceGetRepoCalls: 1,
      },
      gate2WarmReopen: {
        ...gate2Stats,
        tasksListReposCalls: 2,
        tasksWriterCalls: 0,
        workspaceCalls: 0,
      },
      gate3IncrementalAdvance: {
        ...gate3Stats,
        tasksListReposCalls: 2,
        tasksListRepoOpsCalls: 5,
        tasksGetRepoCalls: 0,
      },
      gate4ResetRecovery: {
        ...gate4Stats,
        attemptsPerRun: gate4Retries,
      },
      gate5OversizedStar: {
        ...summarize(gate5SamplesMs),
        bytesSeenBeforeAbort: gate5BytesSeen,
        rssPeakDeltaBytes: gate5RssDeltas,
        rssPeakDeltaMedianMiB: Number((medianRssDeltaBytes / (1024 * 1024)).toFixed(2)),
        rssPeakDeltaMaxMiB: Number((maxRssDeltaBytes / (1024 * 1024)).toFixed(2)),
        setAsideDids: lastGate5View.setAside.map((entry) => entry.did),
      },
    };
    process.stdout.write(`TASKS_PERFORMANCE_ENVELOPE ${JSON.stringify(report)}\n`);

    // Sanity check cold independent reader against the same oversized STAR stream.
    const coldCheck = await readIndependentTasksSpace(gate5Harness.transport, gate5Workspace);
    assert.equal(coldCheck.complete, false);
    assert.equal(coldCheck.projects.length, 1);
    assert.equal(
      coldCheck.setAside.some(
        (entry) =>
          entry.did === oversizedWriter.did &&
          entry.permanent === true &&
          entry.reason === "its answer is larger than this app reads",
      ),
      true,
    );
  } finally {
    await network?.close();
    rmSync(dbDir, { recursive: true, force: true });
    fixtureTemp.cleanup();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
