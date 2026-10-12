export type DmHalfRecord = { uri: string; rkey: string; ownerDid: string; value: Record<string, unknown> };

export type DmHalfPage = {
  ownerDid: string;
  /** Every record fetched so far for this half, in any order. */
  records: readonly DmHalfRecord[];
  /** True once this half's own history has been fully paged (no older records remain). */
  exhausted: boolean;
};

export type DmMergeResult = {
  /** Newest first, deduplicated by URI, at most `limit` entries. */
  messages: DmHalfRecord[];
  /**
   * Owner DIDs whose half must be paged further (older records fetched) before
   * `messages` can be trusted as the true newest `limit` across every half.
   * Mirrors the channel `fillLatest` idea in `src/workspaces/channel-sync.ts`:
   * a half only needs another page while it isn't exhausted and its oldest
   * fetched record could still land inside the current merge window.
   */
  needsMore: string[];
  /** Cursor for the next older page, present only while more history may exist. */
  nextBefore?: string;
};

/**
 * Pure k-way merge of per-half DM message pages by TID (`rkey`), newest first.
 * Callers page whichever halves `needsMore` names and call this again until it
 * comes back empty, then take the final `messages`/`nextBefore`.
 */
export function mergeDmHalves(halves: readonly DmHalfPage[], input: { limit: number; before?: string }): DmMergeResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new RangeError("DM merge limit must be a positive safe integer.");
  const byUri = new Map<string, DmHalfRecord>();
  for (const half of halves) {
    for (const record of half.records) {
      if (input.before !== undefined && record.rkey >= input.before) continue;
      byUri.set(record.uri, record);
    }
  }
  const merged = [...byUri.values()].sort((left, right) =>
    left.rkey === right.rkey ? left.uri.localeCompare(right.uri) : right.rkey.localeCompare(left.rkey));
  const messages = merged.slice(0, input.limit);
  const cutoff = messages.length >= input.limit ? messages[messages.length - 1]!.rkey : undefined;

  const needsMore = halves.filter((half) => {
    if (half.exhausted) return false;
    if (cutoff === undefined) return true;
    const oldestFetched = half.records.reduce<string | undefined>(
      (min, record) => (min === undefined || record.rkey < min ? record.rkey : min), undefined);
    return oldestFetched === undefined || oldestFetched >= cutoff;
  }).map((half) => half.ownerDid);

  const hasMore = merged.length > messages.length || halves.some((half) => !half.exhausted);
  const nextBefore = hasMore && messages.length > 0 ? messages[messages.length - 1]!.rkey : undefined;
  return { messages, needsMore, nextBefore };
}
