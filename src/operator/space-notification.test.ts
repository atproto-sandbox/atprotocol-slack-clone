import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { closeDb, getRawDb } from "@/lib/db";
import { dmInboxUri } from "@/protocol/keys";
import { OperatorAuthError } from "./security";
import { authenticateSpaceNotification } from "./space-notification";

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-space-notification-test-"));
const SERVICE_REF = "did:web:localhost%3A3000#atproto_slack_admin";
process.env.DATABASE_PATH = join(DIRECTORY, "notification-auth.db");
process.env.AUTH_ENCRYPTION_KEY = "33".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

const CHANNEL = "at://did:plc:owner/space/org.slack.channel/alpha";
const METHOD = "com.atproto.space.notifyWrite";

/** A bearer token whose payload claims `iss`; its signature is junk, which only a verifier would notice. */
function requestClaiming(iss?: string): Request {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return new Request("http://127.0.0.1:3000/xrpc/com.atproto.space.notifyWrite", {
    method: "POST",
    headers: iss ? { authorization: `Bearer ${part({ alg: "ES256K", typ: "JWT" })}.${part({ iss })}.signature` } : {},
  });
}

const register = (space: string) => getRawDb().prepare("INSERT OR REPLACE INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)").run(SERVICE_REF, space, Date.now() + 3_600_000);
const unregisterAll = () => getRawDb().prepare("DELETE FROM notification_registration").run();
const isRefusal = (error: unknown) => error instanceof OperatorAuthError && error.message === "Notification is not authorized.";

/** A stand-in for the real verifier that counts how often it is asked, so a test can prove it was never reached. */
function verifier(outcome: () => string | Promise<string>) {
  const calls = { count: 0 };
  return { calls, authenticate: async () => { calls.count += 1; return outcome(); } };
}

test("every refusal carries the same message: no token, a token naming a stranger, an unregistered space, a bad signature", async () => {
  // #given the channel is registered
  unregisterAll();
  register(CHANNEL);

  // #when/#then none of the ways to be refused can be told apart from another
  await assert.rejects(authenticateSpaceNotification(requestClaiming(), METHOD, CHANNEL), isRefusal);
  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:stranger"), METHOD, CHANNEL), isRefusal);
  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:owner"), METHOD, CHANNEL, async () => { throw new OperatorAuthError("Service authorization is invalid or expired."); }), isRefusal);
  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:owner"), METHOD, "at://did:plc:owner/space/org.slack.channel/unregistered"), isRefusal);
});

test("a token that names anyone but the space's authority is refused before registration is looked up or any DID is resolved", async () => {
  register(CHANNEL);
  const { calls, authenticate } = verifier(() => "did:plc:stranger");

  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:stranger"), METHOD, CHANNEL, authenticate), isRefusal);
  assert.equal(calls.count, 0, "the verifier, which resolves the issuer's DID, was never reached");
});

test("an unregistered space is refused before any DID is resolved, even for a token that names its authority", async () => {
  unregisterAll();
  const { calls, authenticate } = verifier(() => "did:plc:owner");

  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:owner"), METHOD, CHANNEL, authenticate), isRefusal);
  assert.equal(calls.count, 0);
});

test("a registered space accepts a notice only when the verified issuer is the space's own authority", async () => {
  register(CHANNEL);

  // #given a token that names the authority but verifies as someone else, and one that verifies as the authority
  const forged = verifier(() => "did:plc:stranger");
  const genuine = verifier(() => "did:plc:owner");

  // #then only the genuine one is accepted
  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:owner"), METHOD, CHANNEL, forged.authenticate), isRefusal);
  await assert.doesNotReject(authenticateSpaceNotification(requestClaiming("did:plc:owner"), METHOD, CHANNEL, genuine.authenticate));
  assert.equal(genuine.calls.count, 1);
});

test("a DM space needs no registration, but its notice must still come from its own authority", async () => {
  unregisterAll();
  const inbox = dmInboxUri("did:plc:alice");
  const asAlice = verifier(() => "did:plc:alice");
  const asStranger = verifier(() => "did:plc:stranger");

  await assert.doesNotReject(authenticateSpaceNotification(requestClaiming("did:plc:alice"), METHOD, inbox, asAlice.authenticate));
  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:stranger"), METHOD, inbox, asStranger.authenticate), isRefusal);
  assert.equal(asStranger.calls.count, 0, "a stranger's token is refused without resolving the stranger's DID");
});

test("a transient failure to verify a notice is not turned into a refusal, so the authority retries", async () => {
  register(CHANNEL);
  await assert.rejects(authenticateSpaceNotification(requestClaiming("did:plc:owner"), METHOD, CHANNEL, async () => { throw new Error("PLC unreachable"); }), /PLC unreachable/);
});
