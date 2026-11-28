import assert from "node:assert/strict";
import test from "node:test";
import {
  appInboxUri,
  channelUri,
  dmConversationUri,
  dmInboxUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  personalInboxUri,
  reactionRecordKey,
  requestRecordKey,
  spaceRecordUri,
  subjectKey,
  tasksSpaceUri,
  workspaceUri,
} from "./keys";
import {
  ALL_SPACE_TYPE,
  ATGRP_COLLECTION,
  ATGRP_MOD_REASON,
  ATGRP_POLICY,
  ATGRP_SPACE_TYPE,
  ATPROTO_SPACE_COLLECTION,
  BLOCK_TYPE,
  COLLECTION,
  FLOCK_EXTENSION_FIELD,
  SPACE_TYPE,
} from "./nsids";
import {
  decodeFlockConfirmationExtensions,
  decodeFlockMembershipExtensions,
  isHttpOrHttpsUrl,
  spaceCollections,
  validateDmHeaderMatchesRequest,
  validateGroupDeclaration,
  validatePublicRecord,
  validateSpacePolicy,
  validateSpaceRecord,
  validateSpaceTypeKey,
} from "./registry";

const authorityDid = "did:plc:owner";
const memberDid = "did:plc:member";
const workspace = workspaceUri(authorityDid);
const metaSpace = groupMetaUri(authorityDid);
const membersSpace = groupMembersUri(authorityDid);
const channel = channelUri(authorityDid, "general");
const otherChannel = channelUri(authorityDid, "private");
const now = "2026-09-24T12:00:00.000Z";

test("validateSpaceTypeKey enforces literal:self, tid, 1..512 record-key rules, and rejects group-owned inbox spaces", () => {
  for (const selfType of [
    ATGRP_SPACE_TYPE.meta,
    ATGRP_SPACE_TYPE.members,
    ATGRP_SPACE_TYPE.inbox,
    SPACE_TYPE.workspace,
    SPACE_TYPE.inbox,
    SPACE_TYPE.dmInbox,
  ]) {
    assert.equal(validateSpaceTypeKey(selfType, "self").valid, true, `${selfType}/self`);
    assert.equal(validateSpaceTypeKey(selfType, "foo").valid, false, `${selfType}/foo must fail`);
  }

  // Group Host cannot own org.atgrp.inbox
  assert.equal(
    validateSpaceTypeKey(ATGRP_SPACE_TYPE.inbox, "self", { isGroupHostOwnSpace: true }).valid,
    false,
  );

  // key: "any" modality spaces accept 129 and 512 chars and reject 513, '.', and '..'
  assert.equal(validateSpaceTypeKey("third.party.modality", "x".repeat(129)).valid, true);
  assert.equal(validateSpaceTypeKey("third.party.modality", "x".repeat(512)).valid, true);
  assert.equal(validateSpaceTypeKey("third.party.modality", "x".repeat(513)).valid, false);
  assert.equal(validateSpaceTypeKey("third.party.modality", ".").valid, false);
  assert.equal(validateSpaceTypeKey("third.party.modality", "..").valid, false);

  // DM conversation requires canonical TID (leading k..z rejected)
  assert.equal(validateSpaceTypeKey(SPACE_TYPE.dmConversation, "2222222222222").valid, true);
  assert.equal(validateSpaceTypeKey(SPACE_TYPE.dmConversation, "k222222222222").valid, false);
});

test("decodeFlockMembershipExtensions and decodeFlockConfirmationExtensions strictly validate types and canonical TIDs", () => {
  assert.deepEqual(
    decodeFlockMembershipExtensions({
      [FLOCK_EXTENSION_FIELD.incarnation]: "inc-1",
      [FLOCK_EXTENSION_FIELD.generation]: 2,
      [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "222222222222a",
      [FLOCK_EXTENSION_FIELD.afterWriterRev]: "2222222222227",
    }),
    {
      valid: true,
      incarnation: "inc-1",
      generation: 2,
      admittedSpaceRev: "222222222222a",
      afterWriterRev: "2222222222227",
    },
  );
  assert.equal(
    decodeFlockMembershipExtensions({ [FLOCK_EXTENSION_FIELD.afterWriterRev]: null }).valid,
    true,
  );

  for (const bad of [
    { [FLOCK_EXTENSION_FIELD.incarnation]: 42 },
    { [FLOCK_EXTENSION_FIELD.incarnation]: "has space" },
    { [FLOCK_EXTENSION_FIELD.generation]: 0 },
    { [FLOCK_EXTENSION_FIELD.generation]: "2" },
    { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "k222222222222" },
    { [FLOCK_EXTENSION_FIELD.admittedSpaceRev]: "z222222222222" },
    { [FLOCK_EXTENSION_FIELD.afterWriterRev]: "k222222222222" },
    { [FLOCK_EXTENSION_FIELD.afterWriterRev]: false },
  ]) {
    assert.equal(decodeFlockMembershipExtensions(bad).valid, false, JSON.stringify(bad));
  }

  assert.deepEqual(
    decodeFlockConfirmationExtensions({ [FLOCK_EXTENSION_FIELD.incarnation]: "inc-1" }),
    { valid: true, incarnation: "inc-1" },
  );
  assert.equal(decodeFlockConfirmationExtensions({ [FLOCK_EXTENSION_FIELD.incarnation]: "" }).valid, false);
  assert.equal(decodeFlockConfirmationExtensions({ [FLOCK_EXTENSION_FIELD.incarnation]: 123 }).valid, false);
});

test("Atmosphere Groups about, config, rule, labeler, role, membership, confirmation, invite, policy, declaration, prefix reservation, and label validation", () => {
  // About http/https website check
  assert.equal(isHttpOrHttpsUrl("https://acme.example/"), true);
  assert.equal(isHttpOrHttpsUrl("javascript:alert(1)"), false);
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.about,
      { displayName: "Acme", website: "https://acme.example/" },
      { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    true,
  );
  for (const badUrl of ["javascript:alert(1)", "data:text/html,hi", "ftp://acme.example/"]) {
    assert.equal(
      validateSpaceRecord(
        ATGRP_COLLECTION.about,
        { displayName: "Acme", website: badUrl },
        { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "self" },
      ).valid,
      false,
      badUrl,
    );
  }

  // Config accepts knownValues and custom strings
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.config,
      { joinPolicy: "open" },
      { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.config,
      { joinPolicy: "custom-future-policy" },
      { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    true,
  );

  // Rule & Labeler live in org.atgrp.members/self ONLY (rejected in meta/self!)
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.rule,
      { title: "Be kind", text: "Respect everyone" },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: "2222222222222" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.rule,
      { title: "Be kind", text: "Respect everyone" },
      { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "2222222222222" },
    ).valid,
    false,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.labeler,
      { policies: { labelValues: ["!hide"] }, reasonTypes: [ATGRP_MOD_REASON.spam, "org.example.custom#reason"] },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.labeler,
      { policies: { labelValues: ["!hide"] } },
      { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    false,
  );

  // Role: write-strict [a-z-]{3,512} vs importMode-lenient record-key
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.role,
      { permissions: ["include:org.atgrp.authModerate"] },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: "Mods" },
    ).valid,
    false,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.role,
      { permissions: ["include:org.atgrp.authModerate"] },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: "Mods", importMode: true },
    ).valid,
    true,
  );

  // Membership: rejects self DID, empty roles, non-DID rkey, and invalid role IDs (write-strict vs import-lenient)
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.membership,
      { roles: ["member"], createdAt: now },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: memberDid },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.membership,
      { roles: ["Mod1"], createdAt: now },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: memberDid },
    ).valid,
    false,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.membership,
      { roles: ["Mod1"], createdAt: now },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: memberDid, importMode: true },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.membership,
      { roles: ["member"], createdAt: now },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: authorityDid },
    ).valid,
    false,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.membership,
      { roles: [], createdAt: now },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: memberDid },
    ).valid,
    false,
  );

  // Confirmation: member-authored in members/self, rejects groupDid author
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.confirmation,
      { createdAt: now, [FLOCK_EXTENSION_FIELD.incarnation]: "inc-1" },
      { authorityDid, spaceUri: membersSpace, repoDid: memberDid, rkey: "self" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.confirmation,
      { createdAt: now },
      { authorityDid, spaceUri: membersSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    false,
  );

  // Invite: external groupDid writing into personalInboxUri(memberDid)
  const inviteSpace = personalInboxUri(memberDid);
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.invite,
      { createdAt: now, message: "Welcome!" },
      { authorityDid: memberDid, spaceUri: inviteSpace, repoDid: authorityDid, rkey: "2222222222222" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATGRP_COLLECTION.invite,
      { createdAt: now },
      { authorityDid: memberDid, spaceUri: inviteSpace, repoDid: memberDid, rkey: "2222222222222" },
    ).valid,
    false,
  );

  // Full org.atgrp.* prefix reservation in both spaces and public repos!
  assert.equal(
    validateSpaceRecord(
      "org.atgrp.forged",
      { anything: true },
      { authorityDid, spaceUri: channel, repoDid: authorityDid, rkey: "self" },
    ).valid,
    false,
  );
  assert.equal(
    validateSpaceRecord(
      "org.atgrp.declaration",
      { $type: "org.atgrp.declaration" },
      { authorityDid, spaceUri: metaSpace, repoDid: authorityDid, rkey: "self" },
    ).valid,
    false,
  );
  assert.equal(
    validatePublicRecord("org.atgrp.declaration", { $type: "org.atgrp.declaration" }, { repoDid: authorityDid, rkey: "self" }).valid,
    true,
  );
  assert.equal(
    validatePublicRecord("org.atgrp.about", { displayName: "Nope" }, { repoDid: authorityDid, rkey: "self" }).valid,
    false,
  );
  assert.equal(
    validatePublicRecord("org.atgrp.forged", { foo: "bar" }, { repoDid: authorityDid, rkey: "self" }).valid,
    false,
  );

  // Space policy: rejects duplicate role grants, non-spec role IDs (write-strict), and cross-space / non-space permissions
  assert.equal(
    validateSpacePolicy(
      { $type: ATGRP_POLICY, grants: [{ role: "member", read: true, write: true }] },
      { groupDid: authorityDid, spaceType: SPACE_TYPE.channel, skey: "general" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpacePolicy(
      { $type: ATGRP_POLICY, grants: [{ role: "Mods", read: true }] },
      { groupDid: authorityDid, spaceType: SPACE_TYPE.channel, skey: "general" },
    ).valid,
    false,
  );
  assert.equal(
    validateSpacePolicy(
      { $type: ATGRP_POLICY, grants: [{ role: "Mods", read: true }] },
      { groupDid: authorityDid, spaceType: SPACE_TYPE.channel, skey: "general", importMode: true },
    ).valid,
    true,
  );
  assert.equal(
    validateSpacePolicy(
      { $type: ATGRP_POLICY, grants: [{ role: "member" }, { role: "member" }] },
      { groupDid: authorityDid, spaceType: SPACE_TYPE.channel, skey: "general" },
    ).valid,
    false,
  );
  assert.equal(
    validateSpacePolicy(
      {
        $type: ATGRP_POLICY,
        grants: [{ role: "member", permissions: ["space:new.flock.channel?skey=other&action=read"] }],
      },
      { groupDid: authorityDid, spaceType: SPACE_TYPE.channel, skey: "general" },
    ).valid,
    false,
  );

  // Group declaration (empty marker record)
  assert.equal(
    validateGroupDeclaration({ $type: "org.atgrp.declaration" }, authorityDid).valid,
    true,
  );
  assert.equal(
    validateGroupDeclaration({ $type: "org.atgrp.wrong" }, authorityDid).valid,
    false,
  );

  // Labels: tid rkey, EmptyLabelValue, CrossSpaceLabel
  const msgUri = spaceRecordUri(channel, memberDid, COLLECTION.message, "2222222222222");
  assert.equal(
    validateSpaceRecord(
      ATPROTO_SPACE_COLLECTION.label,
      { uri: msgUri, val: "!hide", cts: now },
      { authorityDid, spaceUri: channel, repoDid: authorityDid, rkey: "2222222222223" },
    ).valid,
    true,
  );
  assert.equal(
    validateSpaceRecord(
      ATPROTO_SPACE_COLLECTION.label,
      { uri: msgUri, val: "", cts: now },
      { authorityDid, spaceUri: channel, repoDid: authorityDid, rkey: "2222222222223" },
    ).valid,
    false,
  );
  assert.equal(
    validateSpaceRecord(
      ATPROTO_SPACE_COLLECTION.label,
      { uri: msgUri, val: "!hide", cts: now },
      { authorityDid, spaceUri: otherChannel, repoDid: authorityDid, rkey: "2222222222223" },
    ).valid,
    false,
  );
});

test("validators bind collections to space types and directory keys to channel keys", () => {
  assert.equal(validateSpaceRecord("new.flock.directory", {
    skey: "general", name: "General", visibility: "public",
  }, { authorityDid, spaceUri: channel, repoDid: authorityDid, rkey: "general" }).valid, false);
  assert.equal(validateSpaceRecord("new.flock.directory", {
    skey: "general", name: "General", visibility: "public",
  }, { authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "general" }).valid, true);
});

test("messages, requests, DMs, app commands/actions, and Tasks collections preserve all validation invariants", () => {
  const top = spaceRecordUri(channel, "did:plc:alice", "new.flock.channel.message", "2222222222222");
  const nested = spaceRecordUri(channel, "did:plc:bob", "new.flock.channel.message", "2222222222223");
  const baseContext = {
    authorityDid, spaceUri: channel, repoDid: "did:plc:alice", rkey: "2222222222224",
    knownMessages: new Set([top, nested]), knownTopLevelMessages: new Set([top]),
  };
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "hello", createdAt: now, parent: top }, baseContext).valid, true);
  assert.equal(validateSpaceRecord("new.flock.channel.message", { text: "hello", createdAt: now, parent: nested }, baseContext).valid, false);

  const request = { channelSkey: "general", requestId: "2222222222222", createdAt: now };
  assert.equal(
    validateSpaceRecord("new.flock.joinRequest", request, {
      authorityDid,
      spaceUri: inboxUri(authorityDid),
      repoDid: memberDid,
      rkey: requestRecordKey(channel, memberDid),
    }).valid,
    true,
  );

  const dmInbox = dmInboxUri(authorityDid);
  const convKey = "2222222222222";
  const participants = ["did:plc:member", "did:plc:owner"];
  assert.equal(
    validateSpaceRecord("new.flock.dm.request", { convKey, participants, createdAt: now }, {
      authorityDid, spaceUri: dmInbox, repoDid: memberDid, rkey: convKey,
    }).valid,
    true,
  );
  const half = dmConversationUri(authorityDid, convKey);
  assert.equal(
    validateSpaceRecord("new.flock.dm.header", { convKey, participants, createdAt: now }, {
      authorityDid, spaceUri: half, repoDid: authorityDid, rkey: "self",
    }).valid,
    true,
  );
  assert.equal(validateDmHeaderMatchesRequest({ convKey, participants, createdAt: now }, { convKey, participants, createdAt: now }), true);

  const dmSubject = spaceRecordUri(dmConversationUri(memberDid, convKey), memberDid, "new.flock.dm.message", "2222222222225");
  const dmReactionKey = reactionRecordKey(dmSubject, "💜", authorityDid);
  assert.equal(
    validateSpaceRecord("new.flock.dm.reaction", { subject: dmSubject, emoji: "💜", createdAt: now }, {
      authorityDid, spaceUri: half, repoDid: authorityDid, rkey: dmReactionKey,
    }).valid,
    true,
  );

  const appInbox = appInboxUri(authorityDid, "self", "did:plc:bot");
  assert.equal(
    validateSpaceRecord("new.flock.app.command", { command: "echo", text: "", channel, createdAt: now }, {
      authorityDid, spaceUri: appInbox, repoDid: memberDid, rkey: "2222222222224",
    }).valid,
    true,
  );

  const tasksSpace = tasksSpaceUri(authorityDid);
  assert.equal(
    validateSpaceRecord(
      COLLECTION.extInstall,
      { extId: "tasks", active: true, space: tasksSpace, cleanupComplete: false, enabledBy: authorityDid, enabledAt: now, updatedAt: now },
      { authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: "tasks" },
    ).valid,
    true,
  );

  assert.equal(
    validateSpaceRecord("new.flock.channel.message", {
      text: "fallback",
      blocks: [{ $type: BLOCK_TYPE.section, text: "Hello" }],
      createdAt: now,
    }, { authorityDid, spaceUri: channel, repoDid: memberDid, rkey: "2222222222224" }).valid,
    true,
  );

  assert.equal(
    validateSpaceRecord(
      COLLECTION.appInstall,
      { subject: "did:plc:bot", active: true, channels: [{ skey: "general", write: true }], installedBy: authorityDid, installedAt: now, updatedAt: now },
      { authorityDid, spaceUri: workspace, repoDid: authorityDid, rkey: subjectKey("did:plc:bot") },
    ).valid,
    true,
  );
});

test("no source module spells new.flock.* literally: every one comes from nsids.ts", async () => {
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { NAMESPACE } = await import("./nsids");
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const roots = ["packages", "apps"]
    .flatMap((group) =>
      readdirSync(join(repository, group)).flatMap((name) => [
        join(group, name, "src"),
        join(group, name, "scripts"),
      ]),
    )
    .concat("scripts")
    .filter((root) => existsSync(join(repository, root)));
  const files = roots
    .flatMap((root) =>
      readdirSync(join(repository, root), { recursive: true, encoding: "utf8" }).map((file) => join(root, file)),
    )
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("node_modules"))
    .filter(
      (file) =>
        file !== join("packages", "protocol", "src", "nsids.ts") &&
        !file.startsWith(join("packages", "protocol", "src", "lexicons", "api")),
    );

  const offenders = files.filter((file) => readFileSync(join(repository, file), "utf8").includes(`${NAMESPACE}.`));
  assert.deepEqual(offenders, []);
});

test("every Flock and Atmosphere Groups space lexicon lists exactly the collections registered for its space type", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const flockRoot = fileURLToPath(new URL("../lexicons/new/flock", import.meta.url));
  const atgrpRoot = fileURLToPath(new URL("../lexicons/org/atgrp", import.meta.url));
  const readSpaces = (root: string) =>
    (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(root, file), "utf8")) as { id: string; defs: { main?: { type?: string; title?: string; name?: string; collections?: string[] } } })
      .filter((doc) => doc.defs.main?.type === "space");

  const spaceMains = [...readSpaces(flockRoot), ...readSpaces(atgrpRoot)];
  const spaceDocs = new Map(spaceMains.map((doc) => [doc.id, doc.defs.main!.collections ?? []]));

  assert.deepEqual([...spaceDocs.keys()].sort(), Object.values(ALL_SPACE_TYPE).sort(), "every space type has a space lexicon");
  for (const doc of spaceMains) {
    assert.equal(typeof doc.defs.main?.title, "string", `${doc.id} declares title`);
    assert.equal(doc.defs.main?.name, undefined, `${doc.id} no longer declares deprecated name`);
  }
  for (const spaceType of Object.values(ALL_SPACE_TYPE)) {
    const lexCols = [...(spaceDocs.get(spaceType) ?? [])]
      .filter((col) =>
        !(
          (spaceType === ATGRP_SPACE_TYPE.meta || spaceType === ATGRP_SPACE_TYPE.members) &&
          col === ATPROTO_SPACE_COLLECTION.spacePolicy
        ),
      )
      .sort();
    assert.deepEqual(lexCols, [...spaceCollections(spaceType)].sort(), spaceType);
  }
});
