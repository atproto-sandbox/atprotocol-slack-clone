import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError, captureInviteLink, clearAccountScopedState, INVITE_LINK_KEY, inviteLinkFor, workspaceFromInviteSearch, isAccessFailure, isAuthorizationRequired, makeTid, mergeMessages, threadMessages, workspaceOperationIdFor, parseWorkspaceUri, splitDids, toSlug, withReactions, type Message } from "./client-api";

const message = (rkey: string): Message => ({ uri: `at://did:plc:a/space/x/${rkey}`, rkey, repo: "did:plc:a", value: { text: rkey } });

test("withReactions counts per emoji and marks the viewer's own reactions", () => {
  const [first, second] = withReactions([message("2"), message("1")], [
    { repo: "did:plc:me", value: { subject: message("2").uri, emoji: "💜" } },
    { repo: "did:plc:b", value: { subject: message("2").uri, emoji: "💜" } },
    { repo: "did:plc:b", value: { subject: message("2").uri, emoji: "👍" } },
    { repo: "did:plc:b", value: { subject: 42 as unknown as string, emoji: "👍" } },
  ], "did:plc:me");
  assert.deepEqual(first.reactions, [{ emoji: "💜", count: 2, active: true }, { emoji: "👍", count: 1, active: false }]);
  assert.deepEqual(second.reactions, []);
});

test("mergeMessages dedupes by URI and sorts newest first", () => {
  assert.deepEqual(mergeMessages([message("3"), message("2")], [message("2"), message("1")], true).map((entry) => entry.rkey), ["3", "2", "1"]);
  assert.deepEqual(mergeMessages([message("3")], [message("1")], false).map((entry) => entry.rkey), ["1"]);
});

test("client helpers parse workspace URIs, DID lists, slugs, TIDs, and access failures", () => {
  assert.deepEqual(parseWorkspaceUri(" at://did:plc:abc/space/org.slack.workspace/team "), { authorityDid: "did:plc:abc", skey: "team" });
  assert.equal(parseWorkspaceUri("at://did:plc:abc/space/org.slack.channel/team"), null);
  assert.deepEqual(splitDids(" did:plc:a, did:plc:b\n"), ["did:plc:a", "did:plc:b"]);
  assert.equal(toSlug("  Project Room!! "), "project-room");
  assert.equal(toSlug("!!!"), "channel");
  assert.match(makeTid(), /^[2-7a-z]{13}$/);
  assert.equal(isAccessFailure(new ApiError(409, "archived")), true);
  assert.equal(isAccessFailure(new ApiError(500, "down")), false);
  assert.equal(isAccessFailure(new Error("plain")), false);
});

test("api() surfaces a typed error code, and only the authorization-required 403 is treated as such", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: "Workspace setup needs your permission first.", code: "authorization_required" }, { status: 403 });
    const caught = await api("/api/workspaces/bootstrap", { method: "POST", body: "{}" }).catch((error: unknown) => error);
    assert.ok(caught instanceof ApiError);
    assert.equal(caught.status, 403);
    assert.equal(caught.code, "authorization_required");
    assert.equal(isAuthorizationRequired(caught), true);

    globalThis.fetch = async () => Response.json({ error: "Forbidden." }, { status: 403 });
    const plain = await api("/api/anything").catch((error: unknown) => error);
    assert.equal(isAuthorizationRequired(plain), false, "a plain 403 has no code");
    assert.equal(isAuthorizationRequired(new ApiError(400, "x", "authorization_required")), false, "the code only counts on a 403");
    assert.equal(isAuthorizationRequired(new Error("authorization_required")), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("a stored workspace operation ID is reused only for the exact name it was issued for", () => {
  const stored = JSON.stringify({ name: "Acme", operationId: "2222222222222" });
  const mint = () => "3333333333333";
  assert.equal(workspaceOperationIdFor("Acme", stored, mint), "2222222222222", "same name resumes the same operation");
  assert.equal(workspaceOperationIdFor("Acme Inc", stored, mint), "3333333333333", "a corrected name starts a fresh operation");
  assert.equal(workspaceOperationIdFor("Acme", null, mint), "3333333333333");
  for (const corrupt of ["", "not json", "null", "[]", JSON.stringify({ name: "Acme" }), JSON.stringify({ name: 1, operationId: "x" })]) {
    assert.equal(workspaceOperationIdFor("Acme", corrupt, mint), "3333333333333", `ignores ${JSON.stringify(corrupt)}`);
  }
});

test("invite links round-trip a workspace URI and reject anything that is not one", () => {
  const uri = "at://did:plc:abc/space/org.slack.workspace/acme-1";
  const link = inviteLinkFor("http://127.0.0.1:3000", uri);
  assert.equal(link, "http://127.0.0.1:3000/?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Forg.slack.workspace%2Facme-1");
  assert.equal(workspaceFromInviteSearch(new URL(link).search), uri);
  for (const search of ["", "?invite=", "?invite=hello", "?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Forg.slack.channel%2Fgeneral", "?other=1", "?invite=javascript%3Aalert(1)"]) {
    assert.equal(workspaceFromInviteSearch(search), null, search);
  }
});

test("captureInviteLink stores only a valid workspace, so sign-in redirects cannot lose or forge one", () => {
  const stored = new Map<string, string>();
  const storage = { setItem: (key: string, value: string) => { stored.set(key, value); } };
  assert.equal(captureInviteLink("?invite=nonsense", storage), null);
  assert.equal(stored.size, 0);
  const uri = "at://did:plc:abc/space/org.slack.workspace/acme-1";
  assert.equal(captureInviteLink(new URL(inviteLinkFor("http://x", uri)).search, storage), uri);
  assert.equal(stored.get(INVITE_LINK_KEY), uri);
});

test("workspace URIs must have the exact shape the server accepts, so a hostile link cannot render odd text", () => {
  const valid = "at://did:plc:abc/space/org.slack.workspace/acme-1";
  assert.deepEqual(parseWorkspaceUri(valid), { authorityDid: "did:plc:abc", skey: "acme-1" });
  for (const bad of [
    "at://did:plc:ab\u202ec/space/org.slack.workspace/acme-1",
    "at://did:plc:abc d/space/org.slack.workspace/acme-1",
    `at://did:plc:${"a".repeat(600)}/space/org.slack.workspace/acme-1`,
    "at://did:PLC:abc/space/org.slack.workspace/acme-1",
    "at://did:plc:abc/space/org.slack.workspace/",
  ]) assert.equal(parseWorkspaceUri(bad), null, bad);
});

test("signing out clears this app's account-scoped session state and nothing else", () => {
  const entries = new Map([["spaces.inviteLink", "a"], ["spaces.pendingInvite", "b"], ["spaces.pendingWorkspaceOperation", "c"], ["other.app", "keep"]]);
  const storage = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(key); },
  };
  clearAccountScopedState(storage);
  assert.deepEqual([...entries.keys()], ["other.app"]);
});

test("signing in clears a previous account's half-finished actions but keeps the pending invitation", () => {
  const entries = new Map([["spaces.inviteLink", "a"], ["spaces.pendingInvite", "b"], ["spaces.autoCreateWorkspace", "c"], ["other.app", "keep"]]);
  const storage = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(key); },
  };
  clearAccountScopedState(storage, [INVITE_LINK_KEY]);
  assert.deepEqual([...entries.keys()].sort(), ["other.app", INVITE_LINK_KEY].sort());
});

test("threadMessages places each reply under its parent, oldest reply first, and leaves orphan replies in place", () => {
  // #given messages newest first, with two replies to "2" and one reply whose parent is not loaded
  const reply = (rkey: string, parent: string): Message => ({ ...message(rkey), value: { text: rkey, parent } });
  const incoming = [message("5"), reply("4b", message("2").uri), reply("orphan", "at://did:plc:a/space/x/unloaded"), reply("4a", message("2").uri), message("2"), message("1")];

  // #when
  const threaded = threadMessages(incoming);

  // #then
  assert.deepEqual(threaded.map(({ message: { rkey }, isReply }) => `${rkey}${isReply ? "^" : ""}`), ["5", "orphan", "2", "4a^", "4b^", "1"]);
});
