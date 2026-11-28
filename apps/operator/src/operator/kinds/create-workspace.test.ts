import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import {
  canonicalJson,
  channelUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  requestDigest,
  workspaceUri,
} from "@flock/protocol/keys";
import { ATGRP_COLLECTION, ATGRP_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import {
  CreationNotAuthorizedError,
  grantCreationAuthorization,
  hasCreationAuthorization,
} from "../creation-authorization";
import { OperationRejectedError } from "../journal";
import { executeOperatorOperation, resumePendingWorkspaceCreations } from "../operations";
import { fakeGroupHost, plcDid, type FakeGroupSessionOptions } from "../testing/fake-group-session";
import {
  assertCreationAdmissible,
  createWorkspace,
  createWorkspaceKind,
  WorkspaceExistsError,
} from "./create-workspace";

const BOOTSTRAP_ADMIN = plcDid("cwbootstrap");
const CREATOR = plcDid("cwcreator");
const OTHER = plcDid("cwother");
let directory = "";
let groupSeq = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "create-workspace-test-"));
  process.env.DATABASE_PATH = join(directory, "create.db");
  process.env.AUTH_ENCRYPTION_KEY = "35".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.GROUP_HOST_URL = "http://127.0.0.1:3004";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);
const SCOPE_MISSING = () =>
  Response.json(
    {
      error: "ScopeMissingError",
      message: 'Missing required scope "space:new.flock.workspace?skey=self&action=read_self&manage=create"',
    },
    { status: 403 },
  );
const OUTAGE = () => Response.json({ error: "InternalServerError", message: "outage" }, { status: 500 });
const WRITES = new Set(["com.atproto.space.createSpace", "com.atproto.space.putRecord"]);
const ACTIVE_R13_STEPS = [
  "workspace-space",
  "inbox-space",
  "general-channel-space",
  "workspace-profile",
  "creator-admin",
  "general-directory",
] as const;

const nextGroupDid = () => plcDid(`cwgroup${++groupSeq}`);
const rowOf = (operationId: string) =>
  getRawDb()
    .prepare("SELECT actor, workspace, state, steps_json FROM operation WHERE operation_id = ?")
    .get(operationId) as { actor: string; workspace: string; state: string; steps_json: string } | undefined;
const approve = (groupDid: string, name: string, initiatorDid = CREATOR) =>
  grantCreationAuthorization({ authorityDid: groupDid, initiatorDid, name }, now());
const spacesOf = (groupDid: string) => ({
  meta: groupMetaUri(groupDid),
  members: groupMembersUri(groupDid),
  workspace: workspaceUri(groupDid),
  inbox: inboxUri(groupDid),
  general: channelUri(groupDid, "general"),
});

async function newGroup(options: FakeGroupSessionOptions = {}) {
  const groupDid = nextGroupDid();
  const host = await fakeGroupHost(groupDid, {
    creatorDid: options.creatorDid ?? BOOTSTRAP_ADMIN,
    ...options,
  });
  return host;
}

test("someone cannot create a workspace under an OpenSocial group without creation authorization, and nothing is written", async () => {
  const host = await newGroup();

  const attempt = createWorkspace(host.session, {
    creator: CREATOR,
    name: "Unapproved",
    operationId: "2222222222222",
  });

  await assert.rejects(attempt, CreationNotAuthorizedError);
  assert.equal(rowOf("2222222222222"), undefined);
  assert.deepEqual(host.writes, []);
});

test("the group DID itself cannot be passed as a human workspace creator", async () => {
  const host = await newGroup();
  await assert.rejects(
    createWorkspace(host.session, {
      creator: host.groupDid,
      name: "Self Group",
      operationId: "2222222222224",
    }),
    OperationRejectedError,
  );
  assert.equal(rowOf("2222222222224"), undefined);
  assert.deepEqual(host.writes, []);
});

test("with creation approval, createWorkspace provisions OpenSocial modality spaces, updates profile/self, and ensures creator admin membership without groupDid membership", async () => {
  const host = await newGroup({ creatorDid: CREATOR, name: "Initial" });
  approve(host.groupDid, "Team Alpha", CREATOR);

  const result = await createWorkspace(host.session, {
    creator: CREATOR,
    name: "Team Alpha",
    joinPolicy: "approval",
    operationId: "2222222222223",
  });

  const { meta, members, workspace, inbox, general } = spacesOf(host.groupDid);
  assert.equal(result.state, "completed");
  assert.equal(result.groupDid, host.groupDid);
  assert.equal(result.workspace, workspace);
  assert.equal(result.channel, general);
  assert.deepEqual(result.completedSteps, [...ACTIVE_R13_STEPS]);
  assert.deepEqual(
    { ...rowOf("2222222222223"), steps_json: undefined },
    { actor: CREATOR, workspace: host.groupDid, state: "completed", steps_json: undefined },
  );

  assert.equal(await host.effectiveAccess(workspace, CREATOR), "rw");
  assert.equal(await host.effectiveAccess(inbox, CREATOR), "rw");
  assert.equal(await host.effectiveAccess(general, CREATOR), "rw");

  const profile = await host.getRecord<{ displayName: string }>(
    meta,
    ATGRP_COLLECTION.about,
    "self",
  );
  assert.equal(profile?.displayName, "Team Alpha");
  const config = await host.getRecord<{ joinPolicy: string }>(
    meta,
    ATGRP_COLLECTION.config,
    "self",
  );
  assert.equal(config?.joinPolicy, "approval");

  const creatorMem = await host.getRecord<{ roles: string[] }>(
    members,
    ATGRP_COLLECTION.membership,
    CREATOR,
  );
  assert.ok(creatorMem?.roles.includes("admin"));
  assert.ok(creatorMem?.roles.includes("member"));

  // Group DID itself is NEVER in `membership/*` (`proposal.md:44`)
  assert.equal(
    await host.getRecord(members, ATGRP_COLLECTION.membership, host.groupDid),
    undefined,
  );
});

test("an approval is for one name, one creator and one creation; a retry of that creation resumes without it", async () => {
  let failing = false;
  const host = await newGroup({
    intercept: (method) => (failing && method === "com.atproto.space.createSpace" ? OUTAGE() : undefined),
  });
  approve(host.groupDid, "Team Beta", CREATOR);

  await assert.rejects(
    createWorkspace(host.session, { creator: CREATOR, name: "Team Gamma", operationId: "3333333333333" }),
    CreationNotAuthorizedError,
    "an approval for one name creates no other",
  );
  await assert.rejects(
    createWorkspace(host.session, { creator: OTHER, name: "Team Beta", operationId: "3333333333334" }),
    CreationNotAuthorizedError,
    "nor does it let anyone else create",
  );

  failing = true;
  const first = await createWorkspace(host.session, { creator: CREATOR, name: "Team Beta", operationId: "3333333333335" });
  assert.equal(first.state, "pending");

  await assert.rejects(
    createWorkspace(host.session, { creator: CREATOR, name: "Team Beta", operationId: "3333333333336" }),
    CreationNotAuthorizedError,
  );

  failing = false;
  const retry = await createWorkspace(host.session, { creator: CREATOR, name: "Team Beta", operationId: "3333333333335" });
  assert.equal(retry.state, "completed");
});

test("a creation refused at its first step for a missing scope leaves no row and gives the approval back for that operation only", async () => {
  let scopeMissing = true;
  const host = await newGroup({
    intercept: (method) => (scopeMissing && method === "com.atproto.space.createSpace" ? SCOPE_MISSING() : undefined),
  });
  approve(host.groupDid, "Team Delta", CREATOR);

  const refused = await createWorkspace(host.session, { creator: CREATOR, name: "Team Delta", operationId: "4444444444444" });

  assert.equal(refused.authorizationRequired, true);
  assert.equal(rowOf("4444444444444"), undefined);
  assert.equal(
    getRawDb().prepare("SELECT 1 FROM operation_workspace_catalog WHERE workspace_uri = ?").get(refused.workspace),
    undefined,
  );
  assert.deepEqual(
    (getRawDb().prepare("SELECT event FROM audit_event WHERE operation_id = ?").all("4444444444444") as Array<{ event: string }>).map(
      (row) => row.event,
    ),
    ["operationDiscarded"],
  );

  await assert.rejects(
    createWorkspace(host.session, { creator: CREATOR, name: "Team Delta", operationId: "4444444444445" }),
    CreationNotAuthorizedError,
  );
  await assert.rejects(
    createWorkspace(host.session, { creator: OTHER, name: "Team Delta", operationId: "4444444444444" }),
    CreationNotAuthorizedError,
  );

  scopeMissing = false;
  const retried = await createWorkspace(host.session, { creator: CREATOR, name: "Team Delta", operationId: "4444444444444" });
  assert.equal(retried.state, "completed");
});

test("a missing scope after some steps keeps the row, keeps asking for reauthorization, and survives a retry", async () => {
  const state: { host?: Awaited<ReturnType<typeof newGroup>> } = {};
  const hostRef = await newGroup({
    intercept: (method) =>
      method === "com.atproto.space.createSpace" && (state.host?.writes.length ?? 0) > 0 ? SCOPE_MISSING() : undefined,
  });
  state.host = hostRef;
  approve(hostRef.groupDid, "Team Theta", CREATOR);

  const first = await createWorkspace(hostRef.session, { creator: CREATOR, name: "Team Theta", operationId: "4545454545454" });
  const retry = await createWorkspace(hostRef.session, { creator: CREATOR, name: "Team Theta", operationId: "4545454545454" });

  assert.deepEqual(first.completedSteps, ["workspace-space"]);
  assert.equal(first.authorizationRequired, true);
  assert.deepEqual(retry.completedSteps, ["workspace-space"]);
  assert.equal(retry.authorizationRequired, true);
  assert.equal(rowOf("4545454545454")?.state, "pending");
});

test("a creation stopped at any write step resumes for its creator, repeating no write", async () => {
  for (const [index, step] of ACTIVE_R13_STEPS.entries()) {
    let succeeded = 0;
    let outage = true;
    // BOOTSTRAP_ADMIN owns the initial group so `creator-admin` also performs a real `putRecord(membership/<CREATOR>)` write!
    const host = await newGroup({
      creatorDid: BOOTSTRAP_ADMIN,
      name: "Initial",
      intercept: (method) => {
        if (!WRITES.has(method)) return undefined;
        if (outage && succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      },
    });
    const name = `Resume ${index}`;
    const operationId = `5555555555a${"abcdefghijklmnop"[index]}a`;
    approve(host.groupDid, name, CREATOR);

    const stopped = await createWorkspace(host.session, { creator: CREATOR, name, operationId });
    outage = false;
    const resumed = await createWorkspace(host.session, { creator: CREATOR, name, operationId });

    assert.equal(stopped.state, "pending", step);
    assert.deepEqual(stopped.completedSteps, ACTIVE_R13_STEPS.slice(0, index), step);
    assert.equal(resumed.state, "completed", step);
    assert.equal(new Set(host.writes).size, host.writes.length, `${step}: no write repeated`);
    assert.equal(host.writes.length, ACTIVE_R13_STEPS.length, step);
  }
});

async function pendingCreation(name: string, operationId: string, steps: readonly string[]) {
  const host = await newGroup({ creatorDid: CREATOR, name: "Initial" });
  const { members, workspace } = spacesOf(host.groupDid);
  await host.putRecord(members, ATGRP_COLLECTION.membership, OTHER, {
    roles: ["admin", "member"],
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  const request = { kind: "createWorkspace", name, creator: CREATOR };
  const created = Math.floor(Date.now() / 1000) - 60;
  getRawDb()
    .prepare(
      `INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'earlier failure', ?, ?)`,
    )
    .run(
      host.groupDid,
      workspace,
      CREATOR,
      operationId,
      requestDigest({ workspace, request }),
      canonicalJson({ workspace, request }),
      JSON.stringify(steps),
      created,
      created,
    );
  getRawDb()
    .prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
    .run(host.groupDid, workspace);
  const other = {
    did: OTHER,
    session: host.session,
    workspace: { uri: workspace, authorityDid: host.groupDid, skey: "self" },
    canRecoverOperations: true,
  };
  return { host, other };
}

const AFTER_ADMIN = ACTIVE_R13_STEPS.slice(0, ACTIVE_R13_STEPS.indexOf("creator-admin") + 1);
const NEXT_OPERATION = { kind: "createChannel", skey: "notes", name: "notes", visibility: "public" };

test("before a creation has begun (0 steps), another admin's operation cannot resume it and does not run", async () => {
  const { host, other } = await pendingCreation("Team Epsilon", "7777777777777", []);

  const attempt = executeOperatorOperation(other, "7777777777778", NEXT_OPERATION);

  await assert.rejects(attempt, /Only its creator can resume/);
  assert.deepEqual(
    { ...rowOf("7777777777777"), steps_json: JSON.parse(rowOf("7777777777777")!.steps_json) },
    { actor: CREATOR, workspace: host.groupDid, state: "pending", steps_json: [] },
  );
  assert.equal(rowOf("7777777777778"), undefined);
});

test("once a creation has made its creator an admin, another admin recovers it, and it stays the creator's", async () => {
  const { host, other } = await pendingCreation("Team Zeta", "8888888888888", AFTER_ADMIN);
  // Seed the spaces created by the completed prefix steps
  for (const [st, sk] of [
    [SPACE_TYPE.workspace, "self"],
    [SPACE_TYPE.inbox, "self"],
    [SPACE_TYPE.channel, "general"],
  ] as const) {
    await host.selfClient.procedure("com.atproto.space.createSpace", {
      spaceType: st,
      skey: sk,
      policy: {
        $type: ATGRP_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [{ role: "member", read: true, write: true }],
      },
    });
  }

  const view = await executeOperatorOperation(other, "8888888888889", NEXT_OPERATION);

  assert.equal(rowOf("8888888888888")?.state, "completed");
  assert.equal(rowOf("8888888888888")?.actor, CREATOR);
  assert.equal(view.state, "completed");
});

test("an approval is for a new workspace: one whose workspace/self space exists already is not created again for someone else", async () => {
  const host = await newGroup({ creatorDid: BOOTSTRAP_ADMIN });
  approve(host.groupDid, "Existing", BOOTSTRAP_ADMIN);
  assert.equal(
    (await createWorkspace(host.session, { creator: BOOTSTRAP_ADMIN, name: "Existing", operationId: "2323232323232" })).state,
    "completed",
  );
  approve(host.groupDid, "Existing", CREATOR);
  const before = host.writes.length;

  const creation = createWorkspace(host.session, { creator: CREATOR, name: "Existing", operationId: "2323232323233" });

  await assert.rejects(creation, WorkspaceExistsError);
  assert.equal(host.writes.length, before, "nothing is written");
  assert.equal(rowOf("2323232323233"), undefined);
  assert.equal(
    hasCreationAuthorization({ authorityDid: host.groupDid, initiatorDid: CREATOR, name: "Existing" }, "2323232323233", now()),
    true,
    "the approval is not used",
  );
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), ATGRP_COLLECTION.membership, CREATOR),
    undefined,
  );
});

test("a retry of a creation whose first step's answer was lost resumes, though workspace/self now exists", async () => {
  const { host } = await pendingCreation("Team Iota", "2424242424242", []);
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: "self",
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });

  const result = await createWorkspace(host.session, { creator: CREATOR, name: "Team Iota", operationId: "2424242424242" });
  assert.equal(result.state, "completed");
});

test("a creation with no approval is refused before the group's grant is used, unless it retries a creation that had one", async () => {
  const gDid = nextGroupDid();
  const input = { authorityDid: gDid, creator: CREATOR, name: "Team Kappa", operationId: "2525252525252" };
  assert.throws(() => assertCreationAdmissible(input), CreationNotAuthorizedError);
  assert.throws(() => assertCreationAdmissible({ ...input, creator: gDid }), OperationRejectedError);
  approve(gDid, "Team Kappa", CREATOR);
  assert.doesNotThrow(() => assertCreationAdmissible({ ...input, name: "  Team Kappa " }));

  const { host } = await pendingCreation("Team Lambda", "2626262626262", []);
  assert.doesNotThrow(() =>
    assertCreationAdmissible({
      authorityDid: host.groupDid,
      creator: CREATOR,
      name: "Team Lambda",
      operationId: "2626262626262",
    }),
  );
});

function journalRow(
  groupDid: string,
  workspace: string,
  actorDid: string,
  operationId: string,
  request: Record<string, unknown>,
  ageSeconds = 60,
  state = "pending",
) {
  const created = now() - ageSeconds;
  getRawDb()
    .prepare(
      `INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'earlier failure', ?, ?)`,
    )
    .run(
      groupDid,
      workspace,
      actorDid,
      operationId,
      requestDigest({ workspace, request }),
      canonicalJson({ workspace, request }),
      state,
      created,
      created,
    );
  getRawDb()
    .prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)")
    .run(groupDid, workspace);
}

const auditOf = (operationId: string) =>
  (getRawDb().prepare("SELECT event FROM audit_event WHERE operation_id = ?").all(operationId) as Array<{ event: string }>).map(
    (row) => row.event,
  );

test("the operator's recovery discards a creator's row with nothing done whose first step lacks a scope, and restores the approval", async () => {
  const host = await newGroup({
    intercept: (method) => (method === "com.atproto.space.createSpace" ? SCOPE_MISSING() : undefined),
  });
  const { workspace } = spacesOf(host.groupDid);
  journalRow(host.groupDid, workspace, CREATOR, "2727272727272", {
    kind: "createWorkspace",
    name: "Team Mu",
    creator: CREATOR,
  });

  const [result] = await resumePendingWorkspaceCreations(host.session, workspace);

  assert.equal(result?.authorizationRequired, true);
  assert.equal(rowOf("2727272727272"), undefined);
  assert.equal(
    hasCreationAuthorization({ authorityDid: host.groupDid, initiatorDid: CREATOR, name: "Team Mu" }, "2727272727272", now()),
    true,
  );
});

test("an unfinished creation claims its workspace: nobody else creates it meanwhile, and it resumes into its own", async () => {
  let outage = true;
  const host = await newGroup({
    intercept: (method) => (outage && method === "com.atproto.space.createSpace" ? OUTAGE() : undefined),
  });
  approve(host.groupDid, "Dup", CREATOR);
  approve(host.groupDid, "Dup", OTHER);

  const first = await createWorkspace(host.session, { creator: CREATOR, name: "Dup", operationId: "2a2a2a2a2a2a2" });
  outage = false;

  const second = createWorkspace(host.session, { creator: OTHER, name: "Dup", operationId: "2a2a2a2a2a2a3" });

  assert.equal(first.state, "pending");
  assert.deepEqual(first.completedSteps, []);
  await assert.rejects(second, WorkspaceExistsError);
  assert.deepEqual(host.writes, []);
  assert.equal(rowOf("2a2a2a2a2a2a3"), undefined);
  assert.equal((await createWorkspace(host.session, { creator: CREATOR, name: "Dup", operationId: "2a2a2a2a2a2a2" })).state, "completed");
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), ATGRP_COLLECTION.membership, OTHER),
    undefined,
  );
});

test("a first write whose answer was lost is retried within the same attempt, which completes", async () => {
  let lost = false;
  const state: { host?: Awaited<ReturnType<typeof newGroup>> } = {};
  const hostRef = await newGroup({
    intercept: async (method) => {
      if (method !== "com.atproto.space.createSpace" || lost) return undefined;
      lost = true;
      await state.host!.selfClient.procedure("com.atproto.space.createSpace", {
        spaceType: SPACE_TYPE.workspace,
        skey: "self",
        policy: {
          $type: ATGRP_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "member", read: true },
          ],
        },
      });
      return OUTAGE();
    },
  });
  state.host = hostRef;
  approve(hostRef.groupDid, "Team Nu", CREATOR);

  const result = await createWorkspace(hostRef.session, { creator: CREATOR, name: "Team Nu", operationId: "2b2b2b2b2b2b2" });

  assert.equal(result.state, "completed");
  assert.deepEqual(result.completedSteps, [...ACTIVE_R13_STEPS]);
});

test("the operator's recovery skips and audits a row it may not run, and recovers the workspace's other rows", async () => {
  const host = await newGroup();
  const { workspace } = spacesOf(host.groupDid);
  journalRow(host.groupDid, workspace, OTHER, "2c2c2c2c2c2c1", { kind: "bootstrapWorkspace", name: "Team Xi" }, 300);
  journalRow(host.groupDid, workspace, CREATOR, "2c2c2c2c2c2c2", { kind: "createWorkspace", name: "Team Xi", creator: "not-a-did" }, 200);
  journalRow(host.groupDid, workspace, CREATOR, "2c2c2c2c2c2c3", { kind: "createWorkspace", name: "Team Xi", creator: CREATOR }, 100);

  const results = await resumePendingWorkspaceCreations(host.session, workspace);

  assert.deepEqual(results.map((result) => [result.operationId, result.state]), [["2c2c2c2c2c2c3", "completed"]]);
  for (const skipped of ["2c2c2c2c2c2c1", "2c2c2c2c2c2c2"]) {
    assert.equal(rowOf(skipped)?.state, "pending");
    assert.deepEqual(auditOf(skipped), ["operationResumeFailed"]);
  }
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), ATGRP_COLLECTION.membership, OTHER),
    undefined,
  );
});

test("a creation whose runner stopped mid-run still claims its workspace", async () => {
  const host = await newGroup();
  const { workspace } = spacesOf(host.groupDid);
  journalRow(host.groupDid, workspace, OTHER, "2d2d2d2d2d2d2", { kind: "createWorkspace", name: "Team Omicron", creator: OTHER }, 60, "running");
  approve(host.groupDid, "Team Omicron", CREATOR);

  const creation = createWorkspace(host.session, { creator: CREATOR, name: "Team Omicron", operationId: "2d2d2d2d2d2d3" });

  await assert.rejects(creation, WorkspaceExistsError);
  assert.deepEqual(host.writes, []);
});

test("createWorkspace journals joinPolicy and publicMeta: false and preserves both across partial-step replay", async () => {
  let failAtDirectory = true;
  const host = await newGroup({
    creatorDid: CREATOR,
    publicMeta: true, // group starts public; createWorkspace({ publicMeta: false }) must flip meta/self private and delete declaration!
    intercept: (method, target) => {
      if (failAtDirectory && method === "com.atproto.space.putRecord" && target.collection === "new.flock.directory") {
        return OUTAGE();
      }
      return undefined;
    },
  });
  const opId = "2e2e2e2e2e2e2";
  approve(host.groupDid, "Private Team", CREATOR);

  const first = await createWorkspace(host.session, {
    creator: CREATOR,
    name: "Private Team",
    joinPolicy: "approval",
    publicMeta: false,
    operationId: opId,
  });
  assert.equal(first.state, "pending");

  const stored = getRawDb()
    .prepare("SELECT request_json FROM operation WHERE operation_id = ?")
    .get(opId) as { request_json: string } | undefined;
  const parsedRequest = JSON.parse(stored!.request_json) as { request: Record<string, unknown> };
  assert.equal(parsedRequest.request.joinPolicy, "approval");
  assert.equal(parsedRequest.request.publicMeta, false);

  failAtDirectory = false;
  const [resumed] = await resumePendingWorkspaceCreations(host.session, workspaceUri(host.groupDid));
  assert.equal(resumed?.state, "completed");

  const metaPolicy = await host.getSpacePolicy(groupMetaUri(host.groupDid));
  assert.equal(metaPolicy?.publicRead, false, "meta/self policy must be private when publicMeta: false");
  const profile = await host.getRecord<{ displayName: string }>(
    groupMetaUri(host.groupDid),
    ATGRP_COLLECTION.about,
    "self",
  );
  assert.equal(profile?.displayName, "Private Team");
  const config = await host.getRecord<{ joinPolicy: string }>(
    groupMetaUri(host.groupDid),
    ATGRP_COLLECTION.config,
    "self",
  );
  assert.equal(config?.joinPolicy, "approval");

  await assert.rejects(
    host.selfClient.query("com.atproto.repo.getRecord", {
      repo: host.groupDid,
      collection: "org.atgrp.declaration",
      rkey: "self",
    }),
    "public org.atgrp.declaration/self must be absent when publicMeta: false",
  );
});

void createWorkspaceKind;
