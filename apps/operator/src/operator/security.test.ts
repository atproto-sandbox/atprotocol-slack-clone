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
import { channelUri, dmConversationUri, dmInboxUri, inboxUri, subjectKey, workspaceUri } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { closeDb, getRawDb } from "../lib/db";
import type { WorkspaceRef } from "./actor";
import { OperatorAuthError } from "./errors";
import { runJournaledOperation } from "./journal";
import { executeOperatorOperation } from "./operations";
import {
  authorizeOperationActor,
  authorizeSubmittedOperation,
  resetDmProofReplayCacheForTests,
  verifyDmNotifyCredentialAndProof,
} from "./security";
import { fakeAuthorityPds, type FakeAuthorityPdsOptions } from "./testing/fake-authority-pds";

let directory = "";
const SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "flock-operator-security-test-"));
  process.env.DATABASE_PATH = join(directory, "security.db");
  process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
  process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
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
  pds.membersOf(channelUri(OWNER, PUBLIC_SKEY)).set(ADMIN, { did: ADMIN, read: true, write: true }).set(MEMBER, { did: MEMBER, read: true, write: true });
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
  const pds = workspacePds();
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, { kind: "leaveChannel", skey: "../../etc" }), /Invalid channel key/);
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
  const LEAVE_ID = "3mabchjk3xyz2";
  const leave = { kind: "leaveWorkspace" };
  let removals = 0;
  const pds = workspacePds({
    intercept: (method) => method === "com.atproto.memberspace.removeMembers" && ++removals === 2
      ? Response.json({ error: "InvalidRequest", message: "refused" }, { status: 400 })
      : undefined,
  });
  const stopped = await executeOperatorOperation(await authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, leave), LEAVE_ID, leave);
  assert.deepEqual([stopped.state, stopped.completedSteps], ["pending", ["remove-inbox-membership"]]);
  await assert.rejects(authorizeOperationActor(pds.session, WORKSPACE, MEMBER, leave), refusal(/admin permission is required/), "current state alone now refuses the member");

  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, "3mabchjk3xyz3", leave), refusal(/admin permission is required/));
  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, { kind: "leaveChannel", skey: PRIVATE_SKEY }), refusal(/admin permission is required/));
  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, OUTSIDER, LEAVE_ID, leave), refusal(/admin permission is required/));

  const retrying = await authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, leave);
  const finished = await executeOperatorOperation(retrying, LEAVE_ID, leave);

  assert.equal(retrying.canRecoverOperations, false);
  assert.equal(finished.state, "completed");
  assert.equal(pds.membersOf(WORKSPACE.uri).has(MEMBER), false);
  assert.equal(pds.writes.filter((write) => write === `removeMembers ${INBOX} ${MEMBER}`).length, 1, "the completed step is not repeated");

  const writes = pds.writes.length;
  const replayed = await executeOperatorOperation(await authorizeSubmittedOperation(pds.session, WORKSPACE, MEMBER, LEAVE_ID, leave), LEAVE_ID, leave);
  assert.deepEqual([replayed.state, pds.writes.length], ["completed", writes]);
});

test("an admin whose own demotion stopped part-way may send it again, but not an operation that left their role alone", async () => {
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

  await assert.rejects(authorizeSubmittedOperation(pds.session, WORKSPACE, ADMIN, INVITE_ID, invite), refusal(/admin permission is required/));

  const retrying = await authorizeSubmittedOperation(pds.session, WORKSPACE, ADMIN, DEMOTE_ID, demote);
  const finished = await executeOperatorOperation(retrying, DEMOTE_ID, demote);

  assert.deepEqual([retrying.canRecoverOperations, finished.state], [false, "completed"]);
  assert.equal(pds.recordsOf(WORKSPACE.uri, COLLECTION.admin).get(subjectKey(ADMIN))?.active, false);
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

  const aliceDid = "did:plc:alice" as const;
  const bobDid = "did:plc:bob" as const;
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

  // 1. Valid credential + timestamped PoP from conversation participant Bob succeeds; fresh credential/JTI also succeeds
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

  // 2. Replaying the exact same proof (or re-signing the same credential JTI) is rejected (403)
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

  // 3. Authority key rotation: stale cached key fails first, forceRefresh=true resolves new key and succeeds
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

  // 4. Another user cannot request notify target for Alice's dm.inbox
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

  // 5. Non-DM space is rejected before DID resolution
  let resolved = false;
  const credNonDm = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: WORKSPACE.uri, callerDid: OWNER, credential: credNonDm, proof: await makeProof(credNonDm, holderKey) },
      { resolveSigningKey: async () => { resolved = true; return aliceAuthorityKey.did(); }, operatorServiceRef: SERVICE_REF },
    ),
    refusal(/only for DM spaces/),
  );
  assert.equal(resolved, false);

  // 6. Wrong issuer (iss !== requireSpaceAuthority(space)) is rejected BEFORE resolving any DID document
  const wrongIssuerCred = await createSpaceCredential({
    iss: "did:plc:attacker",
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

  // 7. Wrong subject (credential minted for dmConv, presented for dmConvOther)
  const credWrongSub = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConvOther, callerDid: bobDid, credential: credWrongSub, proof: await makeProof(credWrongSub, holderKey) },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/Invalid or expired space credential/),
  );

  // 8. Strict credential expiry cutoff (exact exp second -> rejected with zero clock-skew extension)
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

  // 9. Stolen credential (PoP signed with attacker's key instead of cnf.kid)
  const credStolen = await mintCred();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof(
      { space: dmConv, callerDid: bobDid, credential: credStolen, proof: await makeProof(credStolen, attackerHolderKey) },
      { resolveSigningKey: async () => aliceAuthorityKey.did(), operatorServiceRef: SERVICE_REF },
    ),
    refusal(/Invalid space credential possession proof/),
  );

  // 10. Wrong audience in PoP signature
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

test("verifyDmNotifyCredentialAndProof blocks missing/invalid created, sig->sig2 relabeling, ECDSA high-S malleability, cross-process replay, and post-restart replay with zero DM metadata in SQLite", async () => {
  resetDmProofReplayCacheForTests();
  const aliceAuthorityKey = await Secp256k1Keypair.create();
  const holderKey = await generateSpaceKey();
  const aliceDid = "did:plc:alice2345678901234567890" as const;
  const bobDid = "did:plc:bob234567890123456789012" as const;
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

  // 1. Missing `;created=` (plain createSpaceSigHeaders without created) -> rejected 403!
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

  // Non-integer `;created=`, out-of-window `Math.abs(nowSec - created) > 60`, and `created > exp` -> rejected 403!
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

  // 2. Relabeling `sig=` -> `sig2=` on the same (jti, created) -> rejected 403!
  const credRelabel = await mintCred();
  const sigParams = `("authorization" "atproto-space-audience");created=${nowSec};tag="atproto-space-credential"`;
  const sig1 = await signCustomProof(credRelabel, holderKey, sigParams, "sig");
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credRelabel, proof: sig1 }, deps),
  );

  // Relabeled without re-signing (`sig=` -> `sig2=`, identical signature bytes)
  const relabeledSameBytes = {
    authorization: sig1.authorization,
    signatureInput: sig1.signatureInput.replace(/^sig=/, "sig2="),
    signature: sig1.signature.replace(/^sig=/, "sig2="),
  };
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credRelabel, proof: relabeledSameBytes }, deps),
    refusal(/already been used/),
  );

  // Re-signed under `sig2=`
  const sig2Resigned = await signCustomProof(credRelabel, holderKey, sigParams, "sig2");
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credRelabel, proof: sig2Resigned }, deps),
    refusal(/already been used/),
  );

  // 3. High-S ECDSA signature malleability (`s' = P256_N - s` on the exact same `signatureInput`) -> rejected 403!
  const credMalleable = await mintCred();
  const origProof = await signCustomProof(credMalleable, holderKey, sigParams, "sig");
  const malleableBytes = flipP256SignatureS(origProof.sigBytes);
  const malleableProof = {
    authorization: origProof.authorization,
    signatureInput: origProof.signatureInput,
    signature: `sig=:${malleableBytes.toString("base64")}:`,
  };
  assert.notEqual(malleableProof.signature, origProof.signature);

  // Prove @atproto/space's verifyCredentialSig genuinely accepts `s'` when verified directly
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

  // Present `s` first -> accepted; then present `s'` -> rejected 403 by canonical replay store!
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credMalleable, proof: origProof }, deps),
  );
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credMalleable, proof: malleableProof }, deps),
    refusal(/already been used/),
  );

  // 4. Cross-process (second SQLite connection / child worker) & post-closeDb() restart replay -> rejected 403!
  const credCrossProc = await mintCred();
  const crossProcProof = await makeProof(credCrossProc, holderKey);
  const crossProcJti = (JSON.parse(Buffer.from(credCrossProc.split(".")[1]!, "base64url").toString("utf8")) as { jti: string }).jti;
  await assert.doesNotReject(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credCrossProc, proof: crossProcProof }, deps),
  );

  // Verify zero DM space URI, zero callerDid, zero iss, and zero plaintext jti exist in SQLite oauth_request_lock
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

  // Spawn second Node process sharing DATABASE_PATH attempting to replay `crossProcProof`
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
    child.stdout.setEncoding("utf8").on("data", (c: string) => { out += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { errOut += c; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`Child exited ${code}: ${errOut}`))));
  });
  assert.match(childReplayOutcome, /^OperatorAuthError:.*already been used/);

  // Simulate full operator process restart (`closeDb()` then re-open SQLite) and replay -> still rejected 403!
  closeDb();
  await assert.rejects(
    verifyDmNotifyCredentialAndProof({ space: dmConv, callerDid: bobDid, credential: credCrossProc, proof: crossProcProof }, deps),
    refusal(/already been used/),
  );
});
