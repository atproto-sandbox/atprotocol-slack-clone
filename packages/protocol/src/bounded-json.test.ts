import assert from "node:assert/strict";
import test from "node:test";
import { readUpstreamJson, readUpstreamText, UpstreamResponseTooLargeError } from "./bounded-json";

test("upstream JSON enforces streamed byte limits and tolerates invalid JSON", async () => {
  const oversized = new Response(JSON.stringify({ value: "body too large" }));
  await assert.rejects(readUpstreamJson(oversized, 8), UpstreamResponseTooLargeError);

  const malformed = new Response("not json");
  assert.equal(await readUpstreamJson(malformed, 64), null);
});

test("upstream text enforces streamed byte limits and decodes UTF-8", async () => {
  const oversized = new Response("did:plc:this-is-a-very-long-identifier-value");
  await assert.rejects(readUpstreamText(oversized, 8), UpstreamResponseTooLargeError);

  const valid = new Response("did:plc:alice");
  assert.equal(await readUpstreamText(valid, 64), "did:plc:alice");
});
