import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCanonicalMigrationManifest,
  verifyMigrationManifestDigest,
} from "./migration-manifest";

test("computeCanonicalMigrationManifest produces deterministic UTF-16 sorted RFC 8785 JSON and SHA-256 digest", () => {
  const inputA = {
    groupDid: "did:plc:group1",
    operationId: "op-1",
    deadlineAtMs: 1_700_000_000_000,
    sourceLocalRotationKey: "did:key:zDnaerx9CtbPJ1q36T5Ln5wYt3MQYeGRG5ehnPAmxcf5mDZpv",
    publicRepoDataRootCid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    publicRecords: [
      { collection: "org.atgrp.declaration", rkey: "self", cid: "cid-1" },
      { collection: "app.bsky.actor.profile", rkey: "self", cid: "cid-2" },
    ],
    blobs: ["cid-b", "cid-a", "cid-b"],
    spaces: [
      {
        spaceUri: "at:space/did:plc:group1/org.atgrp.meta/self",
        isOwnAuthority: true,
        spaceMetaSha256: "aa".repeat(32),
        repoRootDataHex: "BB".repeat(32),
      },
      {
        spaceUri: "at:space/did:plc:invitee/org.atgrp.inbox/self",
        isOwnAuthority: false,
        spaceMetaSha256: "ignored",
        repoRootDataHex: "cc".repeat(32),
      },
    ],
  };

  const inputB = {
    ...inputA,
    publicRecords: [...inputA.publicRecords].reverse(),
    blobs: ["cid-a", "cid-b"],
    spaces: [...inputA.spaces].reverse(),
  };

  const resA = computeCanonicalMigrationManifest(inputA);
  const resB = computeCanonicalMigrationManifest(inputB);

  assert.equal(resA.manifestJson, resB.manifestJson);
  assert.equal(resA.manifestDigest, resB.manifestDigest);
  assert.deepEqual(resA.manifest.blobs, ["cid-a", "cid-b"]);
  assert.equal(resA.manifest.spaces[1]?.spaceMetaSha256, null, "external invite space has null spaceMetaSha256");
  assert.equal(resA.manifest.spaces[0]?.repoRootDataHex, "bb".repeat(32), "repoRootDataHex normalized to lowercase");
  assert.equal(verifyMigrationManifestDigest(resA.manifestJson, resA.manifestDigest), true);
  assert.equal(verifyMigrationManifestDigest(resA.manifestJson + " ", resA.manifestDigest), false);
});
