import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AtprotoDid } from "@atproto/oauth-client-browser";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { wellKnownHandleResolver } from "./browser-session";

const realFetch = globalThis.fetch;
let responder: (url: string) => Response;

function fakeAsResolvedHandle(value: string): null | (string & AtprotoDid) {
  return /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value) ? (value as string & AtprotoDid) : null;
}

beforeEach(() => {
  globalThis.fetch = ((url: string) => Promise.resolve(responder(String(url)))) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the well-known handle resolver reads https://<handle>/.well-known/atproto-did directly, with no third-party service", async () => {
  responder = (url) => {
    assert.equal(url, "https://alice.test/.well-known/atproto-did");
    return new Response("did:plc:alice\n");
  };
  const resolver = wellKnownHandleResolver(fakeAsResolvedHandle);
  assert.equal(await resolver.resolve("alice.test"), "did:plc:alice");
});

test("a non-ok response resolves to null rather than throwing", async () => {
  responder = () => new Response("not found", { status: 404 });
  const resolver = wellKnownHandleResolver(fakeAsResolvedHandle);
  assert.equal(await resolver.resolve("missing.test"), null);
});

test("a network failure resolves to null rather than throwing", async () => {
  responder = () => { throw new Error("network down"); };
  const resolver = wellKnownHandleResolver(fakeAsResolvedHandle);
  assert.equal(await resolver.resolve("unreachable.test"), null);
});

test("a body that is not a valid DID resolves to null", async () => {
  responder = () => new Response("not a did");
  const resolver = wellKnownHandleResolver(fakeAsResolvedHandle);
  assert.equal(await resolver.resolve("alice.test"), null);
});

test("an oversized well-known body throws instead of being silently accepted", async () => {
  responder = () => new Response(`did:plc:${"a".repeat(1024)}`);
  const resolver = wellKnownHandleResolver(fakeAsResolvedHandle);
  await assert.rejects(resolver.resolve("huge.test"), UpstreamResponseTooLargeError);
});
