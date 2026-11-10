import assert from "node:assert/strict";
import test from "node:test";
import { selectValidChannelMessages, type ChannelMessageRecord } from "./valid-channel-messages";
import { spaceRecordUri } from "@/protocol/keys";

const authority = "did:plc:authority";
const space = `at://${authority}/space/new.flock.channel/general`;
const timestamp = "2026-01-01T00:00:00.000Z";

function message(repo: string, rkey: string, value: Record<string, unknown>): ChannelMessageRecord {
  return { uri: spaceRecordUri(space, repo, "new.flock.channel.message", rkey), rkey, repo, value };
}

test("invalid messages do not displace valid history or authorize replies", async () => {
  const malformedParent = message("did:plc:writer", "3333333333333", {
    $type: "new.flock.channel.message", text: "", createdAt: timestamp,
  });
  const validParent = message("did:plc:writer", "2222222222222", {
    $type: "new.flock.channel.message", text: "valid", createdAt: timestamp,
  });
  const invalidReply = message("did:plc:reply", "3333333333334", {
    $type: "new.flock.channel.message", text: "reply", createdAt: timestamp, parent: malformedParent.uri,
  });
  let parentReads = 0;
  const selected = await selectValidChannelMessages([malformedParent, invalidReply, validParent], {
    authorityDid: authority,
    spaceUri: space,
    limit: 1,
    getParent: async () => {
      parentReads += 1;
      return { uri: malformedParent.uri, value: malformedParent.value };
    },
  });
  assert.deepEqual(selected.messages.map((record) => record.uri), [validParent.uri]);
  assert.equal(selected.knownTopLevelMessages.has(malformedParent.uri), false);
  assert.equal(selected.knownMessages.has(invalidReply.uri), false);
  assert.equal(parentReads, 1);
});

test("valid one-level replies remain selectable when their top-level parent is valid", async () => {
  const parent = message("did:plc:writer", "2222222222222", {
    $type: "new.flock.channel.message", text: "parent", createdAt: timestamp,
  });
  const reply = message("did:plc:reply", "2222222222223", {
    $type: "new.flock.channel.message", text: "reply", createdAt: timestamp, parent: parent.uri,
  });
  const selected = await selectValidChannelMessages([reply, parent], {
    authorityDid: authority,
    spaceUri: space,
    limit: 2,
    getParent: async () => null,
  });
  assert.deepEqual(selected.messages.map((record) => record.uri), [reply.uri, parent.uri]);
  assert.equal(selected.knownMessages.has(reply.uri), true);
});
