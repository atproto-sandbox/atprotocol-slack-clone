import assert from "node:assert/strict";
import test from "node:test";
import { readWebhooksConfig } from "./config";

const BASE = {
  WEBHOOKS_URL: "http://127.0.0.1:3003",
  WEBHOOKS_STATE_FILE: "./.webhooks-session.json",
  WEBHOOKS_DID: "did:plc:webhooks",
  WEBHOOKS_WORKSPACES: "at://did:plc:a/space/new.flock.workspace/acme, at://did:plc:b/space/new.flock.workspace/beta",
  PLC_URL: "https://plc.directory",
  OPERATOR_URL: "http://127.0.0.1:3001",
  OPERATOR_SERVICE_REF: "did:web:localhost%3A3001#atproto_flock_operator",
};

test("readWebhooksConfig derives port, loopback host, workspaces, and a separate hooks file beside stateFile", () => {
  const cfg = readWebhooksConfig(BASE);
  assert.equal(cfg.appUrl, "http://127.0.0.1:3003");
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 3003);
  assert.equal(cfg.loopback, true);
  assert.equal(cfg.trustProxy, false);
  assert.equal(cfg.hooksFile, "./.webhooks-session.json.hooks.json");
  assert.deepEqual(cfg.workspaces, [
    "at://did:plc:a/space/new.flock.workspace/acme",
    "at://did:plc:b/space/new.flock.workspace/beta",
  ]);
  assert.equal(readWebhooksConfig({ ...BASE, WEBHOOKS_TRUST_PROXY: "true" }).trustProxy, true);
});

test("readWebhooksConfig refuses plain http off loopback, https without keys, and sharing stateFile with hooksFile", () => {
  assert.throws(() => readWebhooksConfig({ ...BASE, WEBHOOKS_URL: "http://localhost:3003" }), /127\.0\.0\.1/);
  assert.throws(() => readWebhooksConfig({ ...BASE, WEBHOOKS_URL: "https://hooks.example" }), /WEBHOOKS_PRIVATE_JWKS/);
  assert.throws(
    () => readWebhooksConfig({ ...BASE, WEBHOOKS_HOOKS_FILE: "./.webhooks-session.json" }),
    /beside WEBHOOKS_STATE_FILE/,
  );
});
