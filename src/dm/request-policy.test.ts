import assert from "node:assert/strict";
import test from "node:test";
import { isSenderAllowedUnderMode, modeForInboxPolicy, publicWriteForMode } from "./request-policy";

test("publicWriteForMode opens writes only for everyone", () => {
  assert.equal(publicWriteForMode("everyone"), true);
  assert.equal(publicWriteForMode("allowlist"), false);
  assert.equal(publicWriteForMode("nobody"), false);
});

test("modeForInboxPolicy inverts publicWriteForMode, using active (write:true) members to split allowlist from nobody", () => {
  assert.equal(modeForInboxPolicy(true, []), "everyone");
  assert.equal(modeForInboxPolicy(true, [{ did: "did:plc:a", write: true }]), "everyone");
  assert.equal(modeForInboxPolicy(false, []), "nobody");
  assert.equal(modeForInboxPolicy(false, [{ did: "did:plc:a", write: true }]), "allowlist");
  assert.equal(modeForInboxPolicy(false, [{ did: "did:plc:a", write: false }]), "nobody", "a dormant-only member list reports nobody");
  assert.equal(modeForInboxPolicy(false, [{ did: "did:plc:a", write: false }, { did: "did:plc:b", write: true }]), "allowlist", "any active member reports allowlist");
});

test("isSenderAllowedUnderMode enforces client-side filtering regardless of PDS-side tracking", () => {
  const sender = "did:plc:sender";
  assert.equal(isSenderAllowedUnderMode({ mode: "everyone", allowlist: [], senderDid: sender }), true);
  assert.equal(isSenderAllowedUnderMode({ mode: "nobody", allowlist: [sender], senderDid: sender }), false, "nobody mode rejects even an already-tracked writer");
  assert.equal(isSenderAllowedUnderMode({ mode: "allowlist", allowlist: [sender], senderDid: sender }), true);
  assert.equal(isSenderAllowedUnderMode({ mode: "allowlist", allowlist: ["did:plc:someone-else"], senderDid: sender }), false, "a stranger tracked under an earlier public policy is filtered out");
});
