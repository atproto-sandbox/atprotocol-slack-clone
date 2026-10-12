import assert from "node:assert/strict";
import test from "node:test";
import { buildDmClientMetadata } from "./client-metadata";

const scope = "atproto space:org.slack.dm.inbox?authority=*&collection=org.slack.dm.request&action=create";

test("HTTPS mode builds a discoverable client_id pointing at the DM metadata route", () => {
  const metadata = buildDmClientMetadata({ appUrl: "https://spaces.example.com", scope });
  assert.equal(metadata.client_id, "https://spaces.example.com/oauth/dm-client-metadata.json");
  assert.equal(metadata.client_uri, "https://spaces.example.com");
  assert.deepEqual(metadata.redirect_uris, ["https://spaces.example.com/dm/callback"]);
  assert.equal(metadata.scope, scope);
  assert.equal(metadata.application_type, "web");
  assert.equal(metadata.token_endpoint_auth_method, "none");
  assert.equal(metadata.dpop_bound_access_tokens, true);
});

test("loopback HTTP mode embeds the redirect_uri and scope in the client_id itself", () => {
  const metadata = buildDmClientMetadata({ appUrl: "http://127.0.0.1:3000", scope });
  assert.equal(metadata.client_uri, undefined);
  assert.deepEqual(metadata.redirect_uris, ["http://127.0.0.1:3000/dm/callback"]);
  const clientId = new URL(metadata.client_id);
  assert.equal(clientId.protocol, "http:");
  assert.equal(clientId.hostname, "localhost");
  assert.equal(clientId.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/dm/callback");
  assert.equal(clientId.searchParams.get("scope"), scope);
});

test("a loopback appUrl given as 'localhost' still redirects on the 127.0.0.1 IP literal", () => {
  const metadata = buildDmClientMetadata({ appUrl: "http://localhost:3000", scope });
  assert.deepEqual(metadata.redirect_uris, ["http://127.0.0.1:3000/dm/callback"]);
});

test("HTTPS is never treated as loopback even on a loopback hostname", () => {
  const metadata = buildDmClientMetadata({ appUrl: "https://127.0.0.1:3000", scope });
  assert.equal(metadata.client_id, "https://127.0.0.1:3000/oauth/dm-client-metadata.json");
});
