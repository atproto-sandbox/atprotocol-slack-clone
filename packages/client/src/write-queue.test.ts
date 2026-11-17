import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import { tidNow } from "@flock/protocol/keys";
import { IndexedDbStore } from "./indexeddb-store";
import { MemoryStore } from "./memory-store";
import { decodeTid, MAX_TID_COLLISION_RETRIES, WriteQueue, type WebLockManager } from "./write-queue";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const BASE_MS = 1_700_000_000_000;

Object.assign(globalThis, { IDBKeyRange });

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("concurrent writes to different entities reserve non-colliding TIDs & monotonic HLCs without blocking on slow entity I/O", async () => {
  const store = await IndexedDbStore.open(ALICE, new IDBFactory());
  try {
    let clockMs = BASE_MS;
    const queue = new WriteQueue({
      store,
      now: () => clockMs,
      randomClockId: () => 5,
      locks: null,
    });

    const entityA = "at://did:plc:auth/space/new.flock.ext.tasks/x-1/did:plc:alice/new.flock.ext.tasks.task/a";
    const entityB = "at://did:plc:auth/space/new.flock.ext.tasks/x-1/did:plc:alice/new.flock.ext.tasks.task/b";
    const entityC = "at://did:plc:auth/space/new.flock.ext.tasks/x-1/did:plc:alice/new.flock.ext.tasks.task/c";

    const gateA = createDeferred();
    const order: string[] = [];

    const writeA = queue.withEntityLock(ALICE, entityA, async () => {
      const stamp = await queue.reserveStamp(ALICE);
      order.push(`start-A:${stamp.tid}:${stamp.hlc}`);
      await gateA.promise;
      order.push("finish-A");
      return stamp;
    });

    // Entity B and C must not be blocked by Entity A's slow network I/O, and even if they finish first
    // (out-of-order HTTP completions), every reserved TID & HLC is unique and persisted monotonically.
    const writeB = queue.withEntityLock(ALICE, entityB, async () => {
      const stamp = await queue.reserveStamp(ALICE);
      order.push(`finish-B:${stamp.tid}:${stamp.hlc}`);
      return stamp;
    });

    const writeC = queue.withEntityLock(ALICE, entityC, async () => {
      const stamp = await queue.reserveStamp(ALICE);
      order.push(`finish-C:${stamp.tid}:${stamp.hlc}`);
      return stamp;
    });

    const [stampB, stampC] = await Promise.all([writeB, writeC]);
    assert.ok(order.some((entry) => entry.startsWith("finish-B:")));
    assert.ok(order.some((entry) => entry.startsWith("finish-C:")));
    assert.equal(order.includes("finish-A"), false, "B and C complete without waiting on A's HTTP gate");

    gateA.resolve();
    const stampA = await writeA;

    const tids = [stampA.tid, stampB.tid, stampC.tid];
    const hlcs = [stampA.hlc, stampB.hlc, stampC.hlc];
    assert.equal(new Set(tids).size, 3);
    assert.equal(new Set(hlcs).size, 3);
    assert.ok(stampA.tid < stampB.tid && stampB.tid < stampC.tid);
    assert.ok(stampA.hlc < stampB.hlc && stampB.hlc < stampC.hlc);

    // Even when wall clock steps backwards, persisted clock state guarantees strict monotonicity.
    clockMs = BASE_MS - 60_000;
    const stampD = await queue.reserveStamp(ALICE);
    assert.ok(stampD.tid > stampC.tid);
    assert.ok(stampD.hlc > stampC.hlc);

    const persisted = await store.getClock(ALICE, "");
    assert.equal(persisted?.ownLastHlc, stampD.hlc);
    assert.equal(tidNow(persisted!.lastTidMs, persisted!.lastClockId), stampD.tid);
  } finally {
    store.close();
  }
});

test("WriteQueue handles navigator.locks === undefined cleanly and uses Web Locks when present", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: undefined },
  });
  try {
    const store = new MemoryStore();
    const queueNoLocks = new WriteQueue({ store, now: () => BASE_MS, randomClockId: () => 1 });
    const s1 = await queueNoLocks.reserveStamp(ALICE);
    const s2 = await queueNoLocks.reserveStamp(ALICE);
    assert.ok(s2.tid > s1.tid);
    assert.ok(s2.hlc > s1.hlc);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }

  // With Web Locks present, verify lock names and cross-instance serialization.
  const store = new MemoryStore();
  const acquired: string[] = [];
  const active = new Map<string, Promise<void>>();
  const fakeLocks: WebLockManager = {
    async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      acquired.push(name);
      const prev = active.get(name) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((res) => {
        release = res;
      });
      active.set(name, tail);
      await prev;
      try {
        return await callback();
      } finally {
        release();
        if (active.get(name) === tail) active.delete(name);
      }
    },
  };

  const queue = new WriteQueue({ store, now: () => BASE_MS, randomClockId: () => 7, locks: fakeLocks });
  const entityUri = "at://did:plc:auth/space/new.flock.ext.tasks/x-1/did:plc:alice/new.flock.ext.tasks.task/t1";
  await queue.withEntityLock(ALICE, entityUri, async () => {
    await queue.reserveStamp(ALICE);
  });

  assert.deepEqual(acquired, [
    `flock:entity:${ALICE}:${entityUri}`,
    `flock:clock:${ALICE}`,
  ]);
});

test("WriteQueue serializes same-(accountDid, entityUri) mutations and rolls over clockId at 1023", async () => {
  const store = new MemoryStore();
  await store.updateClock(ALICE, { lastTidMs: BASE_MS, lastClockId: 1022 }, "");
  let randCalls = 0;
  const queue = new WriteQueue({
    store,
    now: () => BASE_MS,
    randomClockId: () => {
      randCalls += 1;
      return 9;
    },
    locks: null,
  });

  const stamp1 = await queue.reserveStamp(ALICE);
  assert.equal(stamp1.tidMs, BASE_MS);
  assert.equal(stamp1.clockId, 1023);

  const stamp2 = await queue.reserveStamp(ALICE);
  assert.equal(stamp2.tidMs, BASE_MS + 1);
  assert.equal(stamp2.clockId, 9);
  assert.equal(randCalls, 1);

  const entityUri = "at://did:plc:auth/space/new.flock.ext.tasks/x-1/did:plc:alice/new.flock.ext.tasks.task/same";
  const events: string[] = [];
  const gate1 = createDeferred();

  const p1 = queue.withEntityLock(ALICE, entityUri, async () => {
    events.push("enter-1");
    await gate1.promise;
    events.push("exit-1");
  });
  const p2 = queue.withEntityLock(ALICE, entityUri, async () => {
    events.push("enter-2");
    events.push("exit-2");
  });
  // Different account on same entityUri does not share the lock key.
  const pBob = queue.withEntityLock(BOB, entityUri, async () => {
    events.push("enter-bob");
  });

  await pBob;
  assert.deepEqual(events, ["enter-1", "enter-bob"]);
  gate1.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(events, ["enter-1", "enter-bob", "exit-1", "enter-2", "exit-2"]);
});

test("createWithTidRetry retries duplicate-rkey collisions up to MAX_TID_COLLISION_RETRIES (5) with strictly higher (ms+1, freshClockId)", async () => {
  const store = new MemoryStore();
  let clockIdSeq = 0;
  const queue = new WriteQueue({
    store,
    now: () => BASE_MS,
    randomClockId: () => 100 + clockIdSeq++,
    locks: null,
  });

  const seenAttempts: Array<{ tid: string; tidMs: number; clockId: number; hlc: string }> = [];
  const { stamp, result } = await queue.createWithTidRetry({
    accountDid: ALICE,
    observedTs: ["001700000000050.0002"],
    attemptCreate: async (reserved) => {
      seenAttempts.push(reserved);
      if (seenAttempts.length <= MAX_TID_COLLISION_RETRIES) {
        throw new XrpcError(400, "Record already exists", "RecordAlreadyExists");
      }
      return `ok:${reserved.tid}`;
    },
  });

  assert.equal(seenAttempts.length, MAX_TID_COLLISION_RETRIES + 1);
  assert.equal(result, `ok:${stamp.tid}`);
  for (let i = 1; i < seenAttempts.length; i += 1) {
    assert.ok(seenAttempts[i]!.tidMs >= seenAttempts[i - 1]!.tidMs + 1, "each retry increments tidMs >= prev + 1");
    assert.notEqual(seenAttempts[i]!.clockId, seenAttempts[i - 1]!.clockId, "each retry uses fresh clockId");
    assert.ok(seenAttempts[i]!.tid > seenAttempts[i - 1]!.tid);
    assert.ok(seenAttempts[i]!.hlc > seenAttempts[i - 1]!.hlc);
  }

  // Exceeding 5 retries rethrows RecordAlreadyExists; non-collision errors fail immediately without retry.
  let calls = 0;
  await assert.rejects(
    () =>
      queue.createWithTidRetry({
        accountDid: ALICE,
        attemptCreate: async () => {
          calls += 1;
          throw new XrpcError(409, "Record already exists", "RecordAlreadyExists");
        },
      }),
    (err: unknown) => err instanceof XrpcError && err.code === "RecordAlreadyExists",
  );
  assert.equal(calls, MAX_TID_COLLISION_RETRIES + 1);

  let nonCollisionCalls = 0;
  await assert.rejects(
    () =>
      queue.createWithTidRetry({
        accountDid: ALICE,
        attemptCreate: async () => {
          nonCollisionCalls += 1;
          throw new XrpcError(500, "Boom", "InternalServerError");
        },
      }),
    (err: unknown) => err instanceof XrpcError && err.status === 500,
  );
  assert.equal(nonCollisionCalls, 1);
});

test("observeOwnHistory advances clock state monotonically past remote/ambiguous TIDs and HLCs", async () => {
  const store = new MemoryStore();
  const queue = new WriteQueue({ store, now: () => BASE_MS, randomClockId: () => 2, locks: null });

  const futureMs = BASE_MS + 10_000;
  const futureTid = tidNow(futureMs, 88);
  const futureHlc = `${String(futureMs).padStart(15, "0")}.000a`;

  await queue.observeOwnHistory(ALICE, [
    { rkey: tidNow(BASE_MS + 50, 3), hlc: `${String(BASE_MS + 50).padStart(15, "0")}.0001` },
    { rkey: futureTid, hlc: futureHlc },
  ]);

  assert.deepEqual(decodeTid(futureTid), { ms: futureMs, clockId: 88 });
  const next = await queue.reserveStamp(ALICE);
  assert.ok(next.tid > futureTid);
  assert.ok(next.hlc > futureHlc);
});
