import assert from "node:assert/strict";
import test from "node:test";
import { failureLine } from "./failure-line";

test("a failure is logged as one line, however its message was written", () => {
  // #given a sign-in callback's error, which echoes the state its caller sent, carrying a line break and a forged log line
  const forged = new Error('Unknown authorization session "x\r\necho-bot: the account\'s session is gone; sign the bot in again."');

  // #when it is logged
  const line = failureLine(forged);

  // #then it is one line, with the break written out
  assert.equal(line, 'echo-bot: Unknown authorization session "x\\u{d}\\u{a}echo-bot: the account\'s session is gone; sign the bot in again."\n');
});

test("terminal escapes, bidirectional overrides and Unicode line separators are written out", () => {
  assert.equal(failureLine(new Error("\u001b[2Jred\u{202e}done\u{2028}next\u009b")), "echo-bot: \\u{1b}[2Jred\\u{202e}done\\u{2028}next\\u{9b}\n");
});

test("readable text is kept as it is, and a failure that is not an Error is logged by its text", () => {
  assert.equal(failureLine(new Error("café 👋 did:plc:abc")), "echo-bot: café 👋 did:plc:abc\n");
  assert.equal(failureLine("refused"), "echo-bot: refused\n");
});
