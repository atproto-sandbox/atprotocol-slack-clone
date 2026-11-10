import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("scoped OAuth client cache is bounded and evicted callback clients rebuild from encrypted state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slack-oauth-client-cache-"));
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.AUTH_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.PLC_URL = "https://plc.directory";
  process.env.DATABASE_PATH = join(directory, "oauth.db");

  try {
    const [{ getOAuthClient, getOAuthClientForState }, { oauthSqliteStore }, { getRawDb }] = await Promise.all([
      import("./oauth"), import("./encrypted-store"), import("@/lib/db"),
    ]);
    assert.throws(() => getOAuthClient(`atproto space:${"&".repeat(100_000)}`), /loopback client ID is too large/);
    const scope = "atproto space:new.flock.workspace?authority=did:plc:alice&skey=workspace&action=read";
    const originalClient = getOAuthClient(scope);
    const appState = "A".repeat(43);
    await oauthSqliteStore("oauth_state").set("oauth-state-cache-eviction", {
      appState,
      oauthClientScope: scope,
    } as never);

    for (let index = 0; index < 100; index += 1) {
      getOAuthClient(`atproto space:cache-test-${index}`);
    }

    const rebuiltClient = getOAuthClient(scope);
    assert.notEqual(rebuiltClient, originalClient, "old dynamic clients are evicted after the configured bound");
    const callbackClient = await getOAuthClientForState("oauth-state-cache-eviction", appState);
    assert.equal(callbackClient.clientMetadata.scope, scope, "callback reconstruction preserves the exact persisted scope");
    getRawDb().close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
