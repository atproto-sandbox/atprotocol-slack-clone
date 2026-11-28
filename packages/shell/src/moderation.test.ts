import assert from "node:assert/strict";
import test from "node:test";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  channelUri,
  groupMembersUri,
  SELF_SKEY,
  spaceRecordUri,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  ATGRP_COLLECTION,
  ATGRP_METHOD,
  ATGRP_MOD_EVENT_TYPE,
  ATGRP_MOD_REASON,
  ATGRP_POLICY,
  COLLECTION,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { FakeNetwork } from "@flock/testing/fake-network";
import type { DeskShellDeps } from "./membership";
import {
  querySelfHistory,
  readGroupModerationConfig,
  ReportPreconditionError,
  reportSubject,
  STANDARD_REPORT_REASON_TYPES,
  submitAppeal,
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
  const membersUri = groupMembersUri(GROUP);
  const chUri = channelUri(GROUP, "general");
  const wsPolicy = {
    $type: ATGRP_POLICY,
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
      collection: ATGRP_COLLECTION.membership,
      rkey: did,
      record: { $type: ATGRP_COLLECTION.membership, roles: [...roles], createdAt: "2026-11-20T00:00:00.000Z" },
    });
  }

  // Publish labeler/self and one rule in org.atgrp.members/self (R15)
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersUri,
    repo: GROUP,
    collection: ATGRP_COLLECTION.labeler,
    rkey: SELF_SKEY,
    record: {
      $type: ATGRP_COLLECTION.labeler,
      policies: { labelValues: ["!hide", "!takedown"] },
      reasonTypes: [ATGRP_MOD_REASON.spam, ATGRP_MOD_REASON.violation],
      subjectTypes: ["record", "account"],
      subjectCollections: [COLLECTION.message],
      createdAt: "2026-11-20T00:00:00.000Z",
    },
  });
  const ruleRkey = tidNow(net.now());
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersUri,
    repo: GROUP,
    collection: ATGRP_COLLECTION.rule,
    rkey: ruleRkey,
    record: {
      $type: ATGRP_COLLECTION.rule,
      title: "Be civil",
      text: "No harassment or spam.",
      order: 1,
    },
  });

  const ruleUri = spaceRecordUri(membersUri, GROUP, ATGRP_COLLECTION.rule, ruleRkey);
  const msgUri = spaceRecordUri(chUri, BOB, COLLECTION.message, "2222222222224");
  const reports: Array<Record<string, unknown>> = [];

  const depsFor = (did: string): DeskShellDeps => ({
    did,
    memberClient: net.clientFor(did),
    resolvePds: net.resolvePds,
    resolveKemKey: net.resolveKemKey,
    fetchEndpoint: async (request) => {
      if (new URL(request.url).pathname === `/xrpc/${ATGRP_METHOD.modSubmitReport}`) {
        const body = (await request.json()) as Record<string, unknown>;
        reports.push(body);
        return new Response(JSON.stringify({ eventId: `ev-${reports.length}`, createdAt: "2026-11-20T01:00:00.000Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return net.fetchEndpoint(request);
    },
    generateKey: net.generateKey,
    now: net.now,
  });

  return { net, membersUri, chUri, ruleUri, msgUri, reports, depsFor };
}

test("readGroupModerationConfig and reportSubject read members/self and enforce all labeler/self, rule, cid, and active-reader preconditions", async () => {
  const { membersUri, chUri, ruleUri, msgUri, reports, depsFor } = await setupModerationGroup();
  const alice = depsFor(ALICE);
  const outsider = depsFor(OUTSIDER);

  const config = await readGroupModerationConfig(alice, GROUP);
  assert.deepEqual(config.labeler?.reasonTypes, [ATGRP_MOD_REASON.spam, ATGRP_MOD_REASON.violation]);
  assert.deepEqual(config.labeler?.subjectTypes, ["record", "account"]);
  assert.deepEqual(config.labeler?.subjectCollections, [COLLECTION.message]);
  assert.equal(config.rules.length, 1);
  assert.equal(config.rules[0]!.uri, ruleUri);

  // Disallowed reasonType rejected before network call
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: msgUri, reasonType: ATGRP_MOD_REASON.rude }),
    ReportPreconditionError,
  );

  // Disallowed subjectCollection rejected
  const reactionUri = spaceRecordUri(chUri, BOB, COLLECTION.reaction, "x-12345");
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: reactionUri, reasonType: ATGRP_MOD_REASON.spam }),
    ReportPreconditionError,
  );

  // Account report with cid rejected
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: BOB, cid: "bafyreig", reasonType: ATGRP_MOD_REASON.spam }),
    ReportPreconditionError,
  );

  // Violation without rule rejected; violation with unknown rule rejected
  await assert.rejects(
    () => reportSubject(alice, { groupDid: GROUP, subject: msgUri, reasonType: ATGRP_MOD_REASON.violation }),
    ReportPreconditionError,
  );
  await assert.rejects(
    () =>
      reportSubject(alice, {
        groupDid: GROUP,
        subject: msgUri,
        reasonType: ATGRP_MOD_REASON.violation,
        rule: spaceRecordUri(membersUri, GROUP, ATGRP_COLLECTION.rule, "missing-rule"),
      }),
    ReportPreconditionError,
  );

  // Non-member outsider fails readGroupModerationConfig (falls back to server-side submitReport)
  // On our mock host, simulate server-side 403 rejection when outsider calls submitReport
  const outsiderWith403: DeskShellDeps = {
    ...outsider,
    fetchEndpoint: async (request) => {
      if (new URL(request.url).pathname === `/xrpc/${ATGRP_METHOD.modSubmitReport}`) {
        return new Response(JSON.stringify({ error: "NotAuthorized", message: "not a member" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return outsider.fetchEndpoint(request);
    },
  };
  await assert.rejects(
    () => reportSubject(outsiderWith403, { groupDid: GROUP, subject: msgUri, reasonType: ATGRP_MOD_REASON.spam }),
    (err: unknown) => err instanceof XrpcError && err.status === 403,
  );
  assert.equal(reports.length, 0);

  // Spec-only host where readGroupModerationConfig fails still allows reportSubject to proceed cleanly
  const specOnlyBob: DeskShellDeps = {
    ...depsFor(BOB),
    fetchEndpoint: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/xrpc/${ATGRP_METHOD.modSubmitReport}`) {
        const body = (await request.json()) as Record<string, unknown>;
        reports.push(body);
        return new Response(JSON.stringify({ eventId: "ev-speconly", createdAt: "2026-11-20T01:00:00.000Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/xrpc/com.atproto.space.listRecords") {
        return new Response(JSON.stringify({ error: "SpaceNotFound", message: "unavailable" }), { status: 404 });
      }
      return depsFor(BOB).fetchEndpoint(request);
    },
  };
  const specOnlyRes = await reportSubject(specOnlyBob, {
    groupDid: GROUP,
    subject: msgUri,
    reasonType: ATGRP_MOD_REASON.spam,
  });
  assert.equal(specOnlyRes.eventId, "ev-speconly");

  // Valid violation report with rule succeeds
  const res1 = await reportSubject(alice, {
    groupDid: GROUP,
    subject: msgUri,
    reasonType: ATGRP_MOD_REASON.violation,
    rule: ruleUri,
    reason: "Off-topic spam",
  });
  assert.equal(res1.eventId, "ev-2");

  // Valid account report without cid succeeds
  const res2 = await reportSubject(alice, {
    groupDid: GROUP,
    subject: BOB,
    reasonType: ATGRP_MOD_REASON.spam,
  });
  assert.equal(res2.eventId, "ev-3");
  assert.equal(reports.length, 3);
  assert.equal(reports[2]!.cid, undefined);
  void workspaceUri;
  void SpaceCredentialError;
});

test("moderation validates canonical reason tokens, explicit empty reasonTypes: [], rejects malformed 2xx receipts, and supports submitAppeal & querySelfHistory for former members", async () => {
  assert.ok(STANDARD_REPORT_REASON_TYPES.includes(ATGRP_MOD_REASON.nsfw));
  assert.equal((STANDARD_REPORT_REASON_TYPES as readonly string[]).includes("sexual"), false);

  const { net, membersUri, msgUri, depsFor } = await setupModerationGroup();

  // Explicit empty reasonTypes: [] rejects every report locally.
  assert.throws(
    () =>
      validateReportPreconditions(
        {
          labeler: { policies: { labelValues: [] }, reasonTypes: [] },
          rules: [],
        },
        { groupDid: GROUP, subject: msgUri, reasonType: ATGRP_MOD_REASON.spam },
      ),
    ReportPreconditionError,
  );

  // Whitespace-padded reasonType is rejected locally even when no labeler/self is published.
  assert.throws(
    () => validateReportPreconditions({ rules: [] }, { groupDid: GROUP, subject: msgUri, reasonType: " spam " }),
    ReportPreconditionError,
  );

  // Malformed 2xx submitReport responses must throw 502 InvalidReportResponse instead of fabricating receipts.
  for (const badBody of [
    {},
    { eventId: "", createdAt: "2026-11-20T01:00:00.000Z" },
    { eventId: "x".repeat(513), createdAt: "2026-11-20T01:00:00.000Z" },
    { eventId: "rep-1" },
    { eventId: "rep-1", createdAt: "not-a-datetime" },
    { eventId: "rep-1", createdAt: "2026-02-30T00:00:00.000Z" },
  ]) {
    const base = depsFor(ALICE);
    const badDeps: DeskShellDeps = {
      ...base,
      fetchEndpoint: async (request) => {
        if (new URL(request.url).pathname === `/xrpc/${ATGRP_METHOD.modSubmitReport}`) {
          return new Response(JSON.stringify(badBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return base.fetchEndpoint(request);
      },
    };
    await assert.rejects(
      () => reportSubject(badDeps, { groupDid: GROUP, subject: msgUri, reasonType: ATGRP_MOD_REASON.spam }),
      (err: unknown) => err instanceof XrpcError && err.status === 502 && err.code === "InvalidReportResponse",
      `must reject malformed 2xx receipt ${JSON.stringify(badBody)}`,
    );
  }

  // Former-member appeal & self-history directly against FakeNetwork GroupHost (zero Operator calls!)
  const owner = net.clientFor(GROUP);
  // Eject Bob (deletes membership/bob -> records modEjectionEligibility)
  await owner.procedure("com.atproto.space.deleteRecord", {
    space: membersUri,
    repo: GROUP,
    collection: ATGRP_COLLECTION.membership,
    rkey: BOB,
  });

  const bobLiveDeps: DeskShellDeps = {
    did: BOB,
    memberClient: net.clientFor(BOB),
    resolvePds: net.resolvePds,
    resolveKemKey: net.resolveKemKey,
    fetchEndpoint: net.fetchEndpoint,
    generateKey: net.generateKey,
    now: net.now,
  };

  // Reject appealing someone else's DID locally before hitting network
  await assert.rejects(
    () => submitAppeal(bobLiveDeps, { groupDid: GROUP, subject: ALICE, reason: "not mine" }),
    ReportPreconditionError,
  );

  // Former member submits ejection appeal directly by groupDid
  const appealReceipt = await submitAppeal(bobLiveDeps, {
    groupDid: GROUP,
    subject: BOB,
    reason: "Please reconsider my removal",
  });
  assert.ok(appealReceipt.eventId.startsWith("ev-"));

  // Former member queries own redacted self-history
  const history = await querySelfHistory(bobLiveDeps, { groupDid: GROUP });
  assert.ok(history.events.some((ev) => ev.event.$type === ATGRP_MOD_EVENT_TYPE.eject));
  assert.ok(history.events.some((ev) => ev.event.$type === ATGRP_MOD_EVENT_TYPE.appeal));
});
