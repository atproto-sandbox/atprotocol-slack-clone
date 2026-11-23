import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import { extSpaceUriFor } from "@flock/protocol/extensions";
import { groupMembersUri, tidNow } from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION, OPENSOCIAL_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { WorkspaceEnvelopeError } from "@flock/protocol/workspace-summary";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { grantCreationAuthorization } from "../creation-authorization";
import { OperationRejectedError } from "../journal";
import { executeOperatorOperation } from "../operations";
import {
  fakeGroupHost,
  plcDid,
  type FakeGroupHostHandle,
  type FakeGroupSessionOptions,
} from "../testing/fake-group-session";
import { assertOperatorWorkspaceWithinEnvelope } from "../workspace-envelope";
import { generalKey } from "../workspace-spaces";
import { createWorkspace } from "./create-workspace";
import { enableExtensionWithLimit } from "./extension-access";

const CREATOR = plcDid("extcreator");
const PERSON = plcDid("extperson");
const OTHER = plcDid("extother");
const BOT = plcDid("extbot");
let directory = "";
let groupSeq = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "extension-access-test-"));
  process.env.DATABASE_PATH = join(directory, "ext.db");
  process.env.AUTH_ENCRYPTION_KEY = "54".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.GROUP_HOST_URL = "http://127.0.0.1:3004";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const OUTAGE = () => Response.json({ error: "InternalServerError", message: "outage" }, { status: 500 });
const SCOPE_MISSING = () =>
  Response.json({ error: "ScopeMissingError", message: `Missing required scope "space:${SPACE_TYPE.tasks}"` }, { status: 403 });
const WRITES = new Set(["com.atproto.space.createSpace", "com.atproto.space.updateSpace", "com.atproto.space.putRecord"]);

async function workspace(name: string, intercept: FakeGroupSessionOptions["intercept"] = () => undefined) {
  let ready = false;
  const groupDid = plcDid(`extgrp${++groupSeq}`);
  const host = await fakeGroupHost(groupDid, {
    creatorDid: CREATOR,
    name,
    intercept: (method, target, init) => (ready ? intercept(method, target, init) : undefined),
  });
  grantCreationAuthorization({ authorityDid: groupDid, initiatorDid: CREATOR, name }, Math.floor(Date.now() / 1000));
  const created = await createWorkspace(host.session, { creator: CREATOR, name, operationId: tidNow() });
  const owner: OperatorActor = {
    did: CREATOR,
    session: host.session,
    workspace: parseWorkspaceRef(created.workspace),
    canRecoverOperations: true,
  };
  const run = (request: Record<string, unknown>, operationId = tidNow()) =>
    executeOperatorOperation(owner, operationId, request);
  assert.equal((await run({ kind: "inviteMember", subject: PERSON })).state, "completed");
  host.writes.length = 0;
  ready = true;
  return {
    host,
    owner,
    run,
    general: generalKey(owner.workspace.skey),
    tasksSpace: extSpaceUriFor(groupDid, owner.workspace.skey, "tasks"),
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

const extInstallRecord = (host: FakeGroupHostHandle, owner: OperatorActor) =>
  host.getRecord<Record<string, unknown>>(owner.workspace.uri, COLLECTION.extInstall, "tasks");

const rowOf = (operationId: string) =>
  getRawDb()
    .prepare("SELECT state, steps_json FROM operation WHERE operation_id = ?")
    .get(operationId) as { state: string; steps_json: string } | undefined;

test("enableExtension creates the Tasks space first, writes ext.install, and grants human members (never apps) rw access via OpenSocial policy", async () => {
  const { host, owner, run, general, tasksSpace } = await workspace("Ext One");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const before = host.writes.length;

  await completes(run({ kind: "enableExtension", extId: "tasks" }));

  assert.equal(host.writes[before], `createSpace ${tasksSpace}`);
  assert.equal(host.writes[before + 1], `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`);
  assert.equal(host.writes[before + 2], `updateSpace ${tasksSpace}`);
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "rw");
  assert.equal(await host.effectiveAccess(tasksSpace, CREATOR), "rw");
  assert.equal(await host.effectiveAccess(tasksSpace, BOT), "-", "apps hold appRoleKey only and never get Tasks access");

  const record = await extInstallRecord(host, owner);
  assert.equal(record?.extId, "tasks");
  assert.equal(record?.active, true);
  assert.equal(record?.cleanupComplete, false);
  assert.equal(record?.space, tasksSpace);
  assert.equal(record?.enabledBy, CREATOR);
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
  await completes(run({ kind: "enableExtension", extId: "tasks" }));
});

test("enableExtension and disableExtension resume cleanly after an outage at every write, repeating none", async () => {
  const scenarios = [
    { label: "enable", preEnable: false, request: { kind: "enableExtension", extId: "tasks" }, stops: 3, writes: 3 },
    { label: "disable", preEnable: true, request: { kind: "disableExtension", extId: "tasks" }, stops: 3, writes: 3 },
  ] as const;

  for (const scenario of scenarios) {
    for (let index = 0; index < scenario.stops; index += 1) {
      let armed = false;
      let succeeded = 0;
      const { host, owner, run, tasksSpace } = await workspace(`Ext Resume ${scenario.label} ${index}`, (method) => {
        if (!armed || !WRITES.has(method)) return undefined;
        if (succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      });
      if (scenario.preEnable) await completes(run({ kind: "enableExtension", extId: "tasks" }));
      const before = host.writes.length;
      const operationId = tidNow();
      armed = true;

      const stopped = await run(scenario.request, operationId);
      armed = false;
      await completes(run(scenario.request, operationId));

      assert.equal(stopped.state, "pending", `${scenario.label} stop ${index}`);
      const writes = host.writes.slice(before);
      assert.equal(writes.length, scenario.writes, `${scenario.label} stop ${index}: ${writes.join(", ")}`);
      const expectedWrites =
        scenario.label === "enable"
          ? [`createSpace ${tasksSpace}`, `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`, `updateSpace ${tasksSpace}`]
          : [
              `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`,
              `updateSpace ${tasksSpace}`,
              `putRecord ${owner.workspace.uri} ${COLLECTION.extInstall}/tasks`,
            ];
      assert.deepEqual(writes, expectedWrites, `${scenario.label} stop ${index}: exact writes, none repeated`);
      const record = await extInstallRecord(host, owner);
      if (scenario.label === "enable") {
        assert.equal(record?.active, true);
        assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "rw");
      } else {
        assert.equal(record?.active, false);
        assert.equal(record?.cleanupComplete, true);
        assert.equal(typeof record?.disabledAt, "string");
        assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "-");
      }
    }
  }
});

test("disableExtension clears grants, marks unlisted: true, preserves disabledAt across steps, and is idempotent once cleanupComplete is true", async () => {
  const { host, owner, run, tasksSpace } = await workspace("Ext Disable");
  await completes(run({ kind: "enableExtension", extId: "tasks" }));
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "rw");
  assert.equal(await host.effectiveAccess(tasksSpace, OTHER), "rw");

  await completes(run({ kind: "disableExtension", extId: "tasks" }));
  const disabled = await extInstallRecord(host, owner);
  assert.equal(disabled?.active, false);
  assert.equal(disabled?.cleanupComplete, true);
  assert.equal(typeof disabled?.disabledAt, "string");
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "-");
  assert.equal(await host.effectiveAccess(tasksSpace, OTHER), "-");

  const before = host.writes.length;
  await completes(run({ kind: "disableExtension", extId: "tasks" }));
  assert.deepEqual(host.writes.slice(before), []);

  await completes(run({ kind: "enableExtension", extId: "tasks" }));
  const reEnabled = await extInstallRecord(host, owner);
  assert.equal(reEnabled?.active, true);
  assert.equal(reEnabled?.cleanupComplete, false);
  assert.equal(reEnabled?.disabledAt, undefined);
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "rw");
  assert.equal(await host.effectiveAccess(tasksSpace, OTHER), "rw");
});

test("legacy authority grant lacking Tasks scope fails cleanly on enable, uncleaned disable, and reconcile, while succeeding on pre-R11 or cleanly disabled workspaces", async () => {
  let blockTasksScope = true;
  const { host, owner, run, tasksSpace } = await workspace("Ext Legacy Grant", (method, target) => {
    if (!blockTasksScope) return undefined;
    if (
      target.spaceType === SPACE_TYPE.tasks &&
      (method === "com.atproto.space.createSpace" || method === "com.atproto.space.updateSpace")
    ) {
      return SCOPE_MISSING();
    }
    return undefined;
  });

  // 1. Pre-extension workspace: O(1) OpenSocial invite, remove, leave, reconcile all succeed under legacy grant!
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  await completes(run({ kind: "removeMember", subject: OTHER }));
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  await completes(executeOperatorOperation({ ...owner, did: OTHER, canRecoverOperations: false }, tidNow(), { kind: "leaveWorkspace" }));
  await completes(run({ kind: "reconcileWorkspace" }));

  // 2. `enableExtension` under legacy grant fails on step 1 with nothing written and no journal row left behind!
  const enableId = tidNow();
  const writesBeforeEnable = host.writes.length;
  const refusedEnable = await run({ kind: "enableExtension", extId: "tasks" }, enableId);
  assert.equal(refusedEnable.authorizationRequired, true);
  assert.equal(rowOf(enableId), undefined);
  assert.deepEqual(host.writes.slice(writesBeforeEnable), []);
  assert.equal(await extInstallRecord(host, owner), undefined);

  // Re-grant full scope -> retry `enableExtension` with same `operationId` succeeds!
  blockTasksScope = false;
  await completes(run({ kind: "enableExtension", extId: "tasks" }, enableId));
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "rw");

  // 3. Downgrade grant while extension is active (or `active: false, cleanupComplete: false`) -> `reconcileWorkspace` asks for reauth!
  blockTasksScope = true;
  assert.equal((await run({ kind: "reconcileWorkspace" })).authorizationRequired, true);

  const nowIso = "2026-11-16T00:00:00.000Z";
  await host.putRecord(owner.workspace.uri, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: false,
    space: tasksSpace,
    cleanupComplete: false,
    enabledBy: CREATOR,
    enabledAt: nowIso,
    updatedAt: nowIso,
    disabledAt: nowIso,
  });
  assert.equal((await run({ kind: "reconcileWorkspace" })).authorizationRequired, true);

  // 4. Re-grant scope -> `reconcileWorkspace` finishes cleanup (`grants: []`, `cleanupComplete: true`)!
  blockTasksScope = false;
  await completes(run({ kind: "reconcileWorkspace" }));
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "-");
  assert.equal((await extInstallRecord(host, owner))?.cleanupComplete, true);

  // 5. Downgrade grant again when `cleanupComplete === true` -> `reconcileWorkspace` succeeds cleanly!
  blockTasksScope = true;
  await completes(run({ kind: "reconcileWorkspace" }));
});

test("reconcileWorkspace repairs extension policy drift and missing space, and disableExtension handles SpaceNotFound safely", async () => {
  const { host, run, general, tasksSpace } = await workspace("Ext Reconcile");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  await completes(run({ kind: "enableExtension", extId: "tasks" }));

  // Drift: strip `member` grant from Tasks space policy while retaining admin access
  await host.selfClient.procedure("com.atproto.space.updateSpace", {
    space: tasksSpace,
    policy: {
      $type: OPENSOCIAL_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [{ role: "admin", read: true, write: true }],
    },
  });
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "-");

  await completes(run({ kind: "reconcileWorkspace" }));
  assert.equal(await host.effectiveAccess(tasksSpace, PERSON), "rw");
  assert.equal(await host.effectiveAccess(tasksSpace, BOT), "-");

  // Missing extension space: `reconcileWorkspace` creates it for active ext; `disableExtension` handles `SpaceNotFound` safely!
  const ghostWs = await workspace("Ext Ghost Space");
  const nowIso = "2026-11-16T00:00:00.000Z";
  await ghostWs.host.putRecord(ghostWs.owner.workspace.uri, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: true,
    space: ghostWs.tasksSpace,
    cleanupComplete: false,
    enabledBy: CREATOR,
    enabledAt: nowIso,
    updatedAt: nowIso,
  });
  await completes(ghostWs.run({ kind: "reconcileWorkspace" }));
  assert.equal(await ghostWs.host.effectiveAccess(ghostWs.tasksSpace, PERSON), "rw");

  const ghostWs2 = await workspace("Ext Ghost Disable");
  await ghostWs2.host.putRecord(ghostWs2.owner.workspace.uri, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: true,
    space: ghostWs2.tasksSpace,
    cleanupComplete: false,
    enabledBy: CREATOR,
    enabledAt: nowIso,
    updatedAt: nowIso,
  });
  await completes(ghostWs2.run({ kind: "disableExtension", extId: "tasks" }));
  assert.equal((await extInstallRecord(ghostWs2.host, ghostWs2.owner))?.cleanupComplete, true);
});

test("assertOperatorWorkspaceWithinEnvelope scans ext.install and enforces OpenSocial private-channel role caps, malformed authority records, and writer truncation", async () => {
  let truncateExtInstalls = true;
  let injectMalformedMembership = false;
  let extPage = 0;
  let writerPage = 0;
  const { host, owner } = await workspace("Ext Envelope", (method, target) => {
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
    if (
      injectMalformedMembership &&
      method === "com.atproto.space.listRecords" &&
      target.collection === OPENSOCIAL_COLLECTION.membership
    ) {
      return Response.json({
        records: [
          {
            collection: OPENSOCIAL_COLLECTION.membership,
            rkey: "not-a-valid-did",
            value: { $type: OPENSOCIAL_COLLECTION.membership, roles: "broken" },
          },
        ],
      });
    }
    return undefined;
  });
  await assert.rejects(assertOperatorWorkspaceWithinEnvelope(owner), WorkspaceEnvelopeError);
  truncateExtInstalls = false;
  await assert.doesNotReject(assertOperatorWorkspaceWithinEnvelope(owner));

  // Malformed membership record in members/self MUST trigger fail-closed WorkspaceEnvelopeError!
  injectMalformedMembership = true;
  await assert.rejects(assertOperatorWorkspaceWithinEnvelope(owner), WorkspaceEnvelopeError);
  injectMalformedMembership = false;

  // Truncated members/self writer scan (via Space Credential on FakeNetwork) MUST trigger fail-closed WorkspaceEnvelopeError!
  host.network.interceptResponse = ({ method, params, response }) => {
    if (method === "com.atproto.space.listWriters" && params.space === groupMembersUri(host.groupDid)) {
      const page = writerPage++;
      const pageLen = Number(params.limit ?? 500);
      return Response.json({
        repos: Array.from({ length: pageLen }, (_, idx) => ({
          $type: "com.atproto.space.defs#repoWrite",
          repo: `did:plc:writer${page * 1000 + idx}`,
          repoRev: "2222222222222",
          spaceRev: "2222222222222",
        })),
        cursor: `wp-${page + 1}`,
      });
    }
    return response;
  };
  await assert.rejects(assertOperatorWorkspaceWithinEnvelope(owner), WorkspaceEnvelopeError);
  host.network.interceptResponse = undefined;
  await assert.doesNotReject(assertOperatorWorkspaceWithinEnvelope(owner));

  // Round 17 Fix #5 (oclaude #1 + codex #5): Semantically invalid `group.opensocial.policy` (e.g. duplicate role grants),
  // missing published `com.atproto.space.policy/self` record (on core OR modality spaces), or malformed outer policy wrapper
  // MUST trigger fail-closed WorkspaceEnvelopeError!
  let policyFaultMode:
    | "none"
    | "semantically_invalid_get_space"
    | "missing_workspace_policy_record"
    | "malformed_outer_wrapper"
    | "missing_channel_policy_record" = "semantically_invalid_get_space";
  const generalChannelSpace = `at://${host.groupDid}/space/new.flock.channel/${owner.workspace.skey === "self" ? "general" : `${owner.workspace.skey}-general`}`;
  host.network.interceptResponse = ({ method, params, response }) => {
    if (
      policyFaultMode === "semantically_invalid_get_space" &&
      method === "com.atproto.space.getSpace" &&
      params.space === groupMembersUri(host.groupDid)
    ) {
      return Response.json({
        space: groupMembersUri(host.groupDid),
        policy: {
          $type: OPENSOCIAL_POLICY,
          publicRead: false,
          unlisted: false,
          grants: [
            { role: "admin", read: true, write: true },
            { role: "admin", read: true, write: true },
          ],
        },
      });
    }
    if (
      policyFaultMode === "missing_workspace_policy_record" &&
      method === "com.atproto.space.listRecords" &&
      params.collection === "com.atproto.space.policy" &&
      params.space === owner.workspace.uri
    ) {
      return Response.json({ records: [] });
    }
    if (
      policyFaultMode === "malformed_outer_wrapper" &&
      method === "com.atproto.space.listRecords" &&
      params.collection === "com.atproto.space.policy" &&
      params.space === groupMembersUri(host.groupDid)
    ) {
      return Response.json({
        records: [
          {
            collection: "com.atproto.space.policy",
            rkey: "not-self",
            cid: "bafyreimalformedwrapper00001",
            value: {
              $type: "wrong.wrapper.type",
              policy: {
                $type: OPENSOCIAL_POLICY,
                publicRead: false,
                unlisted: false,
                grants: [{ role: "admin", read: true, write: true }],
              },
            },
          },
        ],
      });
    }
    if (
      policyFaultMode === "missing_channel_policy_record" &&
      method === "com.atproto.space.listRecords" &&
      params.collection === "com.atproto.space.policy" &&
      params.space === generalChannelSpace
    ) {
      return Response.json({ records: [] });
    }
    return response;
  };
  for (const mode of [
    "semantically_invalid_get_space",
    "missing_workspace_policy_record",
    "malformed_outer_wrapper",
    "missing_channel_policy_record",
  ] as const) {
    policyFaultMode = mode;
    await assert.rejects(
      assertOperatorWorkspaceWithinEnvelope(owner),
      WorkspaceEnvelopeError,
      `assertOperatorWorkspaceWithinEnvelope must reject ${mode}`,
    );
  }
  policyFaultMode = "none";
  host.network.interceptResponse = undefined;
  await assert.doesNotReject(assertOperatorWorkspaceWithinEnvelope(owner));

  // Seed >90 private channel roles on PERSON -> `assertOperatorWorkspaceWithinEnvelope` rejects (`maxPrivateChannelsPerMember === 90`)!
  const membersSpace = groupMembersUri(host.groupDid);
  const manyChannelRoles = Array.from({ length: 91 }, (_, idx) => `channel-priv${idx}`);
  for (const r of manyChannelRoles) {
    await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.role, r, { displayName: r });
  }
  await host.putRecord(membersSpace, OPENSOCIAL_COLLECTION.membership, PERSON, {
    roles: ["member", ...manyChannelRoles],
    createdAt: "2026-11-16T00:00:00.000Z",
  });
  await assert.rejects(assertOperatorWorkspaceWithinEnvelope(owner), WorkspaceEnvelopeError);
});
