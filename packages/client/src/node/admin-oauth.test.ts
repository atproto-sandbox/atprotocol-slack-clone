import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { JoseKey } from "@atproto/oauth-client-node";
import {
  ADMIN_OAUTH_PATHS,
  ADMIN_OAUTH_SCOPE,
  adminClientMetadata,
  BoundedAdminStateStore,
  createAdminIdentityOAuth,
  PendingSignInCapError,
} from "./admin-oauth";
import { APP_OAUTH_PATHS } from "./oauth";

test("adminClientMetadata uses /admin/oauth/* paths and identity-only atproto scope without colliding with /oauth/*", async () => {
  const loopback = adminClientMetadata({ appUrl: "http://127.0.0.1:3003", keys: [], name: "Webhooks Admin" });
  assert.equal(loopback.scope, ADMIN_OAUTH_SCOPE);
  assert.equal(loopback.token_endpoint_auth_method, "none");
  assert.deepEqual(loopback.redirect_uris, [`http://127.0.0.1:3003${ADMIN_OAUTH_PATHS.callback}`]);
  assert.notEqual(ADMIN_OAUTH_PATHS.clientMetadata, APP_OAUTH_PATHS.clientMetadata);
  assert.notEqual(ADMIN_OAUTH_PATHS.jwks, APP_OAUTH_PATHS.jwks);
  assert.notEqual(ADMIN_OAUTH_PATHS.callback, APP_OAUTH_PATHS.callback);

  assert.throws(() => adminClientMetadata({ appUrl: "https://hooks.example", keys: [], name: "Webhooks Admin" }), /at least one key/);
  assert.throws(() => adminClientMetadata({ appUrl: "http://localhost:3003", keys: [], name: "Webhooks Admin" }), /https, or over http on 127\.0\.0\.1/);

  const key = (await JoseKey.generate(["ES256"], "k1")).privateJwk!;
  const confidential = adminClientMetadata({ appUrl: "https://hooks.example", keys: [key], name: "Webhooks Admin" });
  assert.equal(confidential.token_endpoint_auth_method, "private_key_jwt");
  assert.equal(confidential.client_id, `https://hooks.example${ADMIN_OAUTH_PATHS.clientMetadata}`);
  assert.equal(confidential.jwks_uri, `https://hooks.example${ADMIN_OAUTH_PATHS.jwks}`);
  assert.equal(confidential.scope, "atproto");
});

test("BoundedAdminStateStore caps pending sign-ins and expires stale ones after ten minutes", async () => {
  let now = 1_000_000;
  const store = new BoundedAdminStateStore({ maxEntries: 3, ttlMs: 10 * 60_000, now: () => now });
  for (const id of ["s1", "s2", "s3"]) {
    await store.set(id, { appState: `app-${id}` } as never);
  }
  assert.equal(store.size, 3);
  assert.equal(store.hasPending("s1", "app-s1"), true);
  assert.equal(store.hasPending("s1", "wrong-app"), false);

  await assert.rejects(store.set("s4", { appState: "app-s4" } as never), PendingSignInCapError);

  // After ten minutes, earlier states expire and free capacity.
  now += 10 * 60_000;
  assert.equal(store.hasPending("s1", "app-s1"), false);
  assert.equal(store.size, 0);
  await store.set("s4", { appState: "app-s4" } as never);
  assert.equal(store.hasPending("s4", "app-s4"), true);
});

test("createAdminIdentityOAuth serves public keys only and blocks private-address SSRF off loopback", async () => {
  let connections = 0;
  const server = createServer(() => undefined).on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const key = (await JoseKey.generate(["ES256"], "k1")).privateJwk!;
  const oauth = await createAdminIdentityOAuth({
    appUrl: "https://hooks.example",
    keys: [key],
    name: "Webhooks Admin",
    plcUrl: `https://127.0.0.1:${port}`,
  });
  try {
    const metadata = oauth.answerMetadataRoute(new URL(ADMIN_OAUTH_PATHS.clientMetadata, "https://hooks.example"));
    const jwks = oauth.answerMetadataRoute(new URL(ADMIN_OAUTH_PATHS.jwks, "https://hooks.example"));
    assert.equal(JSON.parse(metadata!.body).scope, "atproto");
    assert.equal((JSON.parse(jwks!.body) as { keys: Array<Record<string, unknown>> }).keys.some((k) => "d" in k), false);
    assert.equal(oauth.answerMetadataRoute(new URL("/admin", "https://hooks.example")), null);

    await assert.rejects(oauth.startSignIn("did:plc:abcdefghijklmnopqrstuvwx"));
    assert.equal(connections, 0);
    assert.equal(oauth.states.size, 0, "failed sign-in leaves no leaked state slot");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
