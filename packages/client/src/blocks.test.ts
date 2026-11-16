import assert from "node:assert/strict";
import test from "node:test";
import {
  actionsBlock,
  BLOCK_TYPE,
  button,
  contextBlock,
  dividerBlock,
  findActionButton,
  sectionBlock,
  validateMessageInput,
} from "./blocks";

test("block constructors build valid message blocks and findActionButton locates buttons by actionId", () => {
  const blocks = [
    sectionBlock("Deploy ready"),
    contextBlock(["env: prod", "commit: abc123"]),
    dividerBlock(),
    actionsBlock([
      button({ actionId: "approve", label: "Approve", value: "v1", style: "primary" }),
      button({ actionId: "abort", label: "Abort", style: "danger" }),
    ]),
  ];
  assert.equal(validateMessageInput({ text: "Deploy ready", blocks }).valid, true);
  assert.deepEqual(findActionButton(blocks, "approve"), {
    $type: BLOCK_TYPE.button,
    actionId: "approve",
    label: "Approve",
    value: "v1",
    style: "primary",
  });
  assert.equal(findActionButton(blocks, "missing"), null);
  assert.deepEqual(
    findActionButton([{ $type: BLOCK_TYPE.actions, elements: [{ actionId: "plain", label: "Plain", value: "42" }] }], "plain"),
    { actionId: "plain", label: "Plain", value: "42" },
  );
});

test("validateMessageInput accepts { text, blocks? } only and rejects extra fields, bad shapes, duplicate actionIds, and oversized bodies", () => {
  assert.equal(validateMessageInput({ text: "hello" }).valid, true);
  assert.equal(validateMessageInput({ text: "hello", blocks: undefined }).valid, true);
  assert.equal(validateMessageInput(null).valid, false);
  assert.equal(validateMessageInput([]).valid, false);
  assert.equal(validateMessageInput({ text: "" }).valid, false);
  assert.equal(validateMessageInput({ text: "hello", blocks: null }).valid, false);
  assert.equal(validateMessageInput({ text: "hello", parent: "at://did:plc:a/space/new.flock.channel/g/did:plc:a/new.flock.channel.message/2222222222222" }).valid, false);
  assert.equal(validateMessageInput({ text: "hello", createdAt: "2026-01-01T00:00:00.000Z" }).valid, false);
  assert.equal(validateMessageInput({ text: "hello", extra: true }).valid, false);
  assert.equal(validateMessageInput({
    text: "dup",
    blocks: [actionsBlock([button({ actionId: "same", label: "One" }), button({ actionId: "same", label: "Two" })])],
  }).valid, false);
  assert.equal(validateMessageInput({
    text: "bad-id",
    blocks: [actionsBlock([button({ actionId: "has spaces", label: "One" })])],
  }).valid, false);
  // 20 section blocks of 4,000 bytes each exceed the 64 KiB record limit even though each section is under 12,000 bytes.
  assert.equal(validateMessageInput({
    text: "oversized",
    blocks: Array.from({ length: 20 }, () => sectionBlock("x".repeat(4_000))),
  }).valid, false);
});
