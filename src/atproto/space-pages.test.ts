import assert from "node:assert/strict";
import test from "node:test";
import type { AtprotoClient } from "./xrpc";
import { listBoundedSpaces } from "./space-pages";

test("workspace discovery bounds its pages and distinguishes exact limits from overflow", async () => {
  const exact = fakeClient([
    { spaces: [{ uri: "space:a" }, { uri: "space:b" }], cursor: "next" },
    { spaces: [] },
  ]);
  assert.deepEqual(await listBoundedSpaces(exact.client, { spaceType: "org.slack.workspace", maxSpaces: 2 }), ["space:a", "space:b"]);
  assert.deepEqual(exact.calls.map(({ limit, cursor }) => ({ limit, cursor })), [
    { limit: 2, cursor: undefined },
    { limit: 1, cursor: "next" },
  ]);

  const overflow = fakeClient([
    { spaces: [{ uri: "space:a" }, { uri: "space:b" }], cursor: "next" },
    { spaces: [{ uri: "space:c" }] },
  ]);
  await assert.rejects(listBoundedSpaces(overflow.client, { spaceType: "org.slack.workspace", maxSpaces: 2 }), /exceeds the 2-space discovery limit/);

  const advancingEmpty = fakeClient(Array.from({ length: 128 }, (_, index) => ({ spaces: [], cursor: `next-${index}` })));
  await assert.rejects(listBoundedSpaces(advancingEmpty.client, { spaceType: "org.slack.workspace", maxSpaces: 2 }), /bounded page limit/);
  assert.equal(advancingEmpty.calls.length, 128);
});

function fakeClient(pages: Array<Record<string, unknown>>) {
  const calls: Array<{ limit?: number; cursor?: string }> = [];
  const client = {
    query: async (_method: string, input: { limit?: number; cursor?: string }) => {
      calls.push(input);
      const page = pages.shift();
      assert.ok(page, "all fixture pages should be consumed");
      return page;
    },
  } as unknown as AtprotoClient;
  return { client, calls };
}
