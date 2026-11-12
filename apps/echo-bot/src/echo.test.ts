import assert from "node:assert/strict";
import test from "node:test";
import { echoReply } from "./echo";

const channel = { workspace: "at://did:plc:a/space/new.flock.workspace/acme", skey: "acme-general" };
const uri = "at://did:plc:a/space/new.flock.channel/acme-general/did:plc:p/new.flock.channel.message/3m2222222222a";

test("the echo bot answers a message with its text, in its thread", () => {
  assert.deepEqual(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: " hello " } } }), { text: "echo: hello", parent: uri });
  const parent = `${uri.slice(0, -1)}b`;
  assert.deepEqual(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "hi", parent } } })?.parent, parent, "a reply's thread is its parent's");
});

test("the echo bot is silent where it reads only, and for a message with no text", () => {
  assert.equal(echoReply({ channel, canWrite: false, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "hello" } } }), null);
  assert.equal(echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "   " } } }), null);
});

test("the echo bot's answer stays within a message's length", () => {
  const reply = echoReply({ channel, canWrite: true, message: { uri, repo: "did:plc:p", rkey: "3m2222222222a", value: { text: "👍".repeat(10_000) } } });
  assert.equal([...new Intl.Segmenter().segment(reply!.text)].length, 10_000);
});
