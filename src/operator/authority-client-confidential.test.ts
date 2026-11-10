import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JoseKey } from "@atproto/jwk-jose";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";

// The confidential authority client as a deployment configures it (HTTPS app URL, keys in AUTHORITY_CLIENT_PRIVATE_JWKS),
// checked against the pinned OAuth client library itself, which validates client metadata and keyset together.

const [newest, older] = await Promise.all([JoseKey.generate(["ES256"], "authority-2026-11"), JoseKey.generate(["ES256"], "authority-2026-08")]);
process.env.APP_URL = "https://spaces.example.com";
process.env.AUTH_ENCRYPTION_KEY = "5d".repeat(32);
process.env.OPERATOR_SERVICE_REF = "did:web:spaces.example.com#atproto_slack_admin";
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "authority-confidential-test-")), "app.db");
process.env.AUTHORITY_CLIENT_PRIVATE_JWKS = JSON.stringify({ keys: [newest.privateJwk, older.privateJwk] });

const [{ authorityClientMetadata, authorityPublicJwks }, { getAuthorityClientKeys }] = await Promise.all([import("./authority-grant"), import("@/lib/config")]);

test("the confidential authority client is accepted by the pinned OAuth client with its configured keys", async () => {
  // given the deployment's metadata and keys
  const metadata = authorityClientMetadata();
  const keyset = await Promise.all(getAuthorityClientKeys().map((key) => JoseKey.fromImportable(key, key.kid)));
  const memory = <T>() => {
    const map = new Map<string, T>();
    return { get: async (key: string) => map.get(key), set: async (key: string, value: T) => { map.set(key, value); }, del: async (key: string) => { map.delete(key); } };
  };

  // when the OAuth client is built from them
  const client = new NodeOAuthClient({ clientMetadata: metadata, keyset, stateStore: memory<NodeSavedState>(), sessionStore: memory<NodeSavedSession>() });

  // then it is a private_key_jwt client whose metadata names both public keys' location and signs with ES256
  assert.equal(client.clientMetadata.token_endpoint_auth_method, "private_key_jwt");
  assert.equal(client.clientMetadata.token_endpoint_auth_signing_alg, "ES256");
  assert.equal(client.clientMetadata.jwks_uri, "https://spaces.example.com/authority/jwks.json");
  assert.deepEqual(authorityPublicJwks().keys.map((key) => key.kid), ["authority-2026-11", "authority-2026-08"]);
});
