import assert from "node:assert/strict";
import test from "node:test";
import {
  appInboxSkey,
  appInboxUri,
  appRoleKey,
  canonicalJson,
  canonicalParticipants,
  channelRoleKey,
  decisionRecordKey,
  DM_INBOX_SKEY,
  dmConversationUri,
  dmInboxUri,
  extSpaceSkey,
  extSpaceUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  isDid,
  isRecordKey,
  isSkey,
  isTid,
  isValidModTag,
  isValidRoleId,
  normalizeLegacySpaceUri,
  parseAnySpaceRecordUri,
  parseAppInboxUri,
  parseChannelUri,
  parseDmConversationUri,
  parseDmInboxUri,
  parseDmMessageUri,
  parseDmSpaceUri,
  parseExtSpaceUri,
  parseGroupMembersUri,
  parseGroupMetaUri,
  parseInboxUri,
  parsePersonalInboxUri,
  parseSpaceRecordUri,
  parseSpaceUri,
  parseTasksSpaceUri,
  parseWorkspaceUri,
  personalInboxUri,
  reactionRecordKey,
  recordKeyHash,
  requestDigest,
  requestRecordKey,
  requireSpaceAuthority,
  spaceRecordUri,
  stableHash,
  subjectKey,
  tasksSpaceUri,
  tidNow,
  workspaceUri,
} from "./keys";

test("stable hashes, appRoleKey, channelRoleKey, isValidRoleId, and isValidModTag follow Atmosphere Groups constraints", () => {
  assert.equal(stableHash("abc"), "xj4bnp4pahh6uqkbidpf3lrceoyagyndsylxvhfucd7wd4qacwwq");
  assert.equal(recordKeyHash("abc"), "x:j:4:b:n:p:4:p:a:h:h:6:u:q:k:b:i:d:p:f:3:l:r:c:e:o:y:a:g:y:n:d:s:y:l:x:v:h:f:u:c:d:7:w:d:4:q:a:c:w:w:q");
  assert.equal(subjectKey("did:plc:alice"), `d-${recordKeyHash("did:plc:alice")}`);
  const roleKey = appRoleKey("did:plc:bot1");
  assert.equal(roleKey.length, 68);
  assert.match(roleKey, /^app-[a-p]{64}$/);
  assert.equal(isValidRoleId(roleKey), true);
  assert.equal(isRecordKey(roleKey), true);

  // Bijective alpha-nibble channelRoleKey works for short, 61-char, and max 128-char skeys
  const genRole = channelRoleKey("general");
  assert.match(genRole, /^channel-[a-p]+$/);
  assert.equal(isValidRoleId(genRole), true);
  assert.notEqual(channelRoleKey("general"), channelRoleKey("General"));
  assert.notEqual(channelRoleKey("a_b"), channelRoleKey("a-b"));
  const key61Role = channelRoleKey("c".repeat(61));
  assert.equal(key61Role.length, 8 + 61 * 2);
  assert.equal(isValidRoleId(key61Role), true);
  const key128Role = channelRoleKey("k".repeat(128));
  assert.equal(key128Role.length, 8 + 128 * 2);
  assert.equal(isValidRoleId(key128Role), true);

  // Role ID syntax: [a-z-]{3,512}
  assert.equal(isValidRoleId("mod"), true);
  assert.equal(isValidRoleId("a-b"), true);
  assert.equal(isValidRoleId("ab"), false);
  assert.equal(isValidRoleId("Mod"), false);
  assert.equal(isValidRoleId("mod1"), false);
  assert.equal(isValidRoleId("a".repeat(512)), true);
  assert.equal(isValidRoleId("a".repeat(513)), false);

  // Mod tag syntax: [a-z-]{1,128}
  assert.equal(isValidModTag("a"), true);
  assert.equal(isValidModTag("needs-review"), true);
  assert.equal(isValidModTag(""), false);
  assert.equal(isValidModTag("BadTag"), false);
  assert.equal(isValidModTag("tag1"), false);
  assert.equal(isValidModTag("a".repeat(128)), true);
  assert.equal(isValidModTag("a".repeat(129)), false);
  assert.equal(requestRecordKey("at:space/did:plc:owner/new.flock.channel/general", "did:plc:alice"),
    `r-${recordKeyHash("at:space/did:plc:owner/new.flock.channel/general\u0000did:plc:alice")}`);
  const messageUri = spaceRecordUri("at:space/did:plc:owner/new.flock.channel/general", "did:plc:alice", "new.flock.channel.message", "abc");
  assert.equal(reactionRecordKey(messageUri, "💜", "did:plc:alice"),
    `x-${recordKeyHash(`${messageUri}\u0000💜\u0000did:plc:alice`)}`);
  const requestUri = spaceRecordUri("at:space/did:plc:owner/new.flock.inbox/self", "did:plc:alice", "new.flock.joinRequest", "r-abc");
  assert.equal(decisionRecordKey(requestUri), `q-${recordKeyHash(requestUri)}`);
  assert.deepEqual(parseSpaceRecordUri(messageUri, "at:space/did:plc:owner/new.flock.channel/general", "new.flock.channel.message"), {
    repo: "did:plc:alice", rkey: "abc",
  });
  assert.equal(parseSpaceRecordUri("at://did:plc:alice/new.flock.channel.message/abc", "at:space/did:plc:owner/new.flock.channel/general", "new.flock.channel.message"), null);
  assert.equal(parseSpaceRecordUri(messageUri, "at:space/did:plc:owner/new.flock.channel/other", "new.flock.channel.message"), null);
});

test("hash outputs are byte-identical to fixed SHA-256 vectors", () => {
  assert.equal(stableHash(""), "4oymiquy7qobjgx36tejs35zeqt24qpemsnzgtfeswmrw6csxbkq");
  assert.equal(stableHash("hello world"), "xfgspomtju7arjjokll5u7nl7lcij37dpjjyb3uqrd32zyxpzxuq");
  assert.equal(requestDigest({ a: 1, b: 2 }), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  assert.equal(requestDigest("hello world"), "9ddefe4435b21d901439e546d54a14a175a3493b9fd8fbf38d9ea6d3cbf70826");
  assert.equal(requestDigest([1, 2, 3]), "a615eeaee21de5179de080de8c3052c8da901138406ba71c38c032845f7d54f4");
});

test("isRecordKey and parseSpaceUri accept 1..512-character protocol record keys while isSkey caps Flock keys at 128", () => {
  const key129 = "k".repeat(129);
  const key512 = "k".repeat(512);
  const key513 = "k".repeat(513);

  assert.equal(isRecordKey("acme-1"), true);
  assert.equal(isRecordKey(".hidden"), true);
  assert.equal(isRecordKey(key129), true);
  assert.equal(isRecordKey(key512), true);
  assert.equal(isRecordKey(key513), false);
  assert.equal(isRecordKey("."), false);
  assert.equal(isRecordKey(".."), false);
  assert.equal(isRecordKey(""), false);

  assert.equal(isSkey("acme-1"), true);
  assert.equal(isSkey("x".repeat(128)), true);
  assert.equal(isSkey(key129), false);
  assert.equal(isSkey("."), false);
  assert.equal(isSkey(".."), false);

  assert.deepEqual(parseSpaceUri(`at:space/did:plc:owner/third.party.modality/${key129}`), {
    authorityDid: "did:plc:owner",
    type: "third.party.modality",
    skey: key129,
  });
  assert.deepEqual(parseSpaceUri(`at:space/did:plc:owner/third.party.modality/${key512}`), {
    authorityDid: "did:plc:owner",
    type: "third.party.modality",
    skey: key512,
  });
  assert.equal(parseSpaceUri(`at:space/did:plc:owner/third.party.modality/${key513}`), null);
  assert.equal(parseSpaceUri("at:space/did:plc:owner/third.party.modality/."), null);
  assert.equal(parseSpaceUri("at:space/did:plc:owner/third.party.modality/.."), null);
});

test("Atmosphere Groups and Flock literal:self space URIs enforce self keys strictly", () => {
  assert.equal(groupMetaUri("did:plc:grp"), "at:space/did:plc:grp/org.atgrp.meta/self");
  assert.equal(groupMembersUri("did:plc:grp"), "at:space/did:plc:grp/org.atgrp.members/self");
  assert.equal(personalInboxUri("did:plc:alice"), "at:space/did:plc:alice/org.atgrp.inbox/self");
  assert.equal(workspaceUri("did:plc:grp"), "at:space/did:plc:grp/new.flock.workspace/self");
  assert.equal(inboxUri("did:plc:grp"), "at:space/did:plc:grp/new.flock.inbox/self");

  assert.deepEqual(parseGroupMetaUri("at:space/did:plc:grp/org.atgrp.meta/self"), { groupDid: "did:plc:grp" });
  assert.equal(parseGroupMetaUri("at:space/did:plc:grp/org.atgrp.meta/other"), null);
  assert.deepEqual(parseGroupMembersUri("at:space/did:plc:grp/org.atgrp.members/self"), { groupDid: "did:plc:grp" });
  assert.equal(parseGroupMembersUri("at:space/did:plc:grp/org.atgrp.members/other"), null);
  assert.deepEqual(parsePersonalInboxUri("at:space/did:plc:alice/org.atgrp.inbox/self"), { userDid: "did:plc:alice" });
  assert.equal(parsePersonalInboxUri("at:space/did:plc:alice/org.atgrp.inbox/other"), null);

  assert.deepEqual(parseWorkspaceUri("at:space/did:plc:owner/new.flock.workspace/self"), { authorityDid: "did:plc:owner", skey: "self" });
  assert.equal(parseWorkspaceUri("at:space/did:plc:owner/new.flock.workspace/team"), null);
  assert.deepEqual(parseInboxUri("at:space/did:plc:owner/new.flock.inbox/self"), { authorityDid: "did:plc:owner", skey: "self" });
  assert.equal(parseInboxUri("at:space/did:plc:owner/new.flock.inbox/team"), null);

  assert.deepEqual(parseChannelUri("at:space/did:plc:owner/new.flock.channel/general"), { authorityDid: "did:plc:owner", skey: "general" });
  assert.equal(parseChannelUri(`at:space/did:plc:owner/new.flock.channel/${"x".repeat(129)}`), null);
  assert.equal(requireSpaceAuthority("at:space/did:plc:owner/new.flock.inbox/self"), "did:plc:owner");
  assert.throws(() => requireSpaceAuthority("at:space/did:plc:owner/new.flock.inbox/.."), /Invalid permissioned space URI/);
});

test("isTid enforces canonical pinned isValidTid first-character [234567abcdefghij] rule and rejects leading k..z", () => {
  const first = tidNow(1_700_000_000_000, 1);
  const second = tidNow(1_700_000_000_001, 1);
  assert.equal(isTid(first), true);
  assert.equal(isTid(second), true);
  assert.equal(isTid("2222222222222"), true);
  assert.equal(isTid("jzzzzzzzzzzzz"), true);
  assert.ok(first < second);
  for (const leading of "klmnopqrstuvwxyz") {
    assert.equal(isTid(`${leading}222222222222`), false, `leading ${leading} must be rejected`);
  }
  assert.equal(isTid("1222222222222"), false);
  assert.equal(isTid("222222222222"), false);
  assert.equal(isTid("22222222222222"), false);
});

test("a DID is bounded in length", () => {
  assert.equal(isDid("did:plc:abc"), true);
  assert.equal(isDid("did:web:localhost%3A3000"), true);
  assert.equal(isDid(`did:plc:${"a".repeat(512)}`), true);
  assert.equal(isDid(`did:plc:${"a".repeat(513)}`), false);
  assert.equal(isDid("did:PLC:abc"), false);
  assert.equal(isDid("did:plc:ab c"), false);
});

test("canonical JSON sorts keys and rejects values outside its JSON domain", () => {
  assert.equal(canonicalJson({ z: -0, a: [true, "x"] }), '{"a":[true,"x"],"z":0}');
  assert.equal(requestDigest({ b: 2, a: 1 }), requestDigest({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson(new Date()), /plain objects/);
});

test("DM inbox and conversation URIs are fixed-shape and reject invalid owners or keys", () => {
  assert.equal(DM_INBOX_SKEY, "self");
  assert.equal(dmInboxUri("did:plc:alice"), "at:space/did:plc:alice/new.flock.dm.inbox/self");
  assert.throws(() => dmInboxUri("alice"), /Invalid DM inbox owner DID/);
  const convKey = "2222222222222";
  assert.equal(dmConversationUri("did:plc:alice", convKey), `at:space/did:plc:alice/new.flock.dm.conversation/${convKey}`);
  assert.throws(() => dmConversationUri("alice", convKey), /Invalid DM conversation owner DID/);
  assert.throws(() => dmConversationUri("did:plc:alice", "short"), /Invalid DM conversation key/);
  assert.throws(() => dmConversationUri("did:plc:alice", "k222222222222"), /Invalid DM conversation key/);
  assert.deepEqual(parseDmConversationUri(`at:space/did:plc:alice/new.flock.dm.conversation/${convKey}`), { ownerDid: "did:plc:alice", convKey });
  assert.deepEqual(parseDmInboxUri("at:space/did:plc:alice/new.flock.dm.inbox/self"), { ownerDid: "did:plc:alice" });
  assert.deepEqual(parseDmSpaceUri("at:space/did:plc:alice/new.flock.dm.inbox/self"), { kind: "inbox", ownerDid: "did:plc:alice" });
  const rkey = "234567abcdefh";
  const uri = spaceRecordUri(dmConversationUri("did:plc:alice", convKey), "did:plc:alice", "new.flock.dm.message", rkey);
  assert.deepEqual(parseDmMessageUri(uri), { ownerDid: "did:plc:alice", convKey, repo: "did:plc:alice", rkey });
});

test("canonical participants, appInboxUri, and extSpaceSkey preserve deterministic derivation", () => {
  assert.deepEqual(canonicalParticipants(["did:plc:bob", "did:plc:alice", "did:plc:bob"]), ["did:plc:alice", "did:plc:bob"]);
  const skey = appInboxSkey("self", "did:plc:bot");
  assert.equal(skey.length, 105);
  assert.equal(isSkey(skey), true);
  assert.deepEqual(parseAppInboxUri(appInboxUri("did:plc:owner", "self", "did:plc:bot")), { authorityDid: "did:plc:owner", skey });
  const tasksKey = extSpaceSkey("self", "tasks");
  assert.equal(tasksKey.length, 105);
  assert.deepEqual(parseTasksSpaceUri(tasksSpaceUri("did:plc:owner", "self")), { authorityDid: "did:plc:owner", skey: tasksKey });
  assert.deepEqual(parseExtSpaceUri(extSpaceUri("did:plc:owner", "self", "tasks", "new.flock.ext.tasks")), {
    authorityDid: "did:plc:owner",
    type: "new.flock.ext.tasks",
    skey: tasksKey,
  });
});

test("at:space/ URIs round-trip strictly for space refs and space records, support did:web underscores, and reject legacy/handle forms", () => {
  const webDid = "did:web:my_team.example.com";
  const sp = workspaceUri(webDid);
  assert.equal(sp, "at:space/did:web:my_team.example.com/new.flock.workspace/self");
  assert.deepEqual(parseSpaceUri(sp), {
    authorityDid: webDid,
    type: "new.flock.workspace",
    skey: "self",
  });

  const rec = spaceRecordUri(sp, "did:plc:alice", "new.flock.directory", "general");
  assert.equal(rec, "at:space/did:web:my_team.example.com/new.flock.workspace/self/did:plc:alice/new.flock.directory/general");
  assert.deepEqual(parseAnySpaceRecordUri(rec), {
    spaceUri: sp,
    authorityDid: webDid,
    spaceType: "new.flock.workspace",
    skey: "self",
    repoDid: "did:plc:alice",
    collection: "new.flock.directory",
    rkey: "general",
  });

  // Strict rejection of legacy at://<did>/space/..., handles, and invalid lengths
  assert.equal(parseSpaceUri("at://did:plc:owner/space/new.flock.workspace/self"), null);
  assert.equal(parseAnySpaceRecordUri("at://did:plc:owner/space/new.flock.channel/gen/did:plc:alice/new.flock.channel.message/2222222222222"), null);
  assert.equal(parseSpaceUri("at:space/alice.bsky.social/new.flock.workspace/self"), null);
  assert.equal(parseSpaceUri("at:space/did:plc:owner/new.flock.workspace"), null);
  assert.equal(parseAnySpaceRecordUri(`${sp}/did:plc:alice/new.flock.directory`), null);

  // Explicit legacy normalizer rewrites old-form URIs idempotently and leaves canonical/non-space URIs intact
  assert.equal(
    normalizeLegacySpaceUri("at://did:plc:owner/space/new.flock.workspace/self"),
    "at:space/did:plc:owner/new.flock.workspace/self",
  );
  assert.equal(
    normalizeLegacySpaceUri("at://did:plc:owner/space/new.flock.channel/gen/did:plc:alice/new.flock.channel.message/2222222222222"),
    "at:space/did:plc:owner/new.flock.channel/gen/did:plc:alice/new.flock.channel.message/2222222222222",
  );
  assert.equal(normalizeLegacySpaceUri(sp), sp);
  assert.equal(normalizeLegacySpaceUri("at://did:plc:owner/app.bsky.feed.post/2222222222222"), "at://did:plc:owner/app.bsky.feed.post/2222222222222");
});
