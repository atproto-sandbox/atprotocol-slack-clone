import assert from "node:assert/strict";
import test from "node:test";
import { channelUri, dmConversationUri, dmInboxUri, reactionRecordKey, requestRecordKey, spaceRecordUri, subjectKey } from "./keys";
import { validateDmHeaderMatchesRequest, validateSpaceRecord } from "./records";

const authorityDid = "did:plc:owner";
const memberDid = "did:plc:member";
const workspace = "at://did:plc:owner/space/org.slack.workspace/workspace";
const channel = channelUri(authorityDid, "general");
const otherChannel = channelUri(authorityDid, "private");
const now = "2026-09-24T12:00:00.000Z";

test("authority records require the authority author and canonical roster key", () => {
  const value = { subject: memberDid, active: true, updatedAt: now };
  assert.equal(validateSpaceRecord("org.slack.workspace.roster", value, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: subjectKey(memberDid),
  }).valid, true);
  assert.equal(validateSpaceRecord("org.slack.workspace.roster", value, {
    authorityDid, spaceUri: workspace, repoDid: memberDid, rkey: subjectKey(memberDid),
  }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.workspace.roster", value, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "wrong",
  }).valid, false);
});

test("workspace profile records are authority authored and use the self key", () => {
  const profile = { $type: "org.slack.workspace.profile", name: "Acme", createdAt: now };
  assert.equal(validateSpaceRecord("org.slack.workspace.profile", profile, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "self",
  }).valid, true);
  assert.equal(validateSpaceRecord("org.slack.workspace.profile", profile, {
    authorityDid, spaceUri: workspace, repoDid: memberDid, rkey: "self",
  }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.workspace.profile", profile, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "other",
  }).valid, false);
});

test("validators bind collections to space types and directory keys to channel keys", () => {
  assert.equal(validateSpaceRecord("org.slack.directory", {
    skey: "general", name: "General", visibility: "public",
  }, { authorityDid, spaceUri: channel, repoDid: authorityDid, rkey: "general" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.directory", {
    skey: "general", name: "General", visibility: "public",
  }, { authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "general" }).valid, true);
});

test("messages reject oversized, cross-channel and nested reply references", () => {
  const top = spaceRecordUri(channel, "did:plc:alice", "org.slack.channel.message", "2222222222222");
  const nested = spaceRecordUri(channel, "did:plc:bob", "org.slack.channel.message", "2222222222223");
  const baseContext = {
    authorityDid, spaceUri: channel, repoDid: "did:plc:alice", rkey: "2222222222224",
    knownMessages: new Set([top, nested]), knownTopLevelMessages: new Set([top]),
  };
  assert.equal(validateSpaceRecord("org.slack.channel.message", { text: "hello", createdAt: now, parent: top }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("org.slack.channel.message", { text: "hello", createdAt: now, parent: nested }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.channel.message", { text: "😀".repeat(10_000), createdAt: now }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("org.slack.channel.message", { text: "😀".repeat(10_001), createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.channel.message", { text: "hello", createdAt: now, parent: `${otherChannel}/x` }, baseContext).valid, false);
});

test("request records use the workspace inbox URI shape and canonical key", () => {
  const request = { channelSkey: "general", requestId: "2222222222222", createdAt: now };
  const valid = validateSpaceRecord("org.slack.joinRequest", request, {
    authorityDid, spaceUri: "at://did:plc:owner/space/org.slack.inbox/inbox", repoDid: memberDid,
    rkey: requestRecordKey(channel, memberDid),
  });
  assert.equal(valid.valid, true);
});

test("DM requests bind the inbox space, the conversation key, and both parties", () => {
  const inbox = dmInboxUri(authorityDid);
  const convKey = "2222222222222";
  const participants = ["did:plc:alice", "did:plc:member", "did:plc:owner"];
  const request = { convKey, participants, createdAt: now };
  const context = { authorityDid, spaceUri: inbox, repoDid: memberDid, rkey: convKey };
  assert.equal(validateSpaceRecord("org.slack.dm.request", request, context).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [memberDid, authorityDid] }, context).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.request", request, { ...context, spaceUri: "at://did:plc:owner/space/org.slack.dm.inbox/notself" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", request, { ...context, spaceUri: channel }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", request, { ...context, rkey: "2222222222223" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, convKey: "2222222222223" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, convKey: "notatid" }, { ...context, rkey: "notatid" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [participants[2], participants[1], participants[0]] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [participants[0], participants[0], participants[1], participants[2]] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [participants[0], "alice"] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [participants[0], participants[1]] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [participants[0], participants[2]] }, context).valid, false);
  const hundred = [memberDid, authorityDid, ...Array.from({ length: 98 }, (_, index) => `did:plc:user${index}`)].sort();
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: hundred }, context).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, participants: [...hundred, "did:plc:zzz"].sort() }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, createdAt: "yesterday" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.request", { ...request, note: "extra" }, context).valid, false);
});

test("DM headers must be authored by the half owner", () => {
  const convKey = "2222222222222";
  const half = dmConversationUri(authorityDid, convKey);
  const participants = ["did:plc:member", "did:plc:owner"];
  const header = { convKey, participants, createdAt: now };
  const context = { authorityDid, spaceUri: half, repoDid: authorityDid, rkey: "self" };
  assert.equal(validateSpaceRecord("org.slack.dm.header", header, context).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.header", header, { ...context, repoDid: memberDid }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", header, { ...context, spaceUri: "at://did:plc:owner/space/org.slack.dm.conversation/notatid" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", header, { ...context, rkey: "2222222222223" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", { ...header, convKey: "2222222222223" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", { ...header, participants: [participants[1], participants[0]] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", { ...header, participants: ["did:plc:alice", "did:plc:member"] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", { ...header, participants: ["did:plc:member"] }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", { ...header, createdAt: "yesterday" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.header", { ...header, note: "extra" }, context).valid, false);
});

test("DM messages require the half owner, trimmed text, and a resolvable parent", () => {
  const convKey = "2222222222222";
  const half = dmConversationUri(authorityDid, convKey);
  const otherHalf = dmConversationUri(memberDid, convKey);
  const parent = spaceRecordUri(otherHalf, memberDid, "org.slack.dm.message", "2222222222225");
  const self = spaceRecordUri(half, authorityDid, "org.slack.dm.message", "2222222222224");
  const participants = ["did:plc:member", "did:plc:owner"];
  const baseContext = { authorityDid, spaceUri: half, repoDid: authorityDid, rkey: "2222222222224", participants };
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now }, { ...baseContext, repoDid: memberDid }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now }, { ...baseContext, spaceUri: "at://did:plc:owner/space/org.slack.dm.conversation/notatid" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now }, { ...baseContext, rkey: "notatid" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "", createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "   ", createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "😀".repeat(10_000), createdAt: now }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "😀".repeat(10_001), createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent: self }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent: 42 }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent: `${otherHalf}/x` }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent: spaceRecordUri(otherHalf, memberDid, "org.slack.dm.message", "notatid") }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent: spaceRecordUri(dmConversationUri("did:plc:alice", "2222222222226"), "did:plc:alice", "org.slack.dm.message", "2222222222227") }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent: spaceRecordUri(otherHalf, "did:plc:alice", "org.slack.dm.message", "2222222222228") }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent }, { ...baseContext, participants: ["did:plc:owner", "did:plc:third"] }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, parent }, { ...baseContext, participants: undefined }).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: "yesterday" }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.message", { text: "hello", createdAt: now, note: "extra" }, baseContext).valid, false);
});

test("DM reactions key on a message in the same conversation", () => {
  const convKey = "2222222222222";
  const half = dmConversationUri(authorityDid, convKey);
  const otherHalf = dmConversationUri(memberDid, convKey);
  const subject = spaceRecordUri(otherHalf, memberDid, "org.slack.dm.message", "2222222222225");
  const rkey = reactionRecordKey(subject, "💜", authorityDid);
  const reaction = { subject, emoji: "💜", createdAt: now };
  const context = { authorityDid, spaceUri: half, repoDid: authorityDid, rkey };
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, context).valid, true);
  const emoji32 = "x".repeat(32);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, emoji: emoji32 }, { ...context, rkey: reactionRecordKey(subject, emoji32, authorityDid) }).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, { ...context, repoDid: memberDid }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, { ...context, spaceUri: "at://did:plc:owner/space/org.slack.dm.conversation/notatid" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, subject: "bogus" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, subject: spaceRecordUri(otherHalf, memberDid, "org.slack.dm.message", "notatid") }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, { ...context, rkey: reactionRecordKey(subject, "💜", memberDid) }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, { ...context, rkey: "x-wrong" }).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, subject: spaceRecordUri(dmConversationUri("did:plc:alice", "2222222222226"), "did:plc:alice", "org.slack.dm.message", "2222222222227") }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, emoji: "" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, emoji: "x".repeat(33) }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, createdAt: "yesterday" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", { ...reaction, note: "extra" }, context).valid, false);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, { ...context, participants: [authorityDid, memberDid] }).valid, true);
  assert.equal(validateSpaceRecord("org.slack.dm.reaction", reaction, { ...context, participants: [authorityDid, "did:plc:third"] }).valid, false);
});

test("DM headers match requests only with identical keys and participants", () => {
  const convKey = "2222222222222";
  const participants = ["did:plc:member", "did:plc:owner"];
  const request = { convKey, participants, createdAt: now };
  assert.equal(validateDmHeaderMatchesRequest({ convKey, participants, createdAt: now }, request), true);
  assert.equal(validateDmHeaderMatchesRequest({ convKey: "2222222222223", participants, createdAt: now }, request), false);
  assert.equal(validateDmHeaderMatchesRequest({ convKey, participants: [...participants].reverse(), createdAt: now }, request), false);
  assert.equal(validateDmHeaderMatchesRequest({ convKey, participants: participants.slice(1), createdAt: now }, request), false);
  assert.equal(validateDmHeaderMatchesRequest({ convKey }, request), false);
  assert.equal(validateDmHeaderMatchesRequest(null, request), false);
  assert.equal(validateDmHeaderMatchesRequest(request, null), false);
});
