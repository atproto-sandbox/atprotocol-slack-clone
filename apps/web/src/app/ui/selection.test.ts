import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import { NO_WORKSPACE, shownChannel, shownWorkspace } from "./selection";

const workspace = (skey: string, channels: WorkspaceSummary["channels"] = []): WorkspaceSummary => ({
  uri: `at://did:plc:a/space/new.flock.workspace/${skey}`, authorityDid: "did:plc:a", skey, name: skey,
  isAdmin: false, admins: [], members: [], channels, installs: [], degradedReasons: [],
});
const general = { uri: "at://did:plc:a/space/new.flock.channel/general", skey: "general", name: "general", visibility: "public" };

test("shownWorkspace keeps the chosen workspace while it is listed, else shows the first; choosing none shows none", () => {
  const [first, second] = [workspace("one"), workspace("two")];
  assert.equal(shownWorkspace([first, second], second.uri), second);
  assert.equal(shownWorkspace([first, second], null), first);
  assert.equal(shownWorkspace([first], second.uri), first);
  assert.equal(shownWorkspace([], second.uri), null);
  assert.equal(shownWorkspace([first, second], NO_WORKSPACE), null, "the create-or-join form was chosen");
});

test("shownChannel follows the directory: renamed, changed visibility, or gone", () => {
  const listed = workspace("one", [general]);
  const chosen = { workspace: listed.uri, skey: "general" };
  assert.deepEqual(shownChannel(listed, chosen), { workspace: listed.uri, skey: "general", name: "general", visibility: "public" });
  const changed = workspace("one", [{ ...general, name: "announcements", visibility: "transitioning" }]);
  assert.deepEqual(shownChannel(changed, chosen), { workspace: listed.uri, skey: "general", name: "announcements", visibility: "transitioning" });
  assert.equal(shownChannel(workspace("one"), chosen), null);
  assert.equal(shownChannel(workspace("two", [general]), chosen), null);
  assert.equal(shownChannel(null, chosen), null);
  assert.equal(shownChannel(listed, null), null);
});
