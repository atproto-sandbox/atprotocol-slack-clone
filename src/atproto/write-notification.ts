import { isDid, parseSpaceUri } from "@/protocol/keys";

export type WriteNotification = { space: string; repo: string; rev: string };

const ALLOWED_KEYS = new Set(["space", "repo", "rev", "hash"]);
const BASE64 = /^[A-Za-z0-9+/]{20,100}={0,2}$/;

/** `hash` is lexicon type `bytes`, which JSON carries as `{ "$bytes": "<base64>" }`. */
export function parseWriteNotification(body: unknown): WriteNotification | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) return null;
  const { space, repo, rev, hash } = input;
  if (typeof space !== "string" || !parseSpaceUri(space) || !isDid(repo)) return null;
  if (typeof rev !== "string" || rev.length < 1 || rev.length > 128) return null;
  if (!hash || typeof hash !== "object" || Object.keys(hash).join() !== "$bytes") return null;
  const encoded = (hash as { $bytes: unknown }).$bytes;
  if (typeof encoded !== "string" || !BASE64.test(encoded)) return null;
  return { space, repo, rev };
}
