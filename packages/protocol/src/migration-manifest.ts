import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { canonicalJson } from "./keys";

export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256HexUtf8(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export type PublicRecordDigestEntry = {
  collection: string;
  rkey: string;
  cid: string;
};

export type MigrationSpaceManifestEntry = {
  spaceUri: string;
  isOwnAuthority: boolean;
  spaceMetaSha256: string | null;
  repoRootDataHex: string;
};

export type CanonicalMigrationManifestInput = {
  groupDid: string;
  operationId: string;
  deadlineAtMs: number;
  sourceLocalRotationKey: string;
  publicRepoDataRootCid: string;
  publicRecords: readonly PublicRecordDigestEntry[];
  blobs: readonly string[];
  spaces: readonly MigrationSpaceManifestEntry[];
};

export type CanonicalMigrationManifest = {
  version: 1;
  groupDid: string;
  operationId: string;
  deadlineAtMs: number;
  sourceLocalRotationKey: string;
  publicRepoDataRootCid: string;
  publicRecordsSha256: string;
  blobs: string[];
  spaces: MigrationSpaceManifestEntry[];
};

export function computePublicRecordsSha256(records: readonly PublicRecordDigestEntry[]): string {
  const lines = records
    .map((entry) => `${entry.collection}\u0000${entry.rkey}\u0000${entry.cid}\n`)
    .sort(compareUtf16);
  return sha256HexUtf8(lines.join(""));
}

/**
 * Builds the canonical RFC 8785 JCS JSON string and SHA-256 digest for Coordinated v1 Group Host migration.
 */
export function computeCanonicalMigrationManifest(input: CanonicalMigrationManifestInput): {
  manifest: CanonicalMigrationManifest;
  manifestJson: string;
  manifestDigest: string;
} {
  const sortedBlobs = [...new Set(input.blobs)].sort(compareUtf16);
  const sortedSpaces = [...input.spaces]
    .map((space) => ({
      spaceUri: space.spaceUri,
      isOwnAuthority: Boolean(space.isOwnAuthority),
      spaceMetaSha256: space.isOwnAuthority ? space.spaceMetaSha256 : null,
      repoRootDataHex: space.repoRootDataHex.toLowerCase(),
    }))
    .sort((a, b) => compareUtf16(a.spaceUri, b.spaceUri));

  const manifest: CanonicalMigrationManifest = {
    version: 1,
    groupDid: input.groupDid,
    operationId: input.operationId,
    deadlineAtMs: input.deadlineAtMs,
    sourceLocalRotationKey: input.sourceLocalRotationKey,
    publicRepoDataRootCid: input.publicRepoDataRootCid,
    publicRecordsSha256: computePublicRecordsSha256(input.publicRecords),
    blobs: sortedBlobs,
    spaces: sortedSpaces,
  };

  const manifestJson = canonicalJson(manifest);
  const manifestDigest = sha256HexUtf8(manifestJson);
  return { manifest, manifestJson, manifestDigest };
}

export function verifyMigrationManifestDigest(manifestJson: string, expectedDigest: string): boolean {
  if (typeof manifestJson !== "string" || typeof expectedDigest !== "string") return false;
  return sha256HexUtf8(manifestJson) === expectedDigest.toLowerCase();
}
