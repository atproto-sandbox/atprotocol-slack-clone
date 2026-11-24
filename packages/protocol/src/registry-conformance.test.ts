import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Lexicons, type LexiconDoc } from "@atproto/lexicon";
import {
  appInboxUri,
  channelUri,
  decisionRecordKey,
  dmConversationUri,
  dmInboxUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  personalInvitesUri,
  reactionRecordKey,
  requestRecordKey,
  spaceRecordUri,
  subjectKey,
  tasksSpaceUri,
  workspaceUri,
} from "./keys";
import { extSpaceUriFor } from "./extensions";
import {
  BLOCK_TYPE,
  COLLECTION,
  OPENSOCIAL_COLLECTION,
} from "./nsids";
import {
  REGISTRY,
  validateRecordShape,
  validateSpaceRecord,
  type RecordContext,
  type RegisteredSpaceCollection,
} from "./registry";

const AUTHORITY = "did:plc:owner";
const MEMBER = "did:plc:member";
const NOW = "2026-11-01T12:00:00.000Z";
const META = groupMetaUri(AUTHORITY);
const MEMBERS = groupMembersUri(AUTHORITY);
const INVITES = personalInvitesUri(MEMBER);
const WORKSPACE = workspaceUri(AUTHORITY);
const INBOX = inboxUri(AUTHORITY);
const APP = "did:plc:bot";
const APP_INBOX = appInboxUri(AUTHORITY, "self", APP);
const CHANNEL = channelUri(AUTHORITY, "acme-general");
const MESSAGE = spaceRecordUri(CHANNEL, MEMBER, COLLECTION.message, "2222222222222");
const REPLY = spaceRecordUri(CHANNEL, MEMBER, COLLECTION.message, "2222222222223");
const CONV_KEY = "2222222222224";
const HALF = dmConversationUri(AUTHORITY, CONV_KEY);
const OTHER_HALF = dmConversationUri(MEMBER, CONV_KEY);
const DM_MESSAGE = spaceRecordUri(OTHER_HALF, MEMBER, COLLECTION.dmMessage, "2222222222225");
const PARTICIPANTS = [MEMBER, AUTHORITY];
const JOIN_REQUEST = spaceRecordUri(INBOX, MEMBER, COLLECTION.joinRequest, requestRecordKey(CHANNEL, MEMBER));
const TASKS = tasksSpaceUri(AUTHORITY);
const OTHER_TASKS = tasksSpaceUri("did:plc:other");
const PROJECT = spaceRecordUri(TASKS, MEMBER, COLLECTION.taskProject, "222222222222e");
const TASK = spaceRecordUri(TASKS, MEMBER, COLLECTION.task, "222222222222f");
const PARENT_TASK = spaceRecordUri(TASKS, MEMBER, COLLECTION.task, "222222222222g");
const HLC_T = "001700000000000.0000";
const OP_REF_A = "a".repeat(32);

type Fixture = { record: Record<string, unknown>; context: RecordContext };

const FIXTURES: Record<RegisteredSpaceCollection, Fixture> = {
  [OPENSOCIAL_COLLECTION.profile]: {
    record: { displayName: "Acme", description: "Team space", joinPolicy: "invite", url: "https://acme.example/" },
    context: { authorityDid: AUTHORITY, spaceUri: META, repoDid: AUTHORITY, rkey: "self" },
  },
  [OPENSOCIAL_COLLECTION.rule]: {
    record: { title: "Be kind", text: "Treat everyone respectfully.", order: 0 },
    context: { authorityDid: AUTHORITY, spaceUri: META, repoDid: AUTHORITY, rkey: "2222222222222" },
  },
  [OPENSOCIAL_COLLECTION.labeler]: {
    record: { policies: { labelValues: ["!takedown", "!hide"] } },
    context: { authorityDid: AUTHORITY, spaceUri: META, repoDid: AUTHORITY, rkey: "self" },
  },
  [OPENSOCIAL_COLLECTION.space]: {
    record: { space: CHANNEL, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: MEMBERS, repoDid: AUTHORITY, rkey: "2222222222222" },
  },
  [OPENSOCIAL_COLLECTION.role]: {
    record: { displayName: "Moderator", scopes: ["include:group.opensocial.authModerate"], assignable: ["member"] },
    context: { authorityDid: AUTHORITY, spaceUri: MEMBERS, repoDid: AUTHORITY, rkey: "moderator" },
  },
  [OPENSOCIAL_COLLECTION.membership]: {
    record: { roles: ["member"], createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: MEMBERS, repoDid: AUTHORITY, rkey: MEMBER },
  },
  [OPENSOCIAL_COLLECTION.acceptance]: {
    record: { createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: MEMBERS, repoDid: MEMBER, rkey: "self" },
  },
  [OPENSOCIAL_COLLECTION.invite]: {
    record: { createdAt: NOW, expiresAt: "2026-12-01T12:00:00.000Z", message: "Join us!" },
    context: { authorityDid: MEMBER, spaceUri: INVITES, repoDid: AUTHORITY, rkey: "2222222222222" },
  },
  [COLLECTION.directory]: {
    record: { skey: "acme-general", name: "general", visibility: "public" },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: "acme-general" },
  },
  [COLLECTION.appInstall]: {
    record: { subject: APP, active: true, channels: [{ skey: "acme-general", write: true }], installedBy: AUTHORITY, installedAt: NOW, updatedAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: subjectKey(APP) },
  },
  [COLLECTION.appCommand]: {
    record: { command: "echo", text: "hello", channel: CHANNEL, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: APP_INBOX, repoDid: MEMBER, rkey: "222222222222c" },
  },
  [COLLECTION.appAction]: {
    record: { message: MESSAGE, actionId: "again_1", channel: CHANNEL, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: APP_INBOX, repoDid: MEMBER, rkey: "222222222222d" },
  },
  [COLLECTION.extInstall]: {
    record: {
      extId: "tasks",
      active: true,
      space: extSpaceUriFor(AUTHORITY, "self", "tasks"),
      cleanupComplete: false,
      enabledBy: AUTHORITY,
      enabledAt: NOW,
      updatedAt: NOW,
    },
    context: { authorityDid: AUTHORITY, spaceUri: WORKSPACE, repoDid: AUTHORITY, rkey: "tasks" },
  },
  [COLLECTION.taskProject]: {
    record: { name: "Roadmap", description: "Q4 milestones", color: "#3b82f6", t: HLC_T, createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: TASKS, repoDid: MEMBER, rkey: "222222222222e" },
  },
  [COLLECTION.taskProjectEdit]: {
    record: { subject: PROJECT, t: "001700000000001.0000", s: [OP_REF_A], name: "Roadmap v2" },
    context: { authorityDid: AUTHORITY, spaceUri: TASKS, repoDid: MEMBER, rkey: "222222222222h" },
  },
  [COLLECTION.task]: {
    record: {
      title: "Ship R13",
      description: "Implement OpenSocial groups",
      status: "todo",
      priority: "high",
      project: PROJECT,
      dueDate: NOW,
      parent: PARENT_TASK,
      assignees: [MEMBER],
      labels: ["protocol"],
      t: HLC_T,
      createdAt: NOW,
    },
    context: { authorityDid: AUTHORITY, spaceUri: TASKS, repoDid: MEMBER, rkey: "222222222222f" },
  },
  [COLLECTION.taskEdit]: {
    record: {
      subject: TASK,
      t: "001700000000002.0000",
      s: [OP_REF_A],
      title: "Ship R13 now",
      status: "in_progress",
      priority: "urgent",
      addAssignees: [AUTHORITY],
      addLabels: ["urgent"],
    },
    context: { authorityDid: AUTHORITY, spaceUri: TASKS, repoDid: MEMBER, rkey: "222222222222i" },
  },
  [COLLECTION.taskComment]: {
    record: { subject: TASK, body: "Looks good", createdAt: NOW },
    context: { authorityDid: AUTHORITY, spaceUri: TASKS, repoDid: MEMBER, rkey: "222222222222j" },
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

const LEXICONS_DIR = fileURLToPath(new URL("../lexicons", import.meta.url));
const PUBLISHED_DOCS: LexiconDoc[] = (readdirSync(LEXICONS_DIR, { recursive: true }) as string[])
  .filter((path) => path.endsWith(".json"))
  .map((path) => JSON.parse(readFileSync(join(LEXICONS_DIR, path), "utf8")) as LexiconDoc);
const PUBLISHED = new Lexicons(PUBLISHED_DOCS);

type PropertyDef = { type: string; format?: string; enum?: string[]; minLength?: number; maxLength?: number; maxGraphemes?: number; items?: PropertyDef };
type CorpusItem = { label: string; value: Record<string, unknown>; wellShaped: boolean };

function shapeCorpus(collection: RegisteredSpaceCollection, base: Record<string, unknown>): CorpusItem[] {
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
    const variant = (label: string, value: unknown, wellShaped: boolean) =>
      items.push({ label: `${field} ${label}`, value: { ...base, [field]: value }, wellShaped });
    variant("null", null, false);
    if (def.type === "boolean") variant("as a string", "true", false);
    if (def.type === "string") {
      variant("as a number", 42, false);
      if (def.format) variant(`not a ${def.format}`, "not valid!", false);
      if (def.enum) variant("outside its enum", "somethingElse", false);
      if (def.minLength) variant("empty", "", false);
      if (def.maxGraphemes) {
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
  for (const [collection, { record, context }] of Object.entries(FIXTURES) as Array<[RegisteredSpaceCollection, Fixture]>) {
    for (const item of shapeCorpus(collection, record)) {
      const registry = validateRecordShape(collection, item.value).valid;
      const lexicon = PUBLISHED.validate(collection, item.value).success;
      assert.equal(registry, lexicon, `${collection}: ${item.label}`);
      assert.equal(lexicon, item.wellShaped, `${collection}: ${item.label} was built ${item.wellShaped ? "well" : "ill"}-shaped`);
      if (!item.wellShaped) assert.equal(validateSpaceRecord(collection, item.value, context).valid, false, `${collection}: ${item.label}`);
      compared += 1;
    }
  }
  assert.ok(compared > 150, `the corpus is not trivially small (${compared} records)`);
});

test("a record with an unknown extension field is accepted in every collection, and the field is kept", () => {
  for (const [collection, { record, context }] of Object.entries(FIXTURES)) {
    const extended = { ...record, addedByAnotherApp: { note: "kept" } };
    assert.deepEqual(validateSpaceRecord(collection, extended, context), { valid: true }, collection);
    assert.deepEqual(extended.addedByAnotherApp, { note: "kept" });
  }
});

test("semantic rejection covers OpenSocial and Flock collections", () => {
  const cases: Array<{ collection: RegisteredSpaceCollection; record?: Record<string, unknown>; context?: Partial<RecordContext>; reason: RegExp }> = [
    { collection: OPENSOCIAL_COLLECTION.profile, record: { url: "javascript:alert(1)" }, reason: /http or https/ },
    { collection: OPENSOCIAL_COLLECTION.space, record: { space: META }, reason: /core or personal/ },
    { collection: OPENSOCIAL_COLLECTION.role, record: { scopes: ["include:unknown.nsid.set"] }, reason: /Unknown permission-set/ },
    { collection: OPENSOCIAL_COLLECTION.membership, context: { rkey: AUTHORITY }, reason: /implicit membership/ },
    { collection: OPENSOCIAL_COLLECTION.membership, record: { roles: [] }, reason: /at least one role/ },
    { collection: OPENSOCIAL_COLLECTION.acceptance, context: { repoDid: AUTHORITY }, reason: /group DID/ },
    { collection: OPENSOCIAL_COLLECTION.invite, context: { repoDid: MEMBER }, reason: /external group DID/ },
    { collection: COLLECTION.directory, context: { rkey: "acme-random" }, reason: /directory key/ },
    { collection: COLLECTION.appInstall, record: { subject: AUTHORITY }, context: { rkey: subjectKey(AUTHORITY) }, reason: /group DID/ },
    { collection: COLLECTION.appCommand, record: { command: "Echo_1" }, reason: /command name/ },
    { collection: COLLECTION.appAction, record: { actionId: "bad id!" }, reason: /actionId/ },
    { collection: COLLECTION.extInstall, record: { space: OTHER_TASKS }, reason: /canonical workspace extension space/ },
    { collection: COLLECTION.taskProject, record: { name: "   " }, reason: /blank/ },
    { collection: COLLECTION.taskProjectEdit, record: { name: undefined }, reason: /at least one mutation/ },
    { collection: COLLECTION.task, record: { title: "   " }, reason: /blank/ },
    { collection: COLLECTION.taskEdit, record: { title: undefined, status: undefined, priority: undefined, addAssignees: undefined, addLabels: undefined }, reason: /at least one mutation/ },
    { collection: COLLECTION.taskComment, record: { body: "   " }, reason: /blank/ },
    { collection: COLLECTION.joinRequest, context: { rkey: requestRecordKey(CHANNEL, AUTHORITY) }, reason: /not canonical/ },
    { collection: COLLECTION.joinDecision, record: { request: spaceRecordUri(INBOX, AUTHORITY, COLLECTION.joinRequest, "x") }, context: { rkey: decisionRecordKey(spaceRecordUri(INBOX, AUTHORITY, COLLECTION.joinRequest, "x")) }, reason: /canonical request/ },
    { collection: COLLECTION.message, record: { blocks: [{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "bad id!", label: "One" }] }] }, reason: /actionId/ },
    { collection: COLLECTION.reaction, context: { knownMessages: new Set() }, reason: /not a message in this channel/ },
    { collection: COLLECTION.dmRequest, record: { participants: [AUTHORITY, MEMBER] }, reason: /canonical/ },
    { collection: COLLECTION.dmHeader, record: { convKey: "222222222222b" }, reason: /conversation key/ },
    { collection: COLLECTION.dmMessage, record: { text: "   " }, reason: /blank/ },
    { collection: COLLECTION.dmReaction, record: { subject: spaceRecordUri(dmConversationUri(MEMBER, "222222222222b"), MEMBER, COLLECTION.dmMessage, "2222222222225") }, reason: /in this conversation/ },
  ];

  for (const testCase of cases) {
    const { record, context } = FIXTURES[testCase.collection];
    const value = Object.fromEntries(Object.entries({ ...record, ...testCase.record }).filter(([, v]) => v !== undefined));
    const result = validateSpaceRecord(testCase.collection, value, { ...context, ...testCase.context });
    assert.equal(result.valid, false, testCase.collection);
    assert.match(result.valid ? "" : result.reason, testCase.reason, testCase.collection);
  }
});
