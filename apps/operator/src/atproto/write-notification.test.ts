import assert from "node:assert/strict";
import test from "node:test";
import { parseConfirmRegistration, parseSpaceUpdateNotification, UPDATE_TYPE } from "./write-notification";

const SPACE = "at:space/did:plc:authority/new.flock.workspace/team";
const TOKEN = "stable-webhook-token-0123456789abcdef";
const REPO = "did:plc:member";
const REPO_REV = "3kabcdefghij2";
const SPACE_REV = "3kabcdefghij3";
const PREV_SPACE_REV = "3kabcdefghij2";
const COMMIT_DIGEST = new Uint8Array(Buffer.from("q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA", "base64"));

test("parseConfirmRegistration validates { space, token, challenge } and rejects unexpected or malformed fields", () => {
  assert.deepEqual(
    parseConfirmRegistration({ space: SPACE, token: TOKEN, challenge: "challenge-nonce-123" }),
    { space: SPACE, token: TOKEN, challenge: "challenge-nonce-123" },
  );
  assert.equal(parseConfirmRegistration({ space: SPACE, token: TOKEN }), null, "missing challenge");
  assert.equal(parseConfirmRegistration({ space: SPACE, token: "", challenge: "c" }), null, "empty token");
  assert.equal(parseConfirmRegistration({ space: SPACE, token: "x".repeat(513), challenge: "c" }), null, "overlong token");
  assert.equal(parseConfirmRegistration({ space: SPACE, token: TOKEN, challenge: "" }), null, "empty challenge");
  assert.equal(parseConfirmRegistration({ space: "at://not-a-space", token: TOKEN, challenge: "c" }), null, "invalid space");
  assert.equal(parseConfirmRegistration({ space: SPACE, token: TOKEN, challenge: "c", extra: 1 }), null, "unexpected field");
  assert.equal(parseConfirmRegistration(null), null);
  assert.equal(parseConfirmRegistration([SPACE]), null);
});

test("parseSpaceUpdateNotification dispatches #repoWrite with decoded lexicon bytes and optional prevSpaceRev", () => {
  const withPrev = parseSpaceUpdateNotification({
    space: SPACE,
    token: TOKEN,
    update: {
      $type: UPDATE_TYPE.repoWrite,
      repo: REPO,
      repoRev: REPO_REV,
      spaceRev: SPACE_REV,
      prevSpaceRev: PREV_SPACE_REV,
      data: COMMIT_DIGEST,
    },
  });
  assert.deepEqual(withPrev, {
    space: SPACE,
    token: TOKEN,
    update: { kind: "repoWrite", repo: REPO, repoRev: REPO_REV, spaceRev: SPACE_REV, prevSpaceRev: PREV_SPACE_REV },
  });

  const withoutPrev = parseSpaceUpdateNotification({
    space: SPACE,
    token: TOKEN,
    update: {
      $type: UPDATE_TYPE.repoWrite,
      repo: REPO,
      repoRev: REPO_REV,
      spaceRev: SPACE_REV,
      data: COMMIT_DIGEST,
    },
  });
  assert.deepEqual(withoutPrev, {
    space: SPACE,
    token: TOKEN,
    update: { kind: "repoWrite", repo: REPO, repoRev: REPO_REV, spaceRev: SPACE_REV },
  });
});

test("parseSpaceUpdateNotification rejects malformed #repoWrite digests, DIDs, and TIDs", () => {
  const baseUpdate = {
    $type: UPDATE_TYPE.repoWrite,
    repo: REPO,
    repoRev: REPO_REV,
    spaceRev: SPACE_REV,
    data: COMMIT_DIGEST,
  };
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, data: "base64string" } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, data: { $bytes: "abc" } } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, data: new Uint8Array(4) } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, data: new Uint8Array(200) } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, repo: "not-a-did" } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, repoRev: "not-a-tid" } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, spaceRev: "not-a-tid" } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { ...baseUpdate, prevSpaceRev: "bad-tid" } }), null);
});

test("parseSpaceUpdateNotification dispatches #repoRemoved, #registrationExpired, and #spaceDeleted", () => {
  assert.deepEqual(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.repoRemoved, repo: REPO, spaceRev: SPACE_REV, prevSpaceRev: PREV_SPACE_REV },
    }),
    {
      space: SPACE,
      token: TOKEN,
      update: { kind: "repoRemoved", repo: REPO, spaceRev: SPACE_REV, prevSpaceRev: PREV_SPACE_REV },
    },
  );
  assert.equal(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.repoRemoved, repo: "not-a-did", spaceRev: SPACE_REV },
    }),
    null,
  );

  assert.deepEqual(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.registrationExpired, spaceRev: SPACE_REV },
    }),
    {
      space: SPACE,
      token: TOKEN,
      update: { kind: "registrationExpired", spaceRev: SPACE_REV },
    },
  );
  assert.equal(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.registrationExpired, spaceRev: "not-a-tid" },
    }),
    null,
  );

  assert.deepEqual(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.spaceDeleted },
    }),
    {
      space: SPACE,
      token: TOKEN,
      update: { kind: "spaceDeleted" },
    },
  );
});

test("parseSpaceUpdateNotification enforces outer envelope boundaries and rejects unknown $type or nested token/space", () => {
  assert.equal(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.spaceDeleted, token: TOKEN },
    }),
    null,
    "token must never appear inside update",
  );
  assert.equal(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: UPDATE_TYPE.spaceDeleted, space: SPACE },
    }),
    null,
    "space must never appear inside update",
  );
  assert.equal(
    parseSpaceUpdateNotification({
      space: SPACE,
      token: TOKEN,
      update: { $type: "com.atproto.space.notifySpaceUpdate#futureVariant" },
    }),
    null,
  );
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: "", update: { $type: UPDATE_TYPE.spaceDeleted } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, update: { $type: UPDATE_TYPE.spaceDeleted } }), null);
  assert.equal(parseSpaceUpdateNotification({ space: SPACE, token: TOKEN, update: { $type: UPDATE_TYPE.spaceDeleted }, extra: true }), null);
});
