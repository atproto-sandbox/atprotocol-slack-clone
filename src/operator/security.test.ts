import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb } from "@/lib/db";
import { channelUri, inboxUri, subjectKey, workspaceUri } from "@/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";
import type { WorkspaceRef } from "./actor";
import { OperatorAuthError } from "./errors";
import { runJournaledOperation } from "./journal";
import { executeOperatorOperation } from "./operations";
import { authorizeOperationActor, authorizeSubmittedOperation } from "./security";
import { fakeAuthorityPds, type FakeAuthorityPdsOptions } from "./testing/fake-authority-pds";

let directory = "";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "flock-operator-security-test-"));
  process.env.DATABASE_PATH = join(directory, "security.db");
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const OWNER = "did:plc:owner";
const ADMIN = "did:plc:admin";
const MEMBER = "did:plc:member";
const OUTSIDER = "did:plc:outsider";
const WORKSPACE: WorkspaceRef = { uri: workspaceUri(OWNER, "acme"), authorityDid: OWNER, skey: "acme" };
const INBOX = inboxUri(OWNER, "acme");
const PRIVATE_SKEY = "acme-design";
const PUBLIC_SKEY = "acme-general";
const UPDATED_AT = "2026-11-01T12:00:00.000Z";

/** A workspace with its authority, an admin and a member, one private channel the member belongs to and one public channel. */
function workspacePds(options?: FakeAuthorityPdsOptions) {
  const pds = fakeAuthorityPds(OWNER, options);
  const record = (collection: string, did: string) => pds.recordsOf(WORKSPACE.uri, collection).set(subjectKey(did), { $type: collection, subject: did, active: true, updatedAt: UPDATED_AT });
  for (const did of [OWNER, ADMIN, MEMBER]) record(COLLECTION.workspaceRoster, did);
  for (const did of [OWNER, ADMIN]) record(COLLECTION.admin, did);
  pds.membersOf(WORKSPACE.uri).set(ADMIN, { did: ADMIN, read: true, write: true }).set(MEMBER, { did: MEMBER, read: true, write: true });
  pds.membersOf(INBOX).set(ADMIN, { did: ADMIN, read: true, write: true }).set(MEMBER, { did: MEMBER, read: false, write: true });
  for (const [skey, visibility] of [[PRIVATE_SKEY, "private"], [PUBLIC_SKEY, "public"]]) {
    pds.recordsOf(WORKSPACE.uri, COLLECTION.directory).set(skey, { $type: COLLECTION.directory, skey, name: skey, visibility });
  }
  pds.membersOf(channelUri(OWNER, PRIVATE_SKEY)).set(MEMBER, { did: MEMBER, read: true, write: true });
  return pds;
}

const refusal = (pattern: RegExp) => (error: unknown) => error instanceof OperatorAuthError && pattern.test(error.message);

test("an active admin may run an admin kind, and recovers pending operations", async () => {
  const pds = workspacePds();
  const actor = await authorizeOperationActor(pds.session, WORKSPACE, ADMIN, { kind: "inviteMember", subject: OUTSIDER });
  assert.deepEqual({ did: actor.did, canRecoverOperations: actor.canRecoverOperations }, { did: ADMIN, canRecoverOperations: true });
});

test("a member may not run an admin kind", async () => {
  const pds = workspacePds();
  for (const request of [{ kind: "inviteMember", subject: OUTSIDER }, { kind: "reconcileWorkspace" }, { kind: "setAdmin", subject: MEMBER, active: true }]) {
    await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, request), refusal(/admin permission is required/), request.kind);
  }
});

test("a member may leave the workspace, and a private channel they belong to, but never recovers others' operations", async () => {
  const pds = workspacePds();
  const leaving = await authorizeOperationActor(pds.session, WORKSPACE, MEMBER, { kind: "leaveWorkspace" });
  assert.deepEqual({ did: leaving.did, canRecoverOperations: leaving.canRecoverOperations }, { did: MEMBER, canRecoverOperations: false });
  const leavingChannel = await authorizeOperationActor(pds.session, WORKSPACE, MEMBER, { kind: "leaveChannel", skey: PRIVATE_SKEY });
  assert.equal(leavingChannel.canRecoverOperations, false);
});

test("a member may not leave a public channel, or a private channel they are not in", async () => {
  const pds = workspacePds();
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, { kind: "leaveChannel", skey: PUBLIC_SKEY }), refusal(/Only an active private channel/));
  pds.membersOf(channelUri(OWNER, PRIVATE_SKEY)).clear();
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, { kind: "leaveChannel", skey: PRIVATE_SKEY }), refusal(/not a member of this channel/));
});

test("a member's request is validated before the kind's own check reads anything", async () => {
  // #given a leave request with a channel key that is not a key
  const pds = workspacePds();

  // #when the member submits it
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, { kind: "leaveChannel", skey: "../../etc" }), /Invalid channel key/);

  // #then no directory record or channel member list was read for it
  assert.deepEqual(pds.calls.filter((call) => call.includes(COLLECTION.directory) || call.includes(`/space/${SPACE_TYPE.channel}/`)), []);
});

test("someone outside the workspace may run nothing, not even a member kind", async () => {
  const pds = workspacePds();
  for (const request of [{ kind: "leaveWorkspace" }, { kind: "inviteMember", subject: OUTSIDER }]) {
    await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, OUTSIDER, request), refusal(/admin permission is required/), request.kind);
  }
});

test("a kind only the authority may start is refused to an admin before anything is read", async () => {
  const pds = workspacePds();
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, ADMIN, { kind: "bootstrapWorkspace", name: "Acme" }), refusal(/Only the workspace authority/));
  assert.deepEqual(pds.calls, []);
});

test("a member whose leave stopped after removing their own access may send it again, and only it", async () => {
  // #given a leave that removed the member from the inbox and was then refused by the PDS
  const LEAVE_ID = "3mabchjk3xyz2";
  const leave = { kind: "leaveWorkspace" };
  let removals = 0;
  const pds = workspacePds({
    intercept: (method) => method === "com.atproto.memberspace.removeMember" && ++removals === 2
      ? Response.json({ error: "InvalidRequest", message: "refused" }, { status: 400 })
      : undefined,
  });
  const stopped = await executeOperatorOperation(await authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, leave), LEAVE_ID, leave);
  assert.deepEqual([stopped.state, stopped.completedSteps], ["pending", ["remove-inbox-membership"]]);
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, leave), refusal(/admin permission is required/), "current state alone now refuses the member");

  // #then another operation, another request under that ID, and another account are all still refused
  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, "3mabchjk3xyz3", leave), refusal(/admin permission is required/));
  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, { kind: "leaveChannel", skey: PRIVATE_SKEY }), refusal(/admin permission is required/));
  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, OUTSIDER, LEAVE_ID, leave), refusal(/admin permission is required/));

  // #when the member sends the same operation again
  const retrying = await authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, leave);
  const finished = await executeOperatorOperation(retrying, LEAVE_ID, leave);

  // #then it finishes from where it stopped, with no right to recover anyone else's operation
  assert.equal(retrying.canRecoverOperations, false);
  assert.equal(finished.state, "completed");
  assert.equal(pds.membersOf(WORKSPACE.uri).has(MEMBER), false);
  assert.equal(pds.writes.filter((write) => write === `removeMember ${INBOX} ${MEMBER}`).length, 1, "the completed step is not repeated");

  // #then sending it once more returns the recorded result and writes nothing
  const writes = pds.writes.length;
  const replayed = await executeOperatorOperation(await authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, leave), LEAVE_ID, leave);
  assert.deepEqual([replayed.state, pds.writes.length], ["completed", writes]);
});

test("an admin whose own demotion stopped part-way may send it again, but not an operation that left their role alone", async () => {
  // #given an admin with an earlier invitation in the journal, whose own demotion took their inbox access and was then refused
  const INVITE_ID = "3mabchjk3xya2";
  const DEMOTE_ID = "3mabchjk3xya3";
  const invite = { kind: "inviteMember", subject: OUTSIDER };
  const demote = { kind: "setAdmin", subject: ADMIN, active: false };
  let recordWrites = 0;
  const pds = workspacePds({
    intercept: (method) => method === "com.atproto.space.putRecord" && ++recordWrites === 1
      ? Response.json({ error: "InvalidRequest", message: "refused" }, { status: 400 })
      : undefined,
  });
  await runJournaledOperation(await authorizeSubmittedOperation(pds.session, WORKSPACE, ADMIN, INVITE_ID, invite), INVITE_ID, invite, [], async () => {});
  const stopped = await executeOperatorOperation(await authorizeSubmittedOperation(pds.session, WORKSPACE, ADMIN, DEMOTE_ID, demote), DEMOTE_ID, demote);
  assert.deepEqual([stopped.state, stopped.completedSteps], ["pending", ["remove-inbox-read"]]);

  // #then the invitation, which never touched their role, is refused to them like any other request
  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, ADMIN, INVITE_ID, invite), refusal(/admin permission is required/));

  // #when the admin sends the demotion again
  const retrying = await authorizeSubmittedOperation(pds.session, WORKSPACE, ADMIN, DEMOTE_ID, demote);
  const finished = await executeOperatorOperation(retrying, DEMOTE_ID, demote);

  // #then it finishes, without the right to recover anyone else's operation
  assert.deepEqual([retrying.canRecoverOperations, finished.state], [false, "completed"]);
  assert.equal(pds.recordsOf(WORKSPACE.uri, COLLECTION.admin).get(subjectKey(ADMIN))?.active, false);
});
