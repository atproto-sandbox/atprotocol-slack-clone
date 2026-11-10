import assert from "node:assert/strict";
import test from "node:test";
import { channelUri, inboxUri, subjectKey, workspaceUri } from "@/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@/protocol/nsids";
import type { WorkspaceRef } from "./actor";
import { OperatorAuthError } from "./errors";
import { authorizeOperationActor } from "./security";
import { fakeAuthorityPds } from "./testing/fake-authority-pds";

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
function workspacePds() {
  const pds = fakeAuthorityPds(OWNER);
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
