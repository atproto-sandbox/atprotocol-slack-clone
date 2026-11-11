import assert from "node:assert/strict";
import test from "node:test";
import { channelUri } from "@/protocol/keys";
import { mayFollow, type MemberAccessDeps } from "./member-access";
import { putListMember, removeListMember } from "./members";
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
