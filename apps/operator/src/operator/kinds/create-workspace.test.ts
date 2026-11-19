import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import { canonicalJson, channelUri, inboxUri, requestDigest, subjectKey, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { CreationNotAuthorizedError, grantCreationAuthorization, hasCreationAuthorization } from "../creation-authorization";
import { executeOperatorOperation, resumePendingWorkspaceCreations } from "../operations";
import { fakeAuthorityPds } from "../testing/fake-authority-pds";
import { assertCreationAdmissible, createWorkspace, createWorkspaceKind, WorkspaceExistsError } from "./create-workspace";
import { generalKey, workspaceKey } from "../workspace-spaces";

// R8: a workspace created under a workspace account for someone else, who becomes its first admin, with the account's
// approval of that one workspace; and the same kind for a person creating under their own account.

const AUTHORITY = "did:plc:workspaceaccount";
const CREATOR = "did:plc:creator";
const OTHER = "did:plc:other";
let directory = "";

// The app config caches DATABASE_PATH on first read, so this file shares one database. Each test uses its own names.
before(() => {
  directory = mkdtempSync(join(tmpdir(), "create-workspace-test-"));
  process.env.DATABASE_PATH = join(directory, "create.db");
  process.env.AUTH_ENCRYPTION_KEY = "35".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);
const SCOPE_MISSING = () => Response.json(
  { error: "ScopeMissingError", message: 'Missing required scope "space:new.flock.workspace?authority=did:plc:workspaceaccount&skey=x&action=read_self&manage=create"' },
  { status: 403 },
);
const OUTAGE = () => Response.json({ error: "InternalServerError", message: "outage" }, { status: 500 });
const WRITES = new Set(["com.atproto.space.createSpace", "com.atproto.space.putRecord", "com.atproto.memberspace.putMembers"]);

const rowOf = (operationId: string) => getRawDb().prepare("SELECT actor, workspace, state, steps_json FROM operation WHERE operation_id = ?")
  .get(operationId) as { actor: string; workspace: string; state: string; steps_json: string } | undefined;
const approve = (name: string, initiatorDid = CREATOR) => grantCreationAuthorization({ authorityDid: AUTHORITY, initiatorDid, name }, now());
const spacesOf = (name: string) => {
  const skey = workspaceKey(name);
  return { workspace: workspaceUri(AUTHORITY, skey), inbox: inboxUri(AUTHORITY, skey), general: channelUri(AUTHORITY, generalKey(skey)) };
};

test("someone other than the workspace account cannot create a workspace under it without its approval, and nothing is written", async () => {
  // given a workspace account whose grant the operator holds, and no approval for this creator
  const pds = fakeAuthorityPds(AUTHORITY);

  // when the creator tries to create a workspace under it
  const attempt = createWorkspace(pds.session, { creator: CREATOR, name: "Unapproved", operationId: "2222222222222" });

  // then it is refused before any journal row or PDS write
  await assert.rejects(attempt, CreationNotAuthorizedError);
  assert.equal(rowOf("2222222222222"), undefined);
  assert.deepEqual(pds.writes, []);
});

test("with the account's approval, the workspace is created for its creator: the members, roster and admin are the creator's", async () => {
  // given the workspace account approved this creator's workspace
  const pds = fakeAuthorityPds(AUTHORITY);
  approve("Team Alpha");

  // when the creator creates it
  const result = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Alpha", operationId: "2222222222223" });

  // then every step ran once, the journal row is the creator's under the account, and the creator is a member and admin
  const { workspace, inbox, general } = spacesOf("Team Alpha");
  assert.equal(result.state, "completed");
  assert.equal(result.workspace, workspace);
  assert.deepEqual(result.completedSteps, [...createWorkspaceKind.steps]);
  assert.deepEqual({ ...rowOf("2222222222223"), steps_json: undefined }, { actor: CREATOR, workspace: AUTHORITY, state: "completed", steps_json: undefined });
  for (const space of [workspace, inbox, general]) assert.deepEqual(pds.membersOf(space).get(CREATOR), { did: CREATOR, read: true, write: true }, space);
  assert.equal(pds.recordsOf(workspace, COLLECTION.workspaceRoster).get(subjectKey(CREATOR))?.active, true);
  assert.equal(pds.recordsOf(workspace, COLLECTION.admin).get(subjectKey(CREATOR))?.active, true);
  // and the account itself is neither on the roster nor an admin
  assert.equal(pds.recordsOf(workspace, COLLECTION.workspaceRoster).has(subjectKey(AUTHORITY)), false);
  assert.equal(pds.recordsOf(workspace, COLLECTION.admin).has(subjectKey(AUTHORITY)), false);
});

test("an approval is for one name, one creator and one creation; a retry of that creation resumes without it", async () => {
  // given an approval for "Team Beta", and its creation stopped by an outage after its first step
  let failing = false;
  const pds = fakeAuthorityPds(AUTHORITY, { intercept: (method) => failing && method === "com.atproto.space.createSpace" ? OUTAGE() : undefined });
  approve("Team Beta");
  await assert.rejects(createWorkspace(pds.session, { creator: CREATOR, name: "Team Gamma", operationId: "3333333333333" }), CreationNotAuthorizedError,
    "an approval for one name creates no other");
  await assert.rejects(createWorkspace(pds.session, { creator: OTHER, name: "Team Beta", operationId: "3333333333334" }), CreationNotAuthorizedError,
    "nor does it let anyone else create");
  failing = true;
  const first = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Beta", operationId: "3333333333335" });
  assert.equal(first.state, "pending");

  // when another creation of the same workspace is tried, it is refused: the approval was used
  await assert.rejects(createWorkspace(pds.session, { creator: CREATOR, name: "Team Beta", operationId: "3333333333336" }), CreationNotAuthorizedError);

  // and when the first is retried, it finds its row and completes
  failing = false;
  const retry = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Beta", operationId: "3333333333335" });
  assert.equal(retry.state, "completed");
});

test("a creation refused at its first step for a missing scope leaves no row and gives the approval back for that operation only", async () => {
  // given an approval, and a grant that lacks the scope for creating spaces
  let scopeMissing = true;
  const pds = fakeAuthorityPds(AUTHORITY, { intercept: (method) => scopeMissing && method === "com.atproto.space.createSpace" ? SCOPE_MISSING() : undefined });
  approve("Team Delta");

  // when the creation runs
  const refused = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Delta", operationId: "4444444444444" });

  // then it asks for reauthorization and leaves no row, no catalog entry, and the discard in the audit trail
  assert.equal(refused.authorizationRequired, true);
  assert.equal(rowOf("4444444444444"), undefined);
  assert.equal(getRawDb().prepare("SELECT 1 FROM operation_workspace_catalog WHERE workspace_uri = ?").get(refused.workspace), undefined);
  assert.deepEqual((getRawDb().prepare("SELECT event FROM audit_event WHERE operation_id = ?").all("4444444444444") as Array<{ event: string }>).map((row) => row.event), ["operationDiscarded"]);

  // and the approval it gave back serves neither another operation nor another person
  await assert.rejects(createWorkspace(pds.session, { creator: CREATOR, name: "Team Delta", operationId: "4444444444445" }), CreationNotAuthorizedError);
  await assert.rejects(createWorkspace(pds.session, { creator: OTHER, name: "Team Delta", operationId: "4444444444444" }), CreationNotAuthorizedError);

  // when the account reauthorizes and the creator retries the same operation, the workspace is created with no second approval
  scopeMissing = false;
  const retried = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Delta", operationId: "4444444444444" });
  assert.equal(retried.state, "completed");
});

test("a missing scope after some steps keeps the row, keeps asking for reauthorization, and survives a retry", async () => {
  // given an approval, and a grant that can create the workspace space but not the inbox (a partial grant)
  const pds = fakeAuthorityPds(AUTHORITY, {
    intercept: (method) => method === "com.atproto.space.createSpace" && pds.writes.length > 0 ? SCOPE_MISSING() : undefined,
  });
  approve("Team Theta");

  // when the creation runs, then is retried
  const first = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Theta", operationId: "4545454545454" });
  const retry = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Theta", operationId: "4545454545454" });

  // then its progress is kept, both attempts ask for reauthorization, and the row stays pending for recovery
  assert.deepEqual(first.completedSteps, ["workspace-space"]);
  assert.equal(first.authorizationRequired, true);
  assert.deepEqual(retry.completedSteps, ["workspace-space"]);
  assert.equal(retry.authorizationRequired, true);
  assert.equal(rowOf("4545454545454")?.state, "pending");
});

test("a creation stopped at any step resumes for its creator, repeating no write", async () => {
  for (const [index, step] of createWorkspaceKind.steps.entries()) {
    // given an approval, and an outage from the write of this step on (it lasts past the journal's own retries)
    let succeeded = 0;
    let outage = true;
    const pds = fakeAuthorityPds(AUTHORITY, {
      intercept: (method) => {
        if (!WRITES.has(method)) return undefined;
        if (outage && succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      },
    });
    const name = `Resume ${index}`;
    const operationId = `5555555555a${"abcdefghijklmnop"[index]}a`;
    approve(name);

    // when it stops there, and its creator retries it once the outage is over
    const stopped = await createWorkspace(pds.session, { creator: CREATOR, name, operationId });
    outage = false;
    const resumed = await createWorkspace(pds.session, { creator: CREATOR, name, operationId });

    // then it was pending at that step, and completes with every write done once
    assert.equal(stopped.state, "pending", step);
    assert.deepEqual(stopped.completedSteps, createWorkspaceKind.steps.slice(0, index), step);
    assert.equal(resumed.state, "completed", step);
    assert.equal(new Set(pds.writes).size, pds.writes.length, `${step}: no write repeated`);
    assert.equal(pds.writes.length, createWorkspaceKind.steps.length, step);
  }
});

test("a workspace account creating under itself needs only its grant, and is not added to the lists it owns", async () => {
  // given no approval at all
  const pds = fakeAuthorityPds(AUTHORITY);

  // when the account creates a workspace for itself
  const result = await createWorkspace(pds.session, { creator: AUTHORITY, name: "Own Team", operationId: "6666666666666" });

  // then it completes, writing no member-list entry, with the account's roster and admin records
  const { workspace } = spacesOf("Own Team");
  assert.equal(result.state, "completed");
  assert.deepEqual(result.completedSteps, createWorkspaceKind.steps.filter((step) => !["creator-workspace", "creator-inbox", "creator-general"].includes(step)));
  assert.equal(pds.writes.some((write) => write.startsWith("putMembers")), false);
  assert.equal(pds.recordsOf(workspace, COLLECTION.admin).get(subjectKey(AUTHORITY))?.active, true);
});

/** A pending creation by CREATOR with `steps` done, in a workspace whose roster already holds CREATOR and OTHER as admins. */
function pendingCreation(name: string, operationId: string, steps: readonly string[]) {
  const { workspace } = spacesOf(name);
  const pds = fakeAuthorityPds(AUTHORITY);
  const updatedAt = "2026-11-01T00:00:00.000Z";
  for (const did of [CREATOR, OTHER]) {
    pds.recordsOf(workspace, COLLECTION.workspaceRoster).set(subjectKey(did), { $type: COLLECTION.workspaceRoster, subject: did, active: true, updatedAt });
    pds.recordsOf(workspace, COLLECTION.admin).set(subjectKey(did), { $type: COLLECTION.admin, subject: did, active: true, updatedAt });
    pds.membersOf(workspace).set(did, { did, read: true, write: true });
  }
  const request = { kind: "createWorkspace", name, creator: CREATOR };
  const created = Math.floor(Date.now() / 1000) - 60;
  getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'earlier failure', ?, ?)`)
    .run(AUTHORITY, workspace, CREATOR, operationId, requestDigest({ workspace, request }), canonicalJson({ workspace, request }), JSON.stringify(steps), created, created);
  getRawDb().prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)").run(AUTHORITY, workspace);
  const other = { did: OTHER, session: pds.session, workspace: { uri: workspace, authorityDid: AUTHORITY, skey: workspaceKey(name) }, canRecoverOperations: true };
  return { pds, other };
}

const BEFORE_ADMIN = createWorkspaceKind.steps.slice(0, createWorkspaceKind.steps.indexOf("creator-admin"));
const AFTER_ADMIN = createWorkspaceKind.steps.slice(0, createWorkspaceKind.steps.indexOf("creator-admin") + 1);
const NEXT_OPERATION = { kind: "createChannel", skey: "notes", name: "notes", visibility: "public" };

test("before a creation has made its creator an admin, another admin's operation cannot resume it and does not run", async () => {
  // given a creation stopped before writing its creator's admin record
  const { other } = pendingCreation("Team Epsilon", "7777777777777", BEFORE_ADMIN);

  // when another admin runs an operation in the workspace
  const attempt = executeOperatorOperation(other, "7777777777778", NEXT_OPERATION);

  // then nothing runs, and the creation is left as it was, still its creator's
  await assert.rejects(attempt, /could not be resumed/);
  assert.deepEqual({ ...rowOf("7777777777777"), steps_json: JSON.parse(rowOf("7777777777777")!.steps_json) },
    { actor: CREATOR, workspace: AUTHORITY, state: "pending", steps_json: BEFORE_ADMIN });
  assert.equal(rowOf("7777777777778"), undefined);
});

test("once a creation has made its creator an admin, another admin recovers it, and it stays the creator's", async () => {
  // given a creation stopped after writing its creator's admin record
  const { other } = pendingCreation("Team Zeta", "8888888888888", AFTER_ADMIN);

  // when another admin runs an operation in the workspace
  const view = await executeOperatorOperation(other, "8888888888889", NEXT_OPERATION);

  // then the creation completes first, with the creator still its principal, and the admin's operation runs
  assert.equal(rowOf("8888888888888")?.state, "completed");
  assert.equal(rowOf("8888888888888")?.actor, CREATOR);
  assert.equal(view.state, "completed");
});

test("the replayed kind refuses a request whose creator is not the row's actor", async () => {
  const { pds } = pendingCreation("Team Eta", "9999999999999", []);
  const view = await createWorkspaceKind.run(
    { did: OTHER, session: pds.session, workspace: { uri: spacesOf("Team Eta").workspace, authorityDid: AUTHORITY, skey: workspaceKey("Team Eta") }, canRecoverOperations: true },
    { operationId: "9999999999999", completedSteps: [], step: async (_name, action) => { await action(); } },
    { kind: "createWorkspace", name: "Team Eta", creator: CREATOR },
  ).then(() => "ran", (error: unknown) => error instanceof Error ? error.message : String(error));
  assert.match(view, /runs as its creator/);
});

test("an approval is for a new workspace: one that exists already is not created again for someone else", async () => {
  // given the account's own workspace "Existing", and an approval of that name for another person
  const pds = fakeAuthorityPds(AUTHORITY);
  assert.equal((await createWorkspace(pds.session, { creator: AUTHORITY, name: "Existing", operationId: "2323232323232" })).state, "completed");
  approve("Existing");
  const before = pds.writes.length;

  // when that person "creates" it
  const creation = createWorkspace(pds.session, { creator: CREATOR, name: "Existing", operationId: "2323232323233" });

  // then it is refused before anything is written or journaled: they are not added, and not made an admin
  await assert.rejects(creation, WorkspaceExistsError);
  assert.equal(pds.writes.length, before, "nothing is written");
  assert.equal(rowOf("2323232323233"), undefined);
  assert.equal(hasCreationAuthorization({ authorityDid: AUTHORITY, initiatorDid: CREATOR, name: "Existing" }, "2323232323233", now()), true, "the approval is not used");
  const { workspace } = spacesOf("Existing");
  assert.equal(pds.recordsOf(workspace, COLLECTION.admin).has(subjectKey(CREATOR)), false);
  assert.equal(pds.membersOf(workspace).has(CREATOR), false);
});

test("a retry of a creation whose first step's answer was lost resumes, though its space now exists", async () => {
  // given a creation row with nothing recorded, whose workspace space the host did create
  const { pds } = pendingCreation("Team Iota", "2424242424242", []);

  // when its creator retries it
  const result = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Iota", operationId: "2424242424242" });

  // then it resumes and completes: only a fresh creation is refused for an existing space
  assert.equal(result.state, "completed");
});

test("a creation with no approval is refused before the account's grant is used, unless it retries a creation that had one", () => {
  const input = { authorityDid: AUTHORITY, creator: CREATOR, name: "Team Kappa", operationId: "2525252525252" };
  assert.throws(() => assertCreationAdmissible(input), CreationNotAuthorizedError);
  assert.doesNotThrow(() => assertCreationAdmissible({ ...input, creator: AUTHORITY }), "the account itself needs only its grant");
  approve("Team Kappa");
  assert.doesNotThrow(() => assertCreationAdmissible({ ...input, name: "  Team Kappa " }), "an approval of the trimmed name");
  pendingCreation("Team Lambda", "2626262626262", []);
  assert.doesNotThrow(() => assertCreationAdmissible({ ...input, name: "Team Lambda", operationId: "2626262626262" }), "a retry of a journaled creation");
});

test("the operator's recovery discards a creator's row with nothing done whose first step lacks a scope, and restores the approval", async () => {
  // given a creator's pending creation with nothing recorded, and a grant that lacks the scope for its first step
  const { workspace } = spacesOf("Team Mu");
  journalRow(workspace, CREATOR, "2727272727272", { kind: "createWorkspace", name: "Team Mu", creator: CREATOR });
  const pds = fakeAuthorityPds(AUTHORITY, { intercept: (method) => method === "com.atproto.space.createSpace" ? SCOPE_MISSING() : undefined });

  // when the reconcile job recovers the workspace's creations
  const [result] = await resumePendingWorkspaceCreations(pds.session, workspace);

  // then the row is gone, as on the creator's own attempt, and the creator may retry that operation without a new approval
  assert.equal(result?.authorizationRequired, true);
  assert.equal(rowOf("2727272727272"), undefined);
  assert.equal(hasCreationAuthorization({ authorityDid: AUTHORITY, initiatorDid: CREATOR, name: "Team Mu" }, "2727272727272", now()), true);
});

function journalRow(workspace: string, actorDid: string, operationId: string, request: Record<string, unknown>, ageSeconds = 60, state = "pending") {
  const created = now() - ageSeconds;
  getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'earlier failure', ?, ?)`)
    .run(AUTHORITY, workspace, actorDid, operationId, requestDigest({ workspace, request }), canonicalJson({ workspace, request }), state, created, created);
  getRawDb().prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)").run(AUTHORITY, workspace);
}

const auditOf = (operationId: string) => (getRawDb().prepare("SELECT event FROM audit_event WHERE operation_id = ?").all(operationId) as Array<{ event: string }>)
  .map((row) => row.event);

test("an unfinished creation claims its workspace: nobody else creates it meanwhile, and it resumes into its own", async () => {
  // given two approvals of one name, and the first creation stopped by an outage before its first write
  approve("Dup");
  approve("Dup", OTHER);
  let outage = true;
  const pds = fakeAuthorityPds(AUTHORITY, { intercept: (method) => outage && method === "com.atproto.space.createSpace" ? OUTAGE() : undefined });
  const first = await createWorkspace(pds.session, { creator: CREATOR, name: "Dup", operationId: "2a2a2a2a2a2a2" });
  outage = false;

  // when the second person, and the account itself, create it before the first is resumed
  const second = createWorkspace(pds.session, { creator: OTHER, name: "Dup", operationId: "2a2a2a2a2a2a3" });
  const own = createWorkspace(pds.session, { creator: AUTHORITY, name: "Dup", operationId: "2a2a2a2a2a2a4" });

  // then both are refused with nothing written or journaled, and the first resumes into a workspace it alone made
  assert.equal(first.state, "pending");
  assert.deepEqual(first.completedSteps, []);
  await assert.rejects(second, WorkspaceExistsError);
  await assert.rejects(own, WorkspaceExistsError);
  assert.deepEqual(pds.writes, []);
  assert.equal(rowOf("2a2a2a2a2a2a3"), undefined);
  assert.equal(rowOf("2a2a2a2a2a2a4"), undefined);
  assert.equal((await createWorkspace(pds.session, { creator: CREATOR, name: "Dup", operationId: "2a2a2a2a2a2a2" })).state, "completed");
  const { workspace } = spacesOf("Dup");
  assert.equal(pds.recordsOf(workspace, COLLECTION.admin).has(subjectKey(OTHER)), false);
  assert.equal(pds.membersOf(workspace).has(OTHER), false);
});

test("a first write whose answer was lost is retried within the same attempt, which completes", async () => {
  // given a host that makes the workspace space and then loses its answer, once
  const { workspace } = spacesOf("Team Nu");
  approve("Team Nu");
  let lost = false;
  const pds = fakeAuthorityPds(AUTHORITY, {
    intercept: (method) => {
      if (method !== "com.atproto.space.createSpace" || lost) return undefined;
      lost = true;
      pds.membersOf(workspace);
      return OUTAGE();
    },
  });

  // when its creator creates the workspace
  const result = await createWorkspace(pds.session, { creator: CREATOR, name: "Team Nu", operationId: "2b2b2b2b2b2b2" });

  // then the journal's retry finds the space made, as the creation's own, and completes
  assert.equal(result.state, "completed");
  assert.deepEqual(result.completedSteps, createWorkspaceKind.steps);
});

test("the operator's recovery skips and audits a row it may not run, and recovers the workspace's other rows", async () => {
  // given, in one workspace, a legacy setup row of someone other than the account, a row whose request is invalid, and a
  // creator's pending creation, oldest first
  const { workspace } = spacesOf("Team Xi");
  journalRow(workspace, OTHER, "2c2c2c2c2c2c1", { kind: "bootstrapWorkspace", name: "Team Xi" }, 300);
  journalRow(workspace, CREATOR, "2c2c2c2c2c2c2", { kind: "createWorkspace", name: "Team Xi", creator: "not-a-did" }, 200);
  journalRow(workspace, CREATOR, "2c2c2c2c2c2c3", { kind: "createWorkspace", name: "Team Xi", creator: CREATOR }, 100);
  const pds = fakeAuthorityPds(AUTHORITY);

  // when the reconcile job recovers the workspace's creations
  const results = await resumePendingWorkspaceCreations(pds.session, workspace);

  // then only the creator's creation ran, and the two others stay pending with the reason in the audit trail
  assert.deepEqual(results.map((result) => [result.operationId, result.state]), [["2c2c2c2c2c2c3", "completed"]]);
  for (const skipped of ["2c2c2c2c2c2c1", "2c2c2c2c2c2c2"]) {
    assert.equal(rowOf(skipped)?.state, "pending");
    assert.deepEqual(auditOf(skipped), ["operationResumeFailed"]);
  }
  assert.equal(pds.membersOf(workspace).has(OTHER), false);
});

test("a creation whose runner stopped mid-run still claims its workspace", async () => {
  // given another creator's creation left running, with nothing done, by a runner that crashed
  const { workspace } = spacesOf("Team Omicron");
  journalRow(workspace, OTHER, "2d2d2d2d2d2d2", { kind: "createWorkspace", name: "Team Omicron", creator: OTHER }, 60, "running");
  approve("Team Omicron");
  const pds = fakeAuthorityPds(AUTHORITY);

  // when someone else creates it
  const creation = createWorkspace(pds.session, { creator: CREATOR, name: "Team Omicron", operationId: "2d2d2d2d2d2d3" });

  // then it is refused, with nothing written
  await assert.rejects(creation, WorkspaceExistsError);
  assert.deepEqual(pds.writes, []);
});

test("the workspace account does not create again a workspace someone else created under it", async () => {
  // given a creator's completed workspace under the account
  approve("Team Pi");
  const pds = fakeAuthorityPds(AUTHORITY);
  assert.equal((await createWorkspace(pds.session, { creator: CREATOR, name: "Team Pi", operationId: "2e2e2e2e2e2e2" })).state, "completed");
  const before = pds.writes.length;

  // when the account creates that name itself
  const creation = createWorkspace(pds.session, { creator: AUTHORITY, name: "Team Pi", operationId: "2e2e2e2e2e2e3" });

  // then it is refused: the account stays neither admin nor member, and the creator's records are untouched
  await assert.rejects(creation, WorkspaceExistsError);
  assert.equal(pds.writes.length, before);
  assert.equal(pds.recordsOf(spacesOf("Team Pi").workspace, COLLECTION.admin).has(subjectKey(AUTHORITY)), false);
});
