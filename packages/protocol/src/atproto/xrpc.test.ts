import assert from "node:assert/strict";
import test from "node:test";
import {
  AtprotoClient,
  isAccountSuspendedError,
  isInvalidCursorError,
  isMissingXrpcResource,
  isScopeMissingError,
  isSpaceAlreadyExists,
} from "./xrpc";

test("XRPC missing-record errors retain their lexicon error code", async () => {
  const client = new AtprotoClient(async () => Response.json({ error: "RecordNotFound", message: "Missing record." }, { status: 400 }));
  await assert.rejects(client.query("com.atproto.space.getRecord"), (error: unknown) => {
    assert.equal(isMissingXrpcResource(error), true);
    return true;
  });
});

test("XRPC authorization and server errors are not treated as missing records", async () => {
  const client = new AtprotoClient(async () => Response.json({ error: "Unauthorized", message: "Denied." }, { status: 401 }));
  await assert.rejects(client.query("com.atproto.space.getRecord"), (error: unknown) => {
    assert.equal(isMissingXrpcResource(error), false);
    return true;
  });
});

test("a PDS missing-scope rejection is recognized from its error name, and other 403s are not", async () => {
  const scopeMissing = new AtprotoClient(async () => Response.json({ error: "ScopeMissingError", message: 'Missing required scope "space:x"' }, { status: 403 }));
  await assert.rejects(scopeMissing.procedure("com.atproto.space.createSpace", {}), (error: unknown) => {
    assert.equal(isScopeMissingError(error), true);
    return true;
  });
  const otherForbidden = new AtprotoClient(async () => Response.json({ error: "AccountNotAuthorized", message: "Denied." }, { status: 403 }));
  await assert.rejects(otherForbidden.procedure("com.atproto.space.createSpace", {}), (error: unknown) => {
    assert.equal(isScopeMissingError(error), false);
    return true;
  });
  assert.equal(isScopeMissingError(new Error('Missing required scope "space:x"')), false, "message text alone is not trusted");
});

test("isInvalidCursorError and isAccountSuspendedError match exact R12 error codes", async () => {
  const invalidCursor = new AtprotoClient(async () => Response.json({ error: "InvalidCursor", message: "Malformed cursor" }, { status: 400 }));
  await assert.rejects(invalidCursor.query("com.atproto.space.listWriters"), (error: unknown) => {
    assert.equal(isInvalidCursorError(error), true);
    assert.equal(isAccountSuspendedError(error), false);
    return true;
  });
  for (const code of ["AccountTakedown", "AccountDeactivated"] as const) {
    const suspended = new AtprotoClient(async () => Response.json({ error: code, message: code }, { status: 401 }));
    await assert.rejects(suspended.procedure("com.atproto.space.updateSpace", {}), (error: unknown) => {
      assert.equal(isAccountSuspendedError(error), true);
      assert.equal(isInvalidCursorError(error), false);
      return true;
    });
  }
});

test("createSpace's SpaceAlreadyExists is recognized from its error name, and other failures are not", async () => {
  const conflict = new AtprotoClient(async () => Response.json({ error: "SpaceAlreadyExists", message: "Space already exists" }, { status: 400 }));
  await assert.rejects(conflict.procedure("com.atproto.space.createSpace", {}), (error: unknown) => {
    assert.equal(isSpaceAlreadyExists(error), true);
    return true;
  });
  const other = new AtprotoClient(async () => Response.json({ error: "UnsupportedPolicy", message: "No." }, { status: 400 }));
  await assert.rejects(other.procedure("com.atproto.space.createSpace", {}), (error: unknown) => {
    assert.equal(isSpaceAlreadyExists(error), false);
    return true;
  });
  assert.equal(isSpaceAlreadyExists(Object.assign(new Error("something already exists"), { status: 409 })), false, "neither a 409 nor message text counts");
});
