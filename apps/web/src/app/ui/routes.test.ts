import assert from "node:assert/strict";
import test from "node:test";
import {
  captureReturnTo,
  channelRoute,
  consumeReturnTo,
  dmConversationRoute,
  dmHomeRoute,
  homeRoute,
  messageRoute,
  parseDecodedSegments,
  parseRoute,
  RETURN_TO_KEY,
  sanitizeReturnTo,
  sentThreadCleanupRoute,
  tasksProjectRoute,
  tasksRoute,
  tasksTaskRoute,
  validateReturnTo,
  workspaceRoute,
} from "./routes";

const DID_PLC = "did:plc:alice123";
const DID_WEB = "did:web:spaces.example";
const DID_WEB_PORT = "did:web:localhost%3A3000";
const DID_BOB = "did:plc:bob456";
const TID = "3k22222222222";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test("route builders and parsers round-trip every grammar route including did:plc, did:web, and did:web:localhost%3A3000", () => {
  assert.equal(homeRoute(), "/");
  assert.deepEqual(parseRoute("/"), { kind: "home" });

  for (const authority of [DID_PLC, DID_WEB, DID_WEB_PORT]) {
    const wsUrl = workspaceRoute(authority, "self");
    if (authority === DID_WEB_PORT) {
      assert.equal(wsUrl, "/w/did%3Aweb%3Alocalhost%253A3000/self", "percent in did:web port encodes as %253A on the wire");
    }
    const parsedWs = parseRoute(wsUrl);
    assert.deepEqual(parsedWs, {
      kind: "workspace",
      authority,
      workspaceSkey: "self",
      workspaceUri: `at:space/${authority}/new.flock.workspace/self`,
    });

    const chUrl = channelRoute({ authority, workspaceSkey: "self", channelSkey: "general", thread: `at:space/${authority}/new.flock.channel/general/${DID_BOB}/new.flock.channel.message/${TID}` });
    const [chPath, chSearch = ""] = chUrl.split("?");
    const parsedCh = parseRoute(chPath!, `?${chSearch}`);
    assert.equal(parsedCh?.kind, "channel");
    assert.equal(parsedCh?.kind === "channel" && parsedCh.authority, authority);
    assert.equal(parsedCh?.kind === "channel" && parsedCh.channelSkey, "general");
    assert.equal(parsedCh?.kind === "channel" && parsedCh.thread, `at:space/${authority}/new.flock.channel/general/${DID_BOB}/new.flock.channel.message/${TID}`);

    const msgUrl = messageRoute({ authority, workspaceSkey: "self", channelSkey: "general", repo: DID_WEB_PORT, rkey: TID });
    assert.deepEqual(parseRoute(msgUrl), {
      kind: "message",
      authority,
      workspaceSkey: "self",
      workspaceUri: `at:space/${authority}/new.flock.workspace/self`,
      channelSkey: "general",
      repo: DID_WEB_PORT,
      rkey: TID,
      messageUri: `at:space/${authority}/new.flock.channel/general/${DID_WEB_PORT}/new.flock.channel.message/${TID}`,
    });

    for (const view of [undefined, "list", "board", "activity"] as const) {
      const tUrl = tasksRoute(authority, "self", view);
      assert.deepEqual(parseRoute(tUrl), {
        kind: "tasks",
        view: view ?? "default",
        authority,
        workspaceSkey: "self",
        workspaceUri: `at:space/${authority}/new.flock.workspace/self`,
      });
    }

    const taskDetailUrl = tasksTaskRoute({ authority, workspaceSkey: "self", repo: DID_BOB, rkey: TID });
    const parsedTask = parseRoute(taskDetailUrl);
    assert.equal(parsedTask?.kind, "tasks");
    if (parsedTask?.kind === "tasks" && parsedTask.view === "task") {
      assert.equal(parsedTask.repo, DID_BOB);
      assert.equal(parsedTask.rkey, TID);
      assert.match(parsedTask.taskUri, /\/new\.flock\.ext\.tasks\.task\//);
    } else {
      assert.fail("expected tasks task route");
    }
  }

  assert.deepEqual(parseRoute(dmHomeRoute()), { kind: "dm", view: "home" });
  assert.deepEqual(parseRoute("/dm", "?view=requests"), { kind: "dm", view: "requests" });
  assert.deepEqual(parseRoute("/dm", "?view=settings"), { kind: "dm", view: "settings" });
  assert.deepEqual(parseRoute(dmConversationRoute(TID)), { kind: "dm", view: "conversation", convKey: TID });
});

test("parseDecodedSegments preserves pre-decoded Next params without double-decoding did:web:localhost%3A3000", () => {
  const route = parseDecodedSegments(["w", DID_WEB_PORT, "self", "ext", "tasks", "p", DID_WEB_PORT, TID]);
  assert.equal(route?.kind, "tasks");
  if (route?.kind === "tasks" && route.view === "project") {
    assert.equal(route.authority, DID_WEB_PORT);
    assert.equal(route.repo, DID_WEB_PORT);
  } else {
    assert.fail("expected parsed project route");
  }
});

test("cross-repo same-rkey projects produce distinct routes and distinct projectUris", () => {
  const aliceProjUrl = tasksProjectRoute({ authority: DID_PLC, workspaceSkey: "self", repo: DID_PLC, rkey: TID });
  const bobProjUrl = tasksProjectRoute({ authority: DID_PLC, workspaceSkey: "self", repo: DID_BOB, rkey: TID });
  assert.notEqual(aliceProjUrl, bobProjUrl);

  const parsedAlice = parseRoute(aliceProjUrl);
  const parsedBob = parseRoute(bobProjUrl);
  assert.equal(parsedAlice?.kind, "tasks");
  assert.equal(parsedBob?.kind, "tasks");
  if (parsedAlice?.kind === "tasks" && parsedAlice.view === "project" && parsedBob?.kind === "tasks" && parsedBob.view === "project") {
    assert.notEqual(parsedAlice.projectUri, parsedBob.projectUri);
    assert.equal(parsedAlice.repo, DID_PLC);
    assert.equal(parsedBob.repo, DID_BOB);
    assert.equal(parsedAlice.rkey, parsedBob.rkey);
  } else {
    assert.fail("expected both parsed routes to be project routes");
  }
});

test("parseRoute rejects invalid segments, bad percent encoding, and unknown paths", () => {
  for (const bad of [
    "",
    "w/did:plc:abc/acme",
    "//evil.com",
    "/w/%ZZ/acme",
    "/w/not-a-did/acme",
    "/w/did:plc:abc/..",
    "/w/did:plc:abc/acme",
    "/w/did:plc:abc/self/c/..",
    "/w/did:plc:abc/self/c/gen/m/did:plc:bob/..",
    "/w/did:plc:abc/self/ext/unknown",
    "/dm/not-a-tid",
    "/unknown",
  ]) {
    assert.equal(parseRoute(bad), null, `expected null for ${bad}`);
  }
});

test("validateReturnTo accepts safe relative routes and rejects all open-redirect / OAuth-loop vectors", () => {
  assert.equal(validateReturnTo("/"), "/");
  assert.equal(validateReturnTo("/w/did%3Aweb%3Alocalhost%253A3000/acme/c/gen?thread=at%3A%2F%2F1"), "/w/did%3Aweb%3Alocalhost%253A3000/acme/c/gen?thread=at%3A%2F%2F1");
  assert.equal(validateReturnTo("/dm/3k22222222222"), "/dm/3k22222222222");

  for (const attack of [
    null,
    undefined,
    123,
    "",
    "relative/no-slash",
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\evil.com",
    "/w/a/b\\@evil.com",
    "/w?next=\\evil",
    "https://evil.com/w/a/b",
    "http://127.0.0.1:3000/w/a/b",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "/\t/evil.com",
    "/\n/evil.com",
    "/w/a\u0000/b",
    "/w/a\u007f/b",
    "/oauth",
    "/oauth/",
    "/oauth/callback",
    "/oauth/callback?code=123",
    "/OAuth/callback",
    "/w/../oauth/callback",
    "/w/../oauth",
  ]) {
    assert.equal(validateReturnTo(attack), null, `expected rejection for ${JSON.stringify(attack)}`);
  }
});

test("captureReturnTo and consumeReturnTo strip transient params, preserve deep routes, and consume single-use", () => {
  const storage = memoryStorage();
  assert.equal(sanitizeReturnTo("/w/did%3Aplc%3Aa/acme/c/gen", "?invite=at%3A%2F%2Fx&thread=at%3A%2F%2Fmsg&signout=kept&authority=failed"), "/w/did%3Aplc%3Aa/acme/c/gen?thread=at%3A%2F%2Fmsg");

  const captured = captureReturnTo("/w/did%3Aplc%3Aa/acme/c/gen", "?thread=at%3A%2F%2Fmsg&invite=x", storage);
  assert.equal(captured, "/w/did%3Aplc%3Aa/acme/c/gen?thread=at%3A%2F%2Fmsg");
  assert.equal(storage.getItem(RETURN_TO_KEY), "/w/did%3Aplc%3Aa/acme/c/gen?thread=at%3A%2F%2Fmsg");

  assert.equal(consumeReturnTo(storage), "/w/did%3Aplc%3Aa/acme/c/gen?thread=at%3A%2F%2Fmsg");
  assert.equal(storage.getItem(RETURN_TO_KEY), null, "consumed single-use");
  assert.equal(consumeReturnTo(storage), "/", "subsequent consume falls back to /");

  captureReturnTo("/w/did%3Aplc%3Aa/acme", "", storage);
  assert.equal(captureReturnTo("/", "?signout=unrevoked", storage), null);
  assert.equal(storage.getItem(RETURN_TO_KEY), null, "navigating at root clears stale returnTo");

  storage.setItem(RETURN_TO_KEY, "https://evil.example/phish");
  assert.equal(consumeReturnTo(storage), "/");
  assert.equal(storage.getItem(RETURN_TO_KEY), null);
});

test("sentThreadCleanupRoute clears ?thread= only when still on that channel with a thread query", () => {
  const sent = {
    authority: DID_PLC,
    workspaceSkey: "self",
    workspaceUri: `at:space/${DID_PLC}/new.flock.workspace/self`,
    channelSkey: "general",
  };
  assert.equal(
    sentThreadCleanupRoute(parseRoute(`/w/${encodeURIComponent(DID_PLC)}/self`), sent),
    null,
    "navigating back to workspace home suppresses post-send channel replace",
  );
  assert.equal(
    sentThreadCleanupRoute(parseRoute(`/w/${encodeURIComponent(DID_PLC)}/self/c/general`), sent),
    null,
    "plain channel URL without ?thread= needs no redundant router.replace",
  );
  assert.equal(
    sentThreadCleanupRoute(parseRoute(`/w/${encodeURIComponent(DID_PLC)}/self/c/random`, `?thread=at://msg/1`), sent),
    null,
    "switching to another channel suppresses post-send replace on the previous channel",
  );
  assert.equal(
    sentThreadCleanupRoute(parseRoute(`/w/${encodeURIComponent(DID_PLC)}/self/c/general`, `?thread=at://msg/1`), sent),
    `/w/${encodeURIComponent(DID_PLC)}/self/c/general`,
  );
});
