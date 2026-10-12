import assert from "node:assert/strict";
import test from "node:test";
import { isSenderAllowedUnderMode, modeForInboxPolicy, writePolicyForMode } from "./request-policy";

test("writePolicyForMode maps everyone to public and every other mode to memberList", () => {
  assert.equal(writePolicyForMode("everyone"), "public");
  assert.equal(writePolicyForMode("allowlist"), "memberList");
  assert.equal(writePolicyForMode("nobody"), "memberList");
});

test("modeForInboxPolicy inverts writePolicyForMode, using active (write:true) members to split allowlist from nobody", () => {
  assert.equal(modeForInboxPolicy("public", []), "everyone");
  assert.equal(modeForInboxPolicy("public", [{ did: "did:plc:a", write: true }]), "everyone");
  assert.equal(modeForInboxPolicy("memberList", []), "nobody");
  assert.equal(modeForInboxPolicy("memberList", [{ did: "did:plc:a", write: true }]), "allowlist");
  assert.equal(modeForInboxPolicy("memberList", [{ did: "did:plc:a", write: false }]), "nobody", "a dormant-only member list reports nobody");
  assert.equal(modeForInboxPolicy("memberList", [{ did: "did:plc:a", write: false }, { did: "did:plc:b", write: true }]), "allowlist", "any active member reports allowlist");
});

test("isSenderAllowedUnderMode enforces client-side filtering regardless of PDS-side tracking", () => {
  const sender = "did:plc:sender";
  assert.equal(isSenderAllowedUnderMode({ mode: "everyone", allowlist: [], senderDid: sender }), true);
  assert.equal(isSenderAllowedUnderMode({ mode: "nobody", allowlist: [sender], senderDid: sender }), false, "nobody mode rejects even an already-tracked writer");
  assert.equal(isSenderAllowedUnderMode({ mode: "allowlist", allowlist: [sender], senderDid: sender }), true);
  assert.equal(isSenderAllowedUnderMode({ mode: "allowlist", allowlist: ["did:plc:someone-else"], senderDid: sender }), false, "a stranger tracked under an earlier public policy is filtered out");
});
