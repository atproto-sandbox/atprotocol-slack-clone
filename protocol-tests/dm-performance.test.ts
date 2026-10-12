import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { JoseKey } from "@atproto/jwk-jose";
import { AtprotoClient } from "@/atproto/xrpc";
import { DmClient, type DmDeps, type DmStore } from "@/dm/dm-client";
import { tidNow } from "@/protocol/keys";
import { mapLimited } from "@/lib/map-limited";
import { createFixtureTempRoot } from "./fixture-temp";

// M4 exit evidence (.ai/plans/dm-tasks/m4.md): a 100-participant conversation
// with 20,000 total messages must let `readConversation` fetch the latest 100
// in <= 5 seconds on the local two-PDS fixture.

type TestAgent = {
  com: { atproto: { server: {
    createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
  } } };
};
type TestPds = { url: string; getAgent(): TestAgent };
type TestNetwork = { pds: TestPds; extraPdses: TestPds[]; close(): Promise<void> };
type Actor = { did: string; accessJwt: string; pds: TestPds };

const PINNED_CHECKOUT = process.env.ATPROTO_PINNED_CHECKOUT;
const PARTICIPANTS = 100;
const TOTAL_MESSAGES = 20_000;
const MESSAGES_PER_HALF = TOTAL_MESSAGES / PARTICIPANTS;
const APPLY_WRITES_BATCH = 100;
const READ_BUDGET_MS = 5_000;

test("DM read budget: 100 participants, 20,000 total messages, latest-100 read in <= 5s", { timeout: 10 * 60 * 1000 }, async () => {
  assert.ok(PINNED_CHECKOUT, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(PINNED_CHECKOUT, "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; pds?: { rateLimitsEnabled?: boolean } }): Promise<TestNetwork> };
  };
  const fixtureTemp = createFixtureTempRoot("dm-performance-fixture-");
  let network: TestNetwork | undefined;
  try {
    network = await TestNetworkNoAppView.create({ extraPdses: 1, pds: { rateLimitsEnabled: false } });
    const pdsByDid = new Map<string, string>();

    const createActor = async (pds: TestPds, name: string, domain: string): Promise<Actor> => {
      const { data } = await pds.getAgent().com.atproto.server.createAccount({
        handle: `${name}.${domain}`, email: `${name}@dm-performance.test`, password: `${name}-dm-performance-pass`,
      });
      pdsByDid.set(data.did, pds.url);
      return { did: data.did, accessJwt: data.accessJwt, pds };
    };

    const rawClientFor = (actor: Actor): AtprotoClient => new AtprotoClient(async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return fetch(new URL(path, actor.pds.url), { ...init, headers, redirect: "error" });
    });

    const createStore = (): DmStore => {
      const map = new Map<string, string>();
      return {
        async get(key) { return map.has(key) ? map.get(key)! : null; },
        async set(key, value) { map.set(key, value); },
        async delete(key) { map.delete(key); },
      };
    };

    const depsFor = (actor: Actor): DmDeps => ({
      did: actor.did,
      memberClient: rawClientFor(actor),
      resolvePds: async (did) => {
        const url = pdsByDid.get(did);
        if (!url) throw new Error(`dm-performance: no known PDS for ${did}`);
        return url;
      },
      fetchEndpoint: (request) => fetch(request),
      generateKey: () => JoseKey.generate(["ES256"]),
      store: createStore(),
    });

    const setupStarted = performance.now();
    const participants: Actor[] = [];
    for (let index = 0; index < PARTICIPANTS; index += 1) {
      const pds = index % 2 === 0 ? network.pds : network.extraPdses[0];
      participants.push(await createActor(pds, `dm${String(index).padStart(3, "0")}`, index % 2 === 0 ? "test" : "test2"));
    }
    const accountsMs = performance.now() - setupStarted;
    process.stdout.write(`DM_PERFORMANCE_PROGRESS accounts=${PARTICIPANTS} elapsedMs=${Math.round(accountsMs)}\n`);

    const convKey = tidNow();
    const allDids = participants.map((actor) => actor.did).sort();
    const createdAt = new Date().toISOString();

    const halfSetupStarted = performance.now();
    await mapLimited(participants, 16, async (owner) => {
      const client = rawClientFor(owner);
      const half = `at://${owner.did}/space/org.slack.dm.conversation/${convKey}`;
      await client.procedure("com.atproto.simplespace.createSpace", {
        type: "org.slack.dm.conversation", skey: convKey,
        readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
        writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
        appAccess: { $type: "com.atproto.simplespace.defs#open" },
      });
      await mapLimited(participants.filter((other) => other.did !== owner.did), 16, (other) =>
        client.procedure("com.atproto.simplespace.putMember", { space: half, did: other.did, read: true, write: false }));
      await client.procedure("com.atproto.space.putRecord", {
        space: half, repo: owner.did, collection: "org.slack.dm.header", rkey: "self",
        record: { $type: "org.slack.dm.header", convKey, participants: allDids, createdAt },
      });
      return { owner, half, client };
    });
    const halfSetupMs = performance.now() - halfSetupStarted;
    process.stdout.write(`DM_PERFORMANCE_PROGRESS halves=${PARTICIPANTS} putMembers=${PARTICIPANTS * (PARTICIPANTS - 1)} elapsedMs=${Math.round(halfSetupMs)}\n`);

    // Interleaved timestamps: message sequence `s` for every participant lands
    // in the same relative time slot, so the true latest 100 spans all 100
    // halves instead of one participant's own tail.
    const base = Date.now() - PARTICIPANTS * MESSAGES_PER_HALF - 1_000;
    const messageStarted = performance.now();
    let totalWritten = 0;
    await mapLimited(participants.map((owner, participantIndex) => ({ owner, participantIndex })), 16, async ({ owner, participantIndex }) => {
      const client = rawClientFor(owner);
      const half = `at://${owner.did}/space/org.slack.dm.conversation/${convKey}`;
      for (let batchStart = 0; batchStart < MESSAGES_PER_HALF; batchStart += APPLY_WRITES_BATCH) {
        const writes = Array.from({ length: Math.min(APPLY_WRITES_BATCH, MESSAGES_PER_HALF - batchStart) }, (_unused, offset) => {
          const sequence = batchStart + offset;
          const timestamp = base + sequence * PARTICIPANTS + participantIndex;
          const rkey = tidNow(timestamp, 0);
          return {
            $type: "com.atproto.space.applyWrites#create", collection: "org.slack.dm.message", rkey,
            value: { $type: "org.slack.dm.message", text: `from ${owner.did} #${sequence}`, createdAt: new Date(timestamp).toISOString() },
          };
        });
        const response = await client.procedure<unknown, { results?: unknown[] }>("com.atproto.space.applyWrites", { space: half, repo: owner.did, writes });
        assert.equal(response.results?.length, writes.length);
        totalWritten += writes.length;
      }
    });
    const messageWriteMs = performance.now() - messageStarted;
    assert.equal(totalWritten, TOTAL_MESSAGES);
    process.stdout.write(`DM_PERFORMANCE_PROGRESS messages=${totalWritten} elapsedMs=${Math.round(messageWriteMs)}\n`);

    const reader = new DmClient(depsFor(participants[0]!));
    const readStarted = performance.now();
    const page = await reader.readConversation(convKey, allDids, { limit: 100 });
    const readMs = performance.now() - readStarted;

    assert.equal(page.messages.length, 100, "the latest-100 page is full");
    assert.equal(Object.keys(page.halves).length, PARTICIPANTS);
    assert.ok(Object.values(page.halves).every((status) => status === "ok"));
    const contributingHalves = new Set(page.messages.map((message) => message.ownerDid));
    assert.equal(contributingHalves.size, PARTICIPANTS, "the interleaved timestamps make every half contribute to the latest page");

    const report = {
      participants: PARTICIPANTS,
      totalMessages: TOTAL_MESSAGES,
      accountProvisioningMs: Math.round(accountsMs),
      halfSetupMs: Math.round(halfSetupMs),
      messageWriteMs: Math.round(messageWriteMs),
      readLatest100Ms: Math.round(readMs),
    };
    process.stdout.write(`DM_PERFORMANCE_ENVELOPE ${JSON.stringify(report)}\n`);
    assert.ok(readMs <= READ_BUDGET_MS, `readConversation took ${Math.round(readMs)}ms, exceeding the ${READ_BUDGET_MS}ms budget`);
  } finally {
    try {
      await network?.close();
    } finally {
      fixtureTemp.cleanup();
    }
  }
});
