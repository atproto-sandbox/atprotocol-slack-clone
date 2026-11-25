import assert from "node:assert/strict";
import test from "node:test";
import { readEchoBotConfig } from "./config";

const base = {
  ECHO_BOT_URL: "http://127.0.0.1:3002", ECHO_BOT_STATE_FILE: "./state.json", PLC_URL: "https://plc.example",
  OPERATOR_URL: "http://127.0.0.1:3001", OPERATOR_SERVICE_REF: "did:web:localhost%3A3001#atproto_flock_operator",
};

test("the echo bot's configuration: its workspaces listed, its port from its URL", () => {
  const config = readEchoBotConfig({ ...base, ECHO_BOT_WORKSPACES: " at:space/did:plc:a/new.flock.workspace/one , at:space/did:plc:a/new.flock.workspace/two,", ECHO_BOT_DID: "did:plc:bot" });
  assert.deepEqual(config.workspaces, ["at:space/did:plc:a/new.flock.workspace/one", "at:space/did:plc:a/new.flock.workspace/two"]);
  assert.deepEqual([config.host, config.port], ["127.0.0.1", 3002], "on loopback it listens on that address only");
  assert.equal(config.did, "did:plc:bot");
  assert.equal(readEchoBotConfig({ ...base, ECHO_BOT_URL: "http://127.0.0.1" }).port, 80);
  assert.deepEqual([readEchoBotConfig({ ...base, ECHO_BOT_URL: "https://bot.example", ECHO_BOT_PRIVATE_JWKS: '{"keys":[{"kid":"k1"}]}' }).host, readEchoBotConfig({ ...base, ECHO_BOT_URL: "https://bot.example", ECHO_BOT_PRIVATE_JWKS: '{"keys":[{"kid":"k1"}]}' }).port], [undefined, 443]);
});

test("the echo bot refuses http off loopback, https without keys, and a missing setting", () => {
  assert.throws(() => readEchoBotConfig({ ...base, ECHO_BOT_URL: "http://bot.example" }), /127\.0\.0\.1/);
  assert.throws(() => readEchoBotConfig({ ...base, ECHO_BOT_URL: "http://localhost:3002" }), /127\.0\.0\.1/, "an OAuth loopback client is named by its address");
  assert.throws(() => readEchoBotConfig({ ...base, ECHO_BOT_URL: "https://bot.example" }), /ECHO_BOT_PRIVATE_JWKS is required/);
  assert.throws(() => readEchoBotConfig({ ...base, PLC_URL: "" }), /PLC_URL is required/);
});
