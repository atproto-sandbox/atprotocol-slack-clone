import assert from "node:assert/strict";
import test from "node:test";
import { OperatorRemoteError } from "@flock/client/operator-client";
import { ChannelUnavailableError } from "@flock/client/errors";
import { captureInviteLink, clearAccountScopedState, INVITE_LINK_KEY, inviteLinkFor, RETURN_TO_KEY, resolveScopedReplyTo, workspaceFromInviteSearch, isAccessFailure, needsAuthorityApproval, makeTid, mergeMessages, threadMessages, workspaceCreationFrom, workspaceOperationIdFor, parsePastedWorkspaceUri, splitDids, toSlug, withReactions, type Message } from "./client-api";

const message = (rkey: string): Message => ({ uri: `at:space/did:plc:a/x/${rkey}`, rkey, repo: "did:plc:a", value: { text: rkey } });

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
  assert.deepEqual(parsePastedWorkspaceUri(" at:space/did:plc:abc/new.flock.workspace/self "), { authorityDid: "did:plc:abc", skey: "self" });
  assert.equal(parsePastedWorkspaceUri("at:space/did:plc:abc/new.flock.workspace/team"), null);
  assert.equal(parsePastedWorkspaceUri("at:space/did:plc:abc/new.flock.channel/team"), null);
  assert.deepEqual(splitDids(" did:plc:a, did:plc:b\n"), ["did:plc:a", "did:plc:b"]);
  assert.equal(toSlug("  Project Room!! "), "project-room");
  assert.equal(toSlug("!!!"), "channel");
  assert.match(makeTid(), /^[2-7a-z]{13}$/);
  assert.equal(isAccessFailure(new ChannelUnavailableError("archived", "archived")), true);
  assert.equal(isAccessFailure(new OperatorRemoteError(403, "Unauthorized", "no")), true);
  assert.equal(isAccessFailure(new OperatorRemoteError(503, "UpstreamUnavailable", "down")), false);
  assert.equal(isAccessFailure(new Error("plain")), false);
});

test("only the operator's answers that the authority must approve its grant ask for the authority flow", () => {
  assert.equal(needsAuthorityApproval(new OperatorRemoteError(403, "AuthorizationRequired", "approve first")), true);
  assert.equal(needsAuthorityApproval(new OperatorRemoteError(502, "AuthoritySessionUnavailable", "approve again")), true);
  assert.equal(needsAuthorityApproval(new OperatorRemoteError(403, "Unauthorized", "not an admin")), false);
  assert.equal(needsAuthorityApproval(new OperatorRemoteError(423, "Paused", "paused")), false);
  assert.equal(needsAuthorityApproval(new Error("AuthorizationRequired")), false);
});

test("a stored workspace operation ID is reused only for the exact name it was issued for", () => {
  const stored = JSON.stringify({ name: "Acme", account: "did:plc:team", operationId: "2222222222222" });
  const mint = () => "3333333333333";
  assert.equal(workspaceOperationIdFor({ name: "Acme", account: "did:plc:team" }, stored, mint), "2222222222222", "same name and account resume the same operation");
  assert.equal(workspaceOperationIdFor({ name: "Acme Inc", account: "did:plc:team" }, stored, mint), "3333333333333", "a corrected name starts a fresh operation");
  assert.equal(workspaceOperationIdFor({ name: "Acme", account: "" }, stored, mint), "3333333333333", "another workspace account starts a fresh operation");
  assert.equal(workspaceOperationIdFor({ name: "Acme", account: "did:plc:team" }, null, mint), "3333333333333");
  for (const corrupt of ["", "not json", "null", "[]", JSON.stringify({ name: "Acme" }), JSON.stringify({ name: "Acme", operationId: "x" }), JSON.stringify({ name: 1, account: "", operationId: "x" })]) {
    assert.equal(workspaceOperationIdFor({ name: "Acme", account: "" }, corrupt, mint), "3333333333333", `ignores ${JSON.stringify(corrupt)}`);
  }
});

test("the creation form keys a trimmed name, and the person's own DID as no workspace account", () => {
  assert.deepEqual(workspaceCreationFrom({ name: "  Acme ", account: " did:plc:team " }, "did:plc:me"), { name: "Acme", account: "did:plc:team" });
  assert.deepEqual(workspaceCreationFrom({ name: "Acme", account: " did:plc:me" }, "did:plc:me"), { name: "Acme", account: "" });
  assert.deepEqual(workspaceCreationFrom({ name: "Acme", account: "" }, "did:plc:me"), { name: "Acme", account: "" });
});

test("invite links round-trip a workspace URI, normalize legacy alpha links, and reject anything else", () => {
  const uri = "at:space/did:plc:abc/new.flock.workspace/self";
  const link = inviteLinkFor("http://127.0.0.1:3000", uri);
  assert.equal(link, "http://127.0.0.1:3000/?invite=at%3Aspace%2Fdid%3Aplc%3Aabc%2Fnew.flock.workspace%2Fself");
  assert.equal(workspaceFromInviteSearch(new URL(link).search), uri);
  assert.equal(
    workspaceFromInviteSearch("?invite=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fspace%2Fnew.flock.workspace%2Fself"),
    uri,
    "legacy alpha invite links normalize to canonical at:space/ URI",
  );
  assert.deepEqual(
    parsePastedWorkspaceUri("at://did:plc:abc/space/new.flock.workspace/self"),
    { authorityDid: "did:plc:abc", skey: "self" },
    "pasted legacy workspace URIs normalize on entry",
  );
  for (const search of ["", "?invite=", "?invite=hello", "?invite=at%3Aspace%2Fdid%3Aplc%3Aabc%2Fnew.flock.channel%2Fgeneral", "?other=1", "?invite=javascript%3Aalert(1)"]) {
    assert.equal(workspaceFromInviteSearch(search), null, search);
  }
});

test("captureInviteLink stores only a valid workspace, so sign-in redirects cannot lose or forge one", () => {
  const stored = new Map<string, string>();
  const storage = { setItem: (key: string, value: string) => { stored.set(key, value); } };
  assert.equal(captureInviteLink("?invite=nonsense", storage), null);
  assert.equal(stored.size, 0);
  const uri = "at:space/did:plc:abc/new.flock.workspace/self";
  assert.equal(captureInviteLink(new URL(inviteLinkFor("http://x", uri)).search, storage), uri);
  assert.equal(stored.get(INVITE_LINK_KEY), uri);
});

test("workspace URIs must have the exact shape the server accepts, so a hostile link cannot render odd text", () => {
  const valid = "at:space/did:plc:abc/new.flock.workspace/self";
  assert.deepEqual(parsePastedWorkspaceUri(valid), { authorityDid: "did:plc:abc", skey: "self" });
  for (const bad of [
    "at://did:plc:ab\u202ec/space/new.flock.workspace/self",
    "at://did:plc:abc d/space/new.flock.workspace/self",
    `at://did:plc:${"a".repeat(600)}/space/new.flock.workspace/self`,
    "at:space/did:PLC:abc/new.flock.workspace/self",
    "at:space/did:plc:abc/new.flock.workspace/",
    "at:space/did:plc:abc/new.flock.workspace/acme-1",
  ]) assert.equal(parsePastedWorkspaceUri(bad), null, bad);
});

test("signing out clears this app's account-scoped session state including returnTo and nothing else", () => {
  const entries = new Map([["spaces.inviteLink", "a"], ["spaces.returnTo", "/w/did:plc:a/acme"], ["spaces.pendingInvite", "b"], ["spaces.pendingWorkspaceOperation", "c"], ["other.app", "keep"]]);
  const storage = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(key); },
  };
  clearAccountScopedState(storage);
  assert.deepEqual([...entries.keys()], ["other.app"]);
});

test("signing in clears a previous account's half-finished actions but keeps the pending invitation and returnTo", () => {
  const entries = new Map([["spaces.inviteLink", "a"], ["spaces.returnTo", "/w/did:plc:a/acme"], ["spaces.pendingInvite", "b"], ["spaces.autoCreateWorkspace", "c"], ["other.app", "keep"]]);
  const storage = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(key); },
  };
  clearAccountScopedState(storage, [INVITE_LINK_KEY, RETURN_TO_KEY]);
  assert.deepEqual([...entries.keys()].sort(), ["other.app", INVITE_LINK_KEY, RETURN_TO_KEY].sort());
});

test("threadMessages places each reply under its parent, oldest reply first, and leaves orphan replies in place", () => {
  // #given messages newest first, with two replies to "2" and one reply whose parent is not loaded
  const reply = (rkey: string, parent: string): Message => ({ ...message(rkey), value: { text: rkey, parent } });
  const incoming = [message("5"), reply("4b", message("2").uri), reply("orphan", "at:space/did:plc:a/x/unloaded"), reply("4a", message("2").uri), message("2"), message("1")];

  // #when
  const threaded = threadMessages(incoming);

  // #then
  assert.deepEqual(threaded.map(({ message: { rkey }, isReply }) => `${rkey}${isReply ? "^" : ""}`), ["5", "orphan", "2", "4a^", "4b^", "1"]);
});

test("resolveScopedReplyTo never leaks another route's reply draft across Back/Forward transitions (Codex #8)", () => {
  const routeA = "/w/did%3Aplc%3Aa/ws/c/general";
  const routeAThread = `${routeA}?thread=at%3A%2F%2FmsgA`;
  const routeB = "/w/did%3Aplc%3Aa/ws/c/random";
  const routeBThread = `${routeB}?thread=at%3A%2F%2FmsgB`;

  // Optimistic reply on channel B overrides channel B's routeThread immediately before router.replace settles.
  const draftInB = { routeKey: routeB, uri: "at://msgB" };
  assert.equal(resolveScopedReplyTo(routeB, "", draftInB), "at://msgB");

  // Once router.replace updates URL to routeBThread, draft matches settled thread seamlessly.
  assert.equal(resolveScopedReplyTo(routeBThread, "at://msgB", draftInB), "at://msgB");

  // Pressing Browser Back to channel A (either with ?thread=msgA or plain) immediately ignores channel B's draft.
  assert.equal(resolveScopedReplyTo(routeAThread, "at://msgA", draftInB), "at://msgA");
  assert.equal(resolveScopedReplyTo(routeA, "", draftInB), "");

  // Canceling reply on routeAThread overrides routeAThread with "" immediately until router.replace finishes.
  assert.equal(resolveScopedReplyTo(routeAThread, "at://msgA", { routeKey: routeAThread, uri: "" }), "");
});
