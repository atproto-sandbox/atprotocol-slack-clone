import assert from "node:assert/strict";
import test from "node:test";
import { channelUri, groupMembersUri, spaceRecordUri } from "./keys";
import { isHidden, isTakendown, LABEL_HIDE, LABEL_TAKEDOWN, labelsForResource, projectActiveLabels } from "./moderation";
import { COLLECTION } from "./nsids";

const GROUP_DID = "did:plc:group123";
const MEMBER_DID = "did:plc:alice123";
const CHANNEL = channelUri(GROUP_DID, "general");
const OTHER_CHANNEL = channelUri(GROUP_DID, "random");
const MEMBERS_SPACE = groupMembersUri(GROUP_DID);
const MSG_URI = spaceRecordUri(CHANNEL, MEMBER_DID, COLLECTION.message, "2222222222222");
const CID_V1 = "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const CID_V2 = "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua";

test("projectActiveLabels selects latest cts per (uri, cid ?? '', val), tie-breaks by rkey desc, and drops expired/invalid/cross-space labels", () => {
  const nowMs = Date.parse("2026-11-20T12:00:00.000Z");

  const active = projectActiveLabels(
    [
      // Older !hide
      {
        repoDid: GROUP_DID,
        rkey: "222222222222a",
        value: { uri: MSG_URI, val: LABEL_HIDE, cts: "2026-11-20T10:00:00.000Z" },
      },
      // Newer !hide wins
      {
        repoDid: GROUP_DID,
        rkey: "222222222222b",
        value: { uri: MSG_URI, val: LABEL_HIDE, cts: "2026-11-20T11:00:00.000Z" },
      },
      // Tie on cts -> higher rkey wins
      {
        repoDid: GROUP_DID,
        rkey: "222222222222c",
        value: { uri: MSG_URI, val: "spoiler", cts: "2026-11-20T11:00:00.000Z" },
      },
      {
        repoDid: GROUP_DID,
        rkey: "222222222222d",
        value: { uri: MSG_URI, val: "spoiler", cts: "2026-11-20T11:00:00.000Z" },
      },
      // Version-pinned !takedown on CID_V1
      {
        repoDid: GROUP_DID,
        rkey: "222222222222e",
        value: { uri: MSG_URI, cid: CID_V1, val: LABEL_TAKEDOWN, cts: "2026-11-20T11:05:00.000Z" },
      },
      // Expired !takedown dropped
      {
        repoDid: GROUP_DID,
        rkey: "222222222222f",
        value: {
          uri: MSG_URI,
          val: LABEL_TAKEDOWN,
          cts: "2026-11-20T09:00:00.000Z",
          exp: "2026-11-20T11:59:59.000Z",
        },
      },
      // Non-authority author ignored
      {
        repoDid: MEMBER_DID,
        rkey: "222222222222g",
        value: { uri: MSG_URI, val: LABEL_TAKEDOWN, cts: "2026-11-20T11:30:00.000Z" },
      },
      // Cross-space record URI ignored
      {
        repoDid: GROUP_DID,
        rkey: "222222222222h",
        value: {
          uri: spaceRecordUri(OTHER_CHANNEL, MEMBER_DID, COLLECTION.message, "2222222222229"),
          val: LABEL_TAKEDOWN,
          cts: "2026-11-20T11:30:00.000Z",
        },
      },
      // Empty label val ignored
      {
        repoDid: GROUP_DID,
        rkey: "222222222222i",
        value: { uri: MSG_URI, val: "", cts: "2026-11-20T11:30:00.000Z" },
      },
      // Invalid leading-'k' TID rkey ignored
      {
        repoDid: GROUP_DID,
        rkey: "k222222222222",
        value: { uri: MSG_URI, val: LABEL_TAKEDOWN, cts: "2026-11-20T11:45:00.000Z" },
      },
    ],
    { groupDid: GROUP_DID, spaceUri: CHANNEL, nowMs },
  );

  assert.equal(active.length, 3);
  assert.equal(active.find((l) => l.val === LABEL_HIDE)?.rkey, "222222222222b");
  assert.equal(active.find((l) => l.val === "spoiler")?.rkey, "222222222222d");

  assert.equal(isHidden(active, MSG_URI, CID_V2), true);
  assert.equal(isTakendown(active, MSG_URI, CID_V1), true);
  assert.equal(isTakendown(active, MSG_URI, CID_V2), false);
  assert.equal(labelsForResource(active, MSG_URI, CID_V1).length, 3);
  assert.equal(labelsForResource(active, MSG_URI, CID_V2).length, 2);
});

test("account DID labels project in org.atgrp.members/self and are rejected in modality spaces", () => {
  const inMembers = projectActiveLabels(
    [
      {
        repoDid: GROUP_DID,
        rkey: "222222222222a",
        value: { uri: MEMBER_DID, val: LABEL_TAKEDOWN, cts: "2026-11-20T10:00:00.000Z" },
      },
    ],
    { groupDid: GROUP_DID, spaceUri: MEMBERS_SPACE },
  );
  assert.equal(isTakendown(inMembers, MEMBER_DID), true);

  const inChannel = projectActiveLabels(
    [
      {
        repoDid: GROUP_DID,
        rkey: "222222222222a",
        value: { uri: MEMBER_DID, val: LABEL_TAKEDOWN, cts: "2026-11-20T10:00:00.000Z" },
      },
    ],
    { groupDid: GROUP_DID, spaceUri: CHANNEL },
  );
  assert.equal(inChannel.length, 0);
});

test("negation labels (neg: true) clear earlier matching labels by latest cts, and later positive labels re-activate", () => {
  const negated = projectActiveLabels(
    [
      {
        repoDid: GROUP_DID,
        rkey: "222222222222a",
        value: { uri: MSG_URI, val: LABEL_HIDE, cts: "2026-11-20T10:00:00.000Z" },
      },
      {
        repoDid: GROUP_DID,
        rkey: "222222222222b",
        value: { uri: MSG_URI, val: LABEL_HIDE, neg: true, cts: "2026-11-20T10:05:00.000Z" },
      },
    ],
    { groupDid: GROUP_DID, spaceUri: CHANNEL },
  );
  assert.equal(isHidden(negated, MSG_URI), false);

  const reapplied = projectActiveLabels(
    [
      {
        repoDid: GROUP_DID,
        rkey: "222222222222a",
        value: { uri: MSG_URI, val: LABEL_HIDE, cts: "2026-11-20T10:00:00.000Z" },
      },
      {
        repoDid: GROUP_DID,
        rkey: "222222222222b",
        value: { uri: MSG_URI, val: LABEL_HIDE, neg: true, cts: "2026-11-20T10:05:00.000Z" },
      },
      {
        repoDid: GROUP_DID,
        rkey: "222222222222c",
        value: { uri: MSG_URI, val: LABEL_HIDE, cts: "2026-11-20T10:10:00.000Z" },
      },
    ],
    { groupDid: GROUP_DID, spaceUri: CHANNEL },
  );
  assert.equal(isHidden(reapplied, MSG_URI), true);
});
