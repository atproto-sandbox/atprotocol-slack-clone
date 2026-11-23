import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_MAC_PROFILE, MAC_COVERED_HEADER, RECORD_MAC_PROFILE, SpaceMacError, SpaceRepoVerificationError } from "@atproto/space";
import { fetchRepoOpsPages, listBoundedWriters, listWritersSince, RepoOpsPageError, WRITER_CURSOR_MAX_AGE_MS, WRITER_REMOVED_TYPE, WRITER_WRITE_TYPE } from "@flock/protocol/atproto/record-pages";
import { mintSpaceCredentialWith } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  advanceHlc,
  buildEditClosure,
  formatHlc,
  MAX_ANCESTOR_REFS,
  opRef,
} from "@flock/protocol/entity-merge";
import { groupMembersUri, SELF_SKEY, spaceRecordUri, tasksSpaceUri, workspaceUri } from "@flock/protocol/keys";
import { ATPROTO_SPACE_COLLECTION, COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { FakeNetwork } from "@flock/testing/fake-network";
import {
  buildHostSuspendedTasksResult,
  readIndependentTasksSpace,
  summarizeVerifiedWorkspaceRecords,
  type IndependentDeps,
} from "./independent-tasks";

const AUTHORITY = "did:plc:authorityaaaaaaaaaaaaaaa";
const ALICE = "did:plc:aliceaaaaaaaaaaaaaaaaaaa";
const BOB = "did:plc:bob2aaaaaaaaaaaaaaaaaaaa";
const CAROL = "did:plc:carolaaaaaaaaaaaaaaaaaaa";
const DAVE = "did:plc:dave2aaaaaaaaaaaaaaaaaaa";
const TIMESTAMP = "2026-11-16T12:00:00.000Z";
const BASE_HLC_MS = 1_700_000_000_000;

function groupDidFor(label: string): string {
  if (label === "acme") return AUTHORITY;
  const cleaned = label.toLowerCase().replace(/[^a-z2-7]/g, "").slice(0, 18);
  return `did:plc:grp${cleaned.padEnd(21, "a")}`;
}

function tidFor(n: number): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let value = n;
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix = alphabet[value % 32]! + suffix;
    value = Math.floor(value / 32);
  }
  return `3k22222${suffix}`;
}

function hlcAt(msOffset: number, counter = 0): string {
  return formatHlc({ ms: BASE_HLC_MS + msOffset, counter });
}

function depsFor(network: FakeNetwork, did: string): IndependentDeps {
  return {
    memberClient: network.clientFor(did),
    resolvePds: network.resolvePds,
    resolveKemKey: network.resolveKemKey,
    fetchEndpoint: network.fetchEndpoint,
    generateKey: network.generateKey,
    now: network.now,
  };
}

async function createTasksWorkspaceFixture(
  network: FakeNetwork,
  input: {
    members: readonly string[];
    enableTasks?: boolean;
    skey?: string;
    tasksReadMembers?: readonly string[];
    createMissingAccounts?: boolean;
  },
): Promise<{ groupDid: string; workspace: string; membersSpace: string; tasksSpace: string; skey: string }> {
  const label = input.skey ?? "acme";
  const groupDid = groupDidFor(label);

  await network.createGroupAccount(groupDid, {
    name: `Workspace ${label}`,
    joinPolicy: "invite",
    publicMeta: true,
    sovereignRotationKeys: ["did:key:zDnaeTestSovereignKey"],
  });
  const owner = network.clientFor(groupDid);
  const workspace = workspaceUri(groupDid);
  const membersSpace = groupMembersUri(groupDid);

  await owner.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey: SELF_SKEY,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: false,
      grants: [
        { role: "admin", read: true, write: true },
        { role: "moderator", read: true, write: true },
        { role: "member", read: true },
      ],
    },
  });

  const tasksSpace = tasksSpaceUri(groupDid, SELF_SKEY);
  const enableTasks = input.enableTasks ?? true;
  if (enableTasks) {
    await owner.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.tasks,
      skey: tasksSpace.split("/").at(-1)!,
      policy: {
        $type: OPENSOCIAL_POLICY,
        publicRead: false,
        unlisted: false,
        grants: [
          { role: "admin", read: true, write: true },
          { role: "moderator", read: true, write: true },
          { role: "member", read: true, write: true },
        ],
      },
    });
  }

  for (const [idx, did] of input.members.entries()) {
    if ((input.createMissingAccounts ?? true) && !network.hasAccount(did)) {
      network.createAccount(did, did.includes("bob2") || did.includes("dave2") ? "pds2" : "pds1");
    }
    if (did === groupDid) continue;
    await owner.procedure("com.atproto.space.putRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: did,
      record: {
        $type: OPENSOCIAL_COLLECTION.membership,
        roles: idx === 0 ? ["admin", "member"] : ["member"],
        createdAt: TIMESTAMP,
      },
    });
    if (network.hasAccount(did)) {
      const mem = await owner.query<{ value: Record<string, unknown> }>("com.atproto.space.getRecord", {
        space: membersSpace,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: did,
      });
      const inc = mem.value["new.flock.incarnation"];
      await network.writeAs(did, membersSpace, OPENSOCIAL_COLLECTION.acceptance, SELF_SKEY, {
        createdAt: TIMESTAMP,
        ...(typeof inc === "string" ? { "new.flock.incarnation": inc } : {}),
      });
    }
  }

  if (enableTasks) {
    await network.writeAs(groupDid, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: input.members[0] ?? ALICE,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  }

  return { groupDid, workspace, membersSpace, tasksSpace, skey: SELF_SKEY };
}

test("multi-writer cold STAR verification merges projects, tasks, comments, OR-Sets, conflicts, and drops orphan/invalid records", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
    members: [ALICE, BOB, CAROL],
  });

  const projectRkey = tidFor(1);
  const projectUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.taskProject, projectRkey);
  await network.writeAs(ALICE, tasksSpace, COLLECTION.taskProject, projectRkey, {
    name: "Platform",
    description: "Core work",
    color: "#112233",
    t: hlcAt(0),
    createdAt: TIMESTAMP,
  });
  await network.writeAs(BOB, tasksSpace, COLLECTION.taskProjectEdit, tidFor(2), {
    subject: projectUri,
    t: hlcAt(10),
    s: [opRef(ALICE, projectRkey)],
    clearDescription: true,
    color: "#445566",
  });

  // Live task with concurrent scalar conflict (title), concurrent equal scalar (priority),
  // concurrent OR-Set add vs remove (labels), and sequential restore.
  const taskRkey = tidFor(10);
  const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, taskRkey);
  await network.writeAs(ALICE, tasksSpace, COLLECTION.task, taskRkey, {
    title: "Initial title",
    status: "todo",
    priority: "none",
    project: projectUri,
    assignees: [ALICE],
    labels: ["bug", "core"],
    t: hlcAt(0),
    createdAt: TIMESTAMP,
  });

  const bobEditRkey = tidFor(11);
  await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, bobEditRkey, {
    subject: taskUri,
    t: hlcAt(20),
    s: [opRef(ALICE, taskRkey)],
    title: "Bob title",
    priority: "high",
    removeLabels: ["bug"],
    addAssignees: [BOB],
  });

  const carolEditRkey = tidFor(12);
  await network.writeAs(CAROL, tasksSpace, COLLECTION.taskEdit, carolEditRkey, {
    subject: taskUri,
    t: hlcAt(30),
    s: [opRef(ALICE, taskRkey)],
    title: "Carol title",
    priority: "high",
    addLabels: ["bug"],
  });

  // Delete + restore task lifecycle on a second task; comments on deleted tasks must be hidden.
  const deletedTaskRkey = tidFor(20);
  const deletedTaskUri = spaceRecordUri(tasksSpace, BOB, COLLECTION.task, deletedTaskRkey);
  await network.writeAs(BOB, tasksSpace, COLLECTION.task, deletedTaskRkey, {
    title: "Temporary task",
    status: "backlog",
    priority: "low",
    t: hlcAt(5),
    createdAt: TIMESTAMP,
  });
  await network.writeAs(CAROL, tasksSpace, COLLECTION.taskEdit, tidFor(21), {
    subject: deletedTaskUri,
    t: hlcAt(40),
    s: [opRef(BOB, deletedTaskRkey)],
    deleted: true,
  });
  await network.writeAs(ALICE, tasksSpace, COLLECTION.taskComment, tidFor(22), {
    subject: deletedTaskUri,
    body: "Hidden comment on deleted task",
    createdAt: "2026-11-16T12:05:00.000Z",
  });

  // Comments on live task (sorted deterministically by createdAt).
  await network.writeAs(CAROL, tasksSpace, COLLECTION.taskComment, tidFor(30), {
    subject: taskUri,
    body: "Second comment",
    createdAt: "2026-11-16T12:02:00.000Z",
  });
  await network.writeAs(BOB, tasksSpace, COLLECTION.taskComment, tidFor(31), {
    subject: taskUri,
    body: "First comment",
    createdAt: "2026-11-16T12:01:00.000Z",
  });

  // Orphan edits & comment targeting missing roots (e.g. removed author under D14).
  const missingTaskUri = spaceRecordUri(tasksSpace, DAVE, COLLECTION.task, tidFor(90));
  const missingProjectUri = spaceRecordUri(tasksSpace, DAVE, COLLECTION.taskProject, tidFor(91));
  await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, tidFor(40), {
    subject: missingTaskUri,
    t: hlcAt(50),
    s: [opRef(DAVE, tidFor(90))],
    title: "Orphan edit",
  });
  await network.writeAs(BOB, tasksSpace, COLLECTION.taskProjectEdit, tidFor(41), {
    subject: missingProjectUri,
    t: hlcAt(50),
    s: [opRef(DAVE, tidFor(91))],
    name: "Orphan project",
  });
  await network.writeAs(CAROL, tasksSpace, COLLECTION.taskComment, tidFor(42), {
    subject: missingTaskUri,
    body: "Orphan comment",
    createdAt: TIMESTAMP,
  });

  // Invalid record in Tasks space (blank title, no-op edit) must be dropped cleanly per registry rules.
  await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(50), {
    title: "   ",
    status: "todo",
    priority: "none",
    t: hlcAt(60),
    createdAt: TIMESTAMP,
  });
  await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, tidFor(51), {
    subject: taskUri,
    t: hlcAt(60),
    s: [opRef(ALICE, taskRkey)],
    clearDescription: false,
  });

  const beforeCalls = new Map(network.calls);
  const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);

  assert.equal(result.enabled, true);
  assert.equal(result.workspaceSnapshotComplete, true);
  assert.equal(result.complete, true);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.degradedReasons, []);
  assert.deepEqual(result.setAside, []);
  assert.equal(result.hasUncertainAncestry, false);

  // Primary STAR path used getRepo, not N+1 getRecord/listRecords.
  assert.ok((network.calls.get("com.atproto.space.getRepo") ?? 0) >= 4);
  assert.equal(network.calls.get("com.atproto.space.getRecord") ?? 0, beforeCalls.get("com.atproto.space.getRecord") ?? 0);
  assert.equal(network.calls.get("com.atproto.space.listRecords") ?? 0, beforeCalls.get("com.atproto.space.listRecords") ?? 0);

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]!.name, "Platform");
  assert.equal(result.projects[0]!.description, undefined);
  assert.equal(result.projects[0]!.color, "#445566");

  assert.equal(result.tasks.length, 2);
  const liveTask = result.tasks.find((t) => t.uri === taskUri)!;
  const deletedTask = result.tasks.find((t) => t.uri === deletedTaskUri)!;
  assert.equal(liveTask.title, "Carol title");
  assert.equal(liveTask.priority, "high");
  assert.equal(liveTask.otherVersions.priority, undefined, "equal concurrent values suppress otherVersions");
  assert.equal(liveTask.otherVersions.title?.length, 1);
  assert.equal(liveTask.otherVersions.title?.[0]?.value, "Bob title");
  assert.deepEqual(liveTask.assignees, [ALICE, BOB]);
  assert.deepEqual(liveTask.labels, ["bug", "core"]);
  assert.equal(deletedTask.deleted, true);

  assert.deepEqual(
    result.commentsByTask.get(taskUri)?.map((c) => c.body),
    ["First comment", "Second comment"],
  );
  assert.equal(result.commentsByTask.get(deletedTaskUri), undefined);
  assert.equal(result.orphanedProjectEdits, 1);
  assert.equal(result.orphanedTaskEdits, 1);
  assert.equal(result.orphanedComments, 1);

  assert.equal(result.activities.length, 2);
  assert.deepEqual(
    result.activities.map((a) => a.kind).sort(),
    ["concurrentFieldOverwrite", "concurrentSetConflict"],
  );
});

test("returns structured disabled result when Tasks extension is missing or deactivated", async () => {
  const network = new FakeNetwork();
  const { workspace } = await createTasksWorkspaceFixture(network, {
    members: [ALICE, BOB],
    enableTasks: false,
  });

  const missingResult = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
  assert.equal(missingResult.enabled, false);
  assert.equal(missingResult.extInstall, null);
  assert.equal(missingResult.workspaceSnapshotComplete, true);
  assert.equal(missingResult.complete, true);
  assert.equal(missingResult.degraded, false);
  assert.deepEqual(missingResult.tasks, []);
  assert.deepEqual(missingResult.projects, []);

  // Explicitly disabled ext.install (active: false, cleanupComplete: true).
  await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: false,
    space: tasksSpaceUri(AUTHORITY, SELF_SKEY),
    cleanupComplete: true,
    enabledBy: ALICE,
    enabledAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    disabledAt: TIMESTAMP,
  });

  const disabledResult = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
  assert.equal(disabledResult.enabled, false);
  assert.equal(disabledResult.extInstall?.active, false);
  assert.equal(disabledResult.extInstall?.cleanupComplete, true);
  assert.equal(disabledResult.workspaceSnapshotComplete, true);
  assert.equal(disabledResult.complete, true);
  assert.equal(disabledResult.degraded, false);
});

test("D11.1 #4 RepoNotFound trust boundary: unwritten non-listed roster member stays complete, listed or unresolvable fails closed", async () => {
  // 1. Unwritten roster member (!listRepos.has(did) && resolvePds succeeds with HTTPS) -> complete: true.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
      members: [ALICE, BOB, CAROL],
    });
    const rkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rkey);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rkey, {
      title: "Solo task",
      status: "todo",
      priority: "medium",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, tidFor(2), {
      subject: taskUri,
      t: hlcAt(10),
      s: [opRef(ALICE, rkey)],
      title: "Bob concurrent A",
    });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, tidFor(3), {
      subject: taskUri,
      t: hlcAt(20),
      s: [opRef(ALICE, rkey)],
      title: "Alice concurrent B",
    });

    // Carol and Authority never wrote to tasksSpace (!listedRepos.has(carol)), so getRepo returns RepoNotFound.
    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.complete, true);
    assert.equal(result.degraded, false);
    assert.deepEqual(result.setAside, []);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.activities.length, 1);
  }

  // 2. Listed writer returning RepoNotFound -> fail closed (setAside + complete: false + Activity suppressed).
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
      members: [ALICE, BOB],
    });
    const rkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rkey);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rkey, {
      title: "Task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, tidFor(2), {
      subject: taskUri,
      t: hlcAt(10),
      s: [opRef(ALICE, rkey)],
      title: "Bob edit",
    });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, tidFor(3), {
      subject: taskUri,
      t: hlcAt(20),
      s: [opRef(ALICE, rkey)],
      title: "Alice edit",
    });
    // Bob was listed in listRepos, then Bob's PDS reports RepoNotFound.
    network.setAccountState(BOB, "missing");

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.equal(result.setAside.length, 1);
    assert.equal(result.setAside[0]!.did, BOB);
    assert.equal(result.setAside[0]!.permanent, false);
    assert.equal(result.setAside[0]!.reason, "its host has no repo for it");
    assert.deepEqual(result.activities, [], "Activity suppressed when complete is false");
  }

  // 3. Roster member whose resolvePds fails (or returns non-loopback http://) -> fail closed.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
      members: [ALICE, CAROL],
    });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });

    const baseDeps = depsFor(network, ALICE);
    // Simulate resolvePds(CAROL) throwing (e.g. unresolvable DID) -> fail closed.
    const noAccount = await readIndependentTasksSpace(
      {
        ...baseDeps,
        resolvePds: async (did) => {
          if (did === CAROL) throw new Error("PLC record missing for CAROL");
          return baseDeps.resolvePds(did);
        },
      },
      workspace,
    );
    assert.equal(noAccount.complete, false);
    assert.equal(noAccount.degraded, true);
    assert.deepEqual(noAccount.setAside.map((s) => s.did), [CAROL]);

    // Have resolvePds return unsafe plain HTTP on a non-loopback host -> still fail closed.
    const unsafeHttp = await readIndependentTasksSpace(
      {
        ...baseDeps,
        resolvePds: async (did) => (did === CAROL ? "http://untrusted.example" : baseDeps.resolvePds(did)),
      },
      workspace,
    );
    assert.equal(unsafeHttp.complete, false);
    assert.equal(unsafeHttp.degraded, true);
    assert.deepEqual(unsafeHttp.setAside.map((s) => s.did), [CAROL]);

    // Loopback HTTP endpoint (127.0.0.1) IS accepted for unwritten RepoNotFound.
    const loopbackResult = await readIndependentTasksSpace(
      {
        ...baseDeps,
        resolvePds: async (did) => (did === CAROL ? "http://127.0.0.1:4000" : baseDeps.resolvePds(did)),
      },
      workspace,
    );
    assert.equal(loopbackResult.complete, true);
    assert.equal(loopbackResult.degraded, false);
    assert.deepEqual(loopbackResult.setAside, []);
  }
});

test("rejects forged MAC, tampered STAR, oversized STAR (>16 MiB), and forged fallback CID without silent fallback", async () => {
  // 1. Forged MAC on getRepo -> setAside + complete: false + NEVER falls back to listRecords.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob task",
      status: "todo",
      priority: "none",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });

    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.repo === BOB && response.ok) {
        const headers = new Headers(response.headers);
        headers.set("signature-input", headers.get("signature-input")!.replaceAll(COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE));
        return new Response(response.body, { status: 200, headers });
      }
      return response;
    };

    const beforeListRecords = network.calls.get("com.atproto.space.listRecords") ?? 0;
    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(network.calls.get("com.atproto.space.listRecords") ?? 0, beforeListRecords, "forged MAC never falls back to listRecords");
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.setAside.map((s) => [s.did, s.permanent]), [[BOB, true]]);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]!.repo, ALICE);
  }

  // 2. Oversized STAR (> 16 MiB default WORKSPACE_ENVELOPE.maxStarArchiveBytes) aborts mid-stream, sets aside, never falls back.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    // Build a genuine >16 MiB repo for BOB (320 valid ~56 KiB task records -> ~18 MiB STAR archive).
    const pad = "x".repeat(56_000);
    const makeBatch = (offset: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        action: "create" as const,
        collection: COLLECTION.task,
        rkey: tidFor(10 + offset + i),
        value: {
          title: `Big ${offset + i}`,
          description: pad,
          status: "todo",
          priority: "none",
          t: hlcAt(10 + offset + i),
          createdAt: TIMESTAMP,
        },
      }));
    await network.applyWritesAs(BOB, tasksSpace, makeBatch(0, 200));
    await network.applyWritesAs(BOB, tasksSpace, makeBatch(200, 120));

    let bytesSeen = 0;
    let streamCanceled = false;
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.repo === BOB && response.ok && response.body) {
        const reader = response.body.getReader();
        const metered = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            bytesSeen += next.value.byteLength;
            controller.enqueue(next.value);
          },
          async cancel() {
            streamCanceled = true;
            await reader.cancel();
          },
        });
        return new Response(metered, { status: 200, headers: response.headers });
      }
      return response;
    };

    const beforeListRecords = network.calls.get("com.atproto.space.listRecords") ?? 0;
    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(network.calls.get("com.atproto.space.listRecords") ?? 0, beforeListRecords, "oversized STAR never falls back to listRecords");
    assert.equal(streamCanceled, true);
    assert.ok(
      bytesSeen > WORKSPACE_ENVELOPE.maxStarArchiveBytes && bytesSeen < WORKSPACE_ENVELOPE.maxStarArchiveBytes + 256 * 1024,
      `expected mid-stream abort right past 16 MiB, got ${bytesSeen} bytes`,
    );
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.setAside.map((s) => [s.did, s.permanent]), [[BOB, true]]);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]!.repo, ALICE);
  }

  // 2b. Configured maxStarRecords bound triggers RepoStarLimitError without falling back to listRecords.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    for (let i = 0; i < 4; i += 1) {
      await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(10 + i), {
        title: `Bob ${i}`,
        status: "todo",
        priority: "none",
        t: hlcAt(10 + i),
        createdAt: TIMESTAMP,
      });
    }
    const beforeListRecords = network.calls.get("com.atproto.space.listRecords") ?? 0;
    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace, { maxStarRecords: 3 });
    assert.equal(network.calls.get("com.atproto.space.listRecords") ?? 0, beforeListRecords);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.setAside.map((s) => [s.did, s.permanent]), [[BOB, true]]);
    assert.equal(result.tasks.length, 1);
  }

  // 2c. Truncated STAR stream (RepoVerificationError after retries) sets aside without falling back.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob task",
      status: "todo",
      priority: "none",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });
    network.interceptResponse = async ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.repo === BOB && response.ok) {
        const full = new Uint8Array(await response.arrayBuffer());
        return new Response(full.subarray(0, full.length - 8), { status: 200, headers: response.headers });
      }
      return response;
    };
    const beforeListRecords = network.calls.get("com.atproto.space.listRecords") ?? 0;
    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(network.calls.get("com.atproto.space.listRecords") ?? 0, beforeListRecords);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.setAside.map((s) => s.did), [BOB]);
  }

  // 3. Fallback path when getRepo is unsupported (501): handles mid-scan race retry, and fails closed on forged CID or forged MAC.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice fallback",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob fallback",
      status: "done",
      priority: "high",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });

    let racedOnce = false;
    network.beforeGetLatestCommit = async ({ space, repo }) => {
      if (space === tasksSpace && repo === ALICE && !racedOnce) {
        racedOnce = true;
        await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(3), {
          title: "Alice concurrent task",
          status: "in_progress",
          priority: "urgent",
          t: hlcAt(20),
          createdAt: TIMESTAMP,
        });
      }
    };
    network.interceptResponse = ({ method, response }) => {
      if (method === "com.atproto.space.getRepo") {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no getRepo" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };

    const okFallback = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(racedOnce, true);
    assert.equal(okFallback.complete, true);
    assert.equal(okFallback.degraded, false);
    assert.equal(okFallback.tasks.length, 3);
    network.beforeGetLatestCommit = undefined;

    // Now forge a record value in BOB's listRecords response (CID mismatch).
    network.interceptResponse = async ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo") {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no getRepo" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "com.atproto.space.listRecords" && params.space === tasksSpace && params.repo === BOB && response.ok) {
        const body = await response.json() as { records: Array<{ value: Record<string, unknown> }> };
        body.records[0]!.value.title = "Forged title";
        return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
      }
      return response;
    };

    const forgedCidResult = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(forgedCidResult.complete, false);
    assert.equal(forgedCidResult.degraded, true);
    assert.deepEqual(forgedCidResult.setAside.map((s) => [s.did, s.permanent]), [[BOB, true]]);
    assert.equal(forgedCidResult.tasks.every((t) => t.repo === ALICE), true);

    // Forged MAC on fallback getLatestCommit also sets writer aside permanently.
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo") {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no getRepo" }), {
          status: 501,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "com.atproto.space.getLatestCommit" && params.space === tasksSpace && params.repo === BOB && response.ok) {
        const headers = new Headers(response.headers);
        headers.set("signature", headers.get("signature")!.replace(/mac=:[^:]+:/, "mac=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:"));
        return new Response(response.body, { status: 200, headers });
      }
      return response;
    };
    const forgedFallbackMac = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(forgedFallbackMac.complete, false);
    assert.equal(forgedFallbackMac.degraded, true);
    assert.deepEqual(forgedFallbackMac.setAside.map((s) => [s.did, s.permanent]), [[BOB, true]]);
  }
});

test("overflowed membership envelope or malformed ext.install sets workspaceSnapshotComplete: false, complete: false, and suppresses Activity", async () => {
  // 1. Membership envelope overflow (> 200 members) alongside valid active tasks ext.install -> snapshot incomplete, tasks read with complete: false & Activity suppressed.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    const rkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rkey);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rkey, {
      title: "Root",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, tidFor(2), {
      subject: taskUri,
      t: hlcAt(10),
      s: [opRef(ALICE, rkey)],
      title: "Alice title",
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, tidFor(3), {
      subject: taskUri,
      t: hlcAt(20),
      s: [opRef(ALICE, rkey)],
      title: "Bob title",
    });

    for (let i = 0; i < 199; i += 1) {
      const extraDid = `did:plc:extramem${String(i).padStart(4, "0")}aaaaaaaaaaaa`;
      await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: extraDid,
        record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: TIMESTAMP },
      });
    }

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.enabled, true);
    assert.equal(result.workspaceSnapshotComplete, false);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.ok(result.degradedReasons.some((r) => r.includes(`${WORKSPACE_ENVELOPE.members} members`)));
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]!.conflictFinal, false);
    assert.equal(result.tasks[0]!.otherVersions.title?.length, 1);
    assert.deepEqual(result.activities, [], "conflict Activity must be suppressed when workspaceSnapshotComplete is false");
  }

  // 2. Malformed secondary ext.install record (`validate: false`) -> workspaceSnapshotComplete: false & Activity suppressed.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    const rkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rkey);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rkey, {
      title: "Root",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, tidFor(2), {
      subject: taskUri,
      t: hlcAt(10),
      s: [opRef(ALICE, rkey)],
      title: "Alice title",
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, tidFor(3), {
      subject: taskUri,
      t: hlcAt(20),
      s: [opRef(ALICE, rkey)],
      title: "Bob title",
    });

    await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
      space: workspace,
      repo: groupDid,
      collection: COLLECTION.extInstall,
      rkey: "bogus",
      validate: false,
      record: {
        $type: COLLECTION.extInstall,
        extId: "bogus",
        active: true,
        space: tasksSpace,
        enabledBy: ALICE,
        enabledAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    });

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.enabled, true);
    assert.equal(result.workspaceSnapshotComplete, false);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.ok(result.degradedReasons.some((r) => r.includes(COLLECTION.extInstall)));
    assert.deepEqual(result.activities, []);
  }

  // 3. Malformed "tasks" ext.install (non-canonical space URI, `validate: false`) -> enabled: false, workspaceSnapshotComplete: false, complete: false.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
    await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
      space: workspace,
      repo: groupDid,
      collection: COLLECTION.extInstall,
      rkey: "tasks",
      validate: false,
      record: {
        $type: COLLECTION.extInstall,
        extId: "tasks",
        active: true,
        space: `at://${groupDid}/space/${SPACE_TYPE.tasks}/non-canonical`,
        cleanupComplete: false,
        enabledBy: ALICE,
        enabledAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    });

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.enabled, false);
    assert.equal(result.workspaceSnapshotComplete, false);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
  }
});

test("removed intermediate writer B (D -> B -> R and >256 sTruncated overflow) yields deterministic cold merge", async () => {
  // 1. D (Alice) -> B (Bob) -> R (Carol), then Bob removed under D14 -> R still dominates D cleanly and stays final.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, {
      members: [ALICE, BOB, CAROL],
    });
    const rootRkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rootRkey);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rootRkey, {
      title: "Root",
      status: "todo",
      priority: "medium",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    const dRkey = tidFor(2);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, dRkey, {
      subject: taskUri,
      t: hlcAt(10),
      s: [opRef(ALICE, rootRkey)],
      deleted: true,
    });
    const bRkey = tidFor(3);
    await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, bRkey, {
      subject: taskUri,
      t: hlcAt(20),
      s: [opRef(ALICE, rootRkey), opRef(ALICE, dRkey)],
      title: "Bob saw delete",
    });
    const rRkey = tidFor(4);
    await network.writeAs(CAROL, tasksSpace, COLLECTION.taskEdit, rRkey, {
      subject: taskUri,
      t: hlcAt(30),
      s: [opRef(ALICE, rootRkey), opRef(ALICE, dRkey), opRef(BOB, bRkey)],
      deleted: false,
      title: "Carol restored",
    });

    // Remove Bob from membership & Tasks space access (D14 purge).
    await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
    });

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.complete, true);
    assert.equal(result.degraded, false);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]!.deleted, false);
    assert.equal(result.tasks[0]!.title, "Carol restored");
    assert.equal(result.tasks[0]!.uncertainAncestry, false);
    assert.equal(result.tasks[0]!.lifecycleFinal, true);
    assert.equal(result.tasks[0]!.conflictFinal, true);
    assert.deepEqual(result.activities, []);
  }

  // 2. >256 sTruncated overflow across Alice, Bob, Carol, followed by Bob removal -> deterministic cold merge & uncertainAncestry.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, {
      members: [ALICE, BOB, CAROL],
    });
    const rootRkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rootRkey);
    const rootT = hlcAt(0);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rootRkey, {
      title: "Hot task",
      status: "todo",
      priority: "none",
      t: rootT,
      createdAt: TIMESTAMP,
    });

    const ops: Array<{ repo: string; rkey: string; t: string; s?: string[]; sTruncated?: boolean; isRoot?: boolean }> = [
      { repo: ALICE, rkey: rootRkey, t: rootT, isRoot: true },
    ];
    let lastT = rootT;
    for (let i = 1; i <= 260; i += 1) {
      const repo = i % 3 === 0 ? ALICE : i % 3 === 1 ? BOB : CAROL;
      const rkey = tidFor(i + 1);
      lastT = advanceHlc({ wallNowMs: BASE_HLC_MS + i * 10, observedTs: [lastT] });
      const closure = buildEditClosure({ observedOps: ops });
      await network.writeAs(repo, tasksSpace, COLLECTION.taskEdit, rkey, {
        subject: taskUri,
        t: lastT,
        s: closure.s,
        ...(closure.sTruncated ? { sTruncated: true } : {}),
        title: `Revision ${i}`,
      });
      ops.push({ repo, rkey, t: lastT, s: closure.s, sTruncated: closure.sTruncated });
    }
    assert.equal(ops.at(-1)!.sTruncated, true);
    assert.equal(ops.at(-1)!.s!.length, MAX_ANCESTOR_REFS);

    // Purge Bob under D14.
    await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
    });

    const runA = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    const runB = await readIndependentTasksSpace(depsFor(network, CAROL), workspace);
    assert.deepEqual(runA.tasks, runB.tasks);
    assert.equal(runA.complete, true);
    assert.equal(runA.hasUncertainAncestry, true);
    assert.equal(runA.degraded, true);
    assert.ok(runA.degradedReasons.some((r) => r.includes("causal history limit")));
    assert.equal(runA.tasks[0]!.uncertainAncestry, true);
    assert.equal(runA.tasks[0]!.lifecycleFinal, false);
    assert.equal(runA.tasks[0]!.conflictFinal, false);
    assert.equal(runA.tasks[0]!.title, "Revision 260");
    assert.deepEqual(runA.activities, []);
  }
});

test("enforces WORKSPACE_ENVELOPE counts without silently dropping valid tasks or projects", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
    members: [ALICE],
  });

  // 101 active projects (> WORKSPACE_ENVELOPE.taskProjects = 100) + 201 comments on one task (> maxCommentsPerTask = 200).
  const projectWrites = Array.from({ length: WORKSPACE_ENVELOPE.taskProjects + 1 }, (_, i) => ({
    action: "create" as const,
    collection: COLLECTION.taskProject,
    rkey: tidFor(i + 1),
    value: {
      name: `Project ${i}`,
      t: hlcAt(i),
      createdAt: TIMESTAMP,
    },
  }));
  await network.applyWritesAs(ALICE, tasksSpace, projectWrites);

  const taskRkey = tidFor(500);
  const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, taskRkey);
  await network.writeAs(ALICE, tasksSpace, COLLECTION.task, taskRkey, {
    title: "Chatty task",
    status: "todo",
    priority: "none",
    t: hlcAt(1000),
    createdAt: TIMESTAMP,
  });

  const commentBatch1 = Array.from({ length: 150 }, (_, i) => ({
    action: "create" as const,
    collection: COLLECTION.taskComment,
    rkey: tidFor(1000 + i),
    value: {
      subject: taskUri,
      body: `Comment ${i}`,
      createdAt: TIMESTAMP,
    },
  }));
  const commentBatch2 = Array.from({ length: WORKSPACE_ENVELOPE.maxCommentsPerTask + 1 - 150 }, (_, i) => ({
    action: "create" as const,
    collection: COLLECTION.taskComment,
    rkey: tidFor(1200 + i),
    value: {
      subject: taskUri,
      body: `Comment ${150 + i}`,
      createdAt: TIMESTAMP,
    },
  }));
  await network.applyWritesAs(ALICE, tasksSpace, commentBatch1);
  await network.applyWritesAs(ALICE, tasksSpace, commentBatch2);

  const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
  assert.equal(result.complete, true);
  assert.equal(result.degraded, true);
  assert.equal(result.projects.length, WORKSPACE_ENVELOPE.taskProjects + 1);
  assert.equal(result.commentsByTask.get(taskUri)?.length, WORKSPACE_ENVELOPE.maxCommentsPerTask + 1);
  assert.ok(result.degradedReasons.some((r) => r.includes("task projects")));
  assert.ok(result.degradedReasons.some((r) => r.includes("comment")));
});

test("workspace snapshot forged MAC, oversized roster (>200), and deactivated Tasks writer fail closed with degraded state", async () => {
  // 1. Forged MAC on workspace authority repo -> workspaceSnapshotComplete: false, enabled: false, complete: false.
  {
    const network = new FakeNetwork();
    const { workspace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.space === workspace && response.ok) {
        const headers = new Headers(response.headers);
        headers.set("signature-input", headers.get("signature-input")!.replaceAll(COMMIT_MAC_PROFILE, RECORD_MAC_PROFILE));
        return new Response(response.body, { status: 200, headers });
      }
      return response;
    };
    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.enabled, false);
    assert.equal(res.workspaceSnapshotComplete, false);
    assert.equal(res.complete, false);
    assert.equal(res.degraded, true);
    assert.deepEqual(res.setAside.map((s) => [s.did, s.permanent]), [[AUTHORITY, true]]);
  }

  // 2. Active workspace roster > 200 members -> workspaceSnapshotComplete: false, complete: false, Activity suppressed.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    for (let i = 0; i < 199; i += 1) {
      const extraDid = `did:plc:extra${String(i).padStart(4, "0")}aaaaaaaaaaaaaaa`;
      await network.clientFor(groupDid).procedure("com.atproto.space.putRecord", {
        space: membersSpace,
        repo: groupDid,
        collection: OPENSOCIAL_COLLECTION.membership,
        rkey: extraDid,
        record: { $type: OPENSOCIAL_COLLECTION.membership, roles: ["member"], createdAt: TIMESTAMP },
      });
    }

    const rkey = tidFor(1);
    const taskUri = spaceRecordUri(tasksSpace, ALICE, COLLECTION.task, rkey);
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, rkey, {
      title: "Root",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.taskEdit, tidFor(2), {
      subject: taskUri,
      t: hlcAt(10),
      s: [opRef(ALICE, rkey)],
      title: "A",
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.taskEdit, tidFor(3), {
      subject: taskUri,
      t: hlcAt(20),
      s: [opRef(ALICE, rkey)],
      title: "B",
    });

    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.enabled, true);
    assert.equal(res.workspaceSnapshotComplete, false);
    assert.equal(res.complete, false);
    assert.equal(res.degraded, true);
    assert.ok(res.degradedReasons.some((r) => r.includes(`${WORKSPACE_ENVELOPE.members} members`)));
    assert.deepEqual(res.activities, []);
  }

  // 3. Deactivated writer -> setAside (permanent: true) + complete: false, other writers still read.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob task",
      status: "todo",
      priority: "none",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });
    network.setAccountState(BOB, "deactivated");

    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.complete, false);
    assert.equal(res.degraded, true);
    assert.deepEqual(res.setAside.map((s) => [s.did, s.permanent]), [[BOB, true]]);
    assert.equal(res.tasks.length, 1);
    assert.equal(res.tasks[0]!.repo, ALICE);
  }
});

test("JSON listRecords fallback enforces aggregate CBOR byte cap and classifies persistent STAR verification failures permanently", async () => {
  // 1. JSON listRecords fallback exceeding maxStarArchiveBytes -> permanent: true ("its answer is larger than this app reads").
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    for (let i = 0; i < 4; i += 1) {
      await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(10 + i), {
        title: `Bob large ${i} ${"x".repeat(180)}`,
        status: "todo",
        priority: "none",
        t: hlcAt(10 + i),
        createdAt: TIMESTAMP,
      });
    }
    let bobListCalls = 0;
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.space === tasksSpace && params.repo === BOB) {
        return new Response(JSON.stringify({ error: "MethodNotImplemented", message: "no star" }), { status: 501 });
      }
      if (method === "com.atproto.space.listRecords" && params.space === tasksSpace && params.repo === BOB) {
        bobListCalls += 1;
      }
      return response;
    };

    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace, { maxStarArchiveBytes: 768 });
    assert.equal(bobListCalls, 1);
    assert.equal(res.complete, false);
    assert.deepEqual(res.setAside, [
      { did: BOB, reason: "its answer is larger than this app reads", permanent: true },
    ]);
  }

  // 2. Persistent tampered STAR stream after maxListRecordsRetry -> permanent: true ("its records could not be authenticated").
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob",
      status: "todo",
      priority: "none",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.getRepo" && params.repo === BOB && response.ok) {
        const tampered = new Uint8Array(64).fill(0xff);
        return new Response(tampered, { status: 200, headers: response.headers });
      }
      return response;
    };

    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.complete, false);
    assert.deepEqual(res.setAside, [
      { did: BOB, reason: "its records could not be authenticated", permanent: true },
    ]);
  }
});

test("listWriters #repoRemoved, cross-page removal override, and >72h / InvalidCursor fallback reconcile Tasks writers cleanly", async () => {
  // 1. Live FakeNetwork removeMembers emits #repoRemoved so Bob is excluded from listWriters & readIndependentTasksSpace.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob task",
      status: "todo",
      priority: "none",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });

    const cred = await mintSpaceCredentialWith(depsFor(network, ALICE), tasksSpace);
    const beforeScan = await listBoundedWriters(cred.client(await network.resolvePds(AUTHORITY)), { space: tasksSpace, maxRepos: 100 });
    assert.deepEqual(beforeScan.writers.map((w) => w.repo).filter((r) => r !== groupDid).sort(), [ALICE, BOB]);

    await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
    });

    const afterScan = await listBoundedWriters(cred.client(await network.resolvePds(AUTHORITY)), { space: tasksSpace, maxRepos: 100 });
    assert.deepEqual(afterScan.writers.map((w) => w.repo).filter((r) => r !== groupDid), [ALICE]);

    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.complete, true);
    assert.deepEqual(res.tasks.map((t) => t.title), ["Alice task"]);

    const inc = await listWritersSince(cred.client(await network.resolvePds(AUTHORITY)), {
      space: tasksSpace,
      since: beforeScan.spaceRev,
      now: network.now(),
      maxRepos: 100,
    });
    assert.equal(inc.fullReconcile, false);
    assert.deepEqual(inc.updates.map((u) => [u.kind, u.repo]), [["removed", BOB]]);

    const staleFallback = await listWritersSince(cred.client(await network.resolvePds(AUTHORITY)), {
      space: tasksSpace,
      since: beforeScan.spaceRev,
      sinceListedAt: network.now() - WRITER_CURSOR_MAX_AGE_MS - 1,
      now: network.now(),
      maxRepos: 100,
    });
    assert.equal(staleFallback.fullReconcile, true);
    assert.deepEqual(staleFallback.writers?.map((w) => w.repo).filter((r) => r !== groupDid), [ALICE]);

    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listWriters" && params.cursor === beforeScan.spaceRev) {
        return new Response(JSON.stringify({ error: "InvalidCursor", message: "Cursor expired" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const invalidCursorFallback = await listWritersSince(cred.client(await network.resolvePds(AUTHORITY)), {
      space: tasksSpace,
      since: beforeScan.spaceRev,
      now: network.now(),
      maxRepos: 100,
    });
    assert.equal(invalidCursorFallback.fullReconcile, true);
    assert.deepEqual(invalidCursorFallback.writers?.map((w) => w.repo).filter((r) => r !== groupDid), [ALICE]);
  }

  // 2. Cross-page latest-wins: page 1 emits #repoWrite for BOB, page 2 emits #repoRemoved for BOB -> BOB excluded from readIndependentTasksSpace.
  {
    const network = new FakeNetwork();
    const { groupDid, workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Alice survives",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(2), {
      title: "Bob removed across pages",
      status: "todo",
      priority: "none",
      t: hlcAt(10),
      createdAt: TIMESTAMP,
    });
    await network.clientFor(groupDid).procedure("com.atproto.space.deleteRecord", {
      space: membersSpace,
      repo: groupDid,
      collection: OPENSOCIAL_COLLECTION.membership,
      rkey: BOB,
    });

    let bobProbed = false;
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listWriters" && params.space === tasksSpace && response.ok) {
        if (!params.cursor) {
          return Response.json({
            repos: [
              { $type: WRITER_WRITE_TYPE, repo: BOB, repoRev: tidFor(10), spaceRev: tidFor(11), data: { $bytes: "AAAA" } },
              { $type: WRITER_WRITE_TYPE, repo: ALICE, repoRev: tidFor(12), spaceRev: tidFor(13), data: { $bytes: "AAAA" } },
            ],
            cursor: tidFor(13),
          });
        }
        return Response.json({
          repos: [{ $type: WRITER_REMOVED_TYPE, repo: BOB, spaceRev: tidFor(14) }],
        });
      }
      if ((method === "com.atproto.space.getRepo" || method === "com.atproto.space.listRecords") && params.repo === BOB) {
        bobProbed = true;
      }
      return response;
    };

    // Pass maxStarRecords=2? No, limit in listBoundedWriters is Math.min(500, maxRepos); test cross-page via listWriters returning cursor + full page.
    // Force 2-page scan by temporarily testing with listBoundedWriters(maxRepos=2) AND in readIndependentTasksSpace by setting cursor on a full-limit or short page?
    // Wait: listBoundedWriters stops when repos.length < limit! So page 1 returning 2 items when limit is 100 stops on page 1 unless we check listBoundedWriters(maxRepos=2) directly OR limit=2!
    const cred = await mintSpaceCredentialWith(depsFor(network, ALICE), tasksSpace);
    const crossPageScan = await listBoundedWriters(cred.client(await network.resolvePds(AUTHORITY)), {
      space: tasksSpace,
      maxRepos: 2,
    });
    assert.deepEqual(crossPageScan.writers.map((w) => w.repo), [ALICE]);
    assert.equal(crossPageScan.truncated, false);
    assert.equal(bobProbed, false);

    // And with readIndependentTasksSpace (whose limit is MAX_TASKS_WRITERS), simulate a page of length MAX_TASKS_WRITERS? Or pass maxStarRecords? MAX_TASKS_WRITERS = 20_000.
    // On a single page where #repoWrite appears first and #repoRemoved appears later in ascending spaceRev order, latest-wins also deletes BOB:
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listWriters" && params.space === tasksSpace && response.ok) {
        return Response.json({
          repos: [
            { $type: WRITER_WRITE_TYPE, repo: BOB, repoRev: tidFor(10), spaceRev: tidFor(11), data: { $bytes: "AAAA" } },
            { $type: WRITER_WRITE_TYPE, repo: ALICE, repoRev: tidFor(12), spaceRev: tidFor(13), data: { $bytes: "AAAA" } },
            { $type: WRITER_REMOVED_TYPE, repo: BOB, spaceRev: tidFor(14) },
          ],
          cursor: tidFor(14),
        });
      }
      if ((method === "com.atproto.space.getRepo" || method === "com.atproto.space.listRecords") && params.repo === BOB) {
        bobProbed = true;
      }
      return response;
    };
    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.complete, true);
    assert.equal(bobProbed, false);
    assert.deepEqual(res.tasks.map((t) => t.title), ["Alice survives"]);
  }
});

test("host-level RepoTakendown/RepoDeactivated on authorizeSpaceSync/listWriters and repo===authorityDid (N3) are transient while non-authority writer takedown stays permanent", async () => {
  for (const state of ["takendown", "deactivated"] as const) {
    const code = state === "takendown" ? "RepoTakendown" : "RepoDeactivated";
    const expectedReason = state === "takendown" ? "its account was taken down" : "its account is deactivated";

    // 1. Host-level suspension on workspace authorizeSpaceSync -> transient setAside (permanent: false), does not throw.
    {
      const network = new FakeNetwork();
      const { workspace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
      network.setAccountState(AUTHORITY, state);
      const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
      assert.equal(res.enabled, false);
      assert.equal(res.workspaceSnapshotComplete, false);
      assert.equal(res.complete, false);
      assert.equal(res.degraded, true);
      assert.deepEqual(res.setAside, [{ did: AUTHORITY, reason: expectedReason, permanent: false }]);
    }

    // 2. Host-level suspension on tasksSpace authorizeSpaceSync and listWriters -> transient setAside (permanent: false).
    for (const targetEndpoint of ["com.atproto.space.authorizeSpaceSync", "com.atproto.space.listWriters"] as const) {
      const network = new FakeNetwork();
      const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
      network.interceptResponse = ({ method, params, response }) => {
        if (method === targetEndpoint && params.space === tasksSpace) {
          return new Response(JSON.stringify({ error: code, message: `${code}: ${AUTHORITY}` }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      };
      const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
      assert.equal(res.enabled, true);
      assert.equal(res.workspaceSnapshotComplete, true);
      assert.equal(res.complete, false);
      assert.equal(res.degraded, true);
      assert.deepEqual(res.setAside, [{ did: AUTHORITY, reason: expectedReason, permanent: false }]);
    }

    // 3. N3 repo === authorityDid vs non-authority writer BOB on repo reads:
    //    authority repo suspension classifies transient (permanent: false), while BOB's classifies permanent (permanent: true).
    {
      const network = new FakeNetwork();
      const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
      await network.writeAs(AUTHORITY, tasksSpace, COLLECTION.task, tidFor(1), {
        title: "Authority task",
        status: "todo",
        priority: "none",
        t: hlcAt(0),
        createdAt: TIMESTAMP,
      });
      await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(2), {
        title: "Alice task",
        status: "todo",
        priority: "none",
        t: hlcAt(10),
        createdAt: TIMESTAMP,
      });
      await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(3), {
        title: "Bob task",
        status: "todo",
        priority: "none",
        t: hlcAt(20),
        createdAt: TIMESTAMP,
      });

      network.setAccountState(BOB, state);
      network.interceptResponse = ({ method, params, response }) => {
        if (method === "com.atproto.space.getRepo" && params.space === tasksSpace && params.repo === AUTHORITY && response.ok) {
          return new Response(JSON.stringify({ error: code, message: `${code}: ${AUTHORITY}` }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      };

      const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
      assert.equal(res.complete, false);
      assert.equal(res.degraded, true);
      assert.deepEqual(res.tasks.map((t) => t.title), ["Alice task"]);
      assert.deepEqual(
        res.setAside,
        [
          { did: AUTHORITY, reason: expectedReason, permanent: false },
          { did: BOB, reason: expectedReason, permanent: true },
        ].sort((a, b) => a.did.localeCompare(b.did)),
      );
    }

    // 4. N3 repo === authorityDid on workspace snapshot getRepo -> transient setAside (permanent: false).
    {
      const network = new FakeNetwork();
      const { workspace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
      network.interceptResponse = ({ method, params, response }) => {
        if (method === "com.atproto.space.getRepo" && params.space === workspace && params.repo === AUTHORITY && response.ok) {
          return new Response(JSON.stringify({ error: code, message: `${code}: ${AUTHORITY}` }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      };
      const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
      assert.equal(res.enabled, false);
      assert.equal(res.workspaceSnapshotComplete, false);
      assert.deepEqual(res.setAside, [{ did: AUTHORITY, reason: expectedReason, permanent: false }]);
    }
  }

  // RepoSuspended on authority host/repo is also transient, and buildHostSuspendedTasksResult deduplicates authorityDid in setAside.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
    network.interceptResponse = ({ method, params, response }) => {
      if (method === "com.atproto.space.listWriters" && params.space === tasksSpace) {
        return new Response(JSON.stringify({ error: "RepoSuspended", message: `RepoSuspended: ${AUTHORITY}` }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return response;
    };
    const res = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(res.complete, false);
    assert.equal(res.degraded, true);
    assert.deepEqual(res.setAside, [{ did: AUTHORITY, reason: "its account is suspended", permanent: false }]);

    const deduped = buildHostSuspendedTasksResult(
      {
        workspaceUri: workspace,
        authorityDid: AUTHORITY,
        workspaceSkey: "ws1",
        tasksSpaceUri: tasksSpace,
        enabled: true,
        extInstall: res.extInstall,
        rosterMembers: [ALICE],
        workspaceSnapshotComplete: false,
        degradedReasons: ["prior warning"],
        setAside: [
          { did: AUTHORITY, reason: "stale authority entry", permanent: false },
          { did: BOB, reason: "its account is deactivated", permanent: true },
        ],
      },
      "its account is suspended",
    );
    assert.deepEqual(
      deduped.setAside,
      [
        { did: AUTHORITY, reason: "its account is suspended", permanent: false },
        { did: BOB, reason: "its account is deactivated", permanent: true },
      ].sort((a, b) => a.did.localeCompare(b.did)),
    );
  }
});

test("verifies RFC 9421 MACs on every listRepoOps page, refreshes rotated KEM keys, and enforces SpaceKemError/SpaceMacError/RepoNotFound", async () => {
  const network = new FakeNetwork();
  const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB, CAROL] });
  await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
    title: "Alice task",
    status: "todo",
    priority: "none",
    t: hlcAt(0),
    createdAt: TIMESTAMP,
  });
  for (let i = 0; i < 3; i += 1) {
    await network.writeAs(BOB, tasksSpace, COLLECTION.task, tidFor(10 + i), {
      title: `Bob ${i}`,
      status: "todo",
      priority: "none",
      t: hlcAt(10 + i),
      createdAt: TIMESTAMP,
    });
  }

  // 1. Multi-page listRepoOps with limit=1 verifies commit + RFC 9421 MAC on EVERY page; rotated KEM key refreshes cleanly.
  const cred = await mintSpaceCredentialWith(depsFor(network, ALICE), tasksSpace);
  const bobPds = await network.resolvePds(BOB);
  const seenListRepoOpsHeaders: Array<{ acceptSig: string | null; covered: string | null; sigInput: string | null; sig: string | null }> = [];
  const spyCred = await mintSpaceCredentialWith({
    ...depsFor(network, ALICE),
    fetchEndpoint: async (request) => {
      const response = await network.fetchEndpoint(request);
      if (new URL(request.url).pathname === "/xrpc/com.atproto.space.listRepoOps" && response.ok) {
        seenListRepoOpsHeaders.push({
          acceptSig: request.headers.get("accept-signature"),
          covered: response.headers.get(MAC_COVERED_HEADER[COMMIT_MAC_PROFILE]),
          sigInput: response.headers.get("signature-input"),
          sig: response.headers.get("signature"),
        });
      }
      return response;
    },
  }, tasksSpace);

  const paged = await fetchRepoOpsPages(spyCred.client(bobPds), { space: tasksSpace, repo: BOB, limit: 1 });
  assert.equal(paged.ops.length, 3);
  assert.ok(paged.commit.rev);
  assert.equal(seenListRepoOpsHeaders.length, 4);
  for (const pageHeaders of seenListRepoOpsHeaders) {
    assert.match(pageHeaders.acceptSig ?? "", /^mac=\("atproto-space-commit";sf\);keyid="did:key:zDn[^"]*";tag="atproto-space-commit"$/);
    assert.ok(pageHeaders.covered?.includes(`repo="${BOB}"`));
    assert.ok(pageHeaders.sigInput?.includes(`tag="${COMMIT_MAC_PROFILE}"`));
    assert.match(pageHeaders.sig ?? "", /^mac=:/);
  }

  await network.rotateKemKey(BOB);
  const afterRotate = await fetchRepoOpsPages(cred.client(bobPds), { space: tasksSpace, repo: BOB, limit: 2 });
  assert.equal(afterRotate.ops.length, 3);

  // Unwritten writer CAROL -> listRepoOps preserves XrpcError RepoNotFound.
  await assert.rejects(
    fetchRepoOpsPages(cred.client(await network.resolvePds(CAROL)), { space: tasksSpace, repo: CAROL, limit: 10 }),
    (err: unknown) => err instanceof XrpcError && err.code === "RepoNotFound",
  );

  // 2. Intermediate page (cursor !== undefined) missing commit -> RepoOpsPageError / SpaceRepoVerificationError.
  network.interceptResponse = async ({ method, params, response }) => {
    if (method === "com.atproto.space.listRepoOps" && params.repo === BOB && !params.cursor && response.ok) {
      const body = await response.json() as Record<string, unknown>;
      delete body.commit;
      return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
    }
    return response;
  };
  await assert.rejects(
    fetchRepoOpsPages(cred.client(bobPds), { space: tasksSpace, repo: BOB, limit: 1 }),
    (err: unknown) => err instanceof SpaceRepoVerificationError || err instanceof RepoOpsPageError,
  );

  // 3. Intermediate page forged commit.repo -> SpaceRepoVerificationError; forged MAC -> SpaceMacError.
  network.interceptResponse = async ({ method, params, response }) => {
    if (method === "com.atproto.space.listRepoOps" && params.repo === BOB && !params.cursor && response.ok) {
      const body = await response.json() as { commit: Record<string, unknown> };
      body.commit.repo = CAROL;
      return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
    }
    return response;
  };
  await assert.rejects(
    fetchRepoOpsPages(cred.client(bobPds), { space: tasksSpace, repo: BOB, limit: 1 }),
    SpaceRepoVerificationError,
  );

  network.interceptResponse = ({ method, params, response }) => {
    if (method === "com.atproto.space.listRepoOps" && params.repo === BOB && !params.cursor && response.ok) {
      const headers = new Headers(response.headers);
      headers.set("signature", "mac=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:");
      return new Response(response.body, { status: 200, headers });
    }
    return response;
  };
  await assert.rejects(
    fetchRepoOpsPages(cred.client(bobPds), { space: tasksSpace, repo: BOB, limit: 1 }),
    SpaceMacError,
  );
  network.interceptResponse = undefined;

  // 4. STAR getRepo sends application/vnd.dasl.star + RFC 9421 Accept-Signature, refreshes rotated KEM key, and handles SpaceKemError permanently.
  const getRepoHeaders: Array<{ accept: string | null; acceptSig: string | null }> = [];
  await network.rotateKemKey(BOB);
  const baseDeps = depsFor(network, ALICE);
  const starOk = await readIndependentTasksSpace({
    ...baseDeps,
    fetchEndpoint: async (req) => {
      if (new URL(req.url).pathname === "/xrpc/com.atproto.space.getRepo") {
        getRepoHeaders.push({ accept: req.headers.get("accept"), acceptSig: req.headers.get("accept-signature") });
      }
      return baseDeps.fetchEndpoint(req);
    },
  }, workspace);
  assert.equal(starOk.complete, true);
  assert.ok(getRepoHeaders.some((h) => h.accept === "application/vnd.dasl.star" && /^mac=\("atproto-space-commit";sf\)/.test(h.acceptSig ?? "")));

  const badKem = await readIndependentTasksSpace({
    ...baseDeps,
    resolveKemKey: async (did, forceRefresh) => (did === BOB ? "not-a-kem-did-key" : baseDeps.resolveKemKey(did, forceRefresh)),
  }, workspace);
  assert.equal(badKem.complete, false);
  assert.deepEqual(badKem.setAside, [
    { did: BOB, reason: "it publishes no usable #atproto_kem key", permanent: true },
  ]);
});

test("readIndependentTasksSpace marks workspaceSnapshotComplete: false when membersWriterScan is truncated and withholds !takedown members from rosterMembers", async () => {
  const network = new FakeNetwork();
  const { workspace, membersSpace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
  const owner = network.clientFor(AUTHORITY);

  // Account-level !takedown on BOB excludes BOB from snapshot.rosterMembers!
  await owner.procedure("com.atproto.space.putRecord", {
    space: membersSpace,
    repo: AUTHORITY,
    collection: ATPROTO_SPACE_COLLECTION.label,
    rkey: tidFor(50),
    record: {
      $type: ATPROTO_SPACE_COLLECTION.label,
      src: AUTHORITY,
      uri: BOB,
      val: "!takedown",
      cts: "2026-11-10T12:15:00.000Z",
    },
  });
  const baseDeps = depsFor(network, ALICE);
  const withTakedown = await readIndependentTasksSpace(baseDeps, workspace);
  assert.equal(withTakedown.rosterMembers.includes(BOB), false, "!takedown member excluded from tasks rosterMembers");

  // Truncated listWriters on membersSpace marks workspaceSnapshotComplete: false and complete: false!
  const truncMembersWritersDeps = {
    ...baseDeps,
    fetchEndpoint: async (req: Request) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/xrpc/com.atproto.space.listWriters" &&
        url.searchParams.get("space") === membersSpace
      ) {
        const offset = Number((url.searchParams.get("cursor") ?? "w-0").replace("w-", "")) || 0;
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const total = 20_001;
        const count = Math.max(0, Math.min(limit, total - offset));
        const repos = Array.from({ length: count }, (_, idx) => ({
          $type: WRITER_WRITE_TYPE,
          repo: offset === 0 && idx === 0 ? ALICE : `did:web:fillertask-${offset + idx}.example`,
          repoRev: tidFor(10),
          spaceRev: tidFor(10),
        }));
        return Response.json({
          repos,
          ...(offset + count < total ? { cursor: `w-${offset + count}` } : {}),
        });
      }
      return baseDeps.fetchEndpoint(req);
    },
  };
  const truncSnap = await readIndependentTasksSpace(truncMembersWritersDeps, workspace);
  assert.equal(truncSnap.workspaceSnapshotComplete, false);
  assert.equal(truncSnap.complete, false);
  assert.equal(truncSnap.degraded, true);
  assert.ok(truncSnap.degradedReasons.some((r) => r.includes("Members space writer set exceeds")));

  // Round 18 Fix #3: Missing or malformed published `com.atproto.space.policy/self` records (even when ALL core policies are absent!)
  // MUST NOT trigger synthetic fallback policies and MUST mark `workspaceSnapshotComplete: false` and `degradedReasons`!
  const missingPolSnap = summarizeVerifiedWorkspaceRecords({
    workspaceUri: workspace,
    authorityDid: AUTHORITY,
    workspaceSkey: "self",
    expectedTasksSpace: tasksSpace,
    metaUri: `at://${AUTHORITY}/space/group.opensocial.meta/self`,
    membersUri: membersSpace,
    metaRecords: [
      {
        collection: OPENSOCIAL_COLLECTION.profile,
        rkey: SELF_SKEY,
        cid: "bafyreiprofile00001",
        record: { $type: OPENSOCIAL_COLLECTION.profile, displayName: "Acme", joinPolicy: "invite" },
      },
    ],
    membersAuthorityRecords: [
      {
        collection: OPENSOCIAL_COLLECTION.role,
        rkey: "member",
        cid: "bafyreirolemember01",
        record: { $type: OPENSOCIAL_COLLECTION.role, displayName: "Member", default: true },
      },
    ],
    wsAuthorityRecords: [],
    acceptances: [],
    memberWriters: new Map(),
    membersWriterScanTruncated: false,
    memberSetAside: [],
  });
  assert.equal(missingPolSnap.workspaceSnapshotComplete, false, "policy-less snapshot must NEVER fall back to synthetic core policies");
  assert.ok(
    missingPolSnap.degradedReasons.some((r) => r.includes("Space policy records contain malformed or missing entries")),
  );

  const badWrapperSnap = summarizeVerifiedWorkspaceRecords({
    workspaceUri: workspace,
    authorityDid: AUTHORITY,
    workspaceSkey: "self",
    expectedTasksSpace: tasksSpace,
    metaUri: `at://${AUTHORITY}/space/group.opensocial.meta/self`,
    membersUri: membersSpace,
    metaRecords: [
      {
        collection: OPENSOCIAL_COLLECTION.profile,
        rkey: SELF_SKEY,
        cid: "bafyreiprofile00001",
        record: { $type: OPENSOCIAL_COLLECTION.profile, displayName: "Acme", joinPolicy: "invite" },
      },
      {
        collection: ATPROTO_SPACE_COLLECTION.spacePolicy,
        rkey: SELF_SKEY,
        cid: "bafyreipolbad1",
        record: {
          $type: "com.example.wrongWrapper",
          policy: { $type: OPENSOCIAL_POLICY, publicRead: true, unlisted: false, grants: [] },
        },
      },
    ],
    membersAuthorityRecords: [],
    wsAuthorityRecords: [],
    acceptances: [],
    memberWriters: new Map(),
    membersWriterScanTruncated: false,
    memberSetAside: [],
  });
  assert.equal(badWrapperSnap.workspaceSnapshotComplete, false);
  assert.ok(
    badWrapperSnap.degradedReasons.some((r) => r.includes("Space policy records contain malformed or missing entries")),
  );
});
