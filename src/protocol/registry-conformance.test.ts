import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Lexicons, type LexiconDoc } from "@atproto/lexicon";
import {
  acceptanceRecordKey, channelUri, decisionRecordKey, dmConversationUri, dmInboxUri, inboxUri, reactionRecordKey, requestRecordKey,
  spaceRecordUri, subjectKey, workspaceUri,
} from "./keys";
import { COLLECTION, type Collection } from "./nsids";
import { REGISTRY, validateRecordShape, validateSpaceRecord, type RecordContext } from "./registry";

// The registry's two validation layers checked against the published lexicon documents: shape agrees with `@atproto/lexicon`
// reading those documents alone, every semantic rule rejects a well-shaped record that breaks it, and an unknown field is kept.

const AUTHORITY = "did:plc:owner";
const MEMBER = "did:plc:member";
const NOW = "2026-11-01T12:00:00.000Z";
const WORKSPACE = workspaceUri(AUTHORITY, "acme");
const INBOX = inboxUri(AUTHORITY, "acme");
const CHANNEL = channelUri(AUTHORITY, "acme-general");
const OTHER_CHANNEL = channelUri(AUTHORITY, "acme-random");
const MESSAGE = spaceRecordUri(CHANNEL, MEMBER, COLLECTION.message, "2222222222222");
const REPLY = spaceRecordUri(CHANNEL, MEMBER, COLLECTION.message, "2222222222223");
const CONV_KEY = "2222222222224";
const HALF = dmConversationUri(AUTHORITY, CONV_KEY);
const OTHER_HALF = dmConversationUri(MEMBER, CONV_KEY);
const DM_MESSAGE = spaceRecordUri(OTHER_HALF, MEMBER, COLLECTION.dmMessage, "2222222222225");
const PARTICIPANTS = [MEMBER, AUTHORITY];
const JOIN_REQUEST = spaceRecordUri(INBOX, MEMBER, COLLECTION.joinRequest, requestRecordKey(CHANNEL, MEMBER));

type Fixture = { record: Record<string, unknown>; context: RecordContext };

/** One record per collection that both layers accept, with the context it is read in. */
const FIXTURES: Record<Collection, Fixture> = {
  [COLLECTION.workspaceProfile]: { record: { name: "Acme", createdAt: NOW }, context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: "self" } },
  [COLLECTION.directory]: {
    record: { skey: "acme-general", name: "general", visibility: "public" },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: "acme-general" },
  },
  [COLLECTION.workspaceRoster]: {
    record: { subject: MEMBER, active: true, updatedAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: subjectKey(MEMBER) },
  },
  [COLLECTION.admin]: {
    record: { subject: MEMBER, active: true, updatedAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: subjectKey(MEMBER) },
  },
  [COLLECTION.acceptance]: {
    record: { workspace: WORKSPACE, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: MEMBER, rkey: acceptanceRecordKey(WORKSPACE) },
  },
  [COLLECTION.joinRequest]: {
    record: { channelSkey: "acme-general", requestId: "2222222222226", createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: INBOX, repoDid: MEMBER, rkey: requestRecordKey(CHANNEL, MEMBER) },
  },
  [COLLECTION.joinDecision]: {
    record: { request: JOIN_REQUEST, requestId: "2222222222226", decision: "approve", updatedAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: INBOX, repoDid: AUTHORITY, rkey: decisionRecordKey(JOIN_REQUEST) },
  },
  [COLLECTION.message]: {
    record: { text: "hello", createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: CHANNEL, repoDid: MEMBER, rkey: "2222222222227", knownMessages: new Set([MESSAGE, REPLY]), knownTopLevelMessages: new Set([MESSAGE]) },
  },
  [COLLECTION.reaction]: {
    record: { subject: MESSAGE, emoji: "👍", createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: CHANNEL, repoDid: MEMBER, rkey: reactionRecordKey(MESSAGE, "👍", MEMBER), knownMessages: new Set([MESSAGE]) },
  },
  [COLLECTION.channelRoster]: {
    record: { subject: MEMBER, active: true, updatedAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: CHANNEL, repoDid: AUTHORITY, rkey: subjectKey(MEMBER) },
  },
  [COLLECTION.dmRequest]: {
    record: { convKey: CONV_KEY, participants: PARTICIPANTS, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: dmInboxUri(AUTHORITY), repoDid: MEMBER, rkey: CONV_KEY },
  },
  [COLLECTION.dmHeader]: {
    record: { convKey: CONV_KEY, participants: PARTICIPANTS, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: HALF, repoDid: AUTHORITY, rkey: "self" },
  },
  [COLLECTION.dmMessage]: {
    record: { text: "hello", createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: HALF, repoDid: AUTHORITY, rkey: "222222222222a", participants: PARTICIPANTS },
  },
  [COLLECTION.dmReaction]: {
    record: { subject: DM_MESSAGE, emoji: "👍", createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: HALF, repoDid: AUTHORITY, rkey: reactionRecordKey(DM_MESSAGE, "👍", AUTHORITY), participants: PARTICIPANTS },
  },
};

/** The published lexicon documents, read from disk with no registry code in between. */
const PUBLISHED_DOCS: LexiconDoc[] = (readdirSync("lexicons", { recursive: true }) as string[])
  .filter((path) => path.endsWith(".json"))
  .map((path) => JSON.parse(readFileSync(join("lexicons", path), "utf8")) as LexiconDoc);
const PUBLISHED = new Lexicons(PUBLISHED_DOCS);

type PropertyDef = { type: string; format?: string; enum?: string[]; minLength?: number; maxLength?: number; maxGraphemes?: number; items?: PropertyDef };
type CorpusItem = { label: string; value: Record<string, unknown>; wellShaped: boolean };

/** Well- and ill-shaped variants of a record, derived from its lexicon's property definitions. */
function shapeCorpus(collection: Collection, base: Record<string, unknown>): CorpusItem[] {
  const doc = PUBLISHED_DOCS.find((candidate) => candidate.id === collection);
  const schema = (doc?.defs.main as { record?: { required?: string[]; properties: Record<string, PropertyDef> } } | undefined)?.record;
  assert.ok(schema, `${collection} has a published record lexicon`);
  const items: CorpusItem[] = [
    { label: "fixture", value: base, wellShaped: true },
    { label: "unknown field", value: { ...base, addedByAnotherApp: { nested: [1, "two"] } }, wellShaped: true },
  ];
  for (const field of schema.required ?? []) {
    items.push({ label: `without ${field}`, value: Object.fromEntries(Object.entries(base).filter(([key]) => key !== field)), wellShaped: false });
  }
  for (const [field, def] of Object.entries(schema.properties)) {
    const variant = (label: string, value: unknown, wellShaped: boolean) => items.push({ label: `${field} ${label}`, value: { ...base, [field]: value }, wellShaped });
    variant("null", null, false);
    if (def.type === "boolean") variant("as a string", "true", false);
    if (def.type === "string") {
      variant("as a number", 42, false);
      if (def.format) variant(`not a ${def.format}`, "not valid!", false);
      if (def.enum) variant("outside its enum", "somethingElse", false);
      if (def.minLength) variant("empty", "", false);
      if (def.maxGraphemes) {
        // An emoji is one grapheme and four UTF-8 bytes, so the grapheme limit is reached exactly at the byte limit.
        variant("at its grapheme limit", "😀".repeat(def.maxGraphemes), true);
        variant("over its grapheme limit", "😀".repeat(def.maxGraphemes + 1), false);
        variant("over its grapheme limit in ASCII", "a".repeat(def.maxGraphemes + 1), false);
      } else if (def.maxLength) {
        variant("at its length limit", "a".repeat(def.maxLength), true);
        variant("over its length limit", "a".repeat(def.maxLength + 1), false);
      }
    }
    if (def.type === "array") {
      variant("as a string", "x", false);
      variant("with a wrongly typed item", [42, 43], false);
      if (def.minLength) variant("under its length", PARTICIPANTS.slice(0, def.minLength - 1), false);
      if (def.maxLength) variant("over its length", Array.from({ length: def.maxLength + 1 }, (_, index) => `did:plc:user${String(index).padStart(3, "0")}`), false);
    }
  }
  return items;
}

test("every registered collection has a fixture both layers accept", () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), Object.keys(REGISTRY).sort());
  for (const [collection, { record, context }] of Object.entries(FIXTURES)) {
    assert.deepEqual(validateSpaceRecord(collection, record, context), { valid: true }, collection);
  }
});

test("schema parity: the registry's shape layer and the published lexicons alone give every corpus record the same verdict", () => {
  let compared = 0;
  for (const [collection, { record, context }] of Object.entries(FIXTURES) as Array<[Collection, Fixture]>) {
    for (const item of shapeCorpus(collection, record)) {
      // #given one corpus record
      // #when both validate its shape
      const registry = validateRecordShape(collection, item.value).valid;
      const lexicon = PUBLISHED.validate(collection, item.value).success;

      // #then they agree, and agree with how the record was built
      assert.equal(registry, lexicon, `${collection}: ${item.label}`);
      assert.equal(lexicon, item.wellShaped, `${collection}: ${item.label} was built ${item.wellShaped ? "well" : "ill"}-shaped`);
      // ...and a record the lexicon rejects never gets through full validation
      if (!item.wellShaped) assert.equal(validateSpaceRecord(collection, item.value, context).valid, false, `${collection}: ${item.label}`);
      compared += 1;
    }
  }
  assert.ok(compared > 150, `the corpus is not trivially small (${compared} records)`);
});

type SemanticCase = { collection: Collection; breaks: string; record?: Record<string, unknown>; context?: Partial<RecordContext>; reason: RegExp };

const SEMANTIC_CASES: SemanticCase[] = [
  // Wrong author.
  ...[COLLECTION.workspaceProfile, COLLECTION.directory, COLLECTION.workspaceRoster, COLLECTION.admin, COLLECTION.joinDecision, COLLECTION.channelRoster]
    .map((collection): SemanticCase => ({ collection, breaks: "authored by a member", context: { repoDid: MEMBER }, reason: /wrong author/ })),
  ...[COLLECTION.dmHeader, COLLECTION.dmMessage, COLLECTION.dmReaction]
    .map((collection): SemanticCase => ({ collection, breaks: "authored by someone other than the half owner", context: { repoDid: MEMBER }, reason: /half owner/ })),
  // Wrong space type.
  ...(Object.keys(FIXTURES) as Collection[]).map((collection): SemanticCase => ({
    collection, breaks: "read in a space of another type", context: { spaceUri: FIXTURES[collection].context.spaceUri === WORKSPACE ? CHANNEL : WORKSPACE }, reason: /space type/,
  })),
  // Wrong key.
  { collection: COLLECTION.workspaceProfile, breaks: "a key other than self", context: { rkey: "other" }, reason: /must be self/ },
  { collection: COLLECTION.dmHeader, breaks: "a key other than self", context: { rkey: "other" }, reason: /must be self/ },
  { collection: COLLECTION.message, breaks: "a key that is not a TID", context: { rkey: "self" }, reason: /TID/ },
  { collection: COLLECTION.dmMessage, breaks: "a key that is not a TID", context: { rkey: "self" }, reason: /TID/ },
  { collection: COLLECTION.directory, breaks: "a key other than its skey", context: { rkey: "acme-random" }, reason: /directory key/ },
  { collection: COLLECTION.workspaceRoster, breaks: "a key other than its subject's", context: { rkey: subjectKey(AUTHORITY) }, reason: /roster key/ },
  { collection: COLLECTION.admin, breaks: "a key other than its subject's", context: { rkey: subjectKey(AUTHORITY) }, reason: /roster key/ },
  { collection: COLLECTION.channelRoster, breaks: "a key other than its subject's", context: { rkey: subjectKey(AUTHORITY) }, reason: /roster key/ },
  { collection: COLLECTION.acceptance, breaks: "a key for another workspace", context: { rkey: acceptanceRecordKey(workspaceUri(AUTHORITY, "other")) }, reason: /acceptance key/ },
  { collection: COLLECTION.joinRequest, breaks: "another member's request key", context: { rkey: requestRecordKey(CHANNEL, AUTHORITY) }, reason: /not canonical/ },
  { collection: COLLECTION.joinDecision, breaks: "a key for another request", context: { rkey: decisionRecordKey(spaceRecordUri(INBOX, MEMBER, COLLECTION.joinRequest, "other")) }, reason: /join decision key/ },
  { collection: COLLECTION.reaction, breaks: "another author's reaction key", context: { rkey: reactionRecordKey(MESSAGE, "👍", AUTHORITY) }, reason: /reaction key/ },
  { collection: COLLECTION.dmRequest, breaks: "a key other than its conversation key", context: { rkey: "222222222222b" }, reason: /conversation key/ },
  { collection: COLLECTION.dmReaction, breaks: "another author's reaction key", context: { rkey: reactionRecordKey(DM_MESSAGE, "👍", MEMBER) }, reason: /reaction key/ },
  // A reference outside the space.
  { collection: COLLECTION.acceptance, breaks: "a workspace reference that is a channel", record: { workspace: CHANNEL }, context: { rkey: acceptanceRecordKey(CHANNEL) }, reason: /acceptance key/ },
  { collection: COLLECTION.joinDecision, breaks: "a request in another inbox", record: { request: spaceRecordUri(inboxUri(AUTHORITY, "other"), MEMBER, COLLECTION.joinRequest, requestRecordKey(CHANNEL, MEMBER)) }, reason: /canonical request in this inbox/ },
  { collection: COLLECTION.joinDecision, breaks: "a request the authority wrote", record: { request: spaceRecordUri(INBOX, AUTHORITY, COLLECTION.joinRequest, "x") }, context: { rkey: decisionRecordKey(spaceRecordUri(INBOX, AUTHORITY, COLLECTION.joinRequest, "x")) }, reason: /canonical request/ },
  { collection: COLLECTION.message, breaks: "a parent in another channel", record: { parent: spaceRecordUri(OTHER_CHANNEL, MEMBER, COLLECTION.message, "2222222222222") }, reason: /in this channel/ },
  { collection: COLLECTION.message, breaks: "a parent this channel does not hold", record: { parent: spaceRecordUri(CHANNEL, MEMBER, COLLECTION.message, "222222222222b") }, reason: /not in this channel/ },
  { collection: COLLECTION.reaction, breaks: "a target in another channel", record: { subject: spaceRecordUri(OTHER_CHANNEL, MEMBER, COLLECTION.message, "2222222222222") }, reason: /not a message in this channel/ },
  { collection: COLLECTION.reaction, breaks: "a target this channel does not hold", context: { knownMessages: new Set() }, reason: /not a message in this channel/ },
  { collection: COLLECTION.dmMessage, breaks: "a parent in another conversation", record: { parent: spaceRecordUri(dmConversationUri(MEMBER, "222222222222b"), MEMBER, COLLECTION.dmMessage, "2222222222225") }, reason: /in this conversation/ },
  { collection: COLLECTION.dmMessage, breaks: "a parent from a non-participant", record: { parent: spaceRecordUri(OTHER_HALF, MEMBER, COLLECTION.dmMessage, "2222222222225") }, context: { participants: [AUTHORITY, "did:plc:third"] }, reason: /participant/ },
  { collection: COLLECTION.dmMessage, breaks: "itself as parent", record: { parent: spaceRecordUri(HALF, AUTHORITY, COLLECTION.dmMessage, "222222222222a") }, reason: /itself/ },
  { collection: COLLECTION.dmReaction, breaks: "a target in another conversation", record: { subject: spaceRecordUri(dmConversationUri(MEMBER, "222222222222b"), MEMBER, COLLECTION.dmMessage, "2222222222225") }, reason: /in this conversation/ },
  // A nested reply.
  { collection: COLLECTION.message, breaks: "a reply to a reply", record: { parent: REPLY }, reason: /nested replies/ },
  // Participants.
  { collection: COLLECTION.dmRequest, breaks: "participants not in canonical order", record: { participants: [AUTHORITY, MEMBER] }, reason: /canonical/ },
  { collection: COLLECTION.dmRequest, breaks: "participants without the sender", record: { participants: [AUTHORITY, "did:plc:third"] }, reason: /sender and the inbox owner/ },
  { collection: COLLECTION.dmHeader, breaks: "participants without the half owner", record: { participants: [MEMBER, "did:plc:third"] }, reason: /half owner/ },
  { collection: COLLECTION.dmHeader, breaks: "a conversation key other than the half's", record: { convKey: "222222222222b" }, reason: /conversation key/ },
  // A subject DID past the length bound (the lexicon's did format has none).
  ...[COLLECTION.workspaceRoster, COLLECTION.admin, COLLECTION.channelRoster].map((collection): SemanticCase => ({
    collection, breaks: "a subject DID longer than the bound", record: { subject: `did:plc:${"a".repeat(1_500)}` },
    context: { rkey: subjectKey(`did:plc:${"a".repeat(1_500)}`) }, reason: /length bound/,
  })),
  // Blank text.
  { collection: COLLECTION.dmMessage, breaks: "text that is only spaces", record: { text: "   " }, reason: /blank/ },
];

test("semantic rejection: a well-shaped record that breaks any meaning rule is rejected for that rule", () => {
  for (const testCase of SEMANTIC_CASES) {
    // #given a fixture changed in one way that keeps its shape
    const { record, context } = FIXTURES[testCase.collection];
    const value = { ...record, ...testCase.record };
    const label = `${testCase.collection}: ${testCase.breaks}`;
    assert.equal(validateRecordShape(testCase.collection, value).valid, true, `${label} is well-shaped`);

    // #when it is validated in full
    const result = validateSpaceRecord(testCase.collection, value, { ...context, ...testCase.context });

    // #then it is rejected for the rule it breaks
    assert.equal(result.valid, false, label);
    assert.match(result.valid ? "" : result.reason, testCase.reason, label);
  }
});

test("every collection with a meaning rule has a case that breaks it", () => {
  const covered = new Set(SEMANTIC_CASES.filter((testCase) => testCase.reason.source !== "space type").map((testCase) => testCase.collection));
  for (const collection of Object.keys(REGISTRY) as Collection[]) {
    if (REGISTRY[collection].semantic) assert.ok(covered.has(collection), collection);
  }
});

test("a record with a field this app does not know is accepted in every collection, and the field is kept", () => {
  for (const [collection, { record, context }] of Object.entries(FIXTURES)) {
    // #given a record another app extended
    const extended = { ...record, addedByAnotherApp: { note: "kept" } };

    // #then it is accepted as is
    assert.deepEqual(validateSpaceRecord(collection, extended, context), { valid: true }, collection);
    assert.deepEqual(extended.addedByAnotherApp, { note: "kept" });
  }
});
