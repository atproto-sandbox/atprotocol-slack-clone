import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { canonicalJson, channelUri, requestDigest, stableHash, subjectKey, workspaceUri } from "@/protocol/keys";
import { COLLECTION } from "@/protocol/nsids";
import type { OperatorActor } from "../actor";
import { AuthorityReauthorizationRequiredError } from "../authority-grant";
import { executeOperatorOperation } from "../operations";
import { fakeAuthorityPds, type FakeAuthorityPdsOptions } from "../testing/fake-authority-pds";
import { resumePendingWorkspaceBootstraps } from "./bootstrap-workspace";

// Journal rows exactly as the code before the kind table wrote them: the request JSON, its hash, the actor and the step
// names. Each must resume under the same hash, actor and workspace lock, and repeat none of its completed steps.

const OWNER = "did:plc:owner";
const ADMIN = "did:plc:admin";
let directory = "";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-journal-replay-test-"));
  process.env.DATABASE_PATH = join(directory, "replay.db");
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

/** The authority's PDS, noting which workspace lock is held at each write. */
function authorityPds(did: string, intercept?: FakeAuthorityPdsOptions["intercept"]) {
  const locksHeld: string[] = [];
  const pds = fakeAuthorityPds(did, {
    intercept,
    onWrite: () => locksHeld.push(...(getRawDb().prepare("SELECT workspace FROM workspace_lock").all() as Array<{ workspace: string }>).map((row) => row.workspace)),
  });
  return { ...pds, locksHeld };
}

/** Writes a pending journal row the way the code before the kind table did. */
function writePreKindTableRow(row: { workspace: string; actor: string; operationId: string; requestHash: string; request: Record<string, unknown>; steps: string[] }): void {
  const raw = getRawDb();
  const now = Math.floor(Date.now() / 1000) - 60;
  const authority = row.workspace.split("/")[2]!;
  raw.prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'earlier failure', ?, ?)`)
    .run(authority, row.workspace, row.actor, row.operationId, row.requestHash, canonicalJson({ workspace: row.workspace, request: row.request }), JSON.stringify(row.steps), now, now);
  raw.prepare("INSERT OR IGNORE INTO operation_workspace_catalog (workspace, workspace_uri) VALUES (?, ?)").run(authority, row.workspace);
}

const journalRow = (operationId: string) => getRawDb().prepare("SELECT actor, request_hash, state, steps_json FROM operation WHERE operation_id = ?")
  .get(operationId) as { actor: string; request_hash: string; state: string; steps_json: string };

const BOOTSTRAP_STEPS = ["workspace-space", "inbox-space", "general-channel-space", "workspace-profile", "owner-roster", "owner-admin", "general-directory"];

// The workspace the code before the kind table derived from the name "Acme", and the hash it stored for that bootstrap.
const ACME = "at://did:plc:owner/space/org.slack.workspace/acme-g4bwzwhzor";
const ACME_BOOTSTRAP_HASH = "3f4494a9a74bce3eecdca090703b11fe39a177308acd99494a0e44bdaf81f8d3";

test("a pre-table bootstrap row with no step done resumes under its hash and runs every step once", async () => {
  // #given a bootstrap that recorded its intent and nothing else
  writePreKindTableRow({ workspace: ACME, actor: OWNER, operationId: "2222222222222", requestHash: ACME_BOOTSTRAP_HASH, request: { kind: "bootstrapWorkspace", name: "Acme" }, steps: [] });
  const pds = authorityPds(OWNER);

  // #when the authority's pending bootstraps are resumed
  const [result] = await resumePendingWorkspaceBootstraps(pds.session, ACME);

  // #then the same row completes every step, in order, each written once, under the authority's workspace lock
  assert.equal(result?.state, "completed");
  assert.deepEqual(JSON.parse(journalRow("2222222222222").steps_json), BOOTSTRAP_STEPS);
  assert.deepEqual({ ...journalRow("2222222222222"), steps_json: undefined }, { actor: OWNER, request_hash: ACME_BOOTSTRAP_HASH, state: "completed", steps_json: undefined });
  assert.equal(pds.writes.length, BOOTSTRAP_STEPS.length);
  assert.equal(new Set(pds.writes).size, pds.writes.length, "no write is repeated");
  assert.deepEqual([...new Set(pds.locksHeld)], [OWNER]);
});

test("a pre-table bootstrap row half done resumes after its last completed step", async () => {
  // #given a bootstrap that created its three spaces before failing
  const name = "Beta";
  const workspace = workspaceUri(OWNER, `beta-${stableHash(name).slice(0, 10)}`);
  const request = { kind: "bootstrapWorkspace", name };
  const requestHash = requestDigest({ workspace, request });
  writePreKindTableRow({ workspace, actor: OWNER, operationId: "3333333333333", requestHash, request, steps: BOOTSTRAP_STEPS.slice(0, 3) });
  const pds = authorityPds(OWNER);

  // #when it is resumed
  const [result] = await resumePendingWorkspaceBootstraps(pds.session, workspace);

  // #then no space is created again, and only the four record writes run
  assert.equal(result?.state, "completed");
  assert.deepEqual(JSON.parse(journalRow("3333333333333").steps_json), BOOTSTRAP_STEPS);
  assert.equal(journalRow("3333333333333").request_hash, requestHash);
  assert.deepEqual(pds.writes.map((write) => write.split(" ")[0]), ["putRecord", "putRecord", "putRecord", "putRecord"]);
});

/** A workspace whose roster holds the authority and one admin, with the admin a member of the workspace space. */
function seededWorkspace(skey: string, intercept?: FakeAuthorityPdsOptions["intercept"]) {
  const workspace = workspaceUri(OWNER, skey);
  const pds = authorityPds(OWNER, intercept);
  const updatedAt = "2026-11-01T00:00:00.000Z";
  for (const did of [OWNER, ADMIN]) {
    pds.recordsOf(workspace, COLLECTION.workspaceRoster).set(subjectKey(did), { $type: COLLECTION.workspaceRoster, subject: did, active: true, updatedAt });
    pds.recordsOf(workspace, COLLECTION.admin).set(subjectKey(did), { $type: COLLECTION.admin, subject: did, active: true, updatedAt });
  }
  pds.membersOf(workspace).set(ADMIN, { did: ADMIN, read: true, write: true });
  const owner: OperatorActor = { did: OWNER, session: pds.session, workspace: { uri: workspace, authorityDid: OWNER, skey }, canRecoverOperations: true };
  return { workspace, pds, owner };
}

const PRIVATE_CHANNEL_STEPS = ["channel-space", `channel-member-${ADMIN}`, `channel-roster-${ADMIN}`, "channel-directory", "channel-membership-verified"];

for (const scenario of [
  { label: "with no step done", skey: "gamma", operationId: "4444444444444", nextOperationId: "6666666666666", done: [] as string[] },
  { label: "half done", skey: "delta", operationId: "5555555555555", nextOperationId: "7777777777777", done: PRIVATE_CHANNEL_STEPS.slice(0, 2) },
]) {
  test(`a pre-table createChannel row ${scenario.label} is recovered for its admin by the next operation, repeating no step`, async () => {
    // #given an admin's private-channel creation, journaled before the kind table, and the PDS state its completed steps left
    const { workspace, pds, owner } = seededWorkspace(scenario.skey);
    const request = { kind: "createChannel", skey: "design", name: "design", visibility: "private", members: [ADMIN] };
      const requestHash = requestDigest({ workspace, request });
    const channel = channelUri(OWNER, `${scenario.skey}-design`);
    if (scenario.done.includes(`channel-member-${ADMIN}`)) pds.membersOf(channel).set(ADMIN, { did: ADMIN, read: true, write: true });
    writePreKindTableRow({ workspace, actor: ADMIN, operationId: scenario.operationId, requestHash, request, steps: scenario.done });

    // #when the authority runs a new operation in that workspace
    const next = await executeOperatorOperation(owner, scenario.nextOperationId, { kind: "createChannel", skey: "random", name: "random", visibility: "public" });

    // #then the admin's row completes under its own actor and hash, and none of its completed steps is written again
    assert.equal(next.state, "completed");
    assert.deepEqual(journalRow(scenario.operationId), { actor: ADMIN, request_hash: requestHash, state: "completed", steps_json: JSON.stringify(PRIVATE_CHANNEL_STEPS) });
    const designWrites = pds.writes.filter((write) => write.includes(channel) || write.endsWith(`/${scenario.skey}-design`));
    const expected = [
      ...(scenario.done.includes("channel-space") ? [] : [`createSpace ${channel}`]),
      ...(scenario.done.includes(`channel-member-${ADMIN}`) ? [] : [`putMember ${channel} ${ADMIN}`]),
      `putRecord ${channel} ${COLLECTION.channelRoster}/${subjectKey(ADMIN)}`,
      `putRecord ${workspace} ${COLLECTION.directory}/${scenario.skey}-design`,
    ];
    assert.deepEqual(designWrites, expected);
    assert.deepEqual([...new Set(pds.locksHeld)], [OWNER]);
  });
}

test("recovery that meets a missing scope keeps the other admin's row pending and asks the authority to approve", async () => {
  // #given an admin's channel creation pending with no step done, and a grant that cannot create channel spaces
  const scopeMissing = (method: string) => method === "com.atproto.space.createSpace"
    ? Response.json({ error: "ScopeMissingError", message: 'Missing required scope "space:org.slack.channel"' }, { status: 403 })
    : undefined;
  const { workspace, owner } = seededWorkspace("epsilon", scopeMissing);
  const request = { kind: "createChannel", skey: "design", name: "design", visibility: "private", members: [ADMIN] };
  writePreKindTableRow({ workspace, actor: ADMIN, operationId: "222222222222c", requestHash: requestDigest({ workspace, request }), request, steps: [] });

  // #when the authority runs a new operation, which first recovers that row
  const next = executeOperatorOperation(owner, "222222222222d", { kind: "reconcileWorkspace" });

  // #then the new operation is refused until the authority approves, and the admin's row is still there, pending
  await assert.rejects(next, AuthorityReauthorizationRequiredError);
  assert.deepEqual({ ...journalRow("222222222222c"), request_hash: undefined }, { actor: ADMIN, request_hash: undefined, state: "pending", steps_json: "[]" });
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM operation WHERE operation_id = ?").get("222222222222d") as { count: number }).count, 0, "the new operation was not started");
});
