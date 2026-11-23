import assert from "node:assert/strict";
import test from "node:test";
import { validateMessageInput } from "@flock/client/blocks";
import { ECHO_BOT_COMMANDS, echoActionReply, echoCommandReply, echoReply } from "./echo";

const channel = { workspace: "at://did:plc:a/space/new.flock.workspace/self", skey: "general" };
const uri = "at://did:plc:a/space/new.flock.channel/general/did:plc:p/new.flock.channel.message/3m2222222222a";

test("the echo bot answers a message with its text, in its thread", () => {
  assert.deepEqual(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: " hello " } } }), { text: "echo: hello", parent: uri });
  const parent = `${uri.slice(0, -1)}b`;
  assert.deepEqual(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "hi", parent } } })?.parent, parent, "a reply's thread is its parent's");
});

test("the echo bot is silent where it reads only, for a message with no text, and for a moderation-hidden message", () => {
  assert.equal(echoReply({ channel, canWrite: false, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "hello" } } }), null);
  assert.equal(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "   " } } }), null);
  assert.equal(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", hidden: true, labels: ["!hide"], value: { text: "hello" } } }), null);
});

test("the echo bot's answer stays within a message's length", () => {
  const reply = echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "👍".repeat(10_000) } } });
  assert.equal([...new Intl.Segmenter().segment(reply!.text)].length, 10_000);
});

test("the echo bot declares /echo and answers both /echo and Again with valid blocks", () => {
  assert.deepEqual(ECHO_BOT_COMMANDS.map((cmd) => cmd.name), ["echo"]);
  const cmdReply = echoCommandReply({ canWrite: true, command: "echo", text: " hello world " });
  assert.ok(cmdReply);
  assert.equal(cmdReply.text, "echo: hello world");
  assert.equal(cmdReply.parent, undefined);
  assert.equal(validateMessageInput({ text: cmdReply.text, blocks: cmdReply.blocks }).valid, true);

  assert.equal(echoCommandReply({ canWrite: false, command: "echo", text: "hello" }), null);
  assert.equal(echoCommandReply({ canWrite: true, command: "echo", text: "   " }), null);
  assert.equal(echoCommandReply({ canWrite: true, command: "other", text: "hello" }), null);

  const actionReply = echoActionReply({
    canWrite: true,
    actionId: "again",
    value: "hello world",
    message: { uri, repo: "did:plc:bot", rkey: "3m2222222222a", value: { text: "echo: hello world", parent: uri } },
  });
  assert.ok(actionReply);
  assert.equal(actionReply.text, "echo: hello world");
  assert.equal(actionReply.parent, uri);
  assert.equal(validateMessageInput({ text: actionReply.text, blocks: actionReply.blocks }).valid, true);

  // Oversized command text still produces valid section and button value bounds.
  const longReply = echoCommandReply({ canWrite: true, command: "echo", text: "👍".repeat(5_000) });
  assert.ok(longReply);
  assert.equal(validateMessageInput({ text: longReply.text, blocks: longReply.blocks }).valid, true);
});
