import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceRecordKey,
  canonicalJson,
  canonicalParticipants,
  decisionRecordKey,
  DM_INBOX_SKEY,
  dmConversationUri,
  dmInboxUri,
  parseDmConversationUri,
  parseDmInboxUri,
  parseDmMessageUri,
  parseDmSpaceUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  reactionRecordKey,
  recordKeyHash,
  requestDigest,
  requestRecordKey,
  spaceRecordUri,
  stableHash,
  subjectKey,
  tidNow,
} from "./keys";

test("stable hashes use UTF-8 SHA-256 and lowercase unpadded base32", () => {
  assert.equal(stableHash("abc"), "xj4bnp4pahh6uqkbidpf3lrceoyagyndsylxvhfucd7wd4qacwwq");
  assert.equal(recordKeyHash("abc"), "x:j:4:b:n:p:4:p:a:h:h:6:u:q:k:b:i:d:p:f:3:l:r:c:e:o:y:a:g:y:n:d:s:y:l:x:v:h:f:u:c:d:7:w:d:4:q:a:c:w:w:q");
  assert.equal(subjectKey("did:plc:alice"), `d-${recordKeyHash("did:plc:alice")}`);
  assert.equal(requestRecordKey("at://did:plc:owner/space/org.slack.channel/general", "did:plc:alice"),
    `r-${recordKeyHash("at://did:plc:owner/space/org.slack.channel/general\u0000did:plc:alice")}`);
  assert.equal(acceptanceRecordKey("at://did:plc:owner/space/org.slack.workspace/workspace"),
    `a-${recordKeyHash("at://did:plc:owner/space/org.slack.workspace/workspace")}`);
  const messageUri = spaceRecordUri("at://did:plc:owner/space/org.slack.channel/general", "did:plc:alice", "org.slack.channel.message", "abc");
  assert.equal(reactionRecordKey(messageUri, "💜", "did:plc:alice"),
    `x-${recordKeyHash(`${messageUri}\u0000💜\u0000did:plc:alice`)}`);
  const requestUri = spaceRecordUri("at://did:plc:owner/space/org.slack.inbox/inbox", "did:plc:alice", "org.slack.joinRequest", "r-abc");
  assert.equal(decisionRecordKey(requestUri), `q-${recordKeyHash(requestUri)}`);
  assert.ok(subjectKey("did:plc:alice").length <= 512);
  assert.match(subjectKey("did:plc:alice"), /^d-[a-z2-7](?::[a-z2-7]){51}$/);
  assert.deepEqual(parseSpaceRecordUri(messageUri, "at://did:plc:owner/space/org.slack.channel/general", "org.slack.channel.message"), {
    repo: "did:plc:alice", rkey: "abc",
  });
  assert.equal(parseSpaceRecordUri("at://did:plc:alice/org.slack.channel.message/abc", "at://did:plc:owner/space/org.slack.channel/general", "org.slack.channel.message"), null);
  assert.equal(parseSpaceRecordUri(messageUri, "at://did:plc:owner/space/org.slack.channel/other", "org.slack.channel.message"), null);
});

test("hash outputs are byte-identical to the fixed vectors from the pre-WebCrypto node:crypto implementation", () => {
  assert.equal(stableHash(""), "4oymiquy7qobjgx36tejs35zeqt24qpemsnzgtfeswmrw6csxbkq");
  assert.equal(stableHash("hello world"), "xfgspomtju7arjjokll5u7nl7lcij37dpjjyb3uqrd32zyxpzxuq");
  assert.equal(requestDigest({ a: 1, b: 2 }), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  assert.equal(requestDigest("hello world"), "9ddefe4435b21d901439e546d54a14a175a3493b9fd8fbf38d9ea6d3cbf70826");
  assert.equal(requestDigest([1, 2, 3]), "a615eeaee21de5179de080de8c3052c8da901138406ba71c38c032845f7d54f4");
});

test("parseSpaceUri extracts the authority, type, and skey and rejects malformed or non-DID authorities", () => {
  assert.deepEqual(parseSpaceUri("at://did:plc:owner/space/org.slack.channel/general"), {
    authorityDid: "did:plc:owner", type: "org.slack.channel", skey: "general",
  });
  assert.deepEqual(parseSpaceUri("at://did:plc:alice/space/org.slack.dm.inbox/self"), {
    authorityDid: "did:plc:alice", type: "org.slack.dm.inbox", skey: "self",
  });
  assert.equal(parseSpaceUri("not-a-uri"), null);
  assert.equal(parseSpaceUri("at://alice/space/org.slack.channel/general"), null);
  assert.equal(parseSpaceUri("at://did:plc:owner/org.slack.channel/general"), null);
  assert.equal(parseSpaceUri("at://did:plc:owner/space/org.slack.channel/general/extra"), null);
});

test("canonical JSON sorts keys and rejects values outside its JSON domain", () => {
  assert.equal(canonicalJson({ z: -0, a: [true, "x"] }), '{"a":[true,"x"],"z":0}');
  assert.equal(requestDigest({ b: 2, a: 1 }), requestDigest({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson(new Date()), /plain objects/);
});

test("TIDs use the protocol alphabet and are sortable by millisecond", () => {
  const first = tidNow(1_700_000_000_000, 1);
  const second = tidNow(1_700_000_000_001, 1);
  assert.match(first, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  assert.ok(first < second);
  assert.notEqual(tidNow(1_700_000_000_000, 1), tidNow(1_700_000_000_000, 2));
});

test("DM inbox and conversation URIs are fixed-shape and reject invalid owners or keys", () => {
  assert.equal(DM_INBOX_SKEY, "self");
  assert.equal(dmInboxUri("did:plc:alice"), "at://did:plc:alice/space/org.slack.dm.inbox/self");
  assert.throws(() => dmInboxUri("alice"), /Invalid DM inbox owner DID/);
  const convKey = "2222222222222";
  assert.equal(dmConversationUri("did:plc:alice", convKey), `at://did:plc:alice/space/org.slack.dm.conversation/${convKey}`);
  assert.throws(() => dmConversationUri("alice", convKey), /Invalid DM conversation owner DID/);
  assert.throws(() => dmConversationUri("did:plc:alice", "short"), /Invalid DM conversation key/);
  assert.throws(() => dmConversationUri("did:plc:alice", "2222222222228"), /Invalid DM conversation key/);
});

test("DM conversation URIs parse strictly and reject other space shapes", () => {
  const convKey = "234567abcdefg";
  const uri = dmConversationUri("did:plc:alice", convKey);
  assert.deepEqual(parseDmConversationUri(uri), { ownerDid: "did:plc:alice", convKey });
  assert.equal(parseDmConversationUri(`at://did:plc:alice/space/org.slack.dm.conversation/${convKey}/did:plc:alice/org.slack.dm.message/${convKey}`), null);
  assert.equal(parseDmConversationUri("at://did:plc:alice/space/org.slack.dm.inbox/self"), null);
  assert.equal(parseDmConversationUri(`at://did:plc:alice/space/org.slack.dm.conversation/notatid`), null);
  assert.equal(parseDmConversationUri(`at://alice/space/org.slack.dm.conversation/${convKey}`), null);
  assert.equal(parseDmConversationUri(""), null);
});

test("DM inbox URIs parse strictly and reject other skeys or shapes", () => {
  assert.deepEqual(parseDmInboxUri("at://did:plc:alice/space/org.slack.dm.inbox/self"), { ownerDid: "did:plc:alice" });
  assert.equal(parseDmInboxUri("at://did:plc:alice/space/org.slack.dm.inbox/other"), null);
  assert.equal(parseDmInboxUri("at://did:plc:alice/space/org.slack.dm.inbox"), null);
  assert.equal(parseDmInboxUri("at://alice/space/org.slack.dm.inbox/self"), null);
  assert.equal(parseDmInboxUri("at://did:plc:alice/space/org.slack.dm.conversation/self"), null);
  assert.equal(parseDmInboxUri(""), null);
});

test("the DM SSE route parameter accepts only DM inbox or conversation space URIs", () => {
  const convKey = "234567abcdefg";
  assert.deepEqual(parseDmSpaceUri("at://did:plc:alice/space/org.slack.dm.inbox/self"), { kind: "inbox", ownerDid: "did:plc:alice" });
  assert.deepEqual(parseDmSpaceUri(dmConversationUri("did:plc:alice", convKey)), { kind: "conversation", ownerDid: "did:plc:alice", convKey });
  for (const rejected of [
    "",
    "at://did:plc:alice/space/org.slack.workspace/workspace",
    "at://did:plc:alice/space/org.slack.inbox/inbox",
    "at://did:plc:alice/space/org.slack.channel/general",
    "at://did:plc:alice/space/org.slack.dm.inbox/other",
    `at://did:plc:alice/space/org.slack.dm.conversation/${convKey}/did:plc:alice/org.slack.dm.message/${convKey}`,
    "at://did:plc:alice/space/org.slack.dm.conversation/notatid",
    "https://example.com/space/org.slack.dm.inbox/self",
    "at://did:plc:alice/org.slack.dm.inbox/self",
  ]) {
    assert.equal(parseDmSpaceUri(rejected), null, `rejected ${rejected}`);
  }
});

test("DM message record URIs parse only the canonical owner-authored shape", () => {
  const convKey = "234567abcdefg";
  const rkey = "234567abcdefh";
  const uri = spaceRecordUri(dmConversationUri("did:plc:alice", convKey), "did:plc:alice", "org.slack.dm.message", rkey);
  assert.deepEqual(parseDmMessageUri(uri), { ownerDid: "did:plc:alice", convKey, repo: "did:plc:alice", rkey });
  const forged = spaceRecordUri(dmConversationUri("did:plc:alice", convKey), "did:plc:bob", "org.slack.dm.message", rkey);
  assert.equal(parseDmMessageUri(forged), null, "a record whose repo is not the half owner is not a canonical DM message URI");
  assert.equal(parseDmMessageUri(`at://did:plc:alice/space/org.slack.dm.conversation/${convKey}/did:plc:alice/org.slack.dm.reaction/${rkey}`), null);
  assert.equal(parseDmMessageUri(42), null);
  assert.equal(parseDmMessageUri(null), null);
});

test("canonical participants are sorted, deduplicated, and bounded to 2 through 100 DIDs", () => {
  assert.deepEqual(canonicalParticipants(["did:plc:bob", "did:plc:alice", "did:plc:bob"]), ["did:plc:alice", "did:plc:bob"]);
  const hundred = Array.from({ length: 100 }, (_, index) => `did:plc:user${index}`);
  assert.deepEqual(canonicalParticipants([...hundred].reverse()), [...hundred].sort());
  assert.throws(() => canonicalParticipants(["did:plc:alice"]), /2 to 100 unique DIDs/);
  assert.throws(() => canonicalParticipants(["did:plc:alice", "did:plc:alice"]), /2 to 100 unique DIDs/);
  assert.throws(() => canonicalParticipants(Array.from({ length: 101 }, (_, index) => `did:plc:user${index}`)), /2 to 100 unique DIDs/);
  assert.throws(() => canonicalParticipants(["did:plc:alice", "alice"]), /Invalid DM participant DID/);
});

test("DM reaction keys reuse the channel reaction key scheme over the message URI", () => {
  const half = dmConversationUri("did:plc:alice", "2222222222222");
  const messageUri = spaceRecordUri(half, "did:plc:alice", "org.slack.dm.message", "2222222222223");
  assert.equal(reactionRecordKey(messageUri, "💜", "did:plc:bob"),
    `x-${recordKeyHash(`${messageUri}\u0000💜\u0000did:plc:bob`)}`);
});
