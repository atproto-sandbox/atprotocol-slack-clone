import assert from "node:assert/strict";
import test from "node:test";
import { channelUri, groupMembersUri, groupMetaUri, inboxUri, tasksSpaceUri, workspaceUri } from "@flock/protocol/keys";
import { Lifecycle } from "./lifecycle";
import { MemoryStore } from "./memory-store";

// The lifecycle table's rules against the store directly: which spaces each rule drops, and which it keeps.

const AUTHORITY = "did:plc:authority";
const OTHER_AUTHORITY = "did:plc:other-authority";
const WORKSPACE = workspaceUri(AUTHORITY);
const META = groupMetaUri(AUTHORITY);
const MEMBERS = groupMembersUri(AUTHORITY);
const OTHER_WORKSPACE = workspaceUri(OTHER_AUTHORITY);
const OTHER_META = groupMetaUri(OTHER_AUTHORITY);
const OTHER_MEMBERS = groupMembersUri(OTHER_AUTHORITY);
const GENERAL = channelUri(AUTHORITY, "general");
const RANDOM = channelUri(AUTHORITY, "random");
const ELSEWHERE = channelUri(OTHER_AUTHORITY, "general");
const INBOX = inboxUri(AUTHORITY, "self");
const TASKS = tasksSpaceUri(AUTHORITY, "self");

async function storeWithSpaces(lastOpenedAt: Record<string, number> = {}) {
  const store = new MemoryStore();
  const spaces: Array<[string, string | null]> = [
    [WORKSPACE, null],
    [META, null],
    [MEMBERS, null],
    [GENERAL, WORKSPACE],
    [RANDOM, WORKSPACE],
    [INBOX, WORKSPACE],
    [TASKS, WORKSPACE],
    [OTHER_WORKSPACE, null],
    [OTHER_META, null],
    [OTHER_MEMBERS, null],
    [ELSEWHERE, OTHER_WORKSPACE],
  ];
  for (const [space, workspace] of spaces) {
    await store.putSpace({ space, spaceRev: null, writers: [], writersListedAt: null, workspace, lastOpenedAt: lastOpenedAt[space] ?? 1_000 });
  }
  return store;
}

const held = async (store: MemoryStore) => (await store.listSpaces()).map((state) => state.space).sort();

test("dropping a workspace or its OpenSocial core spaces drops every space that belongs to it, and nothing else", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).dropSpace(WORKSPACE);
  assert.deepEqual(await held(store), [ELSEWHERE, OTHER_MEMBERS, OTHER_META, OTHER_WORKSPACE].sort());

  const store2 = await storeWithSpaces();
  await new Lifecycle(store2, () => 2_000).dropSpace(MEMBERS);
  assert.deepEqual(await held(store2), [ELSEWHERE, OTHER_MEMBERS, OTHER_META, OTHER_WORKSPACE].sort());
});

test("dropping a channel drops that channel alone", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).dropSpace(GENERAL);
  assert.deepEqual(
    await held(store),
    [WORKSPACE, META, MEMBERS, RANDOM, INBOX, TASKS, OTHER_WORKSPACE, OTHER_META, OTHER_MEMBERS, ELSEWHERE].sort(),
  );
});

test("a workspace no longer listed after discovery goes with its OpenSocial core spaces, channels, inbox, and extension spaces", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).keepWorkspaces([OTHER_WORKSPACE]);
  assert.deepEqual(await held(store), [OTHER_WORKSPACE, OTHER_META, OTHER_MEMBERS, ELSEWHERE].sort());
});

test("a directory read keeps the workspace's current channels and drops the rest, leaving its inbox, extensions, and other workspaces", async () => {
  const store = await storeWithSpaces();
  await new Lifecycle(store, () => 2_000).keepChannels(WORKSPACE, [GENERAL]);
  assert.deepEqual(
    await held(store),
    [WORKSPACE, META, MEMBERS, GENERAL, INBOX, TASKS, OTHER_WORKSPACE, OTHER_META, OTHER_MEMBERS, ELSEWHERE].sort(),
  );
});

test("keepWorkspaceSpaces retains active extension spaces alongside channels and inbox, and purges disabled ones", async () => {
  const store = await storeWithSpaces();
  const lifecycle = new Lifecycle(store, () => 2_000);
  await lifecycle.keepWorkspaceSpaces(WORKSPACE, [WORKSPACE, INBOX, GENERAL, TASKS]);
  assert.deepEqual(
    await held(store),
    [WORKSPACE, META, MEMBERS, GENERAL, INBOX, TASKS, OTHER_WORKSPACE, OTHER_META, OTHER_MEMBERS, ELSEWHERE].sort(),
  );

  await lifecycle.keepWorkspaceSpaces(WORKSPACE, { channels: [GENERAL], extensions: [] });
  assert.deepEqual(
    await held(store),
    [WORKSPACE, META, MEMBERS, GENERAL, INBOX, OTHER_WORKSPACE, OTHER_META, OTHER_MEMBERS, ELSEWHERE].sort(),
  );
});

test("the sweep drops spaces not opened within the retention period", async () => {
  const store = await storeWithSpaces({ [RANDOM]: 1, [ELSEWHERE]: 1 });
  await new Lifecycle(store, () => 2_000).sweep(1_000);
  assert.deepEqual(
    await held(store),
    [WORKSPACE, META, MEMBERS, GENERAL, INBOX, TASKS, OTHER_WORKSPACE, OTHER_META, OTHER_MEMBERS].sort(),
  );
});
