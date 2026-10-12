import assert from "node:assert/strict";
import test from "node:test";
import { readRequestJson, readUpstreamJson, readUpstreamText, RequestJsonError, UpstreamResponseTooLargeError } from "./bounded-json";

test("request JSON enforces declared and streamed byte limits", async () => {
  const declared = new Request("https://example.test", {
    method: "POST",
    headers: { "content-length": "100", "content-type": "application/json" },
    body: "{}",
  });
  await assert.rejects(readRequestJson(declared, 8), (error: unknown) => error instanceof RequestJsonError && error.status === 413);

  const actual = new Request("https://example.test", {
    method: "POST",
    headers: { "content-length": "1", "content-type": "application/json" },
    body: JSON.stringify({ value: "a body larger than eight bytes" }),
  });
  await assert.rejects(readRequestJson(actual, 8), (error: unknown) => error instanceof RequestJsonError && error.status === 413);
});

test("request JSON parses valid UTF-8 and rejects malformed JSON", async () => {
  const valid = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "💜" }) });
  assert.deepEqual(await readRequestJson(valid), { text: "💜" });

  const malformed = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  await assert.rejects(readRequestJson(malformed), (error: unknown) => error instanceof RequestJsonError && error.status === 400);
});

test("request JSON requires an application/json content type", async () => {
  const plainText = new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ action: "mutate" }),
  });
  await assert.rejects(readRequestJson(plainText), (error: unknown) => error instanceof RequestJsonError && error.status === 415);
});

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
