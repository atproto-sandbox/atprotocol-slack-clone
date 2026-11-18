import assert from "node:assert/strict";
import test from "node:test";
import { getConfig } from "./config";

test("a deployed web app names its operator: the loopback default is for loopback development only", () => {
  Object.assign(process.env, { APP_URL: "https://spaces.example.com", OPERATOR_SERVICE_REF: "did:web:operator.spaces.example.com#atproto_flock_operator" });
  delete process.env.OPERATOR_URL;
  assert.throws(getConfig, /OPERATOR_URL is required outside loopback development/);

  process.env.OPERATOR_URL = "https://operator.spaces.example.com";
  assert.equal(getConfig().operatorUrl.origin, "https://operator.spaces.example.com");
});
