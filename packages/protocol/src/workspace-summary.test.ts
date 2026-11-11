import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceWithinEnvelope, WorkspaceEnvelopeError } from "./workspace-summary";

test("workspace envelope checks reject degraded state for operator mutations and inbox recovery", () => {
  assert.doesNotThrow(() => assertWorkspaceWithinEnvelope({ degradedReasons: [] }));
  assert.throws(() => assertWorkspaceWithinEnvelope({ degradedReasons: ["The active channel count exceeds 100 channels."] }),
    (error: unknown) => error instanceof WorkspaceEnvelopeError && error.status === 409 && /degraded mode/.test(error.message));
});
