import assert from "node:assert/strict";
import test from "node:test";
import { rejectCrossOriginMutation } from "./same-origin-mutation";

test("unsafe app requests require the configured app origin", () => {
  process.env.APP_URL = "https://spaces.example.test";
  process.env.AUTH_ENCRYPTION_KEY = "11".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:spaces.example.test#atproto_flock_operator";

  const sameOrigin = new Request("https://spaces.example.test/api/operator/execute", {
    method: "POST", headers: { origin: "https://spaces.example.test" },
  });
  assert.equal(rejectCrossOriginMutation(sameOrigin), null);

  for (const origin of ["https://evil.example.test", null]) {
    const headers = new Headers();
    if (origin) headers.set("origin", origin);
    const rejected = rejectCrossOriginMutation(new Request("https://spaces.example.test/api/operator/execute", { method: "POST", headers }));
    assert.equal(rejected?.status, 403);
  }
});
