import assert from "node:assert/strict";
import test from "node:test";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  channelUri,
  groupMembersUri,
  groupMetaUri,
  SELF_SKEY,
  spaceRecordUri,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  COLLECTION,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_POLICY,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import type { DeskShellDeps } from "./membership";
import {
  readGroupModerationConfig,
  ReportPreconditionError,
  reportSubject,
  STANDARD_REPORT_REASON_TYPES,
  validateReportPreconditions,
} from "./moderation";

const GROUP = "did:plc:grpmodtestaaaaaaaaaaaaaa";
const ALICE = "did:plc:alicemodtestaaaaaaaaaaaa";
const BOB = "did:plc:bobmodtestaaaaaaaaaaaaaa";
const OUTSIDER = "did:plc:outsidermodtestaaaaaaaaa";

async function setupModerationGroup() {
  const net = new FakeNetwork();
  net.createAccount(ALICE, "pds1");
  net.createAccount(BOB, "pds2");
  net.createAccount(OUTSIDER, "pds2");
  await net.createGroupAccount(GROUP, {
    name: "Moderation Group",
    joinPolicy: "invite",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeTestModKey"],
  });
  const owner = net.clientFor(GROUP);
  const metaUri = groupMetaUri(GROUP);
  const membersUri = groupMembersUri(GROUP);
  const chUri = channelUri(GROUP, "general");
  const wsPolicy = {
    $type: OPENSOCIAL_POLICY,
    publicRead: false,
    unlisted: false,
    grants: [
      { role: "admin", read: true, write: true },
      { role: "member", read: true, write: true },
    ],
  };
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.workspace, skey: SELF_SKEY, policy: wsPolicy });
  await owner.procedure("com.atproto.space.createSpace", { spaceType: SPACE_TYPE.channel, skey: "general", policy: wsPolicy });
  for (const [did, roles] of [[ALICE, ["admin", "member"]], [BOB, ["member"]]] as const) {
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersUri,
      repo: GROUP,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: { $type: OPENSOCIAL_COLLECTION.membership, roles: [...roles], createdAt: "2026-11-20T00:00:00.000Z" },
    });
  }

  // Publish labeler/self and one rule in meta/self
  await owner.procedure("com.atproto.space.putRecord", {
    space: metaUri,
    repo: GROUP,
    collection: OPENSOCIAL_COLLECTION.labeler,
    rkey: SELF_SKEY,
    record: {
      $type: OPENSOCIAL_COLLECTION.labeler,
      policies: { labelValues: ["!hide", "!takedown"] },
      reasonTypes: ["spam", "violation"],
      subjectTypes: ["record", "account"],
      subjectCollections: [COLLECTION.message],
      createdAt: "2026-11-20T00:00:00.000Z",
    },
  });
  const ruleRkey = tidNow(net.now());
  await owner.procedure("com.atproto.space.putRecord", {
    space: metaUri,
    repo: GROUP,
    collection: OPENSOCIAL_COLLECTION.rule,
    rkey: ruleRkey,
    record: {
      $type: OPENSOCIAL_COLLECTION.rule,
      title: "Be civil",
      text: "No harassment or spam.",
      order: 1,
    },
  });

  const ruleUri = spaceRecordUri(metaUri, GROUP, OPENSOCIAL_COLLECTION.rule, ruleRkey);
  const msgUri = spaceRecordUri(chUri, BOB, COLLECTION.message, "2222222222224");
  const reports: Array<Record<string, unknown>> = [];

  const depsFor = (did: string): DeskShellDeps => ({
    did,
    memberClient: net.clientFor(did),
    resolvePds: net.resolvePds,
    resolveKemKey: net.resolveKemKey,
    fetchEndpoint: async (request) => {
      if (new URL(request.url).pathname === `/xrpc/${OPENSOCIAL_METHOD.createReport}`) {
        const body = (await request.json()) as Record<string, unknown>;
        reports.push(body);
        return new Response(JSON.stringify({ id: String(reports.length), createdAt: "2026-11-20T01:00:00.000Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return net.fetchEndpoint(request);
    },
    generateKey: net.generateKey,
    now: net.now,
  });

  return { net, metaUri, chUri, ruleUri, msgUri, reports, depsFor };
}

test("readGroupModerationConfig and reportSubject enforce all labeler/self, rule, cid, and active-reader preconditions", async () => {
  const { chUri, ruleUri, msgUri, reports, depsFor } = await setupModerationGroup();
  const alice = depsFor(ALICE);
  const outsider = depsFor(OUTSIDER);

  const config = await readGroupModerationConfig(alice, GROUP);
  assert.deepEqual(config.labeler?.reasonTypes, ["spam", "violation"]);
  assert.deepEqual(config.labeler?.subjectTypes, ["record", "account"]);
  assert.deepEqual(config.labeler?.subjectCollections, [COLLECTION.message]);
  assert.equal(config.rules.length, 1);
  assert.equal(config.rules[0]!.uri, ruleUri);

  // Disallowed reasonType rejected before network call
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: msgUri, reasonType: "rude" }),
    ReportPreconditionError,
  );

  // Disallowed subjectCollection rejected
  const reactionUri = spaceRecordUri(chUri, BOB, COLLECTION.reaction, "x-12345");
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: reactionUri, reasonType: "spam" }),
    ReportPreconditionError,
  );

  // Account report with cid rejected
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: BOB, cid: "bafyreig", reasonType: "spam" }),
    ReportPreconditionError,
  );

  // Violation without rule rejected; violation with unknown rule rejected
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: msgUri, reasonType: "violation" }),
    ReportPreconditionError,
  );
  await assert.rejects(
    () =>
      reportSubject(alice, {
        groupDid: GROUP,
        subject: msgUri,
        reasonType: "violation",
        rule: spaceRecordUri(groupMetaUri(GROUP), GROUP, OPENSOCIAL_COLLECTION.rule, "missing-rule"),
      }),
    ReportPreconditionError,
  );

  // Non-member outsider fails active-reader credential check before createReport
  await assert.rejects(
    () => reportSubject(outsider, { groupDid: GROUP, subject: msgUri, reasonType: "spam" }),
    SpaceCredentialError,
  );
  assert.equal(reports.length, 0);

  // Valid violation report with rule succeeds
  const res1 = await reportSubject(alice, {
    groupDid: GROUP,
    subject: msgUri,
    reasonType: "violation",
    rule: ruleUri,
    reason: "Off-topic spam",
  });
  assert.equal(res1.id, "1");

  // Valid account report without cid succeeds
  const res2 = await reportSubject(alice, {
    groupDid: GROUP,
    subject: BOB,
    reasonType: "spam",
  });
  assert.equal(res2.id, "2");
  assert.equal(reports.length, 2);
  assert.equal(reports[1]!.cid, undefined);
  void workspaceUri;
});

test("moderation validates canonical nsfw reason, explicit empty reasonTypes: [], and rejects malformed 2xx createReport receipts", async () => {
  assert.ok(STANDARD_REPORT_REASON_TYPES.includes("nsfw"));
  assert.equal((STANDARD_REPORT_REASON_TYPES as readonly string[]).includes("sexual"), false);

  const { msgUri, depsFor } = await setupModerationGroup();

  // Explicit empty reasonTypes: [] rejects every report locally.
  assert.throws(
    () =>
      validateReportPreconditions(
        {
          labeler: { policies: { labelValues: [] }, reasonTypes: [] },
          rules: [],
        },
        { groupDid: GROUP, subject: msgUri, reasonType: "spam" },
      ),
    ReportPreconditionError,
  );

  // Whitespace-padded reasonType is rejected locally even when no labeler/self is published.
  assert.throws(
    () => validateReportPreconditions({ rules: [] }, { groupDid: GROUP, subject: msgUri, reasonType: " spam " }),
    ReportPreconditionError,
  );

  // Malformed 2xx createReport responses must throw 502 InvalidReportResponse instead of fabricating receipts.
  for (const badBody of [
    {},
    { id: "", createdAt: "2026-11-20T01:00:00.000Z" },
    { id: "x".repeat(513), createdAt: "2026-11-20T01:00:00.000Z" },
    { id: "rep-1" },
    { id: "rep-1", createdAt: "not-a-datetime" },
    { id: "rep-1", createdAt: "2026-02-30T00:00:00.000Z" },
  ]) {
    const base = depsFor(ALICE);
    const badDeps: DeskShellDeps = {
      ...base,
      fetchEndpoint: async (request) => {
        if (new URL(request.url).pathname === `/xrpc/${OPENSOCIAL_METHOD.createReport}`) {
          return new Response(JSON.stringify(badBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return base.fetchEndpoint(request);
      },
    };
    await assert.rejects(
      () => reportSubject(badDeps, { groupDid: GROUP, subject: msgUri, reasonType: "spam" }),
      (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidReportResponse",
      `must reject malformed 2xx receipt ${JSON.stringify(badBody)}`,
    );
  }
});
