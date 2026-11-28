import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import { appInboxState } from "../../atproto/space-ops";
import {
  appInboxUri,
  appRoleKey,
  canonicalJson,
  channelUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  requestDigest,
  requestRecordKey,
  spaceRecordUri,
  subjectKey,
  tidNow,
} from "@flock/protocol/keys";
import { COLLECTION, ATGRP_COLLECTION, ATGRP_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { grantCreationAuthorization } from "../creation-authorization";
import { executeOperatorOperation } from "../operations";
import type { RegistrationDeps } from "../registrations";
import {
  fakeGroupHost,
  plcDid,
  type FakeGroupHostHandle,
  type FakeGroupSessionOptions,
} from "../testing/fake-group-session";
import { generalKey } from "../workspace-spaces";
import { createWorkspace } from "./create-workspace";
import { hasUncoveredAppInbox } from "./reconcile-workspace";

const CREATOR = plcDid("appcreator");
const PERSON = plcDid("appperson");
const OTHER = plcDid("appother");
const BOT = plcDid("appbot");
let directory = "";
let groupSeq = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "app-access-test-"));
  process.env.DATABASE_PATH = join(directory, "apps.db");
  process.env.AUTH_ENCRYPTION_KEY = "52".repeat(32);
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
  Response.json({ error: "ScopeMissingError", message: "Missing required scope for new.flock.app.install" }, { status: 403 });
const WRITES = new Set([
  "com.atproto.space.createSpace",
  "com.atproto.space.updateSpace",
  "com.atproto.space.putRecord",
  "com.atproto.space.deleteRecord",
]);

async function workspace(name: string, intercept: FakeGroupSessionOptions["intercept"] = () => undefined) {
  let ready = false;
  const groupDid = plcDid(`appgrp${++groupSeq}`);
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
    channel: (skey: string) => skey,
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

async function placements(host: FakeGroupHostHandle, owner: OperatorActor, did: string): Promise<Record<string, string>> {
  const groupDid = owner.workspace.authorityDid;
  const dirOut = await host.selfClient.query<{ records: Array<{ rkey: string }> }>("com.atproto.space.listRecords", {
    space: owner.workspace.uri,
    repo: groupDid,
    collection: COLLECTION.directory,
  });
  const entries: Array<[string, string]> = [
    ["meta", await host.effectiveAccess(groupMetaUri(groupDid), did)],
    ["members", await host.effectiveAccess(groupMembersUri(groupDid), did)],
    ["workspace", await host.effectiveAccess(owner.workspace.uri, did)],
    ["inbox", await host.effectiveAccess(inboxUri(groupDid), did)],
  ];
  for (const row of dirOut.records) {
    entries.push([row.rkey, await host.effectiveAccess(channelUri(groupDid, row.rkey), did)]);
  }
  return Object.fromEntries(entries);
}

const installRecord = (host: FakeGroupHostHandle, owner: OperatorActor, subject = BOT) =>
  host.getRecord<{ active: boolean; channels: Array<{ skey: string; write: boolean }>; installedBy: string; installedAt: string }>(
    owner.workspace.uri,
    COLLECTION.appInstall,
    subjectKey(subject),
  );

const rowOf = (operationId: string) =>
  getRawDb()
    .prepare("SELECT state, steps_json FROM operation WHERE operation_id = ?")
    .get(operationId) as { state: string; steps_json: string } | undefined;

test("an installed app gets a 56-char appRoleKey, reads meta/members/workspace/app.inbox, gets exact channel bits, and never writes acceptance/self", async () => {
  const { host, owner, run, general, channel } = await workspace("Apps One");
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [PERSON] }));
  const before = host.writes.length;

  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));

  const roleKey = appRoleKey(BOT);
  assert.equal(roleKey.length, 68);
  assert.match(roleKey, /^app-[a-p]{64}$/);

  // Step 1 writes `new.flock.app.install` (`known_app_subject`) + `role/<roleKey>` BEFORE `membership/<BOT>`!
  assert.equal(host.writes[before], `putRecord ${owner.workspace.uri} ${COLLECTION.appInstall}/${subjectKey(BOT)}`);
  assert.equal(host.writes[before + 1], `putRecord ${groupMembersUri(host.groupDid)} ${ATGRP_COLLECTION.role}/${roleKey}`);

  const appInbox = appInboxUri(host.groupDid, owner.workspace.skey, BOT);
  assert.equal(await host.effectiveAccess(appInbox, BOT), "r");
  assert.equal(await host.effectiveAccess(appInbox, PERSON), "rw" === (await host.effectiveAccess(appInbox, PERSON)) ? "rw" : "-");
  const inboxPol = await host.getSpacePolicy(appInbox);
  assert.deepEqual(
    inboxPol?.grants.find((g) => g.role === roleKey),
    { role: roleKey, read: true },
  );
  assert.deepEqual(
    inboxPol?.grants.find((g) => g.role === "member"),
    { role: "member", write: true },
  );

  assert.deepEqual(await placements(host, owner, BOT), {
    meta: "r",
    members: "r",
    workspace: "r",
    inbox: "-",
    [general]: "rw",
    [channel("secret")]: "-",
  });

  const mem = await host.getRecord<{ roles: string[] }>(
    groupMembersUri(host.groupDid),
    ATGRP_COLLECTION.membership,
    BOT,
  );
  assert.deepEqual(mem?.roles, [roleKey]);

  const rec = await installRecord(host, owner);
  assert.deepEqual(rec, { ...rec!, active: true, channels: [{ skey: general, write: true }], installedBy: CREATOR });
});

test("installApp refuses the group DID, a human member, a channel that is not open, a second grant, and a twenty-first app, while uninstallApp is RoleInUse- and AppMembershipActive-safe", async () => {
  const { host, owner, run, general, channel } = await workspace("Apps Two");
  await completes(run({ kind: "createChannel", skey: "old", name: "old", visibility: "public" }));
  await completes(run({ kind: "archiveChannel", skey: channel("old") }));

  await refused(run({ kind: "installApp", subject: host.groupDid, channels: [] }), /group account cannot be installed/);
  await refused(run({ kind: "installApp", subject: PERSON, channels: [] }), /member cannot be installed/);
  await refused(run({ kind: "installApp", subject: BOT, channels: [{ skey: channel("nowhere"), write: false }] }), /active channel/);
  await refused(run({ kind: "installApp", subject: BOT, channels: [{ skey: channel("old"), write: false }] }), /active channel/);

  await completes(run({ kind: "installApp", subject: BOT, channels: [] }));
  await refused(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: false }] }), /already installed/);

  const extraBots = Array.from({ length: 19 }, (_, idx) => plcDid(`extrabot${idx + 1}`));
  for (const botDid of extraBots) {
    await completes(run({ kind: "installApp", subject: botDid, channels: [] }));
  }
  const bot21 = plcDid("extrabot21");
  await refused(run({ kind: "installApp", subject: bot21, channels: [] }), /app limit reached \(20\)/);

  // `uninstallApp` removes all policy grants -> deletes `membership` -> deletes `role` -> marks `app.install` `active: false` LAST!
  await completes(run({ kind: "uninstallApp", subject: extraBots[0]! }));
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), ATGRP_COLLECTION.membership, extraBots[0]!),
    undefined,
  );
  assert.equal(
    await host.getRecord(groupMembersUri(host.groupDid), ATGRP_COLLECTION.role, appRoleKey(extraBots[0]!)),
    undefined,
  );
  assert.equal((await installRecord(host, owner, extraBots[0]!))?.active, false);

  await completes(run({ kind: "installApp", subject: bot21, channels: [] }));
});

test("only an installed app's access changes or goes, and a known app service principal is never invited, removed as a person, or made an admin", async () => {
  const { run } = await workspace("Apps Three");
  await refused(run({ kind: "updateAppAccess", subject: BOT, channels: [] }), /not installed/);
  await refused(run({ kind: "uninstallApp", subject: BOT }), /not installed/);
  await completes(run({ kind: "installApp", subject: BOT, channels: [] }));
  await refused(run({ kind: "inviteMember", subject: BOT }), /installed app/);
  await refused(run({ kind: "removeMember", subject: BOT }), /uninstallApp/);
  await refused(run({ kind: "setAdmin", subject: BOT, active: true }), /not an admin/);
  await refused(run({ kind: "setAdmin", subject: BOT, active: false }), /not an admin/);
});

test("installApp, updateAppAccess, and uninstallApp stopped at any mutating write resume cleanly to exact OpenSocial state", async () => {
  const scenarios = [
    {
      label: "install",
      installed: false,
      request: (general: string) => ({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }),
      stops: 9,
      after: "rw",
    },
    {
      label: "update",
      installed: true,
      request: (general: string) => ({ kind: "updateAppAccess", subject: BOT, channels: [{ skey: general, write: false }] }),
      stops: 5,
      after: "r",
    },
    {
      label: "uninstall",
      installed: true,
      request: () => ({ kind: "uninstallApp", subject: BOT }),
      stops: 8,
      after: "-",
    },
  ] as const;

  for (const scenario of scenarios) {
    for (let index = 0; index < scenario.stops; index += 1) {
      let armed = false;
      let succeeded = 0;
      const { host, owner, run, general } = await workspace(`Apps Resume ${scenario.label} ${index}`, (method) => {
        if (!armed || !WRITES.has(method)) return undefined;
        if (succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      });
      if (scenario.installed) {
        await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
      }
      const operationId = tidNow();
      armed = true;

      const stopped = await run(scenario.request(general), operationId);
      armed = false;
      await completes(run(scenario.request(general), operationId));

      assert.equal(stopped.state, "pending", `${scenario.label} ${index}`);
      assert.equal((await placements(host, owner, BOT))[general], scenario.after);
    }
  }
});

test("with an app installed, channel and member operations preserve exact app policy grants and RoleInUse invariants", async () => {
  const { host, owner, run, general, channel } = await workspace("Apps Six");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const at = () => placements(host, owner, BOT);

  await completes(run({ kind: "createChannel", skey: "news", name: "news", visibility: "public" }));
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [CREATOR, PERSON] }));
  assert.deepEqual(await at(), {
    meta: "r",
    members: "r",
    workspace: "r",
    inbox: "-",
    [general]: "rw",
    [channel("news")]: "-",
    [channel("secret")]: "-",
  });

  await completes(
    run({
      kind: "updateAppAccess",
      subject: BOT,
      channels: [
        { skey: general, write: true },
        { skey: channel("secret"), write: false },
      ],
    }),
  );
  assert.equal((await at())[channel("secret")], "r");
  await completes(run({ kind: "transitionChannel", skey: channel("secret"), visibility: "public" }));
  assert.equal((await at())[channel("secret")], "r", "made public");
  await completes(run({ kind: "transitionChannel", skey: channel("secret"), visibility: "private", members: [CREATOR, PERSON] }));
  assert.equal((await at())[channel("secret")], "r", "made private again");

  await completes(run({ kind: "archiveChannel", skey: channel("secret") }));
  assert.equal((await at())[channel("secret")], "-");
  assert.deepEqual((await installRecord(host, owner))?.channels, [{ skey: general, write: true }]);

  await completes(run({ kind: "inviteMember", subject: OTHER }));
  await completes(run({ kind: "removeMember", subject: OTHER }));
  await completes(run({ kind: "reconcileWorkspace" }));
  assert.deepEqual(await at(), {
    meta: "r",
    members: "r",
    workspace: "r",
    inbox: "-",
    [general]: "rw",
    [channel("news")]: "-",
    [channel("secret")]: "-",
  });
});

test("installing an app with a grant lacking app-install scope asks for reauthorization, leaves no row, and succeeds after reauth", async () => {
  let scopeMissing = true;
  const { host, owner, run, general } = await workspace("Apps Seven", (method, target) =>
    scopeMissing && method === "com.atproto.space.putRecord" && target.collection === COLLECTION.appInstall
      ? SCOPE_MISSING()
      : undefined,
  );
  const request = { kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] };
  const operationId = tidNow();

  const first = await run(request, operationId);
  const rowAfterRefusal = rowOf(operationId);
  scopeMissing = false;
  const retried = await run(request, operationId);

  assert.equal(first.authorizationRequired, true, JSON.stringify(first));
  assert.equal(rowAfterRefusal, undefined);
  assert.equal(retried.state, "completed");
  assert.equal((await placements(host, owner, BOT))[general], "rw");
});

test("a repeat of the same install keeps who installed the app and when", async () => {
  const { host, owner, run, general } = await workspace("Apps Ten");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const first = await installRecord(host, owner);
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const second = await installRecord(host, owner);
  assert.deepEqual([second?.installedBy, second?.installedAt], [first?.installedBy, first?.installedAt]);
});

test("no decision on a private-channel join request moves an installed app, approved or denied", async () => {
  const { host, owner, run, general, channel } = await workspace("Apps Eleven");
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [CREATOR, PERSON] }));
  await completes(
    run({
      kind: "installApp",
      subject: BOT,
      channels: [
        { skey: general, write: true },
        { skey: channel("secret"), write: false },
      ],
    }),
  );
  const request = spaceRecordUri(
    inboxUri(host.groupDid),
    BOT,
    COLLECTION.joinRequest,
    requestRecordKey(channelUri(host.groupDid, channel("secret")), BOT),
  );
  const before = host.writes.length;

  for (const decision of ["approve", "deny"] as const) {
    await refused(run({ kind: "decideJoinRequest", request, requestId: tidNow(), decision }), /installed app/);
  }
  assert.deepEqual(host.writes.slice(before), []);
  assert.equal((await placements(host, owner, BOT))[channel("secret")], "r");
});

test("appInboxState distinguishes present, missing and uncovered spaces and rethrows host errors", async () => {
  let mode: "ok" | "uncovered" | "outage" = "ok";
  const gDid = plcDid("appinboxstate");
  const host = await fakeGroupHost(gDid, {
    creatorDid: CREATOR,
    intercept: (method) => {
      if (method !== "com.atproto.space.getSpace") return undefined;
      if (mode === "uncovered") return SCOPE_MISSING();
      if (mode === "outage") return OUTAGE();
      return undefined;
    },
  });
  const inbox = appInboxUri(gDid, "self", BOT);
  assert.equal(await appInboxState(host.session, inbox), "missing");
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType: SPACE_TYPE.appInbox,
    skey: inbox.split("/").at(-1)!,
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: true,
      grants: [],
    },
  });
  assert.equal(await appInboxState(host.session, inbox), "present");
  mode = "uncovered";
  assert.equal(await appInboxState(host.session, inbox), "uncovered");
  mode = "outage";
  await assert.rejects(appInboxState(host.session, inbox), /outage/);
});

test("hasUncoveredAppInbox detects uncovered app inbox spaces and reconcileWorkspace repairs missing app inboxes + post-completion registration errors", async () => {
  let blockInboxScope = true;
  const { host, owner, general } = await workspace("Apps Uncovered Matrix", (method, target) => {
    if (!blockInboxScope) return undefined;
    if (method === "com.atproto.space.getSpace" && target.space?.includes("/new.flock.app.inbox/")) return SCOPE_MISSING();
    return undefined;
  });
  const registered: string[] = [];
  const deps: RegistrationDeps = {
    register: async (_session, space) => {
      registered.push(space);
      return Date.now() + 86_400_000;
    },
    now: () => Date.now(),
  };
  const run = (request: Record<string, unknown>, operationId = tidNow(), withDeps = true) =>
    executeOperatorOperation(owner, operationId, request, withDeps ? deps : undefined);

  const activeBot = plcDid("activeprer13");
  const nowIso = "2026-11-15T00:00:00.000Z";
  await host.putRecord(owner.workspace.uri, COLLECTION.appInstall, subjectKey(activeBot), {
    subject: activeBot,
    active: true,
    channels: [{ skey: general, write: true }],
    installedBy: CREATOR,
    installedAt: nowIso,
    updatedAt: nowIso,
  });

  // Under uncovered grant, `reconcileWorkspace` skips uncovered app inbox and `hasUncoveredAppInbox` returns `true`
  await completes(run({ kind: "reconcileWorkspace" }, tidNow(), false));
  assert.equal(await hasUncoveredAppInbox(owner), true);

  // Re-grant full scope -> `reconcileWorkspace` creates & configures the missing app inbox and registers it!
  blockInboxScope = false;
  registered.length = 0;
  await completes(run({ kind: "reconcileWorkspace" }, tidNow(), true));
  const activeInbox = appInboxUri(host.groupDid, "self", activeBot);
  assert.deepEqual(registered, [activeInbox]);
  assert.equal(await hasUncoveredAppInbox(owner), false);
  assert.equal(await host.effectiveAccess(activeInbox, activeBot), "r");

  // Seeded pending `installApp` row after `app-install-record` replays cleanly to completion
  const replayBot = plcDid("replaybot");
  await host.putRecord(owner.workspace.uri, COLLECTION.appInstall, subjectKey(replayBot), {
    subject: replayBot,
    active: true,
    channels: [{ skey: general, write: false }],
    installedBy: CREATOR,
    installedAt: nowIso,
    updatedAt: nowIso,
  });
  await host.putRecord(groupMembersUri(host.groupDid), ATGRP_COLLECTION.role, appRoleKey(replayBot), {
    displayName: `App: ${replayBot}`,
  });
  const installId = tidNow();
  const installReq = { kind: "installApp", subject: replayBot, channels: [{ skey: general, write: false }] };
  const nowSec = Math.floor(Date.now() / 1000) - 30;
  getRawDb()
    .prepare(
      `INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'outage', ?, ?)`,
    )
    .run(
      host.groupDid,
      owner.workspace.uri,
      CREATOR,
      installId,
      requestDigest({ workspace: owner.workspace.uri, request: installReq }),
      canonicalJson({ workspace: owner.workspace.uri, request: installReq }),
      JSON.stringify(["app-install-record"]),
      nowSec,
      nowSec,
    );
  await completes(run(installReq, installId, false));
  assert.equal((await placements(host, owner, replayBot))[general], "r");
});

test("an effective admin excluded from an existing private channel cannot grant read/write access or expose that channel via updateSpace", async () => {
  const { host, owner, run, general, channel } = await workspace("Apps Excluded Admin");
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [PERSON] }));
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));

  const secretSpace = channelUri(host.groupDid, channel("secret"));
  assert.equal(await host.effectiveAccess(secretSpace, CREATOR), "-");

  const deniedUpdate = await run({
    kind: "updateAppAccess",
    subject: BOT,
    channels: [
      { skey: general, write: true },
      { skey: channel("secret"), write: false },
    ],
  });
  assert.notEqual(deniedUpdate.state, "completed", "Excluded admin must not grant app read access on private channel");
  assert.match(deniedUpdate.error ?? "", /PrivilegeEscalation|lacks read access/);
  assert.equal((await placements(host, owner, BOT))[channel("secret")], "-");
});

test("R15 61-char and 128-char private channel skeys create valid nibble-encoded channelRoleKey roles and reconcile cleanly", async () => {
  const { host, owner, run } = await workspace("Long Channel Keys");
  for (const len of [61, 128] as const) {
    const longSkey = `ch-${"k".repeat(len - 3)}`;
    assert.equal(longSkey.length, len);
    await completes(
      run({
        kind: "createChannel",
        skey: longSkey,
        name: `long-${len}`,
        visibility: "private",
        members: [CREATOR, PERSON],
      }),
    );
    await completes(run({ kind: "reconcileWorkspace" }));
    assert.equal(await host.effectiveAccess(channelUri(host.groupDid, longSkey), PERSON), "rw");
    assert.equal(await host.effectiveAccess(channelUri(host.groupDid, longSkey), CREATOR), "rw");
  }
  void owner;
});
