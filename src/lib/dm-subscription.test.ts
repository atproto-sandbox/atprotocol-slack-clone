import assert from "node:assert/strict";
import test from "node:test";
import { authorizeDmSubscription } from "./dm-subscription";

const alice = "did:plc:alice";
const bob = "did:plc:bob";
const convKey = "2222222222222";

test("an inbox change stream is limited to its owner", () => {
  assert.deepEqual(authorizeDmSubscription(`at://${alice}/space/org.slack.dm.inbox/self`, alice), { allowed: true, space: `at://${alice}/space/org.slack.dm.inbox/self` });
  assert.deepEqual(authorizeDmSubscription(`at://${alice}/space/org.slack.dm.inbox/self`, bob), { allowed: false, status: 403, reason: "A DM inbox change stream is limited to its owner." });
});

test("a conversation half stream is allowed for any signed-in user because its random key is the guard", () => {
  const half = `at://${alice}/space/org.slack.dm.conversation/${convKey}`;
  assert.deepEqual(authorizeDmSubscription(half, bob), { allowed: true, space: half });
});

test("anything that is not a DM space URI is rejected", () => {
  for (const space of ["", "at://did:plc:alice/space/org.slack.channel/general", `at://${alice}/space/org.slack.dm.inbox/notself`, `at://${alice}/space/org.slack.dm.conversation/not-a-tid`, "https://example.com"]) {
    assert.deepEqual(authorizeDmSubscription(space, alice), { allowed: false, status: 400, reason: "The space must be a DM inbox or DM conversation URI." }, space);
  }
});
