import assert from "node:assert/strict";
import test from "node:test";
import { within } from "./within";

test("work that settles in time is passed through, and work that does not is refused once the time is up", async () => {
  assert.equal(await within(Promise.resolve("done"), 50), "done");
  await assert.rejects(within(new Promise(() => undefined), 10), /Not done within 10 ms/);
  await assert.rejects(within(Promise.reject(new Error("its own failure")), 50), /its own failure/);
});
