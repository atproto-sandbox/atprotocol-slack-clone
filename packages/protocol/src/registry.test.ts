import assert from "node:assert/strict";
import test from "node:test";
import { appInboxUri, channelUri, dmConversationUri, dmInboxUri, reactionRecordKey, requestRecordKey, spaceRecordUri, subjectKey } from "./keys";
import { BLOCK_TYPE, SPACE_TYPE } from "./nsids";
import { spaceCollections, validateDmHeaderMatchesRequest, validateSpaceRecord } from "./registry";

const authorityDid = "did:plc:owner";
const memberDid = "did:plc:member";
const workspace = "at://did:plc:owner/space/new.flock.workspace/workspace";
const channel = channelUri(authorityDid, "general");
const otherChannel = channelUri(authorityDid, "private");
const now = "2026-09-24T12:00:00.000Z";

test("authority records require the authority author and canonical roster key", () => {
  const value = { subject: memberDid, active: true, updatedAt: now };
  assert.equal(validateSpaceRecord("new.flock.workspace.roster", value, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: subjectKey(memberDid),
  }).valid, true);
  assert.equal(validateSpaceRecord("new.flock.workspace.roster", value, {
    authorityDid, spaceUri: workspace, repoDid: memberDid, rkey: subjectKey(memberDid),
  }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.workspace.roster", value, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "wrong",
  }).valid, false);
});

test("workspace profile records are authority authored and use the self key", () => {
  const profile = { $type: "new.flock.workspace.profile", name: "Acme", createdAt: now };
  assert.equal(validateSpaceRecord("new.flock.workspace.profile", profile, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "self",
  }).valid, true);
  assert.equal(validateSpaceRecord("new.flock.workspace.profile", profile, {
    authorityDid, spaceUri: workspace, repoDid: memberDid, rkey: "self",
  }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.workspace.profile", profile, {
    authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "other",
  }).valid, false);
});

test("validators bind collections to space types and directory keys to channel keys", () => {
  assert.equal(validateSpaceRecord("new.flock.directory", {
    skey: "general", name: "General", visibility: "public",
  }, { authorityDid, spaceUri: channel, repoDid: authorityDid, rkey: "general" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.directory", {
    skey: "general", name: "General", visibility: "public",
  }, { authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "general" }).valid, true);
});

test("messages reject oversized, cross-channel and nested reply references", () => {
  const top = spaceRecordUri(channel, "did:plc:alice", "new.flock.channel.message", "2222222222222");
  const nested = spaceRecordUri(channel, "did:plc:bob", "new.flock.channel.message", "2222222222223");
  const baseContext = {
    authorityDid, spaceUri: channel, repoDid: "did:plc:alice", rkey: "2222222222224",
    knownMessages: new Set([top, nested]), knownTopLevelMessages: new Set([top]),
  };
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "hello", createdAt: now, parent: top }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "hello", createdAt: now, parent: nested }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "😀".repeat(10_000), createdAt: now }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "😀".repeat(10_001), createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "hello", createdAt: now, parent: `${otherChannel}/x` }, baseContext).valid, false);
});

test("request records use the workspace inbox URI shape and canonical key", () => {
  const request = { channelSkey: "general", requestId: "2222222222222", createdAt: now };
  const valid = validateSpaceRecord("new.flock.joinRequest", request, {
    authorityDid, spaceUri: "at://did:plc:owner/space/new.flock.inbox/inbox", repoDid: memberDid,
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
  assert.equal(validateSpaceRecord("new.flock.dm.request", request, context).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [memberDid, authorityDid] }, context).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.request", request, { ...context, spaceUri: "at://did:plc:owner/space/new.flock.dm.inbox/notself" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", request, { ...context, spaceUri: channel }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", request, { ...context, rkey: "2222222222223" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, convKey: "2222222222223" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, convKey: "notatid" }, { ...context, rkey: "notatid" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [participants[2], participants[1], participants[0]] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [participants[0], participants[0], participants[1], participants[2]] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [participants[0], "alice"] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [participants[0], participants[1]] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [participants[0], participants[2]] }, context).valid, false);
  const hundred = [memberDid, authorityDid, ...Array.from({ length: 98 }, (_, index) => `did:plc:user${index}`)].sort();
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: hundred }, context).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, participants: [...hundred, "did:plc:zzz"].sort() }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, createdAt: "yesterday" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.request", { ...request, note: "extra" }, context).valid, true, "an unknown field is kept and ignored");
});

test("DM headers must be authored by the half owner", () => {
  const convKey = "2222222222222";
  const half = dmConversationUri(authorityDid, convKey);
  const participants = ["did:plc:member", "did:plc:owner"];
  const header = { convKey, participants, createdAt: now };
  const context = { authorityDid, spaceUri: half, repoDid: authorityDid, rkey: "self" };
  assert.equal(validateSpaceRecord("new.flock.dm.header", header, context).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.header", header, { ...context, repoDid: memberDid }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", header, { ...context, spaceUri: "at://did:plc:owner/space/new.flock.dm.conversation/notatid" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", header, { ...context, rkey: "2222222222223" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", { ...header, convKey: "2222222222223" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", { ...header, participants: [participants[1], participants[0]] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", { ...header, participants: ["did:plc:alice", "did:plc:member"] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", { ...header, participants: ["did:plc:member"] }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", { ...header, createdAt: "yesterday" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.header", { ...header, note: "extra" }, context).valid, true, "an unknown field is kept and ignored");
});

test("DM messages require the half owner, trimmed text, and a resolvable parent", () => {
  const convKey = "2222222222222";
  const half = dmConversationUri(authorityDid, convKey);
  const otherHalf = dmConversationUri(memberDid, convKey);
  const parent = spaceRecordUri(otherHalf, memberDid, "new.flock.dm.message", "2222222222225");
  const self = spaceRecordUri(half, authorityDid, "new.flock.dm.message", "2222222222224");
  const participants = ["did:plc:member", "did:plc:owner"];
  const baseContext = { authorityDid, spaceUri: half, repoDid: authorityDid, rkey: "2222222222224", participants };
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now }, { ...baseContext, repoDid: memberDid }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now }, { ...baseContext, spaceUri: "at://did:plc:owner/space/new.flock.dm.conversation/notatid" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now }, { ...baseContext, rkey: "notatid" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "", createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "   ", createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "😀".repeat(10_000), createdAt: now }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "😀".repeat(10_001), createdAt: now }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent: self }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent: 42 }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent: `${otherHalf}/x` }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent: spaceRecordUri(otherHalf, memberDid, "new.flock.dm.message", "notatid") }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent: spaceRecordUri(dmConversationUri("did:plc:alice", "2222222222226"), "did:plc:alice", "new.flock.dm.message", "2222222222227") }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent: spaceRecordUri(otherHalf, "did:plc:alice", "new.flock.dm.message", "2222222222228") }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent }, { ...baseContext, participants: ["did:plc:owner", "did:plc:third"] }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, parent }, { ...baseContext, participants: undefined }).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: "yesterday" }, baseContext).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.message", { text: "hello", createdAt: now, note: "extra" }, baseContext).valid, true, "an unknown field is kept and ignored");
});

test("DM reactions key on a message in the same conversation", () => {
  const convKey = "2222222222222";
  const half = dmConversationUri(authorityDid, convKey);
  const otherHalf = dmConversationUri(memberDid, convKey);
  const subject = spaceRecordUri(otherHalf, memberDid, "new.flock.dm.message", "2222222222225");
  const rkey = reactionRecordKey(subject, "💜", authorityDid);
  const reaction = { subject, emoji: "💜", createdAt: now };
  const context = { authorityDid, spaceUri: half, repoDid: authorityDid, rkey };
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, context).valid, true);
  const emoji32 = "x".repeat(32);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, emoji: emoji32 }, { ...context, rkey: reactionRecordKey(subject, emoji32, authorityDid) }).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, { ...context, repoDid: memberDid }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, { ...context, spaceUri: "at://did:plc:owner/space/new.flock.dm.conversation/notatid" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, subject: "bogus" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, subject: spaceRecordUri(otherHalf, memberDid, "new.flock.dm.message", "notatid") }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, { ...context, rkey: reactionRecordKey(subject, "💜", memberDid) }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, { ...context, rkey: "x-wrong" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, subject: spaceRecordUri(dmConversationUri("did:plc:alice", "2222222222226"), "did:plc:alice", "new.flock.dm.message", "2222222222227") }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, emoji: "" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, emoji: "x".repeat(33) }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, createdAt: "yesterday" }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", { ...reaction, note: "extra" }, context).valid, true, "an unknown field is kept and ignored");
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, { ...context, participants: [authorityDid, memberDid] }).valid, true);
  assert.equal(validateSpaceRecord("new.flock.dm.reaction", reaction, { ...context, participants: [authorityDid, "did:plc:third"] }).valid, false);
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

test("no source module spells an NSID: every one comes from the NSID module", async () => {
  // given every non-test source file outside the NSID module and the generated lexicon client
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { NAMESPACE } = await import("./nsids");
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const roots = ["packages", "apps"].flatMap((group) => readdirSync(join(repository, group)).flatMap((name) => [join(group, name, "src"), join(group, name, "scripts")]))
    .concat("scripts").filter((root) => existsSync(join(repository, root)));
  const files = roots.flatMap((root) => readdirSync(join(repository, root), { recursive: true, encoding: "utf8" }).map((file) => join(root, file)))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("node_modules"))
    .filter((file) => file !== join("packages", "protocol", "src", "nsids.ts") && !file.startsWith(join("packages", "protocol", "src", "lexicons", "api")));

  // when they are searched for the namespace
  const offenders = files.filter((file) => readFileSync(join(repository, file), "utf8").includes(`${NAMESPACE}.`));

  // then none contains it
  assert.deepEqual(offenders, []);
});

test("every space lexicon lists exactly the collections registered for its space type", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../lexicons/new/flock", import.meta.url));
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith(".json"));
  const docs = files.map((file) => JSON.parse(readFileSync(join(root, file), "utf8")) as { id: string; defs: { main?: { type?: string; collections?: string[] } } });
  const spaceDocs = new Map(docs.filter((doc) => doc.defs.main?.type === "space").map((doc) => [doc.id, doc.defs.main!.collections ?? []]));

  assert.deepEqual([...spaceDocs.keys()].sort(), Object.values(SPACE_TYPE).sort(), "every space type has a space lexicon");
  for (const spaceType of Object.values(SPACE_TYPE)) {
    assert.deepEqual([...(spaceDocs.get(spaceType) ?? [])].sort(), [...spaceCollections(spaceType)].sort(), spaceType);
  }
});

test("message blocks validate shape, bounds, closed union types, unique button actionIds, and total record size", () => {
  const baseContext = { authorityDid, spaceUri: channel, repoDid: memberDid, rkey: "2222222222224" };
  const validBlocks = [
    { $type: BLOCK_TYPE.section, text: "Hello from an app" },
    { $type: BLOCK_TYPE.context, elements: ["meta 1", "meta 2"] },
    { $type: BLOCK_TYPE.divider },
    {
      $type: BLOCK_TYPE.actions,
      elements: [
        { actionId: "again_1", label: "Again", value: "payload", style: "primary" },
        { $type: BLOCK_TYPE.button, actionId: "stop-2", label: "Stop", style: "danger" },
      ],
    },
  ];
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "fallback", blocks: validBlocks, createdAt: now }, baseContext).valid, true);

  const invalidBlocks: unknown[] = [
    [{ $type: "new.flock.channel.message#unknown", text: "nope" }],
    Array.from({ length: 21 }, () => ({ $type: BLOCK_TYPE.divider })),
    [{ $type: BLOCK_TYPE.section, text: "" }],
    [{ $type: BLOCK_TYPE.section, text: "😀".repeat(3_001) }],
    [{ $type: BLOCK_TYPE.context, elements: [] }],
    [{ $type: BLOCK_TYPE.context, elements: Array.from({ length: 11 }, () => "x") }],
    [{ $type: BLOCK_TYPE.context, elements: ["😀".repeat(301)] }],
    [{ $type: BLOCK_TYPE.actions, elements: [] }],
    [{ $type: BLOCK_TYPE.actions, elements: Array.from({ length: 6 }, (_, i) => ({ actionId: `a${i}`, label: "Go" })) }],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "same", label: "One" }, { actionId: "same", label: "Two" }] }],
    [
      { $type: BLOCK_TYPE.actions, elements: [{ actionId: "same", label: "One" }] },
      { $type: BLOCK_TYPE.actions, elements: [{ actionId: "same", label: "Two" }] },
    ],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "bad id!", label: "One" }] }],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "a".repeat(65), label: "One" }] }],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "ok", label: "" }] }],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "ok", label: "😀".repeat(76) }] }],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "ok", label: "One", value: "a".repeat(2_001) }] }],
    [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "ok", label: "One", style: "warning" }] }],
  ];
  for (const blocks of invalidBlocks) {
    assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "fallback", blocks, createdAt: now }, baseContext).valid, false, JSON.stringify(blocks).slice(0, 120));
  }
  const overRecordCap = Array.from({ length: 6 }, () => ({ $type: BLOCK_TYPE.section, text: "😀".repeat(3_000) }));
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "fallback", blocks: overRecordCap, createdAt: now }, baseContext).valid, false, "64 KiB record limit still holds");
});

test("app commands and actions validate TID keys, token syntax, same-authority channels, and message references", () => {
  const appInbox = appInboxUri(authorityDid, "workspace", "did:plc:bot");
  const top = spaceRecordUri(channel, "did:plc:bot", "new.flock.channel.message", "2222222222222");
  const context = { authorityDid, spaceUri: appInbox, repoDid: memberDid, rkey: "2222222222224" };

  assert.equal(validateSpaceRecord("new.flock.app.command", { command: "echo", text: "", channel, createdAt: now }, context).valid, true, "empty command text allowed");
  assert.equal(validateSpaceRecord("new.flock.app.command", { command: "echo-2", text: "hi", channel, parent: top, createdAt: now }, context).valid, true);
  assert.equal(validateSpaceRecord("new.flock.app.command", { command: "Echo", text: "", channel, createdAt: now }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.app.command", { command: "echo", text: "", channel: channelUri("did:plc:other", "general"), createdAt: now }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.app.command", { command: "echo", text: "", channel, parent: spaceRecordUri(otherChannel, "did:plc:bot", "new.flock.channel.message", "2222222222222"), createdAt: now }, context).valid, false);

  assert.equal(validateSpaceRecord("new.flock.app.action", { message: top, actionId: "again_1", channel, createdAt: now }, context).valid, true);
  assert.equal(validateSpaceRecord("new.flock.app.action", { message: top, actionId: "bad id", channel, createdAt: now }, context).valid, false);
  assert.equal(validateSpaceRecord("new.flock.app.action", { message: spaceRecordUri(otherChannel, "did:plc:bot", "new.flock.channel.message", "2222222222222"), actionId: "again_1", channel, createdAt: now }, context).valid, false);
});
