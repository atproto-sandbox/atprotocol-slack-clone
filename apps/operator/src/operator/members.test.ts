import assert from "node:assert/strict";
import test from "node:test";
import { channelUri } from "@flock/protocol/keys";
import { listSpaceMembers } from "../atproto/space-ops";
import { mayFollow, type MemberAccessDeps } from "./member-access";
import { putListMember, putListMembers, removeListMember, removeListMembers } from "./members";
import { fakeAuthorityPds } from "./testing/fake-authority-pds";

// The operator's member-list changes go through members.ts, which drops the change feed's cached list for that space, even
// when the change fails part way.

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

test("batch member-list helpers skip empty changes, drop cached lists on partial failure, and fakeAuthorityPds refuses missing spaces", async () => {
  const missing = channelUri(OWNER, "never-created");
  const pds = fakeAuthorityPds(OWNER);
  await assert.rejects(listSpaceMembers(pds.session, missing), /Space not found/);
  await assert.rejects(putListMember(pds.session, missing, MEMBER, true, true), /Space not found/);
  await assert.rejects(removeListMember(pds.session, missing, MEMBER), /Space not found/);

  await putListMembers(pds.session, missing, []);
  await removeListMembers(pds.session, missing, []);
  assert.deepEqual(pds.calls, ["com.atproto.memberspace.listMembers at://did:plc:owner/space/new.flock.channel/never-created",
    "com.atproto.memberspace.putMember at://did:plc:owner/space/new.flock.channel/never-created",
    "com.atproto.memberspace.removeMember at://did:plc:owner/space/new.flock.channel/never-created"], "empty batches make no PDS call");

  const space = channelUri(OWNER, "batch-space");
  pds.membersOf(space);
  await putListMembers(pds.session, space, [{ did: MEMBER, read: false, write: true }, { did: "did:plc:bot", read: true, write: false }]);
  assert.equal((await listSpaceMembers(pds.session, space)).length, 2);
  await removeListMembers(pds.session, space, ["did:plc:bot", MEMBER]);
  assert.equal((await listSpaceMembers(pds.session, space)).length, 0);
});
