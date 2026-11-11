// The order every view merges its sources in (writers in a channel, halves of a DM conversation): newest key first, then
// by URI, so the order is total. Paging continues from a `(key, uri)` cursor: a key alone would lose one of two records
// that share a key at a page boundary.

/** A position in merge order: a record's key and URI, or where a page starts. */
export type Cursor = { key: string; uri: string };

export function compareItems(left: Cursor, right: Cursor): number {
  if (left.key !== right.key) return left.key < right.key ? 1 : -1;
  return left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0;
}

/** Whether `item` comes after `cursor` in merge order, so it belongs to the page that `cursor` starts. */
export function isAfterCursor(item: Cursor, cursor: Cursor | undefined): boolean {
  return cursor === undefined || compareItems(item, cursor) > 0;
}

/** The cursor handed to callers as one opaque string, so they pass it back unchanged. */
export function encodeCursor(cursor: Cursor): string {
  return `${cursor.key} ${cursor.uri}`;
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf(" ");
  if (separator < 1 || separator === value.length - 1) throw new RangeError("Invalid page cursor.");
  return { key: value.slice(0, separator), uri: value.slice(separator + 1) };
}
