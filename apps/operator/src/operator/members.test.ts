import assert from "node:assert/strict";
import test from "node:test";
import { channelUri } from "@flock/protocol/keys";
import { listSpaceMembers } from "../atproto/space-ops";
import { mayFollow, type MemberAccessDeps } from "./member-access";
import { putListMember, putListMembers, removeListMember, removeListMembers } from "./members";
import { fakeAuthorityPds } from "./testing/fake-authority-pds";

// The operator's member-list changes go through members.ts, which drops the change feed's cached list for that space, even
// when the change fails part way, and batches PDS putMembers / removeMembers in chunks of at most 100 entries.

const OWNER = "did:plc:owner";
const MEMBER = "did:plc:member";

test("a member-list change made by the operator is seen by the feed at once, even when the change failed", async () => {
  const space = channelUri(OWNER, "members-wrapper");
  let failNext = false;
  const pds = fakeAuthorityPds(OWNER, { intercept: () => (failNext ? Response.json({ error: "InternalServerError" }, { status: 500 }) : undefined) });
  let reads = 0;
  const access: MemberAccessDeps = {
    isRegistered: () => true,
    readMembers: async () => { reads += 1; return [...pds.membersOf(space).values()]; },
    now: () => 1_000,
  };
  assert.equal(await mayFollow(space, MEMBER, access), false);
  await putListMember(pds.session, space, MEMBER, true, true);
  assert.equal(await mayFollow(space, MEMBER, access), true, "the cached list was dropped, so the new member is seen");
  failNext = true;
  await assert.rejects(removeListMember(pds.session, space, MEMBER));
  failNext = false;
  await mayFollow(space, MEMBER, access);
  assert.equal(reads, 3, "a failed change still drops the cached list, so the next answer reads what is really there");
});

test("batch member-list helpers skip empty changes, chunk >100 entries into <=100 batches, and fakeAuthorityPds refuses missing spaces", async () => {
  const missing = channelUri(OWNER, "never-created");
  const pds = fakeAuthorityPds(OWNER);
  await assert.rejects(listSpaceMembers(pds.session, missing), /Space not found/);
  await assert.rejects(putListMember(pds.session, missing, MEMBER, true, true), /Space not found/);
  await assert.rejects(removeListMember(pds.session, missing, MEMBER), /Space not found/);

  await putListMembers(pds.session, missing, []);
  await removeListMembers(pds.session, missing, []);
  assert.deepEqual(
    pds.calls,
    [
      "com.atproto.memberspace.listMembers at://did:plc:owner/space/new.flock.channel/never-created",
      "com.atproto.memberspace.putMembers at://did:plc:owner/space/new.flock.channel/never-created",
      "com.atproto.memberspace.removeMembers at://did:plc:owner/space/new.flock.channel/never-created",
    ],
    "empty batches make no PDS call",
  );

  // 205 members chunked into 3 calls (100 + 100 + 5), within the 220-member workspace envelope
  const space = channelUri(OWNER, "batch-space");
  pds.membersOf(space);
  pds.calls.length = 0;
  const batch = Array.from({ length: 205 }, (_, idx) => ({ did: `did:plc:member-${idx}`, read: true, write: idx % 2 === 0 }));
  await putListMembers(pds.session, space, batch);
  assert.equal(pds.calls.filter((c) => c.startsWith("com.atproto.memberspace.putMembers ")).length, 3);
  assert.equal((await listSpaceMembers(pds.session, space)).length, 205);

  pds.calls.length = 0;
  await removeListMembers(pds.session, space, batch.map((entry) => entry.did));
  assert.equal(pds.calls.filter((c) => c.startsWith("com.atproto.memberspace.removeMembers ")).length, 3);
  assert.equal((await listSpaceMembers(pds.session, space)).length, 0);
});
