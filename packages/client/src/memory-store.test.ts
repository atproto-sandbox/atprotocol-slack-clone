import assert from "node:assert/strict";
import test from "node:test";
import { LTHASH_STATE_BYTES, SyncStoreError } from "./store";
import { storeContract } from "./testing/store-contract";
import { MemoryStore } from "./memory-store";
import { channelUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";

storeContract("memory store", async () => new MemoryStore());

test("memory store rolls back failed commit and updateClock mutations atomically", async () => {
  const store = new MemoryStore();
  const space = channelUri("did:plc:a", "one");
  const repo = "did:plc:w";
  const account = "did:plc:me";

  await store.updateClock(account, { lastTidMs: 1_000, lastClockId: 1, ownLastHlc: "2026-11-17T00:00:01.000Z-0000-w" });
  await store.commit({
    space,
    repo,
    expectedGeneration: 0,
    upsert: [{ space, repo, collection: COLLECTION.message, rkey: "ok", uri: `${space}/${repo}/${COLLECTION.message}/ok`, cid: "cid-ok", value: { text: "ok" } }],
    next: { syncedRev: "r1", checkedAt: 1, stale: false, coverage: {}, setHash: new Uint8Array(LTHASH_STATE_BYTES).fill(1) },
  });

  await assert.rejects(
    () =>
      store.commit({
        space,
        repo,
        expectedGeneration: 1,
        upsert: [{ space, repo, collection: COLLECTION.message, rkey: "fail", uri: `${space}/${repo}/${COLLECTION.message}/fail`, cid: "cid-fail", value: { text: "fail" } }],
        clock: { accountDid: account, lastTidMs: 9_000, lastClockId: 9 },
        next: { syncedRev: "r2", checkedAt: 2, stale: false, coverage: {}, setHash: new Uint8Array(123) },
      }),
    SyncStoreError,
  );

  await assert.rejects(
    () =>
      store.updateClock(account, () => {
        throw new Error("updater boom");
      }),
    SyncStoreError,
  );

  assert.equal((await store.getWriter(space, repo))!.generation, 1);
  assert.equal(await store.getRecord(space, repo, COLLECTION.message, "fail"), undefined);
  assert.equal((await store.getClock(account))!.lastTidMs, 1_000);
});
