import assert from "node:assert/strict";
import test from "node:test";
import { AtprotoClient, isMissingXrpcResource, isScopeMissingError } from "./xrpc";

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
  await assert.rejects(scopeMissing.procedure("com.atproto.simplespace.createSpace", {}), (error: unknown) => {
    assert.equal(isScopeMissingError(error), true);
    return true;
  });
  const otherForbidden = new AtprotoClient(async () => Response.json({ error: "UserNotAuthorized", message: "Denied." }, { status: 403 }));
  await assert.rejects(otherForbidden.procedure("com.atproto.simplespace.createSpace", {}), (error: unknown) => {
    assert.equal(isScopeMissingError(error), false);
    return true;
  });
  assert.equal(isScopeMissingError(new Error('Missing required scope "space:x"')), false, "message text alone is not trusted");
});
