import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { JoseKey, TokenRefreshError } from "@atproto/oauth-client-node";
import { answerAppOAuthRoute, APP_OAUTH_PATHS, appClientMetadata, appOAuthClient, isSessionLost, StateFile } from "./oauth";

const directory = mkdtempSync(join(tmpdir(), "app-oauth-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const SCOPE = "atproto repo:new.flock.app.declaration?action=create&action=update";

test("on loopback an app is a public loopback client; over https a confidential client with its own keys", async () => {
  const loopback = appClientMetadata({ appUrl: "http://127.0.0.1:3002", keys: [], name: "Echo", scope: SCOPE });
  assert.equal(loopback.token_endpoint_auth_method, "none");
  assert.match(loopback.client_id, /^http:\/\/localhost\?/);
  assert.deepEqual(loopback.redirect_uris, [`http://127.0.0.1:3002${APP_OAUTH_PATHS.callback}`]);
  assert.throws(() => appClientMetadata({ appUrl: "https://bot.example", keys: [], name: "Echo", scope: SCOPE }), /at least one key/);
  const key = (await JoseKey.generate(["ES256"], "k1")).privateJwk!;
  const confidential = appClientMetadata({ appUrl: "https://bot.example", keys: [key], name: "Echo", scope: SCOPE });
  assert.equal(confidential.client_id, `https://bot.example${APP_OAUTH_PATHS.clientMetadata}`);
  assert.equal(confidential.token_endpoint_auth_method, "private_key_jwt");
});

test("an app serves its metadata and only its public keys, and answers nothing else", async () => {
  const key = (await JoseKey.generate(["ES256"], "k1")).privateJwk!;
  const client = await appOAuthClient({ appUrl: "https://bot.example", keys: [key], name: "Echo", scope: SCOPE, plcUrl: "https://plc.example", stateFile: join(directory, "served.json") });
  const metadata = await answerAppOAuthRoute(client, new URL(APP_OAUTH_PATHS.clientMetadata, "https://bot.example"));
  const jwks = await answerAppOAuthRoute(client, new URL(APP_OAUTH_PATHS.jwks, "https://bot.example"));
  assert.equal(JSON.parse(metadata!.body).client_id, `https://bot.example${APP_OAUTH_PATHS.clientMetadata}`);
  const published = JSON.parse(jwks!.body) as { keys: Array<Record<string, unknown>> };
  assert.deepEqual(published.keys.map((entry) => entry.kid), ["k1"]);
  assert.equal(published.keys.some((entry) => "d" in entry), false, "no private part is published");
  assert.equal(await answerAppOAuthRoute(client, new URL("/anything", "https://bot.example")), null);
});

test("the state file keeps sessions and states apart, readable by its owner only, and forgets what is deleted", async () => {
  const path = join(directory, "state.json");
  const file = new StateFile(path);
  await Promise.all([file.store("sessions").set("did:plc:app", { token: "a" }), file.store("states").set("s1", { verifier: "v" })]);
  assert.deepEqual(await new StateFile(path).store("sessions").get("did:plc:app"), { token: "a" });
  assert.equal(await file.store("sessions").get("s1"), undefined);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await file.store("states").del("s1");
  assert.equal(await file.store("states").get("s1"), undefined);
});

test("a refused refresh means the app must sign in again; another failure does not", () => {
  assert.equal(isSessionLost(new TokenRefreshError("did:plc:app", "refused")), true);
  assert.equal(isSessionLost(new Error("network")), false);
});

test("a state file found readable by others is narrowed to its owner, and no key of an object's prototype reads as an entry", async () => {
  const path = join(directory, "wide.json");
  writeFileSync(path, JSON.stringify({ states: {}, sessions: { "did:plc:app": { token: "a" } } }));
  chmodSync(path, 0o644);
  const file = new StateFile(path);
  assert.deepEqual(await file.store("sessions").get("did:plc:app"), { token: "a" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await file.store("states").get("constructor"), undefined);
  assert.equal(await file.store("sessions").get("__proto__"), undefined);
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
});

test("a write a crash cut short leaves no tokens behind once the file is read again, and a link is no state file", async () => {
  const path = join(directory, "crashed.json");
  writeFileSync(path, JSON.stringify({ states: {}, sessions: {} }), { mode: 0o600 });
  writeFileSync(`${path}.0b4a1f6e-6f5c-4c8e-9a3d-2f1e7b9c5d40.tmp`, JSON.stringify({ sessions: { "did:plc:app": { token: "left" } } }));
  writeFileSync(`${path}.backup.tmp`, "not this file's");
  writeFileSync(join(directory, "crashed.json.tmp"), "not this file's either");
  await new StateFile(path).store("sessions").get("did:plc:app");
  assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("crashed.json.") && name.endsWith(".tmp")).sort(), ["crashed.json.backup.tmp", "crashed.json.tmp"]);
  const linked = join(directory, "linked.json");
  symlinkSync(path, linked);
  await assert.rejects(new StateFile(linked).store("sessions").get("did:plc:app"), /plain file, not a link/);
});
