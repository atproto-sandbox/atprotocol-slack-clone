import assert from "node:assert/strict";
import test from "node:test";
import { mapLimited } from "./map-limited";

test("mapLimited preserves input order and never exceeds the concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  const output = await mapLimited([5, 1, 4, 2, 3], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(output, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});

test("mapLimited handles empty input and rejects invalid concurrency", async () => {
  assert.deepEqual(await mapLimited([], 4, async () => 1), []);
  await assert.rejects(mapLimited([1], 0, async (value) => value), RangeError);
});

test("mapLimited propagates the first failure", async () => {
  await assert.rejects(mapLimited([1, 2, 3], 3, async (value) => {
    if (value === 2) throw new Error("boom");
    return value;
  }), /boom/);
});
