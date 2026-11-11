import assert from "node:assert/strict";
import test from "node:test";
import { DID_DOCUMENT_TTL_MS } from "@/atproto/kem-key";
import { transportFor } from "@/testing/engine-fixture";
import { FakeNetwork } from "@/testing/fake-network";
import { RESOLUTION_TIMEOUT_MS, RESOLUTIONS_PER_ORIGIN, withIdentityCache } from "./identity";
import { MemoryStore } from "./memory-store";
import type { ClientTransport } from "./transport";

// The engine's DID resolution: held in the store across sessions for as long as the app trusts a DID document, resolved
// again at once when a MAC fails, and bounded per origin.

const ALICE = "did:plc:alice";
const TTL_MS = DID_DOCUMENT_TTL_MS;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function counting(network: FakeNetwork) {
  const calls: string[] = [];
  const base = transportFor(network, "did:plc:reader");
  const transport: ClientTransport = {
    ...base,
    resolvePds: async (did) => {
      calls.push(`pds ${did}`);
      return base.resolvePds(did);
    },
    resolveKemKey: async (did, forceRefresh) => {
      calls.push(`kem ${did}${forceRefresh ? " forced" : ""}`);
      return base.resolveKemKey(did, forceRefresh);
    },
  };
  return { transport, calls };
}

test("a host resolved in one session is answered from the store in the next, until the TTL passes", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const { transport, calls } = counting(network);
  const store = new MemoryStore();
  const first = await withIdentityCache(transport, store).resolvePds(ALICE);
  assert.equal(await withIdentityCache(transport, store).resolvePds(ALICE), first, "a later session reads the stored host");
  assert.deepEqual(calls, [`pds ${ALICE}`]);
  network.advanceClock(TTL_MS);
  await withIdentityCache(transport, store).resolvePds(ALICE);
  assert.deepEqual(calls, [`pds ${ALICE}`, `pds ${ALICE}`]);
});

test("an entry resolved in the future, after the clock was set back, is resolved again", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const { transport, calls } = counting(network);
  const store = new MemoryStore();
  await store.putIdentity({ kind: "pds", did: ALICE, value: "https://stale.test", resolvedAt: network.now() + 60_000 });
  assert.notEqual(await withIdentityCache(transport, store).resolvePds(ALICE), "https://stale.test");
  assert.deepEqual(calls, [`pds ${ALICE}`]);
});

test("a forced key refresh skips the stored key and stores the new one", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const { transport, calls } = counting(network);
  const resolver = withIdentityCache(transport, new MemoryStore());
  const old = await resolver.resolveKemKey(ALICE, false);
  await network.rotateKemKey(ALICE);
  const rotated = await resolver.resolveKemKey(ALICE, true);
  assert.notEqual(rotated, old);
  assert.equal(await resolver.resolveKemKey(ALICE, false), rotated);
  assert.deepEqual(calls, [`kem ${ALICE}`, `kem ${ALICE} forced`]);
});

test("an older resolution that finishes after a forced one does not put back what the forced one replaced", async () => {
  const network = new FakeNetwork();
  const answers: Array<(key: string) => void> = [];
  const transport: ClientTransport = {
    ...transportFor(network, "did:plc:reader"),
    resolveKemKey: () => new Promise((resolve) => answers.push(resolve)),
  };
  const store = new MemoryStore();
  const resolver = withIdentityCache(transport, store);
  const unforced = resolver.resolveKemKey(ALICE, false);
  await tick();
  assert.equal(answers.length, 1);
  const forced = resolver.resolveKemKey(ALICE, true);
  const joined = resolver.resolveKemKey(ALICE, true);
  await tick();
  assert.equal(answers.length, 2, "a forced ask does not join the unforced one, and the second forced ask joins the first");
  answers[1]!("did:key:new");
  assert.equal(await forced, "did:key:new");
  assert.equal(await joined, "did:key:new");
  answers[0]!("did:key:old");
  assert.equal(await unforced, "did:key:old");
  assert.equal((await store.getIdentity("kem", ALICE))!.value, "did:key:new");
});

test("an unforced ask while a forced resolution is in flight, with nothing stored, waits for the forced one", async () => {
  const network = new FakeNetwork();
  const answers: Array<(key: string) => void> = [];
  const transport: ClientTransport = { ...transportFor(network, "did:plc:reader"), resolveKemKey: () => new Promise((resolve) => answers.push(resolve)) };
  const resolver = withIdentityCache(transport, new MemoryStore());
  const forced = resolver.resolveKemKey(ALICE, true);
  await tick();
  const unforced = resolver.resolveKemKey(ALICE, false);
  await tick();
  assert.equal(answers.length, 1);
  answers[0]!("did:key:new");
  assert.deepEqual(await Promise.all([forced, unforced]), ["did:key:new", "did:key:new"]);
});

test("a resolution that does not answer in time fails and frees its slot for the next", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const network = new FakeNetwork();
  const transport: ClientTransport = {
    ...transportFor(network, "did:plc:reader"),
    resolvePds: (did) => (did.startsWith("did:plc:hung") ? new Promise<string>(() => undefined) : Promise.resolve("https://pds.test")),
  };
  const resolver = withIdentityCache(transport, new MemoryStore());
  const hung = Array.from({ length: RESOLUTIONS_PER_ORIGIN }, (_, n) => resolver.resolvePds(`did:plc:hung${n}`));
  const next = resolver.resolvePds("did:plc:next");
  await tick();
  t.mock.timers.tick(RESOLUTION_TIMEOUT_MS);
  for (const resolution of hung) await assert.rejects(resolution, /did not answer/);
  assert.equal(await next, "https://pds.test");
});

test("asks for one DID at once share one resolution, and a failed one is not kept", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const { transport, calls } = counting(network);
  const resolver = withIdentityCache(transport, new MemoryStore());
  await Promise.all([resolver.resolvePds(ALICE), resolver.resolvePds(ALICE), resolver.resolvePds(ALICE)]);
  assert.deepEqual(calls, [`pds ${ALICE}`]);
  await assert.rejects(resolver.resolvePds("did:plc:nobody"));
  await assert.rejects(resolver.resolvePds("did:plc:nobody"));
  assert.equal(calls.filter((call) => call === "pds did:plc:nobody").length, 2);
});

test("at most six resolutions run at once against one origin, across engines, and another origin is not held up", async () => {
  const network = new FakeNetwork();
  const running = new Map<string, number>();
  const peak = new Map<string, number>();
  const release: Array<() => void> = [];
  const transport: ClientTransport = {
    ...transportFor(network, "did:plc:reader"),
    resolvePds: async (did) => {
      const origin = did.startsWith("did:web:") ? "web" : "plc";
      running.set(origin, (running.get(origin) ?? 0) + 1);
      peak.set(origin, Math.max(peak.get(origin) ?? 0, running.get(origin)!));
      if (origin === "plc") await new Promise<void>((resolve) => release.push(resolve));
      running.set(origin, running.get(origin)! - 1);
      return "https://pds.test";
    },
  };
  const engines = [withIdentityCache(transport, new MemoryStore()), withIdentityCache(transport, new MemoryStore())];
  const plc = Array.from({ length: 10 }, (_, n) => engines[n % 2]!.resolvePds(`did:plc:writer${n}`));
  while (release.length < RESOLUTIONS_PER_ORIGIN) await tick();
  assert.equal(await engines[0]!.resolvePds("did:web:example.com"), "https://pds.test", "a did:web host is not queued behind the PLC directory");
  await tick();
  assert.equal(release.length, RESOLUTIONS_PER_ORIGIN, "the other four wait");
  while (release.length > 0 || (running.get("plc") ?? 0) > 0) {
    release.shift()?.();
    await tick();
  }
  await Promise.all(plc);
  assert.equal(peak.get("plc"), RESOLUTIONS_PER_ORIGIN);
});

test("sign-out drops the stored hosts with everything else", async () => {
  const network = new FakeNetwork();
  network.createAccount(ALICE, "pds1");
  const { transport, calls } = counting(network);
  const store = new MemoryStore();
  await withIdentityCache(transport, store).resolvePds(ALICE);
  await store.clear();
  await withIdentityCache(transport, store).resolvePds(ALICE);
  assert.equal(calls.length, 2);
});
