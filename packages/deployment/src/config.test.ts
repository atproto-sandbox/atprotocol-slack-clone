import assert from "node:assert/strict";
import test from "node:test";
import { DESK_ENV_FILE_KEYS, getConfig, getDeskConfig, isLoopback, resetConfigCacheForTest, serviceUrl } from "./config";

test("a deployed web app names both its operator and group host: loopback defaults are for loopback development only", () => {
  resetConfigCacheForTest();
  Object.assign(process.env, {
    APP_URL: "https://spaces.example.com",
    OPERATOR_SERVICE_REF: "did:web:operator.spaces.example.com#atproto_flock_operator",
  });
  delete process.env.OPERATOR_URL;
  delete process.env.GROUP_HOST_URL;
  assert.throws(getConfig, /OPERATOR_URL is required outside loopback development/);

  process.env.OPERATOR_URL = "https://operator.spaces.example.com";
  assert.throws(getConfig, /GROUP_HOST_URL is required outside loopback development/);

  process.env.GROUP_HOST_URL = "http://groups.spaces.example.com";
  assert.throws(getConfig, /GROUP_HOST_URL must use HTTPS outside loopback development/);

  process.env.GROUP_HOST_URL = "https://groups.spaces.example.com";
  const prodCfg = getConfig();
  assert.equal(prodCfg.operatorUrl.origin, "https://operator.spaces.example.com");
  assert.equal(prodCfg.groupHostUrl.origin, "https://groups.spaces.example.com");

  resetConfigCacheForTest();
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.OPERATOR_URL;
  process.env.GROUP_HOST_URL = "http://localhost:3004";
  const devCfg = getConfig();
  assert.equal(devCfg.appUrl.origin, "http://127.0.0.1:3000");
  assert.equal(devCfg.operatorUrl.origin, "http://127.0.0.1:3001");
  assert.equal(devCfg.groupHostUrl.origin, "http://127.0.0.1:3004");
});

test("serviceUrl and getConfig reject embedded credentials, non-root paths, query strings, and fragments", () => {
  for (const invalid of [
    "https://user:secret@operator.spaces.example.com",
    "https://user@operator.spaces.example.com",
    "https://:secret@operator.spaces.example.com",
    "https://operator.spaces.example.com/subpath",
    "https://operator.spaces.example.com/?leak=1",
    "https://operator.spaces.example.com/#frag",
  ]) {
    assert.throws(() => serviceUrl("OPERATOR_URL", invalid));
  }

  assert.equal(serviceUrl("OPERATOR_URL", "https://operator.spaces.example.com").origin, "https://operator.spaces.example.com");
  assert.equal(serviceUrl("OPERATOR_URL", "https://operator.spaces.example.com/").origin, "https://operator.spaces.example.com");

  resetConfigCacheForTest();
  Object.assign(process.env, {
    APP_URL: "https://spaces.example.com",
    OPERATOR_URL: "https://operator.spaces.example.com",
    GROUP_HOST_URL: "https://groups.spaces.example.com",
    PLC_URL: "https://admin:pw@plc.directory",
    OPERATOR_SERVICE_REF: "did:web:operator.spaces.example.com#atproto_flock_operator",
  });
  assert.throws(getConfig, /PLC_URL must not contain embedded credentials/);

  for (const invalidPlc of [
    "https://plc.directory/subpath",
    "https://plc.directory?query=1",
    "https://plc.directory#frag",
    "http://plc.directory",
  ]) {
    resetConfigCacheForTest();
    process.env.PLC_URL = invalidPlc;
    assert.throws(getConfig);
  }

  delete process.env.PLC_URL;
  resetConfigCacheForTest();
  assert.equal(getConfig().plcDirectoryUrl.origin, "https://plc.directory");

  process.env.PLC_URL = "http://127.0.0.1:2582";
  resetConfigCacheForTest();
  assert.equal(getConfig().plcDirectoryUrl.origin, "http://127.0.0.1:2582");

  process.env.PLC_URL = "https://plc.directory";
  resetConfigCacheForTest();
});

test("isLoopback accepts only localhost, 127.0.0.1, ::1, and [::1] and rejects *.localhost", () => {
  for (const valid of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"]) {
    assert.equal(isLoopback(valid), true, `expected ${valid} to be loopback`);
  }
  for (const invalid of ["groups.localhost", "sub.localhost", "127.0.0.2", "example.com"]) {
    assert.equal(isLoopback(invalid), false, `expected ${invalid} not to be loopback`);
  }
  assert.throws(() => serviceUrl("GROUP_HOST_URL", "http://groups.localhost:3004"), /must use HTTPS/);
});

test("getDeskConfig works with zero Operator/secret env vars, defaults to :3005 in dev, fails closed in production when unset, prioritizes DESK_APP_URL, and enforces HTTPS outside loopback", () => {
  const env: Record<string, string | undefined> = process.env;
  const keys = ["NODE_ENV", "DESK_APP_URL", "APP_URL", "PLC_URL", "GROUP_HOST_URL", "OPERATOR_URL", "OPERATOR_SERVICE_REF", "AUTH_ENCRYPTION_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, env[k]]));
  try {
    for (const k of keys) delete env[k];
    resetConfigCacheForTest();

    assert.deepEqual([...DESK_ENV_FILE_KEYS], ["DESK_APP_URL", "PLC_URL", "GROUP_HOST_URL"]);

    // In production, missing DESK_APP_URL & APP_URL must fail closed instead of falling back to loopback.
    env.NODE_ENV = "production";
    resetConfigCacheForTest();
    assert.throws(getDeskConfig, /DESK_APP_URL.*required in production/);

    // Outside production, defaults cleanly to http://127.0.0.1:3005.
    env.NODE_ENV = "development";
    resetConfigCacheForTest();
    const def = getDeskConfig();
    assert.equal(def.appUrl.origin, "http://127.0.0.1:3005");
    assert.equal(def.plcDirectoryUrl.origin, "https://plc.directory");
    assert.equal(def.groupHostUrl?.origin, "http://127.0.0.1:3004");

    // APP_URL fallback works when DESK_APP_URL is unset
    env.APP_URL = "http://localhost:4100";
    resetConfigCacheForTest();
    assert.equal(getDeskConfig().appUrl.origin, "http://127.0.0.1:4100");

    // DESK_APP_URL overrides APP_URL
    env.DESK_APP_URL = "http://127.0.0.1:4200";
    resetConfigCacheForTest();
    assert.equal(getDeskConfig().appUrl.origin, "http://127.0.0.1:4200");

    // HTTPS required outside loopback; GROUP_HOST_URL optional outside loopback
    env.DESK_APP_URL = "http://desk.example.com";
    resetConfigCacheForTest();
    assert.throws(getDeskConfig, /must use HTTPS outside loopback development/);

    env.DESK_APP_URL = "https://desk.example.com";
    resetConfigCacheForTest();
    const prod = getDeskConfig();
    assert.equal(prod.appUrl.origin, "https://desk.example.com");
    assert.equal(prod.groupHostUrl, undefined);

    env.GROUP_HOST_URL = "http://groups.example.com";
    resetConfigCacheForTest();
    assert.throws(getDeskConfig, /GROUP_HOST_URL must use HTTPS outside loopback development/);

    env.GROUP_HOST_URL = "https://groups.example.com";
    resetConfigCacheForTest();
    assert.equal(getDeskConfig().groupHostUrl?.origin, "https://groups.example.com");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
    resetConfigCacheForTest();
  }
});
