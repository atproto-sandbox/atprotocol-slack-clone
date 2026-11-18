import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AtprotoDid } from "@atproto/oauth-client-browser";
import { UpstreamResponseTooLargeError } from "@flock/protocol/bounded-json";
import { SPACE_TYPE, type SpaceType } from "@flock/protocol/nsids";
import { spaceCollections } from "@flock/protocol/registry";
import { memberGrantScopes } from "@flock/protocol/scopes";
import { missingScopes, wellKnownHandleResolver } from "./session";

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
  const accountDid = "did:plc:abc";
  const required = "atproto repo:new.flock.dm.declaration?action=create&action=update space:new.flock.dm.inbox?authority=self&action=read";
  assert.deepEqual(
    missingScopes("repo:new.flock.dm.declaration?action=create&action=update space:new.flock.dm.inbox?authority=did:plc:abc&collection=new.flock.dm.request&action=read atproto", required, accountDid),
    [],
  );
  assert.deepEqual(
    missingScopes("atproto space:new.flock.dm.inbox?authority=did:plc:abc&collection=new.flock.dm.request&action=read", required, accountDid),
    ["repo:new.flock.dm.declaration?action=create&action=update"],
    "a session granted before the declaration grant existed",
  );
  assert.deepEqual(missingScopes("", "atproto", accountDid), ["atproto"]);
  assert.deepEqual(missingScopes("atproto  extra", "atproto", accountDid), [], "extra grants and repeated spaces are fine");
});

test("missingScopes accepts the scope string a real PDS returns for the DM and full member grants, and flags pre-R10 grants", () => {
  const accountDid = "did:plc:xezitkdo3czy5oedz2gww3l2";
  // Captured from the real OAuth flow in protocol-tests/browser/dm.spec.ts: the PDS resolves authority=self and expands read grants.
  const granted = [
    "atproto",
    "space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=create&action=update&action=delete",
    `space:new.flock.dm.inbox?authority=${accountDid}&collection=new.flock.dm.request&action=read&manage=create&manage=update`,
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
  assert.deepEqual(missingScopes(granted.join(" "), required, accountDid), []);
  assert.deepEqual(missingScopes(granted.filter((token) => !token.startsWith("repo:")).join(" "), required, accountDid), ["repo:new.flock.dm.declaration?action=create&action=update"]);

  // Full memberGrantScopes as rewritten by the PDS at token issuance (no consent loop on current sessions).
  const fullRequired = memberGrantScopes("did:web:operator.example#atproto_flock_operator");
  const pdsRewritten = fullRequired.map((token) => {
    if (!token.startsWith("space:")) return token;
    const [head, query = ""] = token.split("?");
    const spaceType = head!.slice("space:".length) as SpaceType;
    const params = new URLSearchParams(query);
    if (params.get("authority") === "self") params.set("authority", accountDid);
    if (params.getAll("collection").length === 0) {
      for (const collection of spaceCollections(spaceType)) params.append("collection", collection);
    }
    return `${head}?${params.toString()}`;
  });
  assert.deepEqual(missingScopes(pdsRewritten.join(" "), fullRequired.join(" "), accountDid), []);

  // A pre-R10 session without new.flock.app.inbox is flagged for re-consent.
  const preR10 = pdsRewritten.filter((token) => !token.startsWith(`space:${SPACE_TYPE.appInbox}`));
  assert.deepEqual(
    missingScopes(preR10.join(" "), fullRequired.join(" "), accountDid),
    fullRequired.filter((token) => token.startsWith(`space:${SPACE_TYPE.appInbox}`)),
  );
});

test("missingScopes refuses over-acceptance: missing collection, read for write, missing manage, self-only for wildcard, foreign DID, split tokens, and wrong space type", () => {
  const alice = "did:plc:alice";
  const bob = "did:plc:bob";

  // 1. Missing collection (workspace read missing new.flock.app.install, or app.inbox write missing new.flock.app.action).
  assert.deepEqual(
    missingScopes(
      "space:new.flock.workspace?authority=*&collection=new.flock.workspace.profile&collection=new.flock.directory&collection=new.flock.workspace.roster&collection=new.flock.admin&collection=new.flock.acceptance&action=read",
      "space:new.flock.workspace?authority=*&action=read",
      alice,
    ),
    ["space:new.flock.workspace?authority=*&action=read"],
  );
  assert.deepEqual(
    missingScopes(
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&action=create&action=delete",
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete",
      alice,
    ),
    ["space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete"],
  );

  // 2. Read taken for a write.
  assert.deepEqual(
    missingScopes(
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=read",
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete",
      alice,
    ),
    ["space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete"],
  );

  // 3. Missing manage value.
  assert.deepEqual(
    missingScopes(
      `space:new.flock.dm.inbox?authority=${alice}&collection=new.flock.dm.request&action=read&manage=create`,
      "space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update",
      alice,
    ),
    ["space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update"],
  );

  // 4. Self-only grant for an authority=* request, and another user's DID for authority=self.
  assert.deepEqual(
    missingScopes(
      `space:new.flock.dm.conversation?authority=${alice}&collection=new.flock.dm.header&collection=new.flock.dm.message&collection=new.flock.dm.reaction&action=read`,
      "space:new.flock.dm.conversation?authority=*&action=read",
      alice,
    ),
    ["space:new.flock.dm.conversation?authority=*&action=read"],
  );
  assert.deepEqual(
    missingScopes(
      `space:new.flock.dm.inbox?authority=${bob}&collection=new.flock.dm.request&action=read&manage=create&manage=update`,
      "space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update",
      alice,
    ),
    ["space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update"],
  );
  // Wildcard authority grant DOES cover an authority=self request.
  assert.deepEqual(
    missingScopes(
      "space:new.flock.dm.inbox?authority=*&collection=new.flock.dm.request&action=read&manage=create&manage=update",
      "space:new.flock.dm.inbox?authority=self&action=read&manage=create&manage=update",
      alice,
    ),
    [],
  );

  // 5. Another space type does not cover.
  assert.deepEqual(
    missingScopes(
      "space:new.flock.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete",
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete",
      alice,
    ),
    ["space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete"],
  );

  // 6. Two half-grants do not combine to cover a single required token whole.
  assert.deepEqual(
    missingScopes(
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&action=create&action=delete space:new.flock.app.inbox?authority=*&collection=new.flock.app.action&action=create&action=delete",
      "space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete",
      alice,
    ),
    ["space:new.flock.app.inbox?authority=*&collection=new.flock.app.command&collection=new.flock.app.action&action=create&action=delete"],
  );
});
