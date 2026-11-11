import { isDid, isTid, parseSpaceUri } from "@flock/protocol/keys";

export type WriteNotification = { space: string; repo: string; repoRev: string };

const ALLOWED_KEYS = new Set(["space", "repo", "repoRev", "data", "spaceRev", "prevSpaceRev"]);
/** The commit digest's size bounds: a sha256 is 32 bytes, and nothing much smaller or larger is one. */
const MIN_DATA_BYTES = 16;
const MAX_DATA_BYTES = 64;

/** `spaceRev` and `prevSpaceRev` are present only on notifications the space host forwards; only `repoRev` is kept. `data` (the repo's commit digest, formerly `hash`) is lexicon type `bytes`: JSON carries it as `{ "$bytes": "<base64>" }`, and the operator's XRPC server hands it over decoded, as a `Uint8Array`. */
export function parseWriteNotification(body: unknown): WriteNotification | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) return null;
  const { space, repo, repoRev, data, spaceRev, prevSpaceRev } = input;
  if (typeof space !== "string" || !parseSpaceUri(space) || !isDid(repo)) return null;
  if (!isTid(repoRev)) return null;
  if (spaceRev !== undefined && !isTid(spaceRev)) return null;
  if (prevSpaceRev !== undefined && !isTid(prevSpaceRev)) return null;
  if (!(data instanceof Uint8Array) || data.byteLength < MIN_DATA_BYTES || data.byteLength > MAX_DATA_BYTES) return null;
  return { space, repo, repoRev };
}

/**
 * `com.atproto.space.notifySpaceDeleted`: the authority tells a registered syncer that a space was deleted. The lexicon's one
 * field is `space`; a field a later revision adds is ignored rather than refused.
 */
export function parseSpaceDeletedNotification(body: unknown): { space: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { space } = body as Record<string, unknown>;
  return typeof space === "string" && parseSpaceUri(space) ? { space } : null;
}
