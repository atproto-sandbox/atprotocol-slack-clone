import assert from "node:assert/strict";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { NOTICE_METHOD, OPERATOR_METHOD } from "@flock/protocol/nsids";
import { OperatorAuthError } from "./errors";
import { authenticateOperatorRequest, serviceTokenLifetimeSeconds } from "./security";

// Service tokens are bound to this operator and to one method, and each method sets how long its token may live.

const SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
process.env.AUTH_ENCRYPTION_KEY = "44".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;

const CALLER = "did:plc:caller";

async function call(method: string, token: { lxm?: string; aud?: string; lifetimeSeconds: number; ageSeconds?: number }) {
  const keypair = await Secp256k1Keypair.create();
  const iat = Math.floor(Date.now() / 1000) - (token.ageSeconds ?? 0);
  const jwt = await createServiceJwt({ iss: CALLER, aud: token.aud ?? SERVICE_REF, lxm: token.lxm ?? method, keypair, iat, exp: iat + token.lifetimeSeconds });
  return authenticateOperatorRequest(`Bearer ${jwt}`, method, async () => keypair.did());
}

const refused = (error: unknown) => error instanceof OperatorAuthError;

test("a long-poll token may live fifteen minutes, and every other method's a minute and a little more", async () => {
  assert.equal(serviceTokenLifetimeSeconds(OPERATOR_METHOD.getChanges), 900);
  assert.equal(serviceTokenLifetimeSeconds(OPERATOR_METHOD.getDmNotifyTarget), 75);
  assert.equal(await call(OPERATOR_METHOD.getChanges, { lifetimeSeconds: 900, ageSeconds: 600 }), CALLER);
  assert.equal(await call(OPERATOR_METHOD.execute, { lifetimeSeconds: 60 }), CALLER);
  assert.equal(await call(OPERATOR_METHOD.getDmNotifyTarget, { lifetimeSeconds: 60 }), CALLER);
  await assert.rejects(call(OPERATOR_METHOD.execute, { lifetimeSeconds: 900, ageSeconds: 600 }), refused, "a ten-minute-old token is refused for execute");
  await assert.rejects(call(OPERATOR_METHOD.getDmNotifyTarget, { lifetimeSeconds: 900, ageSeconds: 600 }), refused, "and for getDmNotifyTarget");
  await assert.rejects(call(NOTICE_METHOD.notifySpaceUpdate, { lifetimeSeconds: 900, ageSeconds: 600 }), refused);
});

test("a token is refused once it is older than its method's lifetime, whatever expiry the client asked for", async () => {
  await assert.rejects(call(OPERATOR_METHOD.getChanges, { lifetimeSeconds: 3_600, ageSeconds: 901 }), refused, "older than fifteen minutes");
  await assert.rejects(call(OPERATOR_METHOD.execute, { lifetimeSeconds: 3_600, ageSeconds: 76 }), refused);
  assert.equal(await call(OPERATOR_METHOD.getChanges, { lifetimeSeconds: 960, ageSeconds: 10 }), CALLER,
    "a client whose clock runs a minute ahead of its PDS asks for a little more than fifteen minutes, and is accepted while the token is young");
});

test("a token bound to another method or audience is refused", async () => {
  await assert.rejects(call(OPERATOR_METHOD.getChanges, { lxm: OPERATOR_METHOD.execute, lifetimeSeconds: 60 }), refused);
  await assert.rejects(call(OPERATOR_METHOD.getChanges, { aud: "did:web:elsewhere.test#atproto_flock_operator", lifetimeSeconds: 60 }), refused);
});
