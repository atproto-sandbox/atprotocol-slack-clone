import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import test from "node:test";

test("HTTPS OAuth metadata resolves the exact signed scope descriptor", async () => {
  process.env.APP_URL = "https://spaces.example.com";
  process.env.AUTH_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:spaces.example.com#atproto_flock_operator";
  process.env.PLC_URL = "https://plc.directory";

  const [{ canonicalOAuthScope }, { getOAuthClient }, { GET }] = await Promise.all([
    import("./oauth-scope"), import("./oauth"), import("@/app/oauth/client-metadata.json/route"),
  ]);
  const scope = canonicalOAuthScope([
    "atproto",
    "space:new.flock.workspace?authority=did:plc:alice&skey=workspace&action=read",
  ]);
  const clientId = getOAuthClient(scope).clientMetadata.client_id;
  const metadataUrl = new URL(clientId);
  const response = await GET(new NextRequest(metadataUrl));
  const metadata = await response.json() as { client_id: string; scope: string; client_uri: string; application_type: string };

  assert.equal(response.status, 200);
  assert.equal(metadata.client_id, clientId);
  assert.equal(metadata.scope, scope);
  assert.equal(metadata.client_uri, "https://spaces.example.com");
  assert.equal(metadata.application_type, "web");

  metadataUrl.searchParams.set("signature", "00".repeat(32));
  const rejected = await GET(new NextRequest(metadataUrl));
  assert.equal(rejected.status, 400, "a modified metadata descriptor cannot advertise a different scope");
});
