import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_IDS, EXTENSIONS, extSpaceSkeyFor, extSpaceUriFor, getExtension, isExtensionId } from "./extensions";
import { extSpaceSkey, isSkey, parseTasksSpaceUri, tasksSpaceUri } from "./keys";
import { COLLECTION, SPACE_TYPE } from "./nsids";

test("extension catalog registers tasks declaratively with manifest metadata", () => {
  assert.deepEqual(EXTENSION_IDS, ["tasks"]);
  assert.equal(isExtensionId("tasks"), true);
  assert.equal(isExtensionId("notes"), false);
  assert.equal(isExtensionId(null), false);
  assert.equal(isExtensionId(42), false);

  const tasks = getExtension("tasks");
  assert.equal(tasks, EXTENSIONS.tasks);
  assert.equal(tasks.id, "tasks");
  assert.equal(tasks.spaceType, SPACE_TYPE.tasks);
  assert.equal(tasks.defaultRoute, "ext/tasks");
  assert.deepEqual(tasks.collections, [
    COLLECTION.taskProject,
    COLLECTION.taskProjectEdit,
    COLLECTION.task,
    COLLECTION.taskEdit,
    COLLECTION.taskComment,
  ]);
  assert.equal(getExtension("unknown"), undefined);
});

test("extSpaceUriFor derives canonical space URIs bounded even for max-length workspace skeys", () => {
  const uri = extSpaceUriFor("did:plc:owner", "workspace", "tasks");
  assert.equal(uri, tasksSpaceUri("did:plc:owner", "workspace"));
  assert.deepEqual(parseTasksSpaceUri(uri), {
    authorityDid: "did:plc:owner",
    skey: extSpaceSkeyFor("workspace", "tasks"),
  });

  const maxSkey = "a".repeat(128);
  const derived = extSpaceSkeyFor(maxSkey, "tasks");
  assert.equal(derived, extSpaceSkey(maxSkey, "tasks"));
  assert.equal(isSkey(derived), true);
  assert.ok(derived.length <= 128);
  assert.throws(() => extSpaceUriFor("did:plc:owner", "workspace", "unknown" as "tasks"), /Unknown extension/);
});
