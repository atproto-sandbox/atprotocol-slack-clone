import assert from "node:assert/strict";
import test from "node:test";
import { actionsBlock, button, contextBlock, dividerBlock, sectionBlock } from "@flock/client/blocks";
import type { WorkspaceSummary } from "@flock/protocol/workspace-summary";
import {
  channelCommandContext,
  matchingCommands,
  renderableBlocks,
  resolveComposerSubmission,
  WorkspaceDeclarationCache,
} from "./interactions";

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const APP_ONE = "did:plc:appone";
const APP_TWO = "did:plc:apptwo";
const WORKSPACE_URI = `at:space/${AUTHORITY}/new.flock.workspace/self`;

function makeWorkspace(installs: WorkspaceSummary["installs"]): WorkspaceSummary {
  return {
    uri: WORKSPACE_URI,
    authorityDid: AUTHORITY,
    groupDid: AUTHORITY,
    skey: "self",
    name: "Acme",
    joinPolicy: "invite",
    publicMeta: true,
    isAdmin: true,
    isModerator: false,
    admins: [ALICE],
    moderators: [],
    members: [
      { did: ALICE, active: true, roles: ["admin", "member"] },
      { did: BOB, active: true, roles: ["member"] },
    ],
    pendingMembers: [],
    roles: [],
    channels: [
      { uri: `at:space/${AUTHORITY}/new.flock.channel/acme-general`, skey: "acme-general", name: "general", visibility: "public" },
      { uri: `at:space/${AUTHORITY}/new.flock.channel/acme-secret`, skey: "acme-secret", name: "secret", visibility: "private" },
      { uri: `at:space/${AUTHORITY}/new.flock.channel/acme-moving`, skey: "acme-moving", name: "moving", visibility: "transitioning" },
    ],
    installs,
    degradedReasons: [],
  };
}

test("WorkspaceDeclarationCache fetches each active install once per workspace and tolerates unreachable app hosts", async () => {
  const cache = new WorkspaceDeclarationCache();
  let calls = 0;
  const fetcher = async (did: string) => {
    calls += 1;
    if (did === APP_TWO) throw new Error("host unreachable");
    return { name: "Echo", commands: [{ name: "echo", usage: "<text>" }] };
  };

  cache.ensureWorkspace(WORKSPACE_URI, [APP_ONE, APP_TWO], fetcher);
  cache.ensureWorkspace(WORKSPACE_URI, [APP_ONE, APP_TWO], fetcher);
  await Promise.all([
    cache.load(WORKSPACE_URI, APP_ONE, fetcher),
    cache.load(WORKSPACE_URI, APP_TWO, fetcher),
  ]);
  assert.equal(calls, 2, "each app's declaration is fetched once for the workspace");
  const snapshot = cache.forWorkspace(WORKSPACE_URI, [APP_ONE, APP_TWO]);
  assert.deepEqual(snapshot[APP_ONE], { status: "loaded", declaration: { name: "Echo", commands: [{ name: "echo", usage: "<text>" }] } });
  assert.deepEqual(snapshot[APP_TWO], { status: "loaded", declaration: null }, "unreachable app resolves to null instead of staying loading");
});

test("composer holds / messages while declarations load, routes unique commands, requires picker on ambiguity, rejects unknown, and escapes //", () => {
  const workspace = makeWorkspace([
    { did: APP_ONE, channels: [{ skey: "acme-general", write: true }] },
    { did: APP_TWO, channels: [{ skey: "acme-general", write: false }] },
  ]);
  const channel = { workspace: WORKSPACE_URI, skey: "acme-general", name: "general", visibility: "public" };
  const content = { messages: [], roster: null, degradedReasons: [] };

  // While APP_TWO is still loading, any `/` submission is held rather than sent as a message.
  const loadingCtx = channelCommandContext({
    workspace,
    channel,
    viewerDid: ALICE,
    content,
    replyTo: "",
    declarations: {
      [APP_ONE]: { status: "loaded", declaration: { name: "Echo", commands: [{ name: "echo" }] } },
      [APP_TWO]: { status: "loading" },
    },
  });
  assert.equal(loadingCtx.loading, true);
  assert.equal(resolveComposerSubmission("/echo hi", loadingCtx).kind, "held");
  // Escaped `//` still sends as a plain message with one `/` stripped!
  assert.deepEqual(resolveComposerSubmission("//echo hi", loadingCtx), { kind: "message", text: "/echo hi" });

  // Once loaded: unique `/echo`, ambiguous `/ping`, unknown `/nope`.
  const loadedCtx = channelCommandContext({
    workspace,
    channel,
    viewerDid: ALICE,
    content,
    replyTo: "",
    declarations: {
      [APP_ONE]: { status: "loaded", declaration: { name: "Echo", commands: [{ name: "echo" }, { name: "ping" }] } },
      [APP_TWO]: { status: "loaded", declaration: { name: "Helper", commands: [{ name: "ping" }] } },
    },
  });
  assert.equal(loadedCtx.loading, false);
  assert.equal(matchingCommands("/p", loadedCtx).length, 2);
  assert.deepEqual(resolveComposerSubmission("/echo hello world", loadedCtx), {
    kind: "command",
    appDid: APP_ONE,
    appName: "Echo",
    command: "echo",
    text: "hello world",
  });
  assert.equal(resolveComposerSubmission("/nope", loadedCtx).kind, "unknown");
  const ambiguous = resolveComposerSubmission("/ping now", loadedCtx);
  assert.equal(ambiguous.kind, "ambiguous");
  assert.deepEqual(resolveComposerSubmission("/ping now", { ...loadedCtx, chosenAppDid: APP_TWO }), {
    kind: "command",
    appDid: APP_TWO,
    appName: "Helper",
    command: "ping",
    text: "now",
  });
});

test("no command is offered where the viewer cannot read, on a transitioning channel, for an ungranted app, or when replying to a non-top-level message", () => {
  const workspace = makeWorkspace([{ did: APP_ONE, channels: [{ skey: "acme-secret", write: true }] }]);
  const declarations = {
    [APP_ONE]: { status: "loaded" as const, declaration: { name: "Echo", commands: [{ name: "echo" }] } },
  };

  // App not granted #general -> 0 offered commands in #general.
  const generalCtx = channelCommandContext({
    workspace,
    channel: { workspace: WORKSPACE_URI, skey: "acme-general", name: "general", visibility: "public" },
    viewerDid: ALICE,
    content: { messages: [], roster: null, degradedReasons: [] },
    replyTo: "",
    declarations,
  });
  assert.deepEqual(generalCtx.offered, []);
  assert.equal(resolveComposerSubmission("/echo hi", generalCtx).kind, "unknown");

  // Private channel where viewer is refused / off roster -> commands blocked.
  const secretChannel = { workspace: WORKSPACE_URI, skey: "acme-secret", name: "secret", visibility: "private" };
  const outsiderCtx = channelCommandContext({
    workspace,
    channel: secretChannel,
    viewerDid: BOB,
    content: { messages: [], roster: [ALICE], degradedReasons: [], refused: { status: 403, message: "Forbidden" } },
    replyTo: "",
    declarations,
  });
  assert.equal(outsiderCtx.canOffer, false);
  assert.equal(resolveComposerSubmission("/echo hi", outsiderCtx).kind, "blocked");

  // Workspace authority on private channel (even with empty roster) IS admitted.
  const authorityCtx = channelCommandContext({
    workspace,
    channel: secretChannel,
    viewerDid: AUTHORITY,
    content: { messages: [], roster: [ALICE], degradedReasons: [] },
    replyTo: "",
    declarations,
  });
  assert.equal(authorityCtx.canOffer, true);
  assert.equal(authorityCtx.offered.length, 1);

  // Transitioning channel -> blocked.
  const movingCtx = channelCommandContext({
    workspace,
    channel: { workspace: WORKSPACE_URI, skey: "acme-moving", name: "moving", visibility: "transitioning" },
    viewerDid: ALICE,
    content: undefined,
    replyTo: "",
    declarations,
  });
  assert.equal(movingCtx.canOffer, false);

  // Thread checks: allowed on top-level message, blocked on a reply or missing message.
  const topUri = "at:space/did:plc:authority/new.flock.channel/acme-secret/did:plc:alice/new.flock.channel.message/2222222222222";
  const replyUri = "at:space/did:plc:authority/new.flock.channel/acme-secret/did:plc:alice/new.flock.channel.message/2222222222223";
  const threadContent = {
    messages: [
      { uri: topUri, rkey: "2222222222222", repo: ALICE, value: { text: "top" } },
      { uri: replyUri, rkey: "2222222222223", repo: ALICE, value: { text: "reply", parent: topUri } },
    ],
    roster: [ALICE],
    degradedReasons: [],
  };
  assert.equal(channelCommandContext({ workspace, channel: secretChannel, viewerDid: ALICE, content: threadContent, replyTo: topUri, declarations }).canOffer, true);
  assert.equal(channelCommandContext({ workspace, channel: secretChannel, viewerDid: ALICE, content: threadContent, replyTo: replyUri, declarations }).canOffer, false);
  assert.equal(channelCommandContext({ workspace, channel: secretChannel, viewerDid: ALICE, content: threadContent, replyTo: `${topUri}x`, declarations }).canOffer, false);
});

test("renderableBlocks renders blocks only for active workspace installs and renders a person's message as text only", () => {
  const blocks = [
    sectionBlock("App section"),
    contextBlock(["ctx 1"]),
    dividerBlock(),
    actionsBlock([button({ actionId: "go", label: "Go", value: "1", style: "primary" })]),
  ];
  const activeApps = new Set([APP_ONE]);
  assert.deepEqual(
    renderableBlocks({ repo: APP_ONE, value: { text: "fallback", blocks } }, activeApps),
    blocks,
  );
  assert.equal(
    renderableBlocks({ repo: ALICE, value: { text: "person text", blocks } }, activeApps),
    null,
    "a person's blocks are never rendered",
  );
  assert.equal(
    renderableBlocks({ repo: APP_TWO, value: { text: "uninstalled app", blocks } }, activeApps),
    null,
    "an uninstalled app's blocks are not rendered",
  );
});
