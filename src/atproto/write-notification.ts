import { isDid, isTid, parseSpaceUri } from "@/protocol/keys";

export type WriteNotification = { space: string; repo: string; repoRev: string };

const ALLOWED_KEYS = new Set(["space", "repo", "repoRev", "data", "spaceRev", "prevSpaceRev"]);
const BASE64 = /^[A-Za-z0-9+/]{20,100}={0,2}$/;

/** `spaceRev` and `prevSpaceRev` are present only on notifications the space host forwards; only `repoRev` is kept. `data` (the repo's commit digest, formerly `hash`) is lexicon type `bytes`, which JSON carries as `{ "$bytes": "<base64>" }`. */
export function parseWriteNotification(body: unknown): WriteNotification | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) return null;
  const { space, repo, repoRev, data, spaceRev, prevSpaceRev } = input;
  if (typeof space !== "string" || !parseSpaceUri(space) || !isDid(repo)) return null;
  if (!isTid(repoRev)) return null;
  if (spaceRev !== undefined && !isTid(spaceRev)) return null;
  if (prevSpaceRev !== undefined && !isTid(prevSpaceRev)) return null;
  if (!data || typeof data !== "object" || Object.keys(data).join() !== "$bytes") return null;
  const encoded = (data as { $bytes: unknown }).$bytes;
  if (typeof encoded !== "string" || !BASE64.test(encoded)) return null;
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
