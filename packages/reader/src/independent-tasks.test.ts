import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_MAC_TYPE, MAC_HEADER, RECORD_MAC_TYPE } from "@atproto/space";
import { memberspacePolicy } from "@flock/protocol/atproto/space-policy";
import {
  advanceHlc,
  buildEditClosure,
  formatHlc,
  MAX_ANCESTOR_REFS,
  opRef,
} from "@flock/protocol/entity-merge";
import { spaceRecordUri, subjectKey, tasksSpaceUri } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { WORKSPACE_ENVELOPE } from "@flock/protocol/workspace-summary";
import { FakeNetwork } from "@flock/testing/fake-network";
import { readIndependentTasksSpace, type IndependentDeps } from "./independent-tasks";

const AUTHORITY = "did:plc:authority";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob2";
const CAROL = "did:plc:carol";
const DAVE = "did:plc:dave2";
const TIMESTAMP = "2026-11-16T12:00:00.000Z";
const BASE_HLC_MS = 1_700_000_000_000;

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
): Promise<{ workspace: string; tasksSpace: string; skey: string }> {
  const skey = input.skey ?? "acme";
  if (!network.hasAccount(AUTHORITY)) network.createAccount(AUTHORITY, "pds1");
  const owner = network.clientFor(AUTHORITY);

  const { uri: workspace } = await owner.procedure<unknown, { uri: string }>("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.workspace,
    skey,
    policy: memberspacePolicy(),
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceProfile, "self", {
    name: `Workspace ${skey}`,
    createdAt: TIMESTAMP,
  });
  await network.writeAs(AUTHORITY, workspace, COLLECTION.admin, subjectKey(AUTHORITY), {
    subject: AUTHORITY,
    active: true,
    updatedAt: TIMESTAMP,
  });

  const tasksSpace = tasksSpaceUri(AUTHORITY, skey);
  const enableTasks = input.enableTasks ?? true;
  if (enableTasks) {
    await owner.procedure("com.atproto.space.createSpace", {
      spaceType: SPACE_TYPE.tasks,
      skey: tasksSpace.split("/").at(-1)!,
      policy: memberspacePolicy(),
    });
    await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: tasksSpace,
      cleanupComplete: false,
      enabledBy: AUTHORITY,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
  }

  const tasksMembers = new Set(input.tasksReadMembers ?? input.members);
  for (const did of [AUTHORITY, ...input.members]) {
    if ((input.createMissingAccounts ?? true) && !network.hasAccount(did)) {
      network.createAccount(did, did.endsWith("2") ? "pds2" : "pds1");
    }
    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(did), {
      subject: did,
      active: true,
      updatedAt: TIMESTAMP,
    });
    if (did === AUTHORITY) continue;
    await owner.procedure("com.atproto.memberspace.putMember", { space: workspace, did, read: true, write: true });
    if (enableTasks && tasksMembers.has(did)) {
      await owner.procedure("com.atproto.memberspace.putMember", { space: tasksSpace, did, read: true, write: true });
    }
  }

  return { workspace, tasksSpace, skey };
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
    space: tasksSpaceUri(AUTHORITY, "acme"),
    cleanupComplete: true,
    enabledBy: AUTHORITY,
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
    assert.equal(result.setAside[0]!.permanent, true);
    assert.deepEqual(result.activities, [], "Activity suppressed when complete is false");
  }

  // 3. Roster member whose resolvePds fails (or returns non-loopback http://) -> fail closed.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
      members: [ALICE, CAROL],
      createMissingAccounts: false,
    });
    network.createAccount(ALICE, "pds1");
    await network.writeAs(ALICE, tasksSpace, COLLECTION.task, tidFor(1), {
      title: "Task",
      status: "todo",
      priority: "none",
      t: hlcAt(0),
      createdAt: TIMESTAMP,
    });

    // Carol has no account so resolvePds(CAROL) throws.
    const noAccount = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(noAccount.complete, false);
    assert.equal(noAccount.degraded, true);
    assert.deepEqual(noAccount.setAside.map((s) => s.did), [CAROL]);

    // Register Carol but have resolvePds return unsafe plain HTTP on a non-loopback host -> still fail closed.
    network.createAccount(CAROL, "pds2");
    const baseDeps = depsFor(network, ALICE);
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
        headers.set(MAC_HEADER, headers.get(MAC_HEADER)!.replace(COMMIT_MAC_TYPE, RECORD_MAC_TYPE));
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
        headers.set(MAC_HEADER, headers.get(MAC_HEADER)!.replace(/mac=:[^:]+:/, "mac=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:"));
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

test("malformed workspace.roster or ext.install sets workspaceSnapshotComplete: false, complete: false, and suppresses Activity", async () => {
  // 1. Malformed workspace.roster record alongside valid active tasks ext.install -> snapshot incomplete, tasks read with complete: false & Activity suppressed.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
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

    // Inject malformed workspace.roster record (rkey does not match subjectKey(subject)).
    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, "bad-roster-key", {
      subject: CAROL,
      active: true,
      updatedAt: TIMESTAMP,
    });

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.enabled, true);
    assert.equal(result.workspaceSnapshotComplete, false);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.ok(result.degradedReasons.some((r) => r.includes(COLLECTION.workspaceRoster)));
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]!.conflictFinal, false);
    assert.equal(result.tasks[0]!.otherVersions.title?.length, 1);
    assert.deepEqual(result.activities, [], "conflict Activity must be suppressed when workspaceSnapshotComplete is false");
  }

  // 2. Malformed secondary ext.install record -> workspaceSnapshotComplete: false & Activity suppressed.
  {
    const network = new FakeNetwork();
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
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

    await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "bogus", {
      extId: "bogus",
      active: true,
      space: tasksSpace,
      enabledBy: AUTHORITY,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const result = await readIndependentTasksSpace(depsFor(network, ALICE), workspace);
    assert.equal(result.enabled, true);
    assert.equal(result.workspaceSnapshotComplete, false);
    assert.equal(result.complete, false);
    assert.equal(result.degraded, true);
    assert.ok(result.degradedReasons.some((r) => r.includes(COLLECTION.extInstall)));
    assert.deepEqual(result.activities, []);
  }

  // 3. Malformed "tasks" ext.install (non-canonical space URI) -> enabled: false, workspaceSnapshotComplete: false, complete: false.
  {
    const network = new FakeNetwork();
    const { workspace } = await createTasksWorkspaceFixture(network, { members: [ALICE] });
    await network.writeAs(AUTHORITY, workspace, COLLECTION.extInstall, "tasks", {
      extId: "tasks",
      active: true,
      space: `at://${AUTHORITY}/space/${SPACE_TYPE.tasks}/non-canonical`,
      cleanupComplete: false,
      enabledBy: AUTHORITY,
      enabledAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
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
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
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

    // Remove Bob from roster & Tasks space access (D14 purge).
    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(BOB), {
      subject: BOB,
      active: false,
      updatedAt: TIMESTAMP,
    });
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: tasksSpace, did: BOB });

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
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, {
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
    await network.writeAs(AUTHORITY, workspace, COLLECTION.workspaceRoster, subjectKey(BOB), {
      subject: BOB,
      active: false,
      updatedAt: TIMESTAMP,
    });
    await network.clientFor(AUTHORITY).procedure("com.atproto.memberspace.removeMember", { space: tasksSpace, did: BOB });

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
        headers.set(MAC_HEADER, headers.get(MAC_HEADER)!.replace(COMMIT_MAC_TYPE, RECORD_MAC_TYPE));
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
    const { workspace, tasksSpace } = await createTasksWorkspaceFixture(network, { members: [ALICE, BOB] });
    const extraRosterBatch1 = Array.from({ length: 199 }, (_, i) => ({
      action: "create" as const,
      collection: COLLECTION.workspaceRoster,
      rkey: subjectKey(`did:plc:extra${i}`),
      value: { subject: `did:plc:extra${i}`, active: true, updatedAt: TIMESTAMP },
    }));
    await network.applyWritesAs(AUTHORITY, workspace, extraRosterBatch1);

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
