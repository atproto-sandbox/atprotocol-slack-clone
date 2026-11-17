import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { subjectKey, tidNow } from "@flock/protocol/keys";
import { COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { OperationRejectedError } from "../journal";
import { executeOperatorOperation } from "../operations";
import { fakeAuthorityPds, type FakeAuthorityPds, type FakeAuthorityPdsOptions } from "../testing/fake-authority-pds";
import { assertOperatorWorkspaceWithinEnvelope } from "../workspace-envelope";
import { generalKey } from "../workspace-spaces";
import { createWorkspace } from "./create-workspace";
import { enableExtensionWithLimit } from "./extension-access";

const OWNER = "did:plc:owner";
const PERSON = "did:plc:person";
const OTHER = "did:plc:other";
const BOT = "did:plc:bot";
let directory = "";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "extension-access-test-"));
  process.env.DATABASE_PATH = join(directory, "ext.db");
  process.env.AUTH_ENCRYPTION_KEY = "54".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const OUTAGE = () => Response.json({ error: "InternalServerError", message: "outage" }, { status: 500 });
const SCOPE_MISSING = () => Response.json({ error: "ScopeMissingError", message: `Missing required scope "space:${SPACE_TYPE.tasks}"` }, { status: 403 });
const WRITES = new Set(["com.atproto.space.createSpace", "com.atproto.space.putRecord", "com.atproto.memberspace.putMember", "com.atproto.memberspace.removeMember"]);

async function workspace(name: string, intercept: FakeAuthorityPdsOptions["intercept"] = () => undefined) {
  let ready = false;
  const pds = fakeAuthorityPds(OWNER, { intercept: (method, target) => (ready ? intercept(method, target) : undefined) });
  const created = await createWorkspace(pds.session, { creator: OWNER, name, operationId: tidNow() });
  const owner: OperatorActor = { did: OWNER, session: pds.session, workspace: parseWorkspaceRef(created.workspace), canRecoverOperations: true };
  const run = (request: Record<string, unknown>, operationId = tidNow()) => executeOperatorOperation(owner, operationId, request);
  assert.equal((await run({ kind: "inviteMember", subject: PERSON })).state, "completed");
  ready = true;
  return {
    pds,
    owner,
    run,
    general: generalKey(owner.workspace.skey),
    tasksSpace: extSpaceUriFor(OWNER, owner.workspace.skey, "tasks"),
  };
}

async function completes(view: Promise<{ state: string; error?: string }>): Promise<void> {
  const result = await view;
  assert.equal(result.state, "completed", JSON.stringify(result));
}

async function refused(view: Promise<{ state: string; error?: string }>, reason: RegExp): Promise<void> {
  const result = await view;
  assert.equal(result.state, "failed", JSON.stringify(result));
  assert.match(result.error ?? "", reason);
}

const extInstallRecord = (pds: FakeAuthorityPds, owner: OperatorActor) =>
  pds.recordsOf(owner.workspace.uri, COLLECTION.extInstall).get("tasks") as Record<string, unknown> | undefined;

const rowOf = (operationId: string) =>
  getRawDb().prepare("SELECT state, steps_json FROM operation WHERE operation_id = ?").get(operationId) as { state: string; steps_json: string } | undefined;

test("enableExtension creates the Tasks space first, writes ext.install, and grants roster members (not apps) rw access", async () => {
  const { pds, owner, run, general, tasksSpace } = await workspace("Ext One");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const before = pds.writes.length;

  await completes(run({ kind: "enableExtension", extId: "tasks" }));

  assert.equal(pds.writes[before], `createSpace ${tasksSpace}`);
  assert.equal(pds.writes[before + 1], `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`);
  assert.deepEqual(pds.membersOf(tasksSpace).get(PERSON), { did: PERSON, read: true, write: true });
  assert.equal(pds.membersOf(tasksSpace).has(OWNER), false, "the self-owned authority is omitted from the extension member list");
  assert.equal(pds.membersOf(tasksSpace).has(BOT), false, "apps never get Tasks extension space access (D11.9)");

  const record = extInstallRecord(pds, owner);
  assert.equal(record?.extId, "tasks");
  assert.equal(record?.active, true);
  assert.equal(record?.cleanupComplete, false);
  assert.equal(record?.space, tasksSpace);
  assert.equal(record?.enabledBy, OWNER);
  assert.equal(typeof record?.enabledAt, "string");
  assert.equal(typeof record?.updatedAt, "string");
  assert.equal(record?.disabledAt, undefined);
});

test("enableExtension enforces the extension cap and unknown/never-enabled checks", async () => {
  const { owner, run } = await workspace("Ext Cap");
  await refused(run({ kind: "disableExtension", extId: "tasks" }), /not enabled/);
  await assert.rejects(
    enableExtensionWithLimit(owner, { operationId: tidNow(), completedSteps: [], step: async (_n, fn) => fn() }, "tasks", 0),
    (error: unknown) => error instanceof OperationRejectedError && /extension limit reached \(0\)/.test(error.message),
  );
  await completes(run({ kind: "enableExtension", extId: "tasks" }));
  // Re-enabling an already-active extension converges idempotently and preserves enabledBy/enabledAt.
  await completes(run({ kind: "enableExtension", extId: "tasks" }));
});

test("enableExtension and disableExtension resume cleanly after an outage at every PDS write, repeating none", async () => {
  const scenarios = [
    { label: "enable", preEnable: false, request: { kind: "enableExtension", extId: "tasks" }, stops: 3, writes: 3 },
    { label: "disable", preEnable: true, request: { kind: "disableExtension", extId: "tasks" }, stops: 3, writes: 3 },
  ] as const;

  for (const scenario of scenarios) {
    for (let index = 0; index < scenario.stops; index += 1) {
      let armed = false;
      let succeeded = 0;
      const { pds, owner, run, tasksSpace } = await workspace(`Ext Resume ${scenario.label} ${index}`, (method) => {
        if (!armed || !WRITES.has(method)) return undefined;
        if (succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      });
      if (scenario.preEnable) await completes(run({ kind: "enableExtension", extId: "tasks" }));
      const before = pds.writes.length;
      const operationId = tidNow();
      armed = true;

      const stopped = await run(scenario.request, operationId);
      armed = false;
      await completes(run(scenario.request, operationId));

      assert.equal(stopped.state, "pending", `${scenario.label} stop ${index}`);
      const writes = pds.writes.slice(before);
      assert.equal(writes.length, scenario.writes, `${scenario.label} stop ${index}: ${writes.join(", ")}`);
      const expectedWrites = scenario.label === "enable"
        ? [`createSpace ${tasksSpace}`, `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`, `putMember ${tasksSpace} ${PERSON}`]
        : [`putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`, `removeMember ${tasksSpace} ${PERSON}`, `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`];
      assert.deepEqual(writes, expectedWrites, `${scenario.label} stop ${index}: exact writes, none repeated`);
      const record = extInstallRecord(pds, owner);
      if (scenario.label === "enable") {
        assert.equal(record?.active, true);
        assert.equal(pds.membersOf(tasksSpace).has(PERSON), true);
      } else {
        assert.equal(record?.active, false);
        assert.equal(record?.cleanupComplete, true);
        assert.equal(typeof record?.disabledAt, "string");
        assert.equal(pds.membersOf(tasksSpace).size, 0);
      }
    }
  }
});

test("disableExtension removes all members, preserves disabledAt across steps, and is idempotent once cleanupComplete is true", async () => {
  const { pds, owner, run, tasksSpace } = await workspace("Ext Disable");
  await completes(run({ kind: "enableExtension", extId: "tasks" }));
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  assert.equal(pds.membersOf(tasksSpace).size, 2);

  await completes(run({ kind: "disableExtension", extId: "tasks" }));
  const disabled = extInstallRecord(pds, owner);
  assert.equal(disabled?.active, false);
  assert.equal(disabled?.cleanupComplete, true);
  assert.equal(typeof disabled?.disabledAt, "string");
  assert.equal(pds.membersOf(tasksSpace).size, 0);

  // Calling disableExtension again is a safe no-op with no extra writes.
  const before = pds.writes.length;
  await completes(run({ kind: "disableExtension", extId: "tasks" }));
  assert.deepEqual(pds.writes.slice(before), []);

  // Re-enabling after disable restores active: true, cleanupComplete: false, and omits disabledAt.
  await completes(run({ kind: "enableExtension", extId: "tasks" }));
  const reEnabled = extInstallRecord(pds, owner);
  assert.equal(reEnabled?.active, true);
  assert.equal(reEnabled?.cleanupComplete, false);
  assert.equal(reEnabled?.disabledAt, undefined);
  assert.equal(pds.membersOf(tasksSpace).size, 2);
});

test("legacy authority grant lacking Tasks scope fails cleanly on enable, active/uncleaned removal, leave, and reconcile, while succeeding on pre-R11 or cleanly disabled workspaces", async () => {
  let blockTasksScope = true;
  const { pds, owner, run, tasksSpace } = await workspace("Ext Legacy Grant", (method, target) => {
    if (!blockTasksScope) return undefined;
    if (target.spaceType === SPACE_TYPE.tasks) return SCOPE_MISSING();
    if (method === "com.atproto.space.putRecord" && target.collection === COLLECTION.extInstall) return SCOPE_MISSING();
    return undefined;
  });

  // 1. Pre-R11 workspace (no ext.install record): invite, remove, leave, reconcile all succeed under legacy grant.
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  await completes(run({ kind: "removeMember", subject: OTHER }));
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  await completes(executeOperatorOperation({ ...owner, did: OTHER, canRecoverOperations: false }, tidNow(), { kind: "leaveWorkspace" }));
  await completes(run({ kind: "reconcileWorkspace" }));

  // 2. enableExtension under legacy grant fails on step 1 with nothing written and no journal row left behind.
  const enableId = tidNow();
  const writesBeforeEnable = pds.writes.length;
  const refusedEnable = await run({ kind: "enableExtension", extId: "tasks" }, enableId);
  assert.equal(refusedEnable.authorizationRequired, true);
  assert.equal(rowOf(enableId), undefined);
  assert.deepEqual(pds.writes.slice(writesBeforeEnable), []);
  assert.equal(extInstallRecord(pds, owner), undefined);

  // Re-grant full scope -> retry enableExtension with same operationId succeeds.
  blockTasksScope = false;
  await completes(run({ kind: "enableExtension", extId: "tasks" }, enableId));
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  assert.equal(pds.membersOf(tasksSpace).has(OTHER), true);

  // 3. Downgrade grant while extension is active: invite, remove, leave, disable, reconcile ALL require re-consent!
  blockTasksScope = true;
  const inviteRefused = await run({ kind: "inviteMember", subject: "did:plc:newperson" });
  assert.equal(inviteRefused.authorizationRequired, true);

  const removeRefused = await run({ kind: "removeMember", subject: OTHER });
  assert.equal(removeRefused.authorizationRequired, true);
  assert.equal(pds.recordsOf(owner.workspace.uri, COLLECTION.workspaceRoster).get(subjectKey(OTHER))?.active, true, "roster stays active when Tasks removal cannot verify");

  const leaveRefused = await executeOperatorOperation({ ...owner, did: OTHER, canRecoverOperations: false }, tidNow(), { kind: "leaveWorkspace" });
  assert.equal(leaveRefused.authorizationRequired, true);
  assert.equal(pds.recordsOf(owner.workspace.uri, COLLECTION.workspaceRoster).get(subjectKey(OTHER))?.active, true, "roster stays active when Tasks leave cannot verify");

  const reconcileRefused = await run({ kind: "reconcileWorkspace" });
  assert.equal(reconcileRefused.authorizationRequired, true);

  // 4. Seed active: false, cleanupComplete: false under legacy grant -> STILL refuses remove/leave/reconcile!
  const nowIso = "2026-11-16T00:00:00.000Z";
  pds.recordsOf(owner.workspace.uri, COLLECTION.extInstall).set("tasks", {
    $type: COLLECTION.extInstall, extId: "tasks", active: false, space: tasksSpace, cleanupComplete: false,
    enabledBy: OWNER, enabledAt: nowIso, updatedAt: nowIso, disabledAt: nowIso,
  });
  assert.equal((await run({ kind: "removeMember", subject: OTHER })).authorizationRequired, true);
  assert.equal((await executeOperatorOperation({ ...owner, did: OTHER, canRecoverOperations: false }, tidNow(), { kind: "leaveWorkspace" })).authorizationRequired, true);
  assert.equal((await run({ kind: "reconcileWorkspace" })).authorizationRequired, true);

  // 5. Re-grant scope -> reconcileWorkspace finishes cleanup (empties Tasks members + sets cleanupComplete: true).
  blockTasksScope = false;
  await completes(run({ kind: "reconcileWorkspace" }));
  assert.equal(pds.membersOf(tasksSpace).size, 0);
  assert.equal(extInstallRecord(pds, owner)?.cleanupComplete, true);

  // 6. Downgrade grant again when cleanupComplete is true -> remove/leave/reconcile all succeed cleanly!
  blockTasksScope = true;
  await completes(run({ kind: "removeMember", subject: OTHER }));
  await completes(run({ kind: "reconcileWorkspace" }));
});

test("reconcileWorkspace repairs extension drift (missing space, missing member, unexpected app) and handles SpaceNotFound safely", async () => {
  const { pds, run, general, tasksSpace } = await workspace("Ext Reconcile");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  await completes(run({ kind: "enableExtension", extId: "tasks" }));

  // Drift: remove PERSON from Tasks space and sneak BOT + an unrostered DID into Tasks space.
  pds.membersOf(tasksSpace).delete(PERSON);
  pds.membersOf(tasksSpace).set(BOT, { did: BOT, read: true, write: true });
  pds.membersOf(tasksSpace).set("did:plc:stranger", { did: "did:plc:stranger", read: true, write: true });

  await completes(run({ kind: "reconcileWorkspace" }));
  assert.deepEqual(pds.membersOf(tasksSpace).get(PERSON), { did: PERSON, read: true, write: true });
  assert.equal(pds.membersOf(tasksSpace).has(BOT), false, "reconcile evicts installed apps from Tasks space");
  assert.equal(pds.membersOf(tasksSpace).has("did:plc:stranger"), false);

  // Missing extension space: reconcileWorkspace creates it for active ext; removeMember/leaveWorkspace/disableExtension handle SpaceNotFound safely.
  const ghostWs = await workspace("Ext Ghost Space");
  const ghostTasksSpace = ghostWs.tasksSpace;
  const nowIso = "2026-11-16T00:00:00.000Z";
  ghostWs.pds.recordsOf(ghostWs.owner.workspace.uri, COLLECTION.extInstall).set("tasks", {
    $type: COLLECTION.extInstall, extId: "tasks", active: true, space: ghostTasksSpace, cleanupComplete: false,
    enabledBy: OWNER, enabledAt: nowIso, updatedAt: nowIso,
  });
  await completes(ghostWs.run({ kind: "reconcileWorkspace" }));
  assert.deepEqual(ghostWs.pds.membersOf(ghostTasksSpace).get(PERSON), { did: PERSON, read: true, write: true });

  const ghostWs2 = await workspace("Ext Ghost Remove");
  await completes(ghostWs2.run({ kind: "inviteMember", subject: OTHER }));
  ghostWs2.pds.recordsOf(ghostWs2.owner.workspace.uri, COLLECTION.extInstall).set("tasks", {
    $type: COLLECTION.extInstall, extId: "tasks", active: true, space: ghostWs2.tasksSpace, cleanupComplete: false,
    enabledBy: OWNER, enabledAt: nowIso, updatedAt: nowIso,
  });
  await completes(ghostWs2.run({ kind: "removeMember", subject: OTHER }));
  await completes(executeOperatorOperation({ ...ghostWs2.owner, did: PERSON, canRecoverOperations: false }, tidNow(), { kind: "leaveWorkspace" }));
  await completes(ghostWs2.run({ kind: "disableExtension", extId: "tasks" }));
  assert.equal(extInstallRecord(ghostWs2.pds, ghostWs2.owner)?.cleanupComplete, true);
});

test("assertOperatorWorkspaceWithinEnvelope scans ext.install and rejects truncated extension scans", async () => {
  let truncateExtInstalls = true;
  let extPage = 0;
  const { owner } = await workspace("Ext Envelope", (method, target) => {
    if (truncateExtInstalls && method === "com.atproto.space.listRecords" && target.collection === COLLECTION.extInstall) {
      const page = extPage++;
      if (page < 2) {
        return Response.json({
          records: Array.from({ length: 500 }, (_, index) => ({
            collection: COLLECTION.extInstall,
            rkey: `ext-${page * 500 + index}`,
            value: { $type: COLLECTION.extInstall, extId: `ext-${page * 500 + index}` },
          })),
          cursor: `p${page + 1}`,
        });
      }
      return Response.json({
        records: [{ collection: COLLECTION.extInstall, rkey: "ext-1000", value: { $type: COLLECTION.extInstall, extId: "ext-1000" } }],
      });
    }
    return undefined;
  });
  await assert.rejects(assertOperatorWorkspaceWithinEnvelope(owner), WorkspaceEnvelopeError);
  truncateExtInstalls = false;
  await assert.doesNotReject(assertOperatorWorkspaceWithinEnvelope(owner));
});
