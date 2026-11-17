import assert from "node:assert/strict";
import test from "node:test";
import { appInboxUri, channelUri, dmConversationUri, dmInboxUri, inboxUri, tasksSpaceUri, workspaceUri } from "@flock/protocol/keys";
import { dropMemberList, MEMBER_LIST_TTL_MS, mayFollow, type MemberAccessDeps } from "./member-access";

// Who may follow a space's changes: the feed authorization rows of the plan's R5 tests, against an injected member list.

const OWNER = "did:plc:owner";
const MEMBER = "did:plc:member";
const OUTSIDER = "did:plc:outsider";
const UNREGISTERED = channelUri(OWNER, "rules-unregistered");

type Member = { did: string; read: boolean; write: boolean };

function deps(lists: Map<string, Member[] | Error>, clock = { now: 1_000_000 }, registered = (space: string) => space !== UNREGISTERED) {
  const reads: string[] = [];
  const access: MemberAccessDeps = {
    isRegistered: registered,
    readMembers: async (space) => {
      reads.push(space);
      const list = lists.get(space);
      if (!list) throw new Error("SpaceNotFound");
      if (list instanceof Error) throw list;
      return list;
    },
    now: () => clock.now,
  };
  return { access, reads, clock };
}

test("a member who may read follows a space; one without read, an outsider and a write-only inbox member do not", async () => {
  const channel = channelUri(OWNER, "rules-general");
  const inbox = inboxUri(OWNER, "rules");
  const { access } = deps(new Map<string, Member[]>([
    [channel, [{ did: MEMBER, read: true, write: true }, { did: "did:plc:nonreader", read: false, write: true }]],
    [inbox, [{ did: MEMBER, read: false, write: true }]],
  ]));
  assert.equal(await mayFollow(channel, MEMBER, access), true);
  assert.equal(await mayFollow(channel, "did:plc:nonreader", access), false);
  assert.equal(await mayFollow(channel, OUTSIDER, access), false);
  assert.equal(await mayFollow(inbox, MEMBER, access), false, "a write-only inbox member is denied the inbox");
});

test("the authority follows its space only while the space's member list can be read: a deleted space is denied to it too", async () => {
  const workspace = workspaceUri(OWNER, "rules-deleted");
  const lists = new Map<string, Member[] | Error>([[workspace, []]]);
  const { access } = deps(lists);
  assert.equal(await mayFollow(workspace, OWNER, access), true);
  lists.set(workspace, new Error("SpaceDeleted"));
  dropMemberList(workspace);
  assert.equal(await mayFollow(workspace, OWNER, access), false);
});

test("a guessed channel and a failed lookup are denied, and a failed lookup is asked again next time", async () => {
  const guessed = channelUri(OWNER, "rules-guessed");
  const failing = channelUri(OWNER, "rules-failing");
  const lists = new Map<string, Member[] | Error>([[failing, new Error("ServiceUnavailable")]]);
  const { access, reads } = deps(lists);
  assert.equal(await mayFollow(guessed, MEMBER, access), false);
  assert.equal(await mayFollow(failing, MEMBER, access), false);
  lists.set(failing, [{ did: MEMBER, read: true, write: true }]);
  assert.equal(await mayFollow(failing, MEMBER, access), true);
  assert.equal(reads.filter((space) => space === failing).length, 2);
});

test("a list is reused for a minute, dropped at once when the operator changes it, and read again after a minute otherwise", async () => {
  const channel = channelUri(OWNER, "rules-cached");
  const lists = new Map<string, Member[] | Error>([[channel, [{ did: MEMBER, read: true, write: true }]]]);
  const { access, reads, clock } = deps(lists);
  await Promise.all([mayFollow(channel, MEMBER, access), mayFollow(channel, MEMBER, access)]);
  assert.equal(reads.length, 1, "asks at once share one read");
  lists.set(channel, []);
  assert.equal(await mayFollow(channel, MEMBER, access), true, "a change made elsewhere is seen within the minute (D12)");
  clock.now += MEMBER_LIST_TTL_MS;
  assert.equal(await mayFollow(channel, MEMBER, access), false);
  lists.set(channel, [{ did: MEMBER, read: true, write: true }]);
  dropMemberList(channel);
  assert.equal(await mayFollow(channel, MEMBER, access), true, "the operator's own change is seen at once");
});

test("a DM inbox is followed only by its owner, a conversation half by anyone, and any other space by no one", async () => {
  const { access, reads } = deps(new Map());
  assert.equal(await mayFollow(dmInboxUri(MEMBER), MEMBER, access), true);
  assert.equal(await mayFollow(dmInboxUri(MEMBER), OUTSIDER, access), false);
  assert.equal(await mayFollow(dmConversationUri(MEMBER, "3jzfcijpj2z2a"), OUTSIDER, access), true);
  assert.equal(await mayFollow("at://did:plc:owner/space/com.example.other/x", OWNER, access), false);
  assert.deepEqual(reads, [], "none of these reads a member list");
});

test("a space the operator never registered is denied before any grant is restored or member list read", async () => {
  const { access, reads } = deps(new Map([[UNREGISTERED, [{ did: MEMBER, read: true, write: true }]]]));
  assert.equal(await mayFollow(UNREGISTERED, MEMBER, access), false);
  assert.equal(await mayFollow(UNREGISTERED, OWNER, access), false, "not its authority either: the operator does not know the space");
  assert.deepEqual(reads, []);
});

test("an app inbox admits the installed app (read only) and the authority, and denies write-only roster members and admins", async () => {
  const app = "did:plc:bot";
  const admin = "did:plc:admin";
  const appInbox = appInboxUri(OWNER, "acme", app);
  const unregisteredAppInbox = appInboxUri(OWNER, "acme", "did:plc:otherbot");
  const { access } = deps(
    new Map([
      [appInbox, [{ did: app, read: true, write: false }, { did: MEMBER, read: false, write: true }, { did: admin, read: false, write: true }]],
      [unregisteredAppInbox, [{ did: "did:plc:otherbot", read: true, write: false }]],
    ]),
    { now: 1_000_000 },
    (space) => space !== UNREGISTERED && space !== unregisteredAppInbox,
  );
  assert.equal(await mayFollow(appInbox, app, access), true, "the app has read=true");
  assert.equal(await mayFollow(appInbox, OWNER, access), true, "the authority owns the space");
  assert.equal(await mayFollow(appInbox, MEMBER, access), false, "roster writers cannot follow");
  assert.equal(await mayFollow(appInbox, admin, access), false, "non-authority admins cannot follow");
  assert.equal(await mayFollow(appInbox, OUTSIDER, access), false);
  assert.equal(await mayFollow(unregisteredAppInbox, "did:plc:otherbot", access), false, "an unregistered inbox is denied");
});

test("a Tasks extension space admits registered members with read=true and the authority, and dropMemberList clears revoked access immediately", async () => {
  const tasks = tasksSpaceUri(OWNER, "acme");
  const unregisteredTasks = tasksSpaceUri(OWNER, "unregistered");
  const lists = new Map<string, Member[]>([
    [tasks, [{ did: MEMBER, read: true, write: true }, { did: "did:plc:writeonly", read: false, write: true }]],
    [unregisteredTasks, [{ did: MEMBER, read: true, write: true }]],
  ]);
  const { access } = deps(lists, { now: 1_000_000 }, (space) => space !== UNREGISTERED && space !== unregisteredTasks);

  assert.equal(await mayFollow(tasks, MEMBER, access), true);
  assert.equal(await mayFollow(tasks, OWNER, access), true);
  assert.equal(await mayFollow(tasks, "did:plc:writeonly", access), false);
  assert.equal(await mayFollow(tasks, OUTSIDER, access), false);
  assert.equal(await mayFollow(unregisteredTasks, MEMBER, access), false);

  lists.set(tasks, []);
  assert.equal(await mayFollow(tasks, MEMBER, access), true, "cached within TTL");
  dropMemberList(tasks);
  assert.equal(await mayFollow(tasks, MEMBER, access), false, "dropMemberList invalidates immediately");
});
