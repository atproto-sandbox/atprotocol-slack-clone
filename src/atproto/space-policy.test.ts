import assert from "node:assert/strict";
import test from "node:test";
import { MEMBERSPACE_POLICY, isMemberListOnly, memberspacePolicy, readMemberspacePolicy } from "./space-policy";

test("memberspacePolicy sends every flag explicitly, because updateSpace replaces the whole policy", () => {
  assert.deepEqual(memberspacePolicy(), { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: false });
  assert.deepEqual(memberspacePolicy({ publicWrite: true }), { $type: MEMBERSPACE_POLICY, publicRead: false, publicWrite: true });
});

test("readMemberspacePolicy fills the authority's defaults and ignores unknown or mistyped fields", () => {
  assert.deepEqual(readMemberspacePolicy({ $type: MEMBERSPACE_POLICY }), { publicRead: false, publicWrite: false, allowedApps: undefined, publishPolicy: false, publishMembers: false });
  assert.deepEqual(
    readMemberspacePolicy({ $type: MEMBERSPACE_POLICY, publicRead: true, publicWrite: "yes", allowedApps: ["a", 1, "b"], publishMembers: true }),
    { publicRead: true, publicWrite: false, allowedApps: ["a", "b"], publishPolicy: false, publishMembers: true },
  );
});

test("readMemberspacePolicy refuses any other policy type or a non-object", () => {
  for (const value of [undefined, null, "memberspace", 3, [], {}, { $type: "com.atproto.personalspace.policy" }, { $type: "com.atproto.managedspace.policy", managingApp: "did:web:x" }]) {
    assert.equal(readMemberspacePolicy(value), null);
  }
});

test("isMemberListOnly is true only for a memberspace with no public side, no app allow-list and nothing published", () => {
  assert.equal(isMemberListOnly({ $type: MEMBERSPACE_POLICY }), true);
  assert.equal(isMemberListOnly(memberspacePolicy()), true);
  for (const flag of [{ publicRead: true }, { publicWrite: true }, { allowedApps: [] }, { allowedApps: ["client"] }, { publishPolicy: true }, { publishMembers: true }]) {
    assert.equal(isMemberListOnly({ $type: MEMBERSPACE_POLICY, ...flag }), false, JSON.stringify(flag));
  }
  assert.equal(isMemberListOnly({ $type: "com.atproto.personalspace.policy" }), false);
});
