import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { closeDb, getRawDb } from "../lib/db";
import { dmConversationUri, dmInboxUri } from "@flock/protocol/keys";
import { WebhookAuthError } from "./errors";
import { authenticateSpaceNotification, authenticateSpaceWebhook, deriveDmNotifyToken, DM_TOKEN_EPOCH_MS, operatorNotifyEndpoint } from "./space-notification";

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-space-notification-test-"));
const SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
const KEY_HEX = "33".repeat(32);
process.env.DATABASE_PATH = join(DIRECTORY, "notification-auth.db");
process.env.AUTH_ENCRYPTION_KEY = KEY_HEX;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

beforeEach(() => {
  getRawDb().prepare("DELETE FROM notification_registration").run();
});

const CHANNEL = "at://did:plc:owner/space/new.flock.channel/alpha";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const isWebhookRefusal = (error: unknown) => error instanceof WebhookAuthError && error.status === 400;

function seedRegistration(space: string, token: string, expiresAt: number, serviceRef = SERVICE_REF): void {
  getRawDb()
    .prepare("INSERT OR REPLACE INTO notification_registration (service_ref, space_uri, expires_at, token, renew_at) VALUES (?, ?, ?, ?, 0)")
    .run(serviceRef, space, expiresAt, token);
}

test("authenticateSpaceWebhook accepts matching operator tokens regardless of expires_at (staged 0 and >5 min expired)", () => {
  // Staged placeholder row (expires_at = 0) during synchronous confirmRegistration inside authorizeSpaceSync
  seedRegistration(CHANNEL, "operator-secret-token-1", 0);
  assert.deepEqual(authenticateSpaceWebhook(CHANNEL, "operator-secret-token-1"), { kind: "operator" });

  // Long-expired row (>30 minutes past expires_at) when #registrationExpired arrives late
  seedRegistration(CHANNEL, "operator-secret-token-1", Date.now() - 30 * 60_000);
  assert.deepEqual(authenticateSpaceWebhook(CHANNEL, "operator-secret-token-1"), { kind: "operator" });
});

test("authenticateSpaceWebhook rejects missing, empty, mismatched, unregistered, tokenless, or other-service tokens with 400", () => {
  seedRegistration(CHANNEL, "operator-secret-token-1", Date.now() + 600_000);

  assert.throws(() => authenticateSpaceWebhook(CHANNEL, ""), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, "wrong-token"), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, "operator-secret-token-1-extra"), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook("at://did:plc:owner/space/new.flock.channel/unregistered", "operator-secret-token-1"), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook("not-a-space", "operator-secret-token-1"), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, "x".repeat(513)), isWebhookRefusal);

  // Pre-renewal migrated row with empty token='' cannot authenticate webhooks
  seedRegistration(CHANNEL, "", 0);
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, ""), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, "anything"), isWebhookRefusal);

  // Row belonging to another operatorServiceRef is ignored
  getRawDb().prepare("DELETE FROM notification_registration").run();
  seedRegistration(CHANNEL, "other-service-token", Date.now() + 600_000, "did:web:other.test#atproto_flock_operator");
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, "other-service-token"), isWebhookRefusal);
});

test("deriveDmNotifyToken is deterministic within a 30m epoch per (space, callerDid), accepts [epoch, epoch - 1], rejects expired/future epochs with 400, and touches zero SQLite rows", () => {
  const dmConv = dmConversationUri(ALICE, "3kabcdefghij2");
  const dmInbox = dmInboxUri(ALICE);
  const baseMs = 100 * DM_TOKEN_EPOCH_MS + 5_000;
  const key = Buffer.from(KEY_HEX, "hex");

  const aliceToken1 = deriveDmNotifyToken(dmConv, ALICE, key, baseMs);
  const aliceToken2 = deriveDmNotifyToken(dmConv, ALICE, key, baseMs + 10 * 60_000);
  const bobToken = deriveDmNotifyToken(dmConv, BOB, key, baseMs);
  assert.equal(aliceToken1, aliceToken2, "same caller, DM space, and 30m epoch yields stable token across renewals");
  assert.notEqual(aliceToken1, bobToken, "cross-caller isolation prevents registration withdrawal DoS");
  assert.equal(aliceToken1.split(".").length, 4, "dm1.<epochHex>.<caller>.<mac>");
  assert.ok(aliceToken1.startsWith("dm1.64."), "encodes lowercase hex epoch 100 -> 0x64");

  // Accepted in current epoch (100) and immediate next epoch (101, where token is currentEpoch - 1)
  assert.deepEqual(authenticateSpaceNotification(dmConv, aliceToken1, key, baseMs), { kind: "dm", callerDid: ALICE });
  assert.deepEqual(authenticateSpaceNotification(dmConv, aliceToken1, key, baseMs + DM_TOKEN_EPOCH_MS), { kind: "dm", callerDid: ALICE });
  assert.deepEqual(authenticateSpaceWebhook(dmConv, bobToken, key, baseMs), { kind: "dm", callerDid: BOB });
  assert.deepEqual(authenticateSpaceWebhook(dmInbox, deriveDmNotifyToken(dmInbox, ALICE, key, baseMs), key, baseMs), { kind: "dm", callerDid: ALICE });

  // Rejected once [epoch, epoch - 1] rolls past (epoch 102+) and rejected if presented in a past clock (future token epoch)
  assert.throws(() => authenticateSpaceNotification(dmConv, aliceToken1, key, baseMs + 2 * DM_TOKEN_EPOCH_MS), isWebhookRefusal);
  assert.throws(() => authenticateSpaceNotification(dmConv, aliceToken1, key, baseMs - DM_TOKEN_EPOCH_MS), isWebhookRefusal);

  // Zero SQLite rows exist in notification_registration
  const count = (getRawDb().prepare("SELECT count(*) AS count FROM notification_registration").get() as { count: number }).count;
  assert.equal(count, 0);
});

test("authenticateSpaceWebhook rejects cross-space, tampered, legacy 3-part, non-canonical hex, non-dm1, wrong-key, and non-DM-target dm1 tokens with 400", () => {
  const convA = dmConversationUri(ALICE, "3kabcdefghij2");
  const convB = dmConversationUri(ALICE, "3kabcdefghij3");
  const validA = deriveDmNotifyToken(convA, ALICE);

  // Wrong DM space
  assert.throws(() => authenticateSpaceWebhook(convB, validA), isWebhookRefusal);

  // Valid dm1 format cannot be used on a workspace/channel space, even if someone tried
  assert.throws(() => authenticateSpaceWebhook(CHANNEL, validA), isWebhookRefusal);
  assert.throws(() => deriveDmNotifyToken(CHANNEL, ALICE), /DM spaces/);

  // Tampered MAC
  const [ver, epochHex, callerPart, macPart] = validA.split(".");
  const flipped = `${macPart!.slice(0, -1)}${macPart!.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => authenticateSpaceWebhook(convA, `${ver}.${epochHex}.${callerPart}.${flipped}`), isWebhookRefusal);

  // Legacy 3-part timeless dm1 token, non-canonical hex epoch, non-dm1 version prefix, or invalid DID
  assert.throws(() => authenticateSpaceWebhook(convA, `dm1.${callerPart}.${macPart}`), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(convA, `dm1.0${epochHex}.${callerPart}.${macPart}`), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(convA, `dm1.${epochHex!.toUpperCase()}.${callerPart}.${macPart}`), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(convA, `dm2.${epochHex}.${callerPart}.${macPart}`), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(convA, "plain-random-token"), isWebhookRefusal);
  assert.throws(() => authenticateSpaceWebhook(convA, `dm1.${epochHex}.not_a_did.${macPart}`), isWebhookRefusal);

  // Derived with a different operator encryption key
  const wrongKeyToken = deriveDmNotifyToken(convA, ALICE, Buffer.from("99".repeat(32), "hex"));
  assert.throws(() => authenticateSpaceWebhook(convA, wrongKeyToken), isWebhookRefusal);
});

test("operatorNotifyEndpoint maps loopback IP literals to localhost for PDS safeFetch compatibility while preserving non-loopback origins", () => {
  assert.equal(operatorNotifyEndpoint(new URL("http://127.0.0.1:3001")), "http://localhost:3001");
  assert.equal(operatorNotifyEndpoint(new URL("http://[::1]:4123")), "http://localhost:4123");
  assert.equal(operatorNotifyEndpoint(new URL("https://operator.spaces.example.com")), "https://operator.spaces.example.com");
});
