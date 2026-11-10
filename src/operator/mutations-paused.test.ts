import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapWorkspace } from "@/operator/kinds/bootstrap-workspace";
import { executeOperatorOperation } from "./operations";
import { AdminMutationsPausedError } from "./mutations-paused";

test("workspace bootstrap and operator mutation services honor the pause switch", async () => {
  const prior = process.env.SLACK_ADMIN_MUTATIONS_PAUSED;
  process.env.SLACK_ADMIN_MUTATIONS_PAUSED = "true";
  try {
    await assert.rejects(
      bootstrapWorkspace({ did: "did:plc:paused" } as never, { name: "", operationId: "" }),
      AdminMutationsPausedError,
    );
    await assert.rejects(
      executeOperatorOperation({} as never, "2222222222222", null),
      AdminMutationsPausedError,
    );
  } finally {
    if (prior === undefined) delete process.env.SLACK_ADMIN_MUTATIONS_PAUSED;
    else process.env.SLACK_ADMIN_MUTATIONS_PAUSED = prior;
  }
});
