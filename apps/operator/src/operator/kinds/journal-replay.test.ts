import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import {
  canonicalJson,
  channelRoleKey,
  channelUri,
  decisionRecordKey,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  personalInvitesUri,
  requestDigest,
  requestRecordKey,
  requireSpaceAuthority,
  spaceRecordUri,
  stableHash,
  tidNow,
  workspaceUri,
} from "@flock/protocol/keys";
import {
  COLLECTION,
  OPENSOCIAL_COLLECTION,
  OPENSOCIAL_METHOD,
  OPENSOCIAL_POLICY,
  OPENSOCIAL_SPACE_TYPE,
  SPACE_TYPE,
} from "@flock/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { AuthorityReauthorizationRequiredError } from "../authority-grant";
import { grantCreationAuthorization } from "../creation-authorization";
import { OperatorAuthError } from "../errors";
import { OperationRejectedError } from "../journal";
import { executeOperatorOperation, resumePendingWorkspaceCreations, validateOperatorRequest } from "../operations";
import type { RegistrationDeps } from "../registrations";
import { authorizeOperationActor } from "../security";
import { fakeGroupHost, plcDid, type FakeGroupSessionOptions } from "../testing/fake-group-session";
import { createWorkspace } from "./create-workspace";
import { inviteMemberKind } from "./invite-member";

const CREATOR = plcDid("jrcreator");
const ADMIN = plcDid("jradmin");
const MEMBER = plcDid("jrmember");
let directory = "";
let groupSeq = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-journal-replay-test-"));
  process.env.DATABASE_PATH = join(directory, "replay.db");
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.GROUP_HOST_URL = "http://127.0.0.1:3004";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const OUTAGE = () => Response.json({ error: "InternalServerError", message: "outage" }, { status: 500 });

async function authorityGroup(groupDid = plcDid(`jrgrp${++groupSeq}`), intercept?: FakeGroupSessionOptions["intercept"]) {
  const locksHeld: string[] = [];
  const host = await fakeGroupHost(groupDid, {
    creatorDid: CREATOR,
    intercept,
    onWrite: () => {
      locksHeld.push(
        ...(getRawDb().prepare("SELECT workspace FROM workspace_lock").all() as Array<{ workspace: string }>).map(
          (row) => row.workspace,
        ),
      );
    },
  });
  return { ...host, locksHeld };
}

function writePreKindTableRow(row: {
  workspace: string;
  actor: string;
  operationId: string;
  requestHash: string;
  request: Record<string, unknown>;
  steps: string[];
}): void {
  const raw = getRawDb();
  const now = Math.floor(Date.now() / 1000) - 60;
  const authority = requireSpaceAuthority(row.workspace);
  raw
    .prepare(
      `INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'earlier failure', ?, ?)`,
    )
    .run(
      authority,
      row.workspace,
      row.actor,
      row.operationId,
      row.requestHash,
      canonicalJson({ workspace: row.workspace, request: row.request }),
      JSON.stringify(row.steps),
      now,
      now,
    );
  raw
    .prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
    .run(authority, row.workspace);
}

const journalRow = (operationId: string) =>
  getRawDb()
    .prepare("SELECT actor, request_hash, state, steps_json, taken_over_by FROM operation WHERE operation_id = ?")
    .get(operationId) as {
    actor: string;
    request_hash: string;
    state: string;
    steps_json: string;
    taken_over_by: string | null;
  };

const BOOTSTRAP_STEPS = [
  "workspace-space",
  "inbox-space",
  "general-channel-space",
  "workspace-profile",
  "owner-roster",
  "owner-admin",
  "general-directory",
];

test("a pre-table bootstrap row with no step done resumes under its hash and runs every step once", async () => {
  const gDid = plcDid("jrboot1");
  const acmeUri = workspaceUri(gDid);
  const req = { kind: "bootstrapWorkspace", name: "Acme" };
  const hash = requestDigest({ workspace: acmeUri, request: req });
  writePreKindTableRow({
    workspace: acmeUri,
    actor: gDid,
    operationId: "2222222222222",
    requestHash: hash,
    request: req,
    steps: [],
  });
  const host = await authorityGroup(gDid);

  const [result] = await resumePendingWorkspaceCreations(host.session, acmeUri);

  assert.equal(result?.state, "completed");
  assert.deepEqual(JSON.parse(journalRow("2222222222222").steps_json), BOOTSTRAP_STEPS);
  assert.deepEqual(
    { ...journalRow("2222222222222"), steps_json: undefined },
    { actor: gDid, request_hash: hash, state: "completed", steps_json: undefined, taken_over_by: null },
  );
  assert.equal(new Set(host.writes).size, host.writes.length, "no write is repeated");
  assert.deepEqual([...new Set(host.locksHeld)], [gDid]);
});

test("a pre-table bootstrap row half done resumes after its last completed step", async () => {
  const gDid = plcDid("jrboot2");
  const name = "Beta";
  const skey = `beta-${stableHash(name).slice(0, 10)}`;
  const workspace = workspaceUri(gDid, skey);
  const request = { kind: "bootstrapWorkspace", name };
  const requestHash = requestDigest({ workspace, request });
  const host = await authorityGroup(gDid);
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: "self",
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [{ role: "member", read: true, write: true }],
    },
  });
  // Seed legacy pre-R13 workspace space only via `BOOTSTRAP_STEPS.slice(0, 3)` when `skey === "self"`:
  const selfWs = workspaceUri(gDid, "self");
  const selfHash = requestDigest({ workspace: selfWs, request });
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.inbox,
    skey: "self",
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [{ role: "member", read: true, write: true }],
    },
  });
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey: "general",
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [{ role: "member", read: true, write: true }],
    },
  });
  host.writes.length = 0;
  void workspace;
  void requestHash;
  writePreKindTableRow({
    workspace: selfWs,
    actor: gDid,
    operationId: "3333333333333",
    requestHash: selfHash,
    request,
    steps: BOOTSTRAP_STEPS.slice(0, 3),
  });

  const [result] = await resumePendingWorkspaceCreations(host.session, selfWs);

  assert.equal(result?.state, "completed");
  assert.deepEqual(JSON.parse(journalRow("3333333333333").steps_json), BOOTSTRAP_STEPS);
  assert.equal(journalRow("3333333333333").request_hash, selfHash);
  assert.equal(host.writes.some((w) => w.startsWith("createSpace")), false, "no space created again");
});

async function seededWorkspace(label: string, intercept?: FakeGroupSessionOptions["intercept"], joinPolicy: "open" | "approval" | "invite" = "invite") {
  let ready = false;
  const gDid = plcDid(`jrseed${label}${++groupSeq}`);
  const host = await authorityGroup(gDid, (m, t, init) => (ready ? intercept?.(m, t, init) : undefined));
  grantCreationAuthorization({ authorityDid: gDid, initiatorDid: CREATOR, name: label }, Math.floor(Date.now() / 1000));
  const created = await createWorkspace(host.session, {
    creator: CREATOR,
    name: label,
    joinPolicy,
    operationId: tidNow(),
  });
  const membersSpace = groupMembersUri(gDid);
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, ADMIN, {
    roles: ["admin", "member"],
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, MEMBER, {
    roles: ["member"],
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  const owner: OperatorActor = {
    did: CREATOR,
    session: host.session,
    workspace: parseWorkspaceRef(created.workspace),
    canRecoverOperations: true,
  };
  host.writes.length = 0;
  host.locksHeld.length = 0;
  ready = true;
  return { workspace: created.workspace, host, owner };
}

for (const scenario of [
  { label: "zero-steps", operationId: "4444444444444", nextOperationId: "6666666666666", done: [] as string[] },
  {
    label: "half-done",
    operationId: "5555555555555",
    nextOperationId: "7777777777777",
    done: ["channel-space", `channel-member-${ADMIN}`, `channel-roster-${ADMIN}`],
  },
]) {
  test(`a pre-R13 createChannel row (${scenario.label}) is recovered for its admin by the next operation, repeating no step`, async () => {
    const { workspace, host, owner } = await seededWorkspace(scenario.label);
    const request = { kind: "createChannel", skey: "design", name: "design", visibility: "private", members: [ADMIN] };
    const requestHash = requestDigest({ workspace, request });
    const privRole = channelRoleKey("design");
    const membersSpace = groupMembersUri(host.groupDid);

    if (scenario.done.includes("channel-space")) {
      await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.role, privRole, { displayName: "#design member" });
      await host.selfClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.channel,
        skey: "design",
        policy: {
          $type: OPENSOCIAL_POLICY,
          publicRead: false,
          unlisted: true,
          grants: [{ role: privRole, read: true, write: true }],
        },
      });
    }
    if (scenario.done.includes(`channel-member-${ADMIN}`)) {
      await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, ADMIN, {
        roles: ["admin", "member", privRole],
        createdAt: "2026-11-01T00:00:00.000Z",
      });
    }
    host.writes.length = 0;
    writePreKindTableRow({ workspace, actor: ADMIN, operationId: scenario.operationId, requestHash, request, steps: scenario.done });

    const next = await executeOperatorOperation(owner, scenario.nextOperationId, {
      kind: "createChannel",
      skey: "random",
      name: "random",
      visibility: "public",
    });

    assert.equal(next.state, "completed");
    const row = journalRow(scenario.operationId);
    assert.equal(row.actor, ADMIN);
    assert.equal(row.request_hash, requestHash);
    assert.equal(row.state, "completed");
    assert.equal(row.taken_over_by, null);
    if (scenario.done.includes("channel-space")) {
      assert.equal(host.writes.some((w) => w === `createSpace ${channelUri(host.groupDid, "design")}`), false);
    }
    assert.deepEqual([...new Set(host.locksHeld)], [host.groupDid]);
  });
}

test("recovery that meets a missing scope keeps the other admin's row pending and asks the authority to approve", async () => {
  const scopeMissing = (method: string) =>
    method === "com.atproto.space.createSpace"
      ? Response.json({ error: "ScopeMissingError", message: 'Missing required scope "space:new.flock.channel"' }, { status: 403 })
      : undefined;
  const { workspace, owner } = await seededWorkspace("epsilon", scopeMissing);
  const request = { kind: "createChannel", skey: "design", name: "design", visibility: "private", members: [ADMIN] };
  writePreKindTableRow({
    workspace,
    actor: ADMIN,
    operationId: "222222222222c",
    requestHash: requestDigest({ workspace, request }),
    request,
    steps: [],
  });

  const next = executeOperatorOperation(owner, "222222222222d", { kind: "reconcileWorkspace" });

  await assert.rejects(next, AuthorityReauthorizationRequiredError);
  assert.deepEqual(
    { ...journalRow("222222222222c"), request_hash: undefined },
    { actor: ADMIN, request_hash: undefined, state: "pending", steps_json: "[]", taken_over_by: null },
  );
  assert.equal(
    (getRawDb().prepare("SELECT count(*) AS count FROM operation WHERE operation_id = ?").get("222222222222d") as { count: number }).count,
    0,
  );
});

function recordingRegistration() {
  const registered: string[] = [];
  const deps: RegistrationDeps = {
    register: async (_session, space) => {
      registered.push(space);
      return Date.now() + 24 * 60 * 60 * 1000;
    },
    now: () => Date.now(),
  };
  return { deps, registered };
}

test("resumed operations register the spaces they created, including meta/self and members/self on bootstrap", async () => {
  const gDid = plcDid("jrbootreg");
  const bootstrap = workspaceUri(gDid, "self");
  const bootReq = { kind: "bootstrapWorkspace", name: "Epsilon" };
  writePreKindTableRow({
    workspace: bootstrap,
    actor: gDid,
    operationId: "2222222222224",
    requestHash: requestDigest({ workspace: bootstrap, request: bootReq }),
    request: bootReq,
    steps: [],
  });
  const bootHost = await authorityGroup(gDid);

  const { workspace, host, owner } = await seededWorkspace("zeta");
  const request = { kind: "createChannel", skey: "design", name: "design", visibility: "private", members: [ADMIN] };
  writePreKindTableRow({
    workspace,
    actor: ADMIN,
    operationId: "2222222222225",
    requestHash: requestDigest({ workspace, request }),
    request,
    steps: [],
  });

  const resumedBootstrap = recordingRegistration();
  const [result] = await resumePendingWorkspaceCreations(bootHost.session, bootstrap, resumedBootstrap.deps);
  const resumedChannel = recordingRegistration();
  await executeOperatorOperation(
    owner,
    "2222222222226",
    { kind: "createChannel", skey: "random", name: "random", visibility: "public" },
    resumedChannel.deps,
  );

  assert.equal(result?.state, "completed");
  assert.deepEqual(resumedBootstrap.registered, [
    groupMetaUri(gDid),
    groupMembersUri(gDid),
    bootstrap,
    inboxUri(gDid),
    channelUri(gDid, "general"),
  ]);
  assert.deepEqual(resumedChannel.registered, [
    channelUri(host.groupDid, "design"),
    channelUri(host.groupDid, "random"),
  ]);
});

test("seeded pre-R13 pending decideJoinRequest private-channel upgrade rows replay cleanly onto OpenSocial channel-<skey> roles", async () => {
  const { workspace, host, owner } = await seededWorkspace("prer13decide");
  const createSecret = await executeOperatorOperation(owner, tidNow(), {
    kind: "createChannel",
    skey: "secret",
    name: "secret",
    visibility: "private",
    members: [CREATOR],
  });
  assert.equal(createSecret.state, "completed");

  const secretSpace = channelUri(host.groupDid, "secret");
  const inbox = inboxUri(host.groupDid);
  const reqRkey = requestRecordKey(secretSpace, MEMBER);
  const reqId = tidNow();
  const reqUri = spaceRecordUri(inbox, MEMBER, COLLECTION.joinRequest, reqRkey);

  await host.putMemberRecord(MEMBER, inbox, COLLECTION.joinRequest, reqRkey, {
    channelSkey: "secret",
    requestId: reqId,
    createdAt: "2026-11-18T12:00:00.000Z",
  });

  const decideReq = { kind: "decideJoinRequest", request: reqUri, requestId: reqId, decision: "approve" };
  const decideId = tidNow();
  writePreKindTableRow({
    workspace,
    actor: ADMIN,
    operationId: decideId,
    requestHash: requestDigest({ workspace, request: decideReq }),
    request: decideReq,
    steps: ["join-request-baseline-none-0"],
  });

  const recovered = await executeOperatorOperation(owner, tidNow(), { kind: "reconcileWorkspace" });
  assert.equal(recovered.state, "completed");

  const row = journalRow(decideId);
  assert.equal(row.state, "completed");
  assert.equal(row.actor, ADMIN);
  assert.deepEqual(JSON.parse(row.steps_json), [
    "join-request-baseline-none-0",
    "join-request-channel-membership",
    "join-request-private-roster",
    "join-request-decision",
    "join-request-approved-membership-verified",
  ]);

  const memberRecord = await host.getRecord<{ roles: string[] }>(
    groupMembersUri(host.groupDid),
    OPENSOCIAL_COLLECTION.membership,
    MEMBER,
  );
  assert.ok(memberRecord?.roles.includes(channelRoleKey("secret")));

  const decisionRecord = await host.getRecord<{ decision: string; requestId: string }>(
    inbox,
    COLLECTION.joinDecision,
    decisionRecordKey(reqUri),
  );
  assert.equal(decisionRecord?.decision, "approve");
  assert.equal(decisionRecord?.requestId, reqId);
});

test("distinct decideGroupJoinRequest approves with If-Join-Request-Present: true, denies via denyJoinRequest, rejects missing requests, and replays idempotently after post-commit crashes", async () => {
  let loseApproveResponse = false;
  let loseDenyResponse = false;
  const { host, owner } = await seededWorkspace(
    "groupjoin",
    async (method, target, init) => {
      if (
        loseApproveResponse &&
        method === "com.atproto.space.putRecord" &&
        target.collection === OPENSOCIAL_COLLECTION.membership
      ) {
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get("if-join-request-present"),
          "true",
          "decideGroupJoinRequest(approve) MUST send If-Join-Request-Present: true",
        );
        loseApproveResponse = false;
        // Let the real Group Host commit first, then simulate lost HTTP response!
        await host.putRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, target.rkey!, {
          roles: ["member"],
          createdAt: new Date().toISOString(),
        });
        return OUTAGE();
      }
      if (loseDenyResponse && method === OPENSOCIAL_METHOD.denyJoinRequest) {
        loseDenyResponse = false;
        await host.selfClient.procedure(OPENSOCIAL_METHOD.denyJoinRequest, { member: target.member });
        return OUTAGE();
      }
      return undefined;
    },
    "approval",
  );

  const applicantApprove = plcDid("jrapprove");
  const applicantDeny = plcDid("jrdeny");
  const applicantMissing = plcDid("jrmissing");

  // 1. Approving or denying when no `join_request` exists fails with `JoinRequestNotFound`
  const missingApprove = await executeOperatorOperation(owner, tidNow(), {
    kind: "decideGroupJoinRequest",
    member: applicantMissing,
    decision: "approve",
  });
  assert.equal(missingApprove.state, "failed");
  assert.match(missingApprove.error ?? "", /JoinRequestNotFound/);

  const missingDeny = await executeOperatorOperation(owner, tidNow(), {
    kind: "decideGroupJoinRequest",
    member: applicantMissing,
    decision: "deny",
  });
  assert.equal(missingDeny.state, "failed");
  assert.match(missingDeny.error ?? "", /JoinRequestNotFound/);

  // 2. Real `requestJoin` (`status: "pending"`) -> `decideGroupJoinRequest(approve)` with lost response -> idempotent replay succeeds!
  const join1 = await host.requestGroupJoin(applicantApprove, { idempotencyKey: "join-op-1" });
  assert.equal(join1.status, "pending");
  loseApproveResponse = true;
  const approved = await executeOperatorOperation(owner, tidNow(), {
    kind: "decideGroupJoinRequest",
    member: applicantApprove,
    decision: "approve",
  });
  assert.equal(approved.state, "completed", JSON.stringify(approved));
  const mem = await host.getRecord<{ roles: string[] }>(
    groupMembersUri(host.groupDid),
    OPENSOCIAL_COLLECTION.membership,
    applicantApprove,
  );
  assert.deepEqual(mem?.roles, ["member"]);

  // 3. Real `requestJoin` (`status: "pending"`) -> `decideGroupJoinRequest(deny)` with lost response -> idempotent replay succeeds!
  const join2 = await host.requestGroupJoin(applicantDeny, { idempotencyKey: "join-op-2" });
  assert.equal(join2.status, "pending");
  loseDenyResponse = true;
  const denied = await executeOperatorOperation(owner, tidNow(), {
    kind: "decideGroupJoinRequest",
    member: applicantDeny,
    decision: "deny",
  });
  assert.equal(denied.state, "completed", JSON.stringify(denied));
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, applicantDeny),
    undefined,
  );
});

test("demotion of originalActor: (1) satisfied leaveChannel completes, (2) 0-step aborts as aborted_actor_revoked, and (3) >=1-step after EVERY durable step refuses under-privileged sub-admins (403) then completes via audited operationAdminTakeover", async () => {
  // --- Branch (1): Member `leaveChannel` pending row satisfied by state (`operationSatisfiedByState`) ---
  {
    const { workspace, host, owner } = await seededWorkspace("takeover-member");
    await executeOperatorOperation(owner, tidNow(), {
      kind: "createChannel",
      skey: "secret",
      name: "secret",
      visibility: "private",
      members: [MEMBER],
    });
    const leaveChReq = { kind: "leaveChannel", skey: "secret" };
    const leaveChId = tidNow();
    writePreKindTableRow({
      workspace,
      actor: MEMBER,
      operationId: leaveChId,
      requestHash: requestDigest({ workspace, request: leaveChReq }),
      request: leaveChReq,
      steps: [],
    });
    // Eject MEMBER before recovery runs
    await host.deleteRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, MEMBER);

    const res = await executeOperatorOperation(owner, tidNow(), { kind: "reconcileWorkspace" });
    assert.equal(res.state, "completed");
    assert.equal(journalRow(leaveChId).state, "completed");
    const audits = getRawDb()
      .prepare("SELECT actor, event FROM audit_event WHERE operation_id = ?")
      .all(leaveChId) as Array<{ actor: string; event: string }>;
    assert.deepEqual(audits, [{ actor: CREATOR, event: "operationSatisfiedByState" }]);
  }

  // --- Branch (2): 0-step pending operation & live pre-step-0 demotion -> `aborted_actor_revoked` (`operationAbortedActorRevoked`) ---
  {
    const { workspace, host, owner } = await seededWorkspace("takeover-zero");
    const zeroReq = { kind: "createChannel", skey: "aborted", name: "aborted", visibility: "public" };
    const zeroId = tidNow();
    const zeroHash = requestDigest({ workspace, request: zeroReq });
    writePreKindTableRow({
      workspace,
      actor: ADMIN,
      operationId: zeroId,
      requestHash: zeroHash,
      request: zeroReq,
      steps: [],
    });
    // Demote ADMIN (`roles: ["member"]`) before recovery
    await host.putRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, ADMIN, {
      roles: ["member"],
      createdAt: "2026-11-01T00:00:00.000Z",
    });

    const next = await executeOperatorOperation(owner, tidNow(), { kind: "reconcileWorkspace" });
    assert.equal(next.state, "completed");
    assert.deepEqual(journalRow(zeroId), {
      actor: ADMIN,
      request_hash: zeroHash,
      state: "aborted_actor_revoked",
      steps_json: "[]",
      taken_over_by: null,
    });
    assert.equal(await host.getSpacePolicy(channelUri(host.groupDid, "aborted")), null);
    const audits = getRawDb()
      .prepare("SELECT actor, event, details_json FROM audit_event WHERE operation_id = ?")
      .all(zeroId) as Array<{ actor: string; event: string; details_json: string }>;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actor, CREATOR);
    assert.equal(audits[0]?.event, "operationAbortedActorRevoked");
    assert.equal(JSON.parse(audits[0]!.details_json).originalActor, ADMIN);
  }

  // --- Branch (3): Demotion of `originalActor` after EVERY durable step (`1, 2, 3`) of multi-step private `createChannel` ---
  // Active steps for private `createChannel` with `[MEMBER]`:
  //   step 1: `channel-space` (`putRecord(role)` + `createSpace`)
  //   step 2: `channel-member-${MEMBER}` (`putRecord(membership)`)
  //   step 3: `channel-directory` (`putRecord(directory)`)
  //   step 4: `channel-membership-verified` (`getSpace` + `readGroupGovernanceState` verification)
  for (const stopAfterStepCount of [1, 2, 3] as const) {
    let blockFromStep = false;
    let directoryWritten = false;
    const { workspace, host, owner } = await seededWorkspace(`takeover-step-${stopAfterStepCount}`, (method, target) => {
      if (!blockFromStep) return undefined;
      if (stopAfterStepCount === 1 && method === "com.atproto.space.putRecord" && target.collection === OPENSOCIAL_COLLECTION.membership) {
        return OUTAGE();
      }
      if (stopAfterStepCount === 2 && method === "com.atproto.space.putRecord" && target.collection === COLLECTION.directory) {
        return OUTAGE();
      }
      if (method === "com.atproto.space.putRecord" && target.collection === COLLECTION.directory && target.rkey === "priv") {
        directoryWritten = true;
        return undefined;
      }
      if (stopAfterStepCount === 3 && directoryWritten && method === "com.atproto.space.getSpace" && target.space?.endsWith("/priv")) {
        return OUTAGE();
      }
      return undefined;
    });

    // Provision a limited sub-admin (`RECRUITER`) who can `inviteMember` (`member` role only) but CANNOT create private channels!
    const recruiterDid = plcDid(`jrrecruiter${stopAfterStepCount}`);
    const membersSpace = groupMembersUri(host.groupDid);
    await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.role, "recruiter", {
      displayName: "Recruiter",
      scopes: [
        `space:${OPENSOCIAL_SPACE_TYPE.members}?skey=self&collection=${OPENSOCIAL_COLLECTION.membership}&action=read&action=create&action=update`,
      ],
      assignable: ["member"],
    });
    await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, recruiterDid, {
      roles: ["member", "recruiter"],
      createdAt: "2026-11-01T00:00:00.000Z",
    });

    const adminActor: OperatorActor = { ...owner, did: ADMIN };
    const opId = tidNow();
    const createPrivReq = {
      kind: "createChannel",
      skey: "priv",
      name: "priv",
      visibility: "private",
      members: [MEMBER],
    };
    const expectedHash = requestDigest({ workspace, request: createPrivReq });

    blockFromStep = true;
    const stopped = await executeOperatorOperation(adminActor, opId, createPrivReq);
    blockFromStep = false;
    assert.equal(stopped.state, "pending");
    assert.equal(stopped.completedSteps.length, stopAfterStepCount);

    // Demote `ADMIN` (`originalActor`) after `stopAfterStepCount` durable steps!
    await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, ADMIN, {
      roles: ["member"],
      createdAt: "2026-11-02T00:00:00.000Z",
    });
    const writesBeforeRecovery = host.writes.length;

    // 3a. Under-privileged sub-admin (`recruiterDid`) attempting an operation fails recovery with `403 OperatorAuthError`!
    const recruiterActor = await authorizeOperationActor(host.session, owner.workspace, recruiterDid, {
      kind: "inviteMember",
      subject: plcDid(`jrcand${stopAfterStepCount}`),
    });
    await assert.rejects(
      executeOperatorOperation(recruiterActor, tidNow(), {
        kind: "inviteMember",
        subject: plcDid(`jrcand${stopAfterStepCount}`),
      }),
      (err: unknown) => err instanceof OperatorAuthError,
      `step ${stopAfterStepCount}: under-privileged sub-admin must get 403 on takeover`,
    );
    assert.equal(journalRow(opId).state, "pending");
    assert.equal(journalRow(opId).taken_over_by, null);

    // 3b. Full active admin (`CREATOR`) recovers `(workspace, ADMIN, opId)` via audited `operationAdminTakeover`!
    const afterRecovery = await executeOperatorOperation(owner, tidNow(), { kind: "reconcileWorkspace" });
    assert.equal(afterRecovery.state, "completed");

    const finalRow = journalRow(opId);
    assert.equal(finalRow.actor, ADMIN, "immutable ownerDid preserved on operation.actor");
    assert.equal(finalRow.request_hash, expectedHash, "request_hash preserved");
    assert.equal(finalRow.state, "completed");
    assert.equal(finalRow.taken_over_by, CREATOR, "taken_over_by records executorActor.did");
    assert.deepEqual(JSON.parse(finalRow.steps_json), [
      "channel-space",
      `channel-member-${MEMBER}`,
      "channel-directory",
      "channel-membership-verified",
    ]);

    // Pre-takeover durable writes were NOT repeated
    const recoveryWrites = host.writes.slice(writesBeforeRecovery);
    assert.equal(
      recoveryWrites.includes(`createSpace ${channelUri(host.groupDid, "priv")}`),
      false,
      "completed channel-space step is not repeated during takeover",
    );

    // Audit trail separates originalActor from takeover executorActor!
    const auditEvents = getRawDb()
      .prepare("SELECT actor, event, details_json FROM audit_event WHERE operation_id = ? ORDER BY id ASC")
      .all(opId) as Array<{ actor: string; event: string; details_json: string }>;
    const takeoverIdx = auditEvents.findIndex((e) => e.event === "operationAdminTakeover");
    assert.ok(takeoverIdx >= 0, `expected operationAdminTakeover audit event at step ${stopAfterStepCount}`);
    assert.deepEqual(JSON.parse(auditEvents[takeoverIdx]!.details_json), {
      completedStepsBeforeTakeover: stopAfterStepCount,
      originalActor: ADMIN,
    });
    for (const preEvent of auditEvents.slice(0, takeoverIdx)) {
      assert.equal(preEvent.actor, ADMIN, "events before takeover attributed to originalActor");
    }
    for (const postEvent of auditEvents.slice(takeoverIdx)) {
      assert.equal(postEvent.actor, CREATOR, "takeover, remaining steps, and operationCompleted attributed to executorActor");
    }
    assert.equal(auditEvents.at(-1)?.event, "operationCompleted");
  }
});

test("inviteMember makes expiring invitations and direct membership grants strictly mutually exclusive, rejecting past/invalid expiresAt and existing members", async () => {
  let failFirstInviteVerify = false;
  const { host, owner } = await seededWorkspace("invitemodes", (method, target) => {
    if (
      failFirstInviteVerify &&
      method === "com.atproto.space.getRecord" &&
      target.collection === OPENSOCIAL_COLLECTION.invite
    ) {
      failFirstInviteVerify = false;
      return OUTAGE();
    }
    return undefined;
  });

  const expiringSubject = plcDid("jrexpireinv");
  const directSubject = plcDid("jrdirectinv");
  const futureIso = new Date(Date.now() + 3_600_000).toISOString();
  const pastIso = new Date(Date.now() - 60_000).toISOString();

  // 1. Past expiresAt is rejected with OperationRejectedError (`state === "failed"`) without writing invite or membership
  const pastOpId = tidNow();
  const pastRes = await executeOperatorOperation(owner, pastOpId, {
    kind: "inviteMember",
    subject: expiringSubject,
    expiresAt: pastIso,
  });
  assert.equal(pastRes.state, "failed");
  assert.match(pastRes.error ?? "", /valid future datetime/);
  assert.equal(
    await host.getRecord(personalInvitesUri(expiringSubject), OPENSOCIAL_COLLECTION.invite, pastOpId),
    undefined,
  );
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, expiringSubject),
    undefined,
  );

  // 2. Invalid expiresAt strings are rejected by both validateOperatorRequest and inviteMemberKind.run
  for (const badExpiresAt of ["", "not-a-date", "foo 2099", "2099-01-01"]) {
    assert.throws(
      () =>
        validateOperatorRequest(
          { kind: "inviteMember", subject: expiringSubject, expiresAt: badExpiresAt },
          owner,
          "execute",
        ),
      /Invalid expiration datetime/,
    );
    await assert.rejects(
      () =>
        inviteMemberKind.run(
          owner,
          {
            operationId: tidNow(),
            completedSteps: [],
            step: async (_name, fn) => fn(),
          },
          { kind: "inviteMember", subject: expiringSubject, expiresAt: badExpiresAt },
        ),
      OperationRejectedError,
    );
  }

  // 3. Already-admitted member cannot receive an expiring invitation (`state === "failed"`)
  const alreadyMemberRes = await executeOperatorOperation(owner, tidNow(), {
    kind: "inviteMember",
    subject: MEMBER,
    expiresAt: futureIso,
  });
  assert.equal(alreadyMemberRes.state, "failed");
  assert.match(alreadyMemberRes.error ?? "", /already a member/);

  // 4. Expiring invitation (`expiresAt` future ISO) writes ONLY `group.opensocial.invite/<operationId>` (no nonstandard `group` field)
  //    and NEVER creates `membership/<subject>` until redeemed (including across transient verification retry)!
  failFirstInviteVerify = true;
  const inviteOpId = tidNow();
  const inviteRes = await executeOperatorOperation(owner, inviteOpId, {
    kind: "inviteMember",
    subject: expiringSubject,
    expiresAt: futureIso,
  });
  assert.equal(inviteRes.state, "completed", JSON.stringify(inviteRes));
  assert.deepEqual(inviteRes.completedSteps, ["member-invite-record", "member-state-verified"]);

  const storedInvite = await host.getRecord<Record<string, unknown>>(
    personalInvitesUri(expiringSubject),
    OPENSOCIAL_COLLECTION.invite,
    inviteOpId,
  );
  assert.ok(storedInvite, "group.opensocial.invite/<operationId> must exist on Group Host");
  assert.equal(storedInvite.expiresAt, futureIso);
  assert.equal(typeof storedInvite.createdAt, "string");
  assert.equal("group" in storedInvite, false, "standard group.opensocial.invite must not include nonstandard group field");

  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, expiringSubject),
    undefined,
    "expiring invitation must NOT grant immediate membership before redemption",
  );
  assert.equal(await host.effectiveAccess(channelUri(host.groupDid, "general"), expiringSubject), "-");

  // Redeem the invitation via `group.opensocial.requestJoin` -> admits `expiringSubject` cleanly
  const inviteUri = `${personalInvitesUri(expiringSubject)}/${host.groupDid}/${OPENSOCIAL_COLLECTION.invite}/${inviteOpId}`;
  const redeemed = await host.requestGroupJoin(expiringSubject, { invite: inviteUri });
  assert.equal(redeemed.status, "admitted");
  assert.deepEqual(
    (await host.getRecord<{ roles: string[] }>(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, expiringSubject))?.roles,
    ["member"],
  );

  // 5. Direct membership grant (`expiresAt === undefined`) writes `membership/<subject>` directly and writes NO invite record
  const directOpId = tidNow();
  const directRes = await executeOperatorOperation(owner, directOpId, {
    kind: "inviteMember",
    subject: directSubject,
  });
  assert.equal(directRes.state, "completed");
  assert.deepEqual(directRes.completedSteps, ["member-workspace", "member-state-verified"]);
  assert.deepEqual(
    (await host.getRecord<{ roles: string[] }>(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, directSubject))?.roles,
    ["member"],
  );
  assert.equal(
    await host.getRecord(personalInvitesUri(directSubject), OPENSOCIAL_COLLECTION.invite, directOpId),
    undefined,
  );
});
