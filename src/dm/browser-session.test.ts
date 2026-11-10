import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AtprotoDid } from "@atproto/oauth-client-browser";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { missingScopes, wellKnownHandleResolver } from "./browser-session";

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

test("missingScopes names the required scope tokens a stored grant lacks, whatever their order", () => {
  const required = "atproto repo:new.flock.dm.declaration?action=create&action=update space:new.flock.dm.inbox?authority=self&action=read";
  assert.deepEqual(missingScopes("repo:new.flock.dm.declaration?action=create&action=update atproto", required), [], "space tokens are not compared: the PDS rewrites them");
  assert.deepEqual(missingScopes("atproto space:new.flock.dm.inbox?authority=did:plc:abc&collection=new.flock.dm.request&action=read", required), ["repo:new.flock.dm.declaration?action=create&action=update"], "a session granted before the declaration grant existed");
  assert.deepEqual(missingScopes("", "atproto"), ["atproto"]);
  assert.deepEqual(missingScopes("atproto  extra", "atproto"), [], "extra grants and repeated spaces are fine");
});

test("missingScopes accepts the scope string a real PDS returns for the DM grant, and flags the same grant without the declaration token", () => {
  // Captured from the real OAuth flow in protocol-tests/browser/dm.spec.ts: the PDS resolves authority=self and expands read grants.
  const granted = [
    "atproto",
    "space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=create&action=update&action=delete",
    "space:new.flock.dm.inbox?authority=did:plc:xezitkdo3czy5oedz2gww3l2&collection=new.flock.dm.request&action=read&manage=create&manage=update",
    "repo:new.flock.dm.declaration?action=create&action=update",
    "space:new.flock.dm.conversation?authority=*&collection=new.flock.dm.header&collection=new.flock.dm.message&collection=new.flock.dm.reaction&action=read",
  ];
  const required = [
    "atproto",
    "space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=create&action=update&action=delete",
    "space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update",
    "repo:new.flock.dm.declaration?action=create&action=update",
    "space:new.flock.dm.conversation?authority=*&action=read",
  ].join(" ");
  assert.deepEqual(missingScopes(granted.join(" "), required), []);
  assert.deepEqual(missingScopes(granted.filter((token) => !token.startsWith("repo:")).join(" "), required), ["repo:new.flock.dm.declaration?action=create&action=update"]);
});
