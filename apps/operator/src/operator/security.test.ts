import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createSpaceCredential, createSpaceSigHeaders } from "@atproto/space";
import { createTimestampedSpaceSigHeaders, verifyCredentialSig } from "@flock/protocol/atproto/space-credential-core";
import { generateSpaceKey } from "@flock/protocol/atproto/space-key";
import {
  channelRoleKey,
  channelUri,
  dmConversationUri,
  dmInboxUri,
  groupMembersUri,
  inboxUri,
  personalInvitesUri,
  workspaceUri,
} from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { closeDb, getRawDb } from "../lib/db";
import type { WorkspaceRef } from "./actor";
import { OperatorAuthError, WebhookAuthError } from "./errors";
import { runJournaledOperation } from "./journal";
import { executeOperatorOperation } from "./operations";
import {
  authorizeOperationActor,
  authorizeSubmittedOperation,
  resetDmProofReplayCacheForTests,
  verifyDmNotifyCredentialAndProof,
  verifySpaceNotifyCredentialAndProof,
} from "./security";
import { authenticateSpaceWebhook, deriveSpaceNotifyToken, INVITE_TOKEN_EPOCH_MS } from "./space-notification";
import { fakeGroupHost, plcDid, type FakeGroupSessionOptions } from "./testing/fake-group-session";

let directory = "";
const SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "flock-operator-security-test-"));
  process.env.DATABASE_PATH = join(directory, "security.db");
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.GROUP_HOST_URL = "http://127.0.0.1:3004";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const CREATOR = plcDid("creatorsec");
const ADMIN = plcDid("adminsec");
const MEMBER = plcDid("membersec");
const OUTSIDER = plcDid("outsidersec");
const PRIVATE_SKEY = "design";
const PUBLIC_SKEY = "general";

let groupCounter = 0;

/**
 * Provisions an OpenSocial group with CREATOR + ADMIN as effective human admins,
 * MEMBER as a human member in `#design` (private) and `#general` (public),
 * and ZERO `group.opensocial.acceptance/self` records (proving Operator auth never gates on `acceptance/self`).
 */
async function workspaceGroup(options: FakeGroupSessionOptions = {}) {
  const groupDid = plcDid(`secgrp${++groupCounter}`);
  const wsRef: WorkspaceRef = { uri: workspaceUri(groupDid), authorityDid: groupDid, skey: "self" };
  let ready = false;
  const host = await fakeGroupHost(groupDid, {
    ...options,
    creatorDid: CREATOR,
    intercept: (method, target, init) => (ready ? options.intercept?.(method, target, init) : undefined),
  });
  const membersSpace = groupMembersUri(groupDid);
  const privRole = channelRoleKey(PRIVATE_SKEY);

  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: "self",
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.inbox,
    skey: "self",
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "member", read: false, write: true },
      ],
    },
  });
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.role, privRole, {
    displayName: "#design member",
  });
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey: PRIVATE_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [{ role: privRole, read: true, write: true }],
    },
  });
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.channel,
    skey: PUBLIC_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [{ role: "member", read: true, write: true }],
    },
  });

  const nowIso = "2026-11-01T12:00:00.000Z";
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, ADMIN, {
    roles: ["admin", "member"],
    createdAt: nowIso,
  });
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, MEMBER, {
    roles: ["member", privRole],
    createdAt: nowIso,
  });

  for (const [skey, visibility] of [
    [PRIVATE_SKEY, "private"],
    [PUBLIC_SKEY, "public"],
  ] as const) {
    await host.putRecord(wsRef.uri, COLLECTION.directory, skey, {
      skey,
      name: skey,
      visibility,
    });
  }

  host.calls.length = 0;
  host.writes.length = 0;
  ready = true;
  return { ...host, workspace: wsRef, inbox: inboxUri(groupDid) };
}

const refusal = (pattern: RegExp) => (error: unknown) => error instanceof OperatorAuthError && pattern.test(error.message);

test("an active admin may run an admin kind without acceptance/self, and recovers pending operations", async () => {
  const host = await workspaceGroup();
  const actor = await authorizeOperationActor(host.session, host.workspace, ADMIN, {
    kind: "inviteMember",
    subject: OUTSIDER,
  });
  assert.deepEqual({ did: actor.did, canRecoverOperations: actor.canRecoverOperations }, { did: ADMIN, canRecoverOperations: true });
});

test("effectiveMemberPermissions authorizes a delegated role whose membership write scopes come solely from policy.grants[].scopes", async () => {
  const host = await workspaceGroup();
  const recruiterDid = plcDid("recruitersec");
  const membersSpace = groupMembersUri(host.groupDid);

  // `role/recruiter` has NO `role.scopes`, only `assignable: ["member"]`; capability comes from `members/self` `policy.grants[].scopes`!
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.role, "recruiter", {
    displayName: "Recruiter",
    assignable: ["member"],
  });
  await host.selfClient.procedure("com.atproto.space.updateSpace", {
    space: membersSpace,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true },
        { role: "member", read: true, write: true },
        {
          role: "recruiter",
          read: true,
          write: true,
          scopes: [
            `space:${SPACE_TYPE.workspace === "new.flock.workspace" ? "group.opensocial.members" : ""}?skey=self&collection=${OPENSOCIAL_COLLECTION.membership}&action=read&action=create&action=update`,
          ],
        },
      ],
    },
  });
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, recruiterDid, {
    roles: ["member", "recruiter"],
    createdAt: "2026-11-01T12:00:00.000Z",
  });

  const actor = await authorizeOperationActor(host.session, host.workspace, recruiterDid, {
    kind: "inviteMember",
    subject: OUTSIDER,
  });
  assert.equal(actor.did, recruiterDid);
  assert.equal(actor.canRecoverOperations, true);

  // Recruiter lacks `group.opensocial.invites` `create` permission -> expiring `inviteMember` is refused!
  const futureExp = new Date(Date.now() + 3_600_000).toISOString();
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, recruiterDid, {
      kind: "inviteMember",
      subject: OUTSIDER,
      expiresAt: futureExp,
    }),
    refusal(/invite write permission/),
  );

  // Grant `group.opensocial.invites` `create` on `role/recruiter` -> expiring `inviteMember` is now authorized!
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.role, "recruiter", {
    displayName: "Recruiter",
    assignable: ["member"],
    scopes: [
      `space:group.opensocial.invites?authority=*&skey=self&collection=${OPENSOCIAL_COLLECTION.invite}&action=create`,
    ],
  });
  const inviterActor = await authorizeOperationActor(host.session, host.workspace, recruiterDid, {
    kind: "inviteMember",
    subject: OUTSIDER,
    expiresAt: futureExp,
  });
  assert.equal(inviterActor.did, recruiterDid);

  // Recruiter cannot run `setAdmin` (`admin` is not in `assignable`)
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, recruiterDid, {
      kind: "setAdmin",
      subject: MEMBER,
      active: true,
    }),
    refusal(/assignable/),
  );
});

test("a member may not run an admin kind", async () => {
  const host = await workspaceGroup();
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "inviteMember", subject: OUTSIDER }),
    refusal(/membership write|admin permission/),
  );
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "reconcileWorkspace" }),
    refusal(/admin permission is required/),
  );
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "setAdmin", subject: MEMBER, active: true }),
    refusal(/membership update|admin permission/),
  );
});

test("a member may leave the workspace, and a private channel they belong to, but never recovers others' operations", async () => {
  const host = await workspaceGroup();
  const leaving = await authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "leaveWorkspace" });
  assert.deepEqual({ did: leaving.did, canRecoverOperations: leaving.canRecoverOperations }, { did: MEMBER, canRecoverOperations: false });
  const leavingChannel = await authorizeOperationActor(host.session, host.workspace, MEMBER, {
    kind: "leaveChannel",
    skey: PRIVATE_SKEY,
  });
  assert.equal(leavingChannel.canRecoverOperations, false);
});

test("a member may not leave a public channel, or a private channel they are not in", async () => {
  const host = await workspaceGroup();
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "leaveChannel", skey: PUBLIC_SKEY }),
    refusal(/Only an active private channel/),
  );
  await host.putRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, MEMBER, {
    roles: ["member"],
    createdAt: "2026-11-01T12:00:00.000Z",
  });
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "leaveChannel", skey: PRIVATE_SKEY }),
    refusal(/not a member of this channel/),
  );
});

test("a member's request is validated before the kind's own check reads directory records", async () => {
  const host = await workspaceGroup();
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, { kind: "leaveChannel", skey: "../../etc" }),
    /Invalid channel key/,
  );
  assert.deepEqual(
    host.calls.filter((call) => call.includes(COLLECTION.directory)),
    [],
  );
});

test("someone outside the workspace (and the group DID itself) may run nothing, not even a member kind", async () => {
  const host = await workspaceGroup();
  for (const request of [{ kind: "leaveWorkspace" }, { kind: "inviteMember", subject: OUTSIDER }]) {
    await assert.rejects(
      authorizeOperationActor(host.session, host.workspace, OUTSIDER, request),
      refusal(/not an active member|admin permission/),
      request.kind,
    );
    await assert.rejects(
      authorizeOperationActor(host.session, host.workspace, host.groupDid, request),
      refusal(/human group member|admin permission/),
      request.kind,
    );
  }
});

test("a kind only the authority may start is refused to an admin before anything is read", async () => {
  const host = await workspaceGroup();
  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, ADMIN, { kind: "bootstrapWorkspace", name: "Acme" }),
    refusal(/Only the workspace authority/),
  );
  assert.deepEqual(host.calls, []);
});

test("a member whose leave stopped after removing their own membership may send it again, and only it", async () => {
  const LEAVE_ID = "3mabchjk3xyz2";
  const leave = { kind: "leaveWorkspace" };
  let blockPostDeleteRead = true;
  let membershipDeleted = false;
  const host = await workspaceGroup({
    intercept: (method, target) => {
      if (method === "com.atproto.space.deleteRecord" && target.collection === OPENSOCIAL_COLLECTION.membership) {
        membershipDeleted = true;
        return undefined;
      }
      if (blockPostDeleteRead && membershipDeleted && method === "com.atproto.space.listRecords") {
        return Response.json({ error: "InternalServerError", message: "transient outage" }, { status: 500 });
      }
      return undefined;
    },
  });

  const stopped = await executeOperatorOperation(
    await authorizeSubmittedOperation(host.session, host.workspace, MEMBER, LEAVE_ID, leave),
    LEAVE_ID,
    leave,
  );
  assert.deepEqual([stopped.state, stopped.completedSteps], ["pending", ["remove-workspace-membership"]]);
  blockPostDeleteRead = false;

  await assert.rejects(
    authorizeOperationActor(host.session, host.workspace, MEMBER, leave),
    refusal(/not an active member/),
    "current state alone now refuses the member",
  );
  await assert.rejects(
    authorizeSubmittedOperation(host.session, host.workspace, MEMBER, "3mabchjk3xyz3", leave),
    refusal(/not an active member/),
  );
  await assert.rejects(
    authorizeSubmittedOperation(host.session, host.workspace, MEMBER, LEAVE_ID, { kind: "leaveChannel", skey: PRIVATE_SKEY }),
    refusal(/not an active member/),
  );
  await assert.rejects(
    authorizeSubmittedOperation(host.session, host.workspace, OUTSIDER, LEAVE_ID, leave),
    refusal(/not an active member/),
  );

  const retrying = await authorizeSubmittedOperation(host.session, host.workspace, MEMBER, LEAVE_ID, leave);
  const finished = await executeOperatorOperation(retrying, LEAVE_ID, leave);

  assert.equal(retrying.canRecoverOperations, false);
  assert.equal(finished.state, "completed");
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), OPENSOCIAL_COLLECTION.membership, MEMBER),
    undefined,
  );
  assert.equal(
    host.writes.filter((write) => write === `deleteRecord ${groupMembersUri(host.groupDid)} ${OPENSOCIAL_COLLECTION.membership}/${MEMBER}`).length,
    1,
    "the completed step is not repeated",
  );

  const writes = host.writes.length;
  const replayed = await executeOperatorOperation(
    await authorizeSubmittedOperation(host.session, host.workspace, MEMBER, LEAVE_ID, leave),
    LEAVE_ID,
    leave,
  );
  assert.deepEqual([replayed.state, host.writes.length], ["completed", writes]);
});

test("an admin whose own demotion stopped part-way may send it again, but not an operation that left their role alone", async () => {
  const INVITE_ID = "3mabchjk3xya2";
  const DEMOTE_ID = "3mabchjk3xya3";
  const invite = { kind: "inviteMember", subject: OUTSIDER };
  const demote = { kind: "setAdmin", subject: ADMIN, active: false };
  let blockPostDemoteVerify = true;
  let adminDemoted = false;
  const host = await workspaceGroup({
    intercept: (method, target) => {
      if (method === "com.atproto.space.putRecord" && target.collection === OPENSOCIAL_COLLECTION.membership && target.rkey === ADMIN) {
        adminDemoted = true;
        return undefined;
      }
      if (blockPostDemoteVerify && adminDemoted && method === "com.atproto.space.listRecords") {
        return Response.json({ error: "InternalServerError", message: "transient outage" }, { status: 500 });
      }
      return undefined;
    },
  });

  await runJournaledOperation(
    await authorizeSubmittedOperation(host.session, host.workspace, ADMIN, INVITE_ID, invite),
    INVITE_ID,
    invite,
    [],
    async () => {},
  );
  const stopped = await executeOperatorOperation(
    await authorizeSubmittedOperation(host.session, host.workspace, ADMIN, DEMOTE_ID, demote),
    DEMOTE_ID,
    demote,
  );
  assert.deepEqual([stopped.state, stopped.completedSteps], ["pending", ["write-admin-inactive"]]);
  blockPostDemoteVerify = false;

  await assert.rejects(
    authorizeSubmittedOperation(host.session, host.workspace, ADMIN, INVITE_ID, invite),
    refusal(/membership write|admin permission/),
  );

  const retrying = await authorizeSubmittedOperation(host.session, host.workspace, ADMIN, DEMOTE_ID, demote);
  const finished = await executeOperatorOperation(retrying, DEMOTE_ID, demote);

  assert.deepEqual([retrying.canRecoverOperations, finished.state], [false, "completed"]);
  const adminMem = await host.getRecord<{ roles: string[] }>(
    groupMembersUri(host.groupDid),
    OPENSOCIAL_COLLECTION.membership,
    ADMIN,
  );
  assert.deepEqual(adminMem?.roles, ["member"]);
});

type CredOptions = Parameters<typeof createSpaceCredential>[0];
type SigOptions = Parameters<typeof createSpaceSigHeaders>[0];

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

async function makeProof(
  credential: string,
  keypair: Awaited<ReturnType<typeof generateSpaceKey>>,
  audience = SERVICE_REF,
  createdSec = Math.floor(Date.now() / 1000),
) {
  const authorization = `Atproto-Space-Credential ${credential}`;
  const { headers } = await createTimestampedSpaceSigHeaders({
    authorization,
    audience,
    keypair,
    createdSec,
  });
  return {
    authorization: headers.authorization!,
    signatureInput: headers["signature-input"]!,
    signature: headers.signature!,
  };
}

async function signCustomProof(
  credential: string,
  keypair: Awaited<ReturnType<typeof generateSpaceKey>>,
  signatureParams: string,
  label = "sig",
  audience = SERVICE_REF,
) {
  const authorization = `Atproto-Space-Credential ${credential}`;
  const base =
    `"authorization": ${authorization}\n` +
    `"atproto-space-audience": ${audience}\n` +
    `"@signature-params": ${signatureParams}`;
  const sigBytes = await keypair.sign(Buffer.from(base, "utf8"));
  return {
    authorization,
    signatureInput: `${label}=${signatureParams}`,
    signature: `${label}=:${Buffer.from(sigBytes).toString("base64")}:`,
    sigBytes,
  };
}

function flipP256SignatureS(compactSig: Uint8Array): Buffer {
  assert.equal(compactSig.byteLength, 64);
  const r = Buffer.from(compactSig.subarray(0, 32));
  const s = BigInt(`0x${Buffer.from(compactSig.subarray(32, 64)).toString("hex")}`);
  const sPrime = P256_N - s;
  const sPrimeBuf = Buffer.from(sPrime.toString(16).padStart(64, "0"), "hex");
  return Buffer.concat([r, sPrimeBuf]);
}

test("verifyDmNotifyCredentialAndProof accepts valid SpaceCredential + PoP, retries on authority key rotation, and enforces strict security gates", async () => {
  resetDmProofReplayCacheForTests();
  const aliceAuthorityKey = await Secp256k1Keypair.create();
  const rotatedAuthorityKey = await Secp256k1Keypair.create();
  const holderKey = await generateSpaceKey();
  const attackerHolderKey = await generateSpaceKey();

  const aliceDid = plcDid("alice");
  const bobDid = plcDid("bob");
  const dmConv = dmConversationUri(aliceDid, "3kabcdefghij2") as CredOptions["sub"];
  const dmConvOther = dmConversationUri(aliceDid, "3kabcdefghij7") as CredOptions["sub"];
  const aliceDmInbox = dmInboxUri(aliceDid) as CredOptions["sub"];
  const holderKid = holderKey.did() as CredOptions["keyId"];

  const mintCred = (expiresInSec = 600) =>
    createSpaceCredential({
      iss: aliceDid,
      sub: dmConv,
      keyId: holderKid,
      keypair: aliceAuthorityKey,
      expiresInSec,
    });

  const credential1 = await mintCred();

  const validProof1 = await makeProof(credential1, holderKey);
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credential1, proof: validProof1 },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
  );
  const credential2 = await mintCred();
  const validProof2 = await makeProof(credential2, holderKey);
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credential2, proof: validProof2 },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
  );

  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credential1, proof: validProof1 },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/already been used/),
  );
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credential1, proof: await makeProof(credential1, holderKey) },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/already been used/),
  );

  const rotatedCredential = await createSpaceCredential({
    iss: aliceDid,
    sub: aliceDmInbox,
    keyId: holderKid,
    keypair: rotatedAuthorityKey,
    expiresInSec: 600,
  });
  const rotatedProof = await makeProof(rotatedCredential, holderKey);
  const refreshFlags: boolean[] = [];
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof(
      { space: aliceDmInbox, callerDid: aliceDid, credential: rotatedCredential, proof: rotatedProof },
      {
        resolveSigningKey: async (_did, forceRefresh) => {
          refreshFlags.push(forceRefresh);
          return forceRefresh ? rotatedAuthorityKey.did() : aliceAuthorityKey.did();
        },
        operatorServiceRef: SERVICE_REF,
      },
    ),
  );
  assert.deepEqual(refreshFlags, [false, true]);

  const rotatedCredentialForBob = await createSpaceCredential({
    iss: aliceDid,
    sub: aliceDmInbox,
    keyId: holderKid,
    keypair: rotatedAuthorityKey,
    expiresInSec: 600,
  });
  const inboxProofForBob = await makeProof(rotatedCredentialForBob, holderKey);
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: aliceDmInbox, callerDid: bobDid, credential: rotatedCredentialForBob, proof: inboxProofForBob },
      { resolveSigningKey: async () => rotatedAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    (err: unknown) => err instanceof OperatorAuthError,
  );

  let resolved = false;
  const credNonDm = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: workspaceUri(aliceDid), callerDid: aliceDid, credential: credNonDm, proof: await makeProof(credNonDm, holderKey) },
      { resolveSigningKey: async () => { resolved = true; return aliceAuthorityKey.did(); }, operatorServiceRef: SERVICE_REF },
    ),
    refusal(/only for DM spaces/),
  );
  assert.equal(resolved, false);

  const wrongIssuerCred = await createSpaceCredential({
    iss: plcDid("attacker"),
    sub: dmConv,
    keyId: holderKid,
    keypair: aliceAuthorityKey,
    expiresInSec: 600,
  });
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: wrongIssuerCred, proof: await makeProof(wrongIssuerCred, holderKey) },
      { resolveSigningKey: async () => { resolved = true; return aliceAuthorityKey.did(); }, operatorServiceRef: SERVICE_REF },
    ),
    refusal(/Invalid or expired space credential/),
  );
  assert.equal(resolved, false, "attacker DID is never resolved when iss !== space authority");

  const credWrongSub = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConvOther, callerDid: bobDid, credential: credWrongSub, proof: await makeProof(credWrongSub, holderKey) },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/Invalid or expired space credential/),
  );

  const credExp = await mintCred();
  const decodedPayload = JSON.parse(Buffer.from(credExp.split(".")[1]!, "base64url").toString("utf8")) as { exp: number };
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credExp, proof: await makeProof(credExp, holderKey, SERVICE_REF, decodedPayload.exp) },
      {
        resolveSigningKey: async () => aliceAuthorityKey.did(),
        operatorServiceRef: SERVICE_REF,
        now: () => decodedPayload.exp * 1000,
      },
    ),
    refusal(/Invalid or expired space credential/),
  );

  const credStolen = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credStolen, proof: await makeProof(credStolen, attackerHolderKey) },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/Invalid space credential possession proof/),
  );

  const credWrongAud = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      {
        space: dmConv,
        callerDid: bobDid,
        credential: credWrongAud,
        proof: await makeProof(credWrongAud, holderKey, "did:web:evil.operator#atproto_flock_operator"),
      },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/Invalid space credential possession proof/),
  );
});

test("verifySpaceNotifyCredentialAndProof enforces personal group.opensocial.invites/self space, 600s max credential lifetime, PoP audience, replay lock, and inv1 epoch tokens", async () => {
  resetDmProofReplayCacheForTests();
  const aliceKey = await Secp256k1Keypair.create();
  const holderKey = await generateSpaceKey();
  const aliceDid = plcDid("aliceinv");
  const bobDid = plcDid("bobinv");
  const aliceInvites = personalInvitesUri(aliceDid) as CredOptions["sub"];
  const holderKid = holderKey.did() as CredOptions["keyId"];
  const deps = {
    resolveSigningKey: async () => aliceKey.did(),
    operatorServiceRef: SERVICE_REF,
  };

  // 1. Valid credential (`exp - iat === 600`) + timestamped PoP for caller's own `group.opensocial.invites/self` succeeds
  const validCred = await createSpaceCredential({
    iss: aliceDid,
    sub: aliceInvites,
    keyId: holderKid,
    keypair: aliceKey,
    expiresInSec: 600,
  });
  const validProof = await makeProof(validCred, holderKey);
  await assert.doesNotReject(
    verifySpaceNotifyCredentialAndProof(
      { space: aliceInvites, callerDid: aliceDid, credential: validCred, proof: validProof },
      deps,
    ),
  );

  // 2. Replay of exact same proof (or same credential JTI) is rejected (403 OperatorAuthError)
  await assert.rejects(
    verifySpaceNotifyCredentialAndProof(
      { space: aliceInvites, callerDid: aliceDid, credential: validCred, proof: validProof },
      deps,
    ),
    refusal(/already been used/),
  );

  // 3. Wrong caller, non-invites space, or non-`self` skey rejected with plain `Error` (400 InvalidRequest) BEFORE DID resolution
  let didResolved = false;
  const noResolveDeps = {
    resolveSigningKey: async () => {
      didResolved = true;
      return aliceKey.did();
    },
    operatorServiceRef: SERVICE_REF,
  };
  const freshCred = await createSpaceCredential({
    iss: aliceDid,
    sub: aliceInvites,
    keyId: holderKid,
    keypair: aliceKey,
    expiresInSec: 600,
  });
  for (const badInput of [
    { space: aliceInvites, callerDid: bobDid },
    { space: workspaceUri(aliceDid), callerDid: aliceDid },
    { space: dmInboxUri(aliceDid), callerDid: aliceDid },
    { space: `at:space/${aliceDid}/group.opensocial.invites/custom`, callerDid: aliceDid },
  ]) {
    await assert.rejects(
      verifySpaceNotifyCredentialAndProof(
        { ...badInput, credential: freshCred, proof: await makeProof(freshCred, holderKey) },
        noResolveDeps,
      ),
      (err: unknown) => err instanceof Error && !(err instanceof OperatorAuthError),
      `expected 400 InvalidRequest Error for ${badInput.space} / ${badInput.callerDid}`,
    );
  }
  assert.equal(didResolved, false);

  // 4. `exp - iat > 600` (`expiresInSec = 601`) is rejected on `getSpaceNotifyTarget`
  const longLivedCred = await createSpaceCredential({
    iss: aliceDid,
    sub: aliceInvites,
    keyId: holderKid,
    keypair: aliceKey,
    expiresInSec: 601,
  });
  await assert.rejects(
    verifySpaceNotifyCredentialAndProof(
      { space: aliceInvites, callerDid: aliceDid, credential: longLivedCred, proof: await makeProof(longLivedCred, holderKey) },
      deps,
    ),
    refusal(/Invalid or expired space credential/),
  );

  // 5. Wrong PoP audience is rejected
  const wrongAudCred = await createSpaceCredential({
    iss: aliceDid,
    sub: aliceInvites,
    keyId: holderKid,
    keypair: aliceKey,
    expiresInSec: 600,
  });
  await assert.rejects(
    verifySpaceNotifyCredentialAndProof(
      {
        space: aliceInvites,
        callerDid: aliceDid,
        credential: wrongAudCred,
        proof: await makeProof(wrongAudCred, holderKey, "did:web:wrong.test#atproto_flock_operator"),
      },
      deps,
    ),
    refusal(/Invalid space credential possession proof/),
  );

  // 6. Stateless 30-min-epoch `inv1.<epochHex>...` token verification (`[currentEpoch, currentEpoch - 1]` accepted, `currentEpoch - 2` & wrong space rejected)
  const t0 = Date.UTC(2026, 10, 20, 12, 0, 0);
  const invToken = deriveSpaceNotifyToken(aliceInvites, aliceDid, undefined, t0);
  assert.match(invToken, /^inv1\.[0-9a-f]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(authenticateSpaceWebhook(aliceInvites, invToken, undefined, t0), {
    kind: "invites",
    callerDid: aliceDid,
  });
  assert.deepEqual(
    authenticateSpaceWebhook(aliceInvites, invToken, undefined, t0 + INVITE_TOKEN_EPOCH_MS),
    { kind: "invites", callerDid: aliceDid },
    "previous 30-min epoch remains valid across boundary",
  );
  assert.throws(
    () => authenticateSpaceWebhook(aliceInvites, invToken, undefined, t0 + 2 * INVITE_TOKEN_EPOCH_MS),
    (err: unknown) => err instanceof WebhookAuthError,
  );
  assert.throws(
    () => authenticateSpaceWebhook(personalInvitesUri(bobDid), invToken, undefined, t0),
    (err: unknown) => err instanceof WebhookAuthError,
  );
});

test("verifyDmNotifyCredentialAndProof blocks missing/invalid created, sig->sig2 relabeling, ECDSA high-S malleability, cross-process replay, and post-restart replay with zero DM metadata in SQLite", async () => {
  resetDmProofReplayCacheForTests();
  const aliceAuthorityKey = await Secp256k1Keypair.create();
  const holderKey = await generateSpaceKey();
  const aliceDid = plcDid("alice2345");
  const bobDid = plcDid("bob2345");
  const dmConv = dmConversationUri(aliceDid, "3kabcdefghij7") as CredOptions["sub"];
  const holderKid = holderKey.did() as CredOptions["keyId"];
  const deps = {
    resolveSigningKey: async () => aliceAuthorityKey.did(),
    operatorServiceRef: SERVICE_REF,
  };

  const mintCred = (expiresInSec = 600) =>
    createSpaceCredential({
      iss: aliceDid,
      sub: dmConv,
      keyId: holderKid,
      keypair: aliceAuthorityKey,
      expiresInSec,
    });

  const credMissingCreated = await mintCred();
  const { headers: noCreatedHeaders } = await createSpaceSigHeaders({
    authorization: `Atproto-Space-Credential ${credMissingCreated}`,
    audience: SERVICE_REF as SigOptions["audience"],
    keypair: holderKey,
  });
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      {
        space: dmConv,
        callerDid: bobDid,
        credential: credMissingCreated,
        proof: {
          authorization: noCreatedHeaders.authorization!,
          signatureInput: noCreatedHeaders["signature-input"]!,
          signature: noCreatedHeaders.signature!,
        },
      },
      deps,
    ),
    refusal(/created timestamp/),
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const decimalCreatedProof = await signCustomProof(
    credMissingCreated,
    holderKey,
    `("authorization" "atproto-space-audience");created=${nowSec}.5;tag="atproto-space-credential"`,
  );
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credMissingCreated, proof: decimalCreatedProof }, deps),
    refusal(/Malformed created/),
  );

  const staleCreatedProof = await makeProof(credMissingCreated, holderKey, SERVICE_REF, nowSec - 61);
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credMissingCreated, proof: staleCreatedProof }, deps),
    refusal(/outside the accepted window/),
  );

  const shortCred = await mintCred(15);
  const shortExp = (JSON.parse(Buffer.from(shortCred.split(".")[1]!, "base64url").toString("utf8")) as { exp: number }).exp;
  const afterExpCreatedProof = await makeProof(shortCred, holderKey, SERVICE_REF, shortExp + 10);
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: shortCred, proof: afterExpCreatedProof }, deps),
    refusal(/outside the accepted window/),
  );

  const credRelabel = await mintCred();
  const sigParams = `("authorization" "atproto-space-audience");created=${nowSec};tag="atproto-space-credential"`;
  const sig1 = await signCustomProof(credRelabel, holderKey, sigParams, "sig");
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credRelabel, proof: sig1 }, deps),
  );

  const relabeledSameBytes = {
    authorization: sig1.authorization,
    signatureInput: sig1.signatureInput.replace(/^sig=/, "sig2="),
    signature: sig1.signature.replace(/^sig=/, "sig2="),
  };
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credRelabel, proof: relabeledSameBytes }, deps),
    refusal(/already been used/),
  );

  const sig2Resigned = await signCustomProof(credRelabel, holderKey, sigParams, "sig2");
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credRelabel, proof: sig2Resigned }, deps),
    refusal(/already been used/),
  );

  const credMalleable = await mintCred();
  const origProof = await signCustomProof(credMalleable, holderKey, sigParams, "sig");
  const malleableBytes = flipP256SignatureS(origProof.sigBytes);
  const malleableProof = {
    authorization: origProof.authorization,
    signatureInput: origProof.signatureInput,
    signature: `sig=:${malleableBytes.toString("base64")}:`,
  };
  assert.notEqual(malleableProof.signature, origProof.signature);

  await assert.doesNotReject(
    verifyCredentialSig(
      {
        authorization: malleableProof.authorization,
        "atproto-space-audience": SERVICE_REF,
        "signature-input": malleableProof.signatureInput,
        signature: malleableProof.signature,
      },
      holderKid,
    ),
    "upstream verifyCredentialSig permits high-S malleable signature",
  );

  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credMalleable, proof: origProof }, deps),
  );
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credMalleable, proof: malleableProof }, deps),
    refusal(/already been used/),
  );

  const credCrossProc = await mintCred();
  const crossProcProof = await makeProof(credCrossProc, holderKey);
  const crossProcJti = (JSON.parse(Buffer.from(credCrossProc.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credCrossProc, proof: crossProcProof }, deps),
  );

  const lockRows = getRawDb()
    .prepare("SELECT name, token FROM oauth_request_lock WHERE name LIKE 'pop:%'")
    .all() as Array<{ name: string; token: string }>;
  assert.ok(lockRows.length >= 3);
  for (const row of lockRows) {
    assert.match(row.name, /^pop:[0-9a-f]{64}$/);
    assert.equal(row.token, "1");
    assert.equal(row.name.includes(dmConv), false);
    assert.equal(row.name.includes(bobDid), false);
    assert.equal(row.name.includes(aliceDid), false);
    assert.equal(row.name.includes(crossProcJti), false);
  }

  const securityModulePath = fileURLToPath(new URL("./security.ts", import.meta.url));
  const dbModulePath = fileURLToPath(new URL("../lib/db.ts", import.meta.url));
  const childReplayOutcome = await new Promise<string>((resolve, reject) => {
    const script = `
      import { verifyDmNotifyCredentialAndProof } from ${JSON.stringify(securityModulePath)};
      import { closeDb } from ${JSON.stringify(dbModulePath)};
      try {
        await verifyDmNotifyCredentialAndProof(
          ${JSON.stringify({ space: dmConv, callerDid: bobDid, credential: credCrossProc, proof: crossProcProof })},
          { resolveSigningKey: async () => ${JSON.stringify(aliceAuthorityKey.did())}, operatorServiceRef: ${JSON.stringify(SERVICE_REF)} },
        );
        closeDb();
        process.stdout.write("unexpected-ok");
      } catch (err) {
        closeDb();
        process.stdout.write(\`\${err.name}:\${err.message}\`);
      }
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      out += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      errOut += c;
    });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`Child exited ${code}: ${errOut}`))));
  });
  assert.match(childReplayOutcome, /^OperatorAuthError:.*already been used/);

  closeDb();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credCrossProc, proof: crossProcProof }, deps),
    refusal(/already been used/),
  );
});

void channelUri;
