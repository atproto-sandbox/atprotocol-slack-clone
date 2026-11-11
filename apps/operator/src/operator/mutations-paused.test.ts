import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "./kinds/create-workspace";
import { executeOperatorOperation } from "./operations";
import { AdminMutationsPausedError } from "./mutations-paused";

test("workspace creation and operator mutation services honor the pause switch", async () => {
  const prior = process.env.FLOCK_ADMIN_MUTATIONS_PAUSED;
  process.env.FLOCK_ADMIN_MUTATIONS_PAUSED = "true";
  try {
    await assert.rejects(
      createWorkspace({ did: "did:plc:paused" } as never, { creator: "did:plc:paused", name: "", operationId: "" }),
      AdminMutationsPausedError,
    );
    await assert.rejects(
      executeOperatorOperation({} as never, "2222222222222", null),
      AdminMutationsPausedError,
    );
  } finally {
    if (prior === undefined) delete process.env.FLOCK_ADMIN_MUTATIONS_PAUSED;
    else process.env.FLOCK_ADMIN_MUTATIONS_PAUSED = prior;
  }
});
