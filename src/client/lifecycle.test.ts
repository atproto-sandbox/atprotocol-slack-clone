import assert from "node:assert/strict";
import test from "node:test";
import { channelUri, inboxUri, workspaceUri } from "@/protocol/keys";
import { Lifecycle } from "./lifecycle";
import { MemoryStore } from "./memory-store";

// The lifecycle table's rules against the store directly: which spaces each rule drops, and which it keeps.

const AUTHORITY = "did:plc:authority";
const WORKSPACE = workspaceUri(AUTHORITY, "acme");
const OTHER_WORKSPACE = workspaceUri(AUTHORITY, "other");
const GENERAL = channelUri(AUTHORITY, "acme-general");
const RANDOM = channelUri(AUTHORITY, "acme-random");
const ELSEWHERE = channelUri(AUTHORITY, "other-general");
const INBOX = inboxUri(AUTHORITY, "acme");

async function storeWithSpaces(lastOpenedAt: Record<string, number> = {}) {
  const store = new MemoryStore();
  const spaces: Array<[string, string | null]> = [[WORKSPACE, null], [GENERAL, WORKSPACE], [RANDOM, WORKSPACE], [INBOX, WORKSPACE], [OTHER_WORKSPACE, null], [ELSEWHERE, OTHER_WORKSPACE]];
  for (const [space, workspace] of spaces) {
    await store.putSpace({ space, spaceRev: null, writers: [], writersListedAt: null, workspace, lastOpenedAt: lastOpenedAt[space] ?? 1_000 });
  }
  return store;
}

const held = async (store: MemoryStore) => (await store.listSpaces()).map((state) => state.space).sort();

test("dropping a workspace drops every space that belongs to it, and nothing else", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).dropSpace(WORKSPACE);
  assert.deepEqual(await held(store), [ELSEWHERE, OTHER_WORKSPACE].sort());
});

test("dropping a channel drops that channel alone", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).dropSpace(GENERAL);
  assert.deepEqual(await held(store), [WORKSPACE, RANDOM, INBOX, OTHER_WORKSPACE, ELSEWHERE].sort());
});

test("a workspace no longer listed after discovery goes with its channels and inbox", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).keepWorkspaces([OTHER_WORKSPACE]);
  assert.deepEqual(await held(store), [OTHER_WORKSPACE, ELSEWHERE].sort());
});

test("a directory read keeps the workspace's current channels and drops the rest, leaving its inbox and other workspaces", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).keepChannels(WORKSPACE, [GENERAL]);
  assert.deepEqual(await held(store), [WORKSPACE, GENERAL, INBOX, OTHER_WORKSPACE, ELSEWHERE].sort());
});

test("the sweep drops spaces not opened within the retention period", async () => {
  const store = await storeWithSpaces({ [RANDOM]: 1, [ELSEWHERE]: 1 });
  await new Lifecycle(store, () => 2_000).sweep(1_000);
  assert.deepEqual(await held(store), [WORKSPACE, GENERAL, INBOX, OTHER_WORKSPACE].sort());
});

test("sign-out clears the store", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).signOut();
  assert.deepEqual(await held(store), []);
});
