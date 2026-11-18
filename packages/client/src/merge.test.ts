import assert from "node:assert/strict";
import test from "node:test";
import { compareItems, decodeCursor, encodeCursor, isAfterCursor } from "./merge";

test("merge order is newest key first, then URI, so it is total", () => {
  const items = [
    { key: "3", uri: "at://b" }, { key: "2", uri: "at://a" }, { key: "3", uri: "at://a" }, { key: "1", uri: "at://z" },
  ];
  assert.deepEqual([...items].sort(compareItems), [
    { key: "3", uri: "at://a" }, { key: "3", uri: "at://b" }, { key: "2", uri: "at://a" }, { key: "1", uri: "at://z" },
  ]);
});

test("a cursor between two records with one key keeps the second for the next page", () => {
  // #given a page that ended on the first of two records sharing key 3
  const cursor = { key: "3", uri: "at://a" };

  // #then the other record with that key, and every older one, belongs to the next page; nothing at or before it does
  assert.equal(isAfterCursor({ key: "3", uri: "at://b" }, cursor), true);
  assert.equal(isAfterCursor({ key: "2", uri: "at://a" }, cursor), true);
  assert.equal(isAfterCursor({ key: "3", uri: "at://a" }, cursor), false);
  assert.equal(isAfterCursor({ key: "4", uri: "at://a" }, cursor), false);
  assert.equal(isAfterCursor({ key: "4", uri: "at://a" }, undefined), true);
});

test("a cursor survives as one opaque string, and a malformed one is refused", () => {
  const cursor = { key: "3jzfcijpj2z2a", uri: "at://did:plc:a/space/new.flock.channel/x/did:plc:b/new.flock.channel.message/3jzfcijpj2z2a" };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(decodeCursor(undefined), undefined);
  for (const value of ["", "no-separator", " leading", "trailing "]) assert.throws(() => decodeCursor(value), RangeError, value);
});
