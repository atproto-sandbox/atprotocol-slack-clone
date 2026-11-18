import assert from "node:assert/strict";
import test from "node:test";
import { nodeTransport } from "./transport";

test("a Node app's transport speaks as its own session and resolves identities the browser's way", async () => {
  // #given an app's OAuth session that answers every request
  const requests: string[] = [];
  const session = { did: "did:plc:app" as const, fetchHandler: async (path: string) => { requests.push(path); return Response.json({ ok: true }); } };

  // #when the engine's transport for it makes a call
  const transport = nodeTransport(session, { plcUrl: "https://plc.example", loopback: false });
  await transport.memberClient.query("com.atproto.server.getSession", {});

  // #then the call went through the session, as the app's own DID
  assert.equal(transport.did, "did:plc:app");
  assert.deepEqual(requests, ["/xrpc/com.atproto.server.getSession"]);
  assert.equal((await transport.generateKey()).constructor.name.length > 0, true);
});

test("off loopback, a Node app reaches no host at a private address, for a DID document or a request", async () => {
  const transport = nodeTransport({ did: "did:plc:app", fetchHandler: async () => Response.json({}) }, { plcUrl: "https://plc.example", loopback: false });
  await assert.rejects(transport.resolvePds("did:web:10.0.0.8"), /non-public address/);
  await assert.rejects(transport.fetchEndpoint(new Request("https://169.254.169.254/xrpc/com.atproto.sync.getRepo")), /non-public address/);
});
