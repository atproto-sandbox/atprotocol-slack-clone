import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import { appInboxState } from "../../atproto/space-ops";
import { appInboxUri, canonicalJson, channelUri, inboxUri, requestDigest, requestRecordKey, spaceRecordUri, subjectKey, tidNow } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { executeOperatorOperation } from "../operations";
import type { RegistrationDeps } from "../registrations";
import { fakeAuthorityPds, type FakeAuthorityPds, type FakeAuthorityPdsOptions } from "../testing/fake-authority-pds";
import { generalKey } from "../workspace-spaces";
import { createWorkspace } from "./create-workspace";
import { hasUncoveredAppInbox } from "./reconcile-workspace";

const OWNER = "did:plc:owner";
const PERSON = "did:plc:person";
const OTHER = "did:plc:other";
const BOT = "did:plc:bot";
let directory = "";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "app-access-test-"));
  process.env.DATABASE_PATH = join(directory, "apps.db");
  process.env.AUTH_ENCRYPTION_KEY = "52".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const OUTAGE = () => Response.json({ error: "InternalServerError", message: "outage" }, { status: 500 });
const SCOPE_MISSING = () => Response.json({ error: "ScopeMissingError", message: "Missing required scope for new.flock.app.install" }, { status: 403 });
const WRITES = new Set(["com.atproto.space.createSpace", "com.atproto.space.putRecord", "com.atproto.memberspace.putMember", "com.atproto.memberspace.removeMember"]);

/** A workspace the account owns, with a person invited; `intercept` sees every request after it is set up. */
async function workspace(name: string, intercept: FakeAuthorityPdsOptions["intercept"] = () => undefined) {
  let ready = false;
  const pds = fakeAuthorityPds(OWNER, { intercept: (method, target) => ready ? intercept(method, target) : undefined });
  const created = await createWorkspace(pds.session, { creator: OWNER, name, operationId: tidNow() });
  const owner: OperatorActor = { did: OWNER, session: pds.session, workspace: parseWorkspaceRef(created.workspace), canRecoverOperations: true };
  const run = (request: Record<string, unknown>, operationId = tidNow()) => executeOperatorOperation(owner, operationId, request);
  assert.equal((await run({ kind: "inviteMember", subject: PERSON })).state, "completed");
  ready = true;
  return { pds, owner, run, general: generalKey(owner.workspace.skey), channel: (skey: string) => `${owner.workspace.skey}-${skey}` };
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

/** Where `did` is in each member list of the workspace: "rw", "r", or "-" for no entry. */
function placements(pds: FakeAuthorityPds, owner: OperatorActor, did: string): Record<string, string> {
  const of = (space: string) => {
    const entry = pds.membersOf(space).get(did);
    return entry ? (entry.write ? "rw" : "r") : "-";
  };
  return Object.fromEntries([
    ["workspace", of(owner.workspace.uri)],
    ["inbox", of(inboxUri(OWNER, owner.workspace.skey))],
    ...[...pds.recordsOf(owner.workspace.uri, COLLECTION.directory).keys()].map((skey) => [skey, of(channelUri(OWNER, skey))]),
  ]);
}

const installRecord = (pds: FakeAuthorityPds, owner: OperatorActor) => pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).get(subjectKey(BOT)) as
  { active: boolean; channels: Array<{ skey: string; write: boolean }>; installedBy: string } | undefined;

const rowOf = (operationId: string) => getRawDb().prepare("SELECT state, steps_json FROM operation WHERE operation_id = ?").get(operationId) as
  { state: string; steps_json: string } | undefined;

test("an installed app reads the workspace and the channels it is granted, with their bits, and nothing else", async () => {
  // #given a workspace with a person, #general and a private channel
  const { pds, owner, run, general, channel } = await workspace("Apps One");
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [PERSON] }));
  const before = pds.writes.length;

  // #when an admin installs the app with write in #general
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));

  // #then the app's inbox space is created first, then its install record, and the app is a reader of the workspace and a writer in #general only
  assert.match(pds.writes[before] ?? "", /^createSpace at:\/\/did:plc:owner\/space\/new\.flock\.app\.inbox\/i-/);
  assert.match(pds.writes[before + 1] ?? "", /^putRecord \S+ new\.flock\.app\.install\//);
  assert.deepEqual(placements(pds, owner, BOT), { workspace: "r", inbox: "-", [general]: "rw", [channel("secret")]: "-" });
  assert.deepEqual(installRecord(pds, owner), { ...installRecord(pds, owner), active: true, channels: [{ skey: general, write: true }], installedBy: OWNER });
});

test("installApp refuses the workspace account, a person, a channel that is not open, a second grant, and a twenty-first app", async () => {
  // #given a workspace with an archived channel and the app installed
  const { run, general, channel } = await workspace("Apps Two");
  await completes(run({ kind: "createChannel", skey: "old", name: "old", visibility: "public" }));
  await completes(run({ kind: "archiveChannel", skey: channel("old") }));

  // #then each is refused
  await refused(run({ kind: "installApp", subject: OWNER, channels: [] }), /workspace account cannot be installed/);
  await refused(run({ kind: "installApp", subject: PERSON, channels: [] }), /member cannot be installed/);
  await refused(run({ kind: "installApp", subject: BOT, channels: [{ skey: channel("nowhere"), write: false }] }), /active channel/);
  await refused(run({ kind: "installApp", subject: BOT, channels: [{ skey: channel("old"), write: false }] }), /active channel/);
  await completes(run({ kind: "installApp", subject: BOT, channels: [] }));
  await refused(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: false }] }), /already installed/);
  for (let index = 1; index < 20; index += 1) await completes(run({ kind: "installApp", subject: `did:plc:bot${index}`, channels: [] }));
  await refused(run({ kind: "installApp", subject: "did:plc:bot20", channels: [] }), /app limit reached \(20\)/);
  await completes(run({ kind: "uninstallApp", subject: "did:plc:bot1" }));
  await completes(run({ kind: "installApp", subject: "did:plc:bot20", channels: [] }));
});

test("only an installed app's access changes or goes, and an installed app is neither invited nor removed as a person", async () => {
  const { run } = await workspace("Apps Three");
  await refused(run({ kind: "updateAppAccess", subject: BOT, channels: [] }), /not installed/);
  await refused(run({ kind: "uninstallApp", subject: BOT }), /not installed/);
  await completes(run({ kind: "installApp", subject: BOT, channels: [] }));
  await refused(run({ kind: "inviteMember", subject: BOT }), /installed app/);
  await refused(run({ kind: "removeMember", subject: BOT }), /uninstallApp/);
  await refused(run({ kind: "setAdmin", subject: BOT, active: true }), /not an admin/);
  await refused(run({ kind: "setAdmin", subject: BOT, active: false }), /not an admin/);
});

const RESUMED = [
  { label: "install", installed: false, request: (general: string) => ({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }), stops: 6, writes: 6, after: "rw" },
  { label: "update", installed: true, request: (general: string) => ({ kind: "updateAppAccess", subject: BOT, channels: [{ skey: general, write: false }] }), stops: 3, writes: 2, after: "r" },
  { label: "uninstall", installed: true, request: () => ({ kind: "uninstallApp", subject: BOT }), stops: 5, writes: 5, after: "-" },
];

for (const scenario of RESUMED) {
  test(`an app's ${scenario.label} stopped at any write resumes, repeating none`, async () => {
    for (let index = 0; index < scenario.stops; index += 1) {
      // #given an outage from this write of the operation on (it outlasts the journal's own retries)
      let armed = false;
      let succeeded = 0;
      const { pds, owner, run, general } = await workspace(`Apps Resume ${scenario.label} ${index}`, (method) => {
        if (!armed || !WRITES.has(method)) return undefined;
        if (succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      });
      if (scenario.installed) await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
      const before = pds.writes.length;
      const operationId = tidNow();
      armed = true;

      // #when it stops there, and the admin retries it once the host is back
      const stopped = await run(scenario.request(general), operationId);
      armed = false;
      await completes(run(scenario.request(general), operationId));

      // #then it was pending, and every write was made once, leaving the app where its record says
      assert.equal(stopped.state, "pending", `${scenario.label} ${index}`);
      const writes = pds.writes.slice(before);
      assert.equal(writes.length, scenario.writes, `${scenario.label} ${index}: ${writes.join(", ")}`);
      assert.equal(new Set(writes).size, writes.length, `${scenario.label} ${index}: no write repeated`);
      assert.equal(placements(pds, owner, BOT)[general], scenario.after);
    }
  });
}

test("a reconcile while an uninstall is stopped after its record cannot restore the app, and it is gone once the host is back", async () => {
  // #given the app installed, and its uninstall stopped after its record by a host refusing removals
  let removals = true;
  const { pds, owner, run, general } = await workspace("Apps Five", (method) => removals && method === "com.atproto.memberspace.removeMember" ? OUTAGE() : undefined);
  removals = false;
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  removals = true;
  const operationId = tidNow();
  const stopped = await run({ kind: "uninstallApp", subject: BOT }, operationId);
  const stoppedAt = JSON.parse(rowOf(operationId)?.steps_json ?? "null") as unknown;
  const before = pds.writes.length;

  // #when a reconcile runs while removals still fail, and again once they work
  await assert.rejects(run({ kind: "reconcileWorkspace" }), /could not be resumed/);
  const meanwhile = pds.writes.slice(before);
  removals = false;
  await completes(run({ kind: "reconcileWorkspace" }));

  // #then the reconcile wrote no entry for the app while the uninstall was stopped, and afterwards the app is nowhere
  assert.equal(stopped.state, "pending");
  assert.deepEqual(stoppedAt, ["app-uninstall-record"]);
  assert.deepEqual(meanwhile.filter((write) => write.includes(BOT)), []);
  assert.deepEqual(placements(pds, owner, BOT), { workspace: "-", inbox: "-", [general]: "-" });
  assert.equal(rowOf(operationId)?.state, "completed");
});

test("with an app installed, channel and member operations each leave it exactly where its record says", async () => {
  // #given the app installed with write in #general
  const { pds, owner, run, general, channel } = await workspace("Apps Six");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const at = () => placements(pds, owner, BOT);

  // #then a new public and a new private channel leave it out
  await completes(run({ kind: "createChannel", skey: "news", name: "news", visibility: "public" }));
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [PERSON] }));
  assert.deepEqual(at(), { workspace: "r", inbox: "-", [general]: "rw", [channel("news")]: "-", [channel("secret")]: "-" });

  // #and granting the private channel read only puts it there, through visibility changes both ways
  await completes(run({ kind: "updateAppAccess", subject: BOT, channels: [{ skey: general, write: true }, { skey: channel("secret"), write: false }] }));
  assert.equal(at()[channel("secret")], "r");
  await completes(run({ kind: "transitionChannel", skey: channel("secret"), visibility: "public" }));
  assert.equal(at()[channel("secret")], "r", "made public");
  await completes(run({ kind: "transitionChannel", skey: channel("secret"), visibility: "private", members: [PERSON] }));
  assert.equal(at()[channel("secret")], "r", "made private again");

  // #and archiving it removes the app and ends that grant in its record
  await completes(run({ kind: "archiveChannel", skey: channel("secret") }));
  assert.equal(at()[channel("secret")], "-");
  assert.deepEqual(installRecord(pds, owner)?.channels, [{ skey: general, write: true }]);

  // #and inviting and removing a person, and a reconcile, leave it as it is
  await completes(run({ kind: "inviteMember", subject: OTHER }));
  await completes(run({ kind: "removeMember", subject: OTHER }));
  await completes(run({ kind: "reconcileWorkspace" }));
  assert.deepEqual(at(), { workspace: "r", inbox: "-", [general]: "rw", [channel("news")]: "-", [channel("secret")]: "-" });
});

test("installing an app with a grant from before apps asks for reauthorization, leaves no row, and the same operation succeeds after", async () => {
  // #given an authority grant from before apps (it lacks both the app-inbox space type and the install collection)
  let scopeMissing = true;
  const { pds, owner, run, general } = await workspace("Apps Seven", (method, target) =>
    scopeMissing && ((method === "com.atproto.space.createSpace" && target.space === undefined) || (method === "com.atproto.space.putRecord" && target.collection === COLLECTION.appInstall))
      ? SCOPE_MISSING()
      : undefined);
  const request = { kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] };
  const operationId = tidNow();

  // #when the admin installs the app, the account approves the grant again, and the admin retries the same operation
  const first = await run(request, operationId);
  const rowAfterRefusal = rowOf(operationId);
  scopeMissing = false;
  const retried = await run(request, operationId);

  // #then the first answer asks for reauthorization with no journal row, and the retry installs the app
  assert.equal(first.authorizationRequired, true, JSON.stringify(first));
  assert.equal(rowAfterRefusal, undefined);
  assert.equal(retried.state, "completed");
  assert.equal(placements(pds, owner, BOT)[general], "rw");
});

test("a visibility change puts back a granted app's entry the channel lost, with its bits", async () => {
  // #given the app granted a private channel read only, and its entry there gone
  const { pds, owner, run, general, channel } = await workspace("Apps Eight");
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [PERSON] }));
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }, { skey: channel("secret"), write: false }] }));
  pds.membersOf(channelUri(OWNER, channel("secret"))).delete(BOT);

  // #when the channel is made public
  const view = await run({ kind: "transitionChannel", skey: channel("secret"), visibility: "public" });

  // #then the app is back, reading only
  assert.equal(view.state, "completed");
  assert.ok(view.completedSteps.includes(`channel-app-${BOT}`), view.completedSteps.join(", "));
  assert.equal(placements(pds, owner, BOT)[channel("secret")], "r");
});

test("an archive stopped after it ended an app's grant resumes, and the app is in no list of the channel", async () => {
  // #given the app granted a channel, and an archive of it stopped by a host refusing removals
  let removals = false;
  const { pds, owner, run, general, channel } = await workspace("Apps Nine", (method) => removals && method === "com.atproto.memberspace.removeMember" ? OUTAGE() : undefined);
  await completes(run({ kind: "createChannel", skey: "old", name: "old", visibility: "public" }));
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }, { skey: channel("old"), write: true }] }));
  removals = true;
  const operationId = tidNow();
  const stopped = await run({ kind: "archiveChannel", skey: channel("old") }, operationId);

  // #when the admin retries it once removals work
  removals = false;
  await completes(run({ kind: "archiveChannel", skey: channel("old") }, operationId));

  // #then it had ended the grant before it stopped, and now the app is in no list of the channel
  assert.equal(stopped.state, "pending");
  assert.ok(stopped.completedSteps.includes(`channel-archive-app-${BOT}`), stopped.completedSteps.join(", "));
  assert.equal(placements(pds, owner, BOT)[channel("old")], "-");
  assert.deepEqual(installRecord(pds, owner)?.channels, [{ skey: general, write: true }]);
});

test("a repeat of the same install keeps who installed the app and when", async () => {
  const { pds, owner, run, general } = await workspace("Apps Ten");
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const first = installRecord(pds, owner) as Record<string, unknown> | undefined;
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  const second = installRecord(pds, owner) as Record<string, unknown> | undefined;
  assert.deepEqual([second?.installedBy, second?.installedAt], [first?.installedBy, first?.installedAt]);
});

test("no decision on a join request moves an installed app, approved or denied", async () => {
  // #given the app granted a private channel read only, and a join request for it under the app's DID
  const { pds, owner, run, general, channel } = await workspace("Apps Eleven");
  await completes(run({ kind: "createChannel", skey: "secret", name: "secret", visibility: "private", members: [PERSON] }));
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }, { skey: channel("secret"), write: false }] }));
  const request = spaceRecordUri(inboxUri(OWNER, owner.workspace.skey), BOT, COLLECTION.joinRequest, requestRecordKey(channelUri(OWNER, channel("secret")), BOT));
  const before = pds.writes.length;

  // #then both decisions are refused before anything is read of the request or written
  for (const decision of ["approve", "deny"]) await refused(run({ kind: "decideJoinRequest", request, requestId: tidNow(), decision }), /installed app/);
  assert.deepEqual(pds.writes.slice(before), []);
  assert.equal(placements(pds, owner, BOT)[channel("secret")], "r");
});

test("appInboxState distinguishes present, missing and uncovered spaces and rethrows host errors", async () => {
  let mode: "ok" | "uncovered" | "outage" = "ok";
  const pds = fakeAuthorityPds(OWNER, {
    intercept: (method) => {
      if (method !== "com.atproto.space.getSpace") return undefined;
      if (mode === "uncovered") return SCOPE_MISSING();
      if (mode === "outage") return OUTAGE();
      return undefined;
    },
  });
  const inbox = appInboxUri(OWNER, "acme", BOT);
  assert.equal(await appInboxState(pds.session, inbox), "missing");
  pds.membersOf(inbox);
  assert.equal(await appInboxState(pds.session, inbox), "present");
  mode = "uncovered";
  assert.equal(await appInboxState(pds.session, inbox), "uncovered");
  mode = "outage";
  await assert.rejects(appInboxState(pds.session, inbox), /outage/);
});

test("the self-owned workspace authority is never written into an app inbox, and uninstall removes the app before writers", async () => {
  const { pds, owner, run, general } = await workspace("Apps Twelve");
  const inbox = appInboxUri(OWNER, owner.workspace.skey, BOT);
  await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
  assert.equal(pds.membersOf(inbox).has(OWNER), false, "the self-owned authority is omitted from the inbox list");
  assert.deepEqual(pds.membersOf(inbox).get(PERSON), { did: PERSON, read: false, write: true });
  assert.deepEqual(pds.membersOf(inbox).get(BOT), { did: BOT, read: true, write: false });

  await completes(run({ kind: "reconcileWorkspace" }));
  assert.equal(pds.membersOf(inbox).has(OWNER), false, "reconcile keeps the self-owned authority out of the inbox list");

  const before = pds.writes.length;
  await completes(run({ kind: "uninstallApp", subject: BOT }));
  const inboxRemovals = pds.writes.slice(before).filter((write) => write.startsWith(`removeMember ${inbox} `));
  assert.deepEqual(inboxRemovals, [`removeMember ${inbox} ${BOT}`, `removeMember ${inbox} ${PERSON}`], "the app is removed from its inbox before writers");
});

test("inviteMember, removeMember, leaveWorkspace and reconcileWorkspace resume after a stop at any write, repeating none", async () => {
  // inviteMember, removeMember and leaveWorkspace with two active apps
  for (const mode of ["invite", "remove", "leave"] as const) {
    const expectedWrites = 6;
    for (let index = 0; index < expectedWrites; index += 1) {
      let armed = false;
      let succeeded = 0;
      const { pds, owner, run, general } = await workspace(`Apps Member Resume ${mode} ${index}`, (method) => {
        if (!armed || !WRITES.has(method)) return undefined;
        if (succeeded === index) return OUTAGE();
        succeeded += 1;
        return undefined;
      });
      const botTwo = "did:plc:bot2";
      await completes(run({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }));
      await completes(run({ kind: "installApp", subject: botTwo, channels: [] }));
      if (mode !== "invite") await completes(run({ kind: "inviteMember", subject: OTHER }));

      const actor: OperatorActor = mode === "leave" ? { ...owner, did: OTHER, canRecoverOperations: false } : owner;
      const request = mode === "invite"
        ? { kind: "inviteMember", subject: OTHER }
        : mode === "remove"
          ? { kind: "removeMember", subject: OTHER }
          : { kind: "leaveWorkspace" };
      const operationId = tidNow();
      const before = pds.writes.length;
      armed = true;
      const stopped = await executeOperatorOperation(actor, operationId, request);
      armed = false;
      await completes(executeOperatorOperation(actor, operationId, request));

      assert.equal(stopped.state, "pending", `${mode} ${index}`);
      const writes = pds.writes.slice(before);
      assert.equal(writes.length, expectedWrites, `${mode} ${index}: ${writes.join(", ")}`);
      assert.equal(new Set(writes).size, writes.length, `${mode} ${index}: no write repeated`);
      for (const app of [BOT, botTwo]) {
        const inbox = appInboxUri(OWNER, owner.workspace.skey, app);
        assert.equal(pds.membersOf(inbox).has(OTHER), mode === "invite");
      }
    }
  }

  // reconcileWorkspace creating a missing inbox and emptying an inactive one, stopped mid-step at every write
  for (let index = 0; index < 5; index += 1) {
    let armed = false;
    let succeeded = 0;
    const { pds, owner, run } = await workspace(`Apps Reconcile Resume ${index}`, (method) => {
      if (!armed || !WRITES.has(method)) return undefined;
      if (succeeded === index) return OUTAGE();
      succeeded += 1;
      return undefined;
    });
    const inactiveBot = "did:plc:inactivebot";
    const nowIso = "2026-11-15T00:00:00.000Z";
    // Active pre-R10 install (no inbox space yet; workspace entry already present)
    pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(BOT), {
      $type: COLLECTION.appInstall, subject: BOT, active: true, channels: [], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
    });
    pds.membersOf(owner.workspace.uri).set(BOT, { did: BOT, read: true, write: false });
    // Inactive install whose inbox still holds the app and a writer
    pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(inactiveBot), {
      $type: COLLECTION.appInstall, subject: inactiveBot, active: false, channels: [], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
    });
    const inactiveInbox = appInboxUri(OWNER, owner.workspace.skey, inactiveBot);
    pds.membersOf(inactiveInbox).set(PERSON, { did: PERSON, read: false, write: true }).set(inactiveBot, { did: inactiveBot, read: true, write: false });

    const operationId = tidNow();
    const before = pds.writes.length;
    armed = true;
    const stopped = await run({ kind: "reconcileWorkspace" }, operationId);
    armed = false;
    await completes(run({ kind: "reconcileWorkspace" }, operationId));

    assert.equal(stopped.state, "pending", `reconcile ${index}`);
    const writes = pds.writes.slice(before);
    assert.equal(writes.length, 5, `reconcile ${index}: ${writes.join(", ")}`);
    assert.equal(new Set(writes).size, writes.length, `reconcile ${index}: no write repeated`);
    const inactiveRemovals = writes.filter((write) => write.startsWith(`removeMember ${inactiveInbox} `));
    assert.deepEqual(inactiveRemovals, [`removeMember ${inactiveInbox} ${inactiveBot}`, `removeMember ${inactiveInbox} ${PERSON}`], "reconcile removes the app before writers");
    const activeInbox = appInboxUri(OWNER, owner.workspace.skey, BOT);
    assert.equal(pds.membersOf(activeInbox).size, 2);
    assert.equal(pds.membersOf(inactiveInbox).size, 0);
  }
});

test("pending pre-R10 journal rows replay cleanly with the new inbox steps", async () => {
  const { pds, owner, run, general } = await workspace("Apps PreR10 Replay");
  const nowIso = "2026-11-15T00:00:00.000Z";
  const nowSec = Math.floor(Date.now() / 1000) - 30;
  const insertPending = (actorDid: string, operationId: string, request: Record<string, unknown>, steps: string[]) => {
    const hash = requestDigest({ workspace: owner.workspace.uri, request });
    getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'pre-r10 outage', ?, ?)`)
      .run(OWNER, owner.workspace.uri, actorDid, operationId, hash, canonicalJson({ workspace: owner.workspace.uri, request }), JSON.stringify(steps), nowSec, nowSec);
  };

  // A pre-R10 installApp row that already wrote app-install-record before R10
  pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(BOT), {
    $type: COLLECTION.appInstall, subject: BOT, active: true, channels: [{ skey: general, write: true }], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
  });
  const installId = tidNow();
  const installReq = { kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] };
  insertPending(OWNER, installId, installReq, ["app-install-record"]);
  await completes(run(installReq, installId));
  const inbox = appInboxUri(OWNER, owner.workspace.skey, BOT);
  assert.deepEqual(pds.membersOf(inbox).get(BOT), { did: BOT, read: true, write: false });
  assert.deepEqual(pds.membersOf(inbox).get(PERSON), { did: PERSON, read: false, write: true });

  // A pre-R10 inviteMember row that stopped after member-inbox-writer
  pds.membersOf(owner.workspace.uri).set(OTHER, { did: OTHER, read: true, write: true });
  pds.membersOf(inboxUri(OWNER, owner.workspace.skey)).set(OTHER, { did: OTHER, read: false, write: true });
  const inviteId = tidNow();
  const inviteReq = { kind: "inviteMember", subject: OTHER };
  insertPending(OWNER, inviteId, inviteReq, ["member-workspace", "member-inbox-writer"]);
  await completes(run(inviteReq, inviteId));
  assert.deepEqual(pds.membersOf(inbox).get(OTHER), { did: OTHER, read: false, write: true });

  // A pre-R10 pending installApp and updateAppAccess row replaying under an old (uncovered) authority grant finishes without wedging the workspace
  const oldGrantBot = "did:plc:oldgrant-bot";
  let blockOldInbox = true;
  const oldGrantWs = await workspace("Apps PreR10 Replay OldGrant", (method, target) => {
    if (!blockOldInbox) return undefined;
    if (method === "com.atproto.space.createSpace" && target.space === undefined) return SCOPE_MISSING();
    if (method === "com.atproto.space.getSpace" && target.space?.includes("/new.flock.app.inbox/")) return SCOPE_MISSING();
    return undefined;
  });
  oldGrantWs.pds.recordsOf(oldGrantWs.owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(oldGrantBot), {
    $type: COLLECTION.appInstall, subject: oldGrantBot, active: true, channels: [{ skey: oldGrantWs.general, write: false }], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
  });
  const oldInstallId = tidNow();
  const oldInstallReq = { kind: "installApp", subject: oldGrantBot, channels: [{ skey: oldGrantWs.general, write: false }] };
  const oldHash = requestDigest({ workspace: oldGrantWs.owner.workspace.uri, request: oldInstallReq });
  getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'pre-r10 outage', ?, ?)`)
    .run(OWNER, oldGrantWs.owner.workspace.uri, OWNER, oldInstallId, oldHash, canonicalJson({ workspace: oldGrantWs.owner.workspace.uri, request: oldInstallReq }), JSON.stringify(["app-install-record"]), nowSec, nowSec);
  await completes(oldGrantWs.run({ kind: "reconcileWorkspace" }));
  assert.equal(rowOf(oldInstallId)?.state, "completed", "pre-R10 pending installApp recovered without wedging on uncovered inbox");
  assert.equal(placements(oldGrantWs.pds, oldGrantWs.owner, oldGrantBot)[oldGrantWs.general], "r");

  const oldUpdateId = tidNow();
  const oldUpdateReq = { kind: "updateAppAccess", subject: oldGrantBot, channels: [{ skey: oldGrantWs.general, write: true }] };
  const oldUpdateHash = requestDigest({ workspace: oldGrantWs.owner.workspace.uri, request: oldUpdateReq });
  oldGrantWs.pds.recordsOf(oldGrantWs.owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(oldGrantBot), {
    $type: COLLECTION.appInstall, subject: oldGrantBot, active: true, channels: [{ skey: oldGrantWs.general, write: true }], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
  });
  getRawDb().prepare(`INSERT INTO operation (workspace, workspace_uri, actor, operation_id, request_hash, request_json, state, steps_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'pre-r10 outage', ?, ?)`)
    .run(OWNER, oldGrantWs.owner.workspace.uri, OWNER, oldUpdateId, oldUpdateHash, canonicalJson({ workspace: oldGrantWs.owner.workspace.uri, request: oldUpdateReq }), JSON.stringify(["app-access-record"]), nowSec, nowSec);
  await completes(oldGrantWs.run({ kind: "reconcileWorkspace" }));
  assert.equal(rowOf(oldUpdateId)?.state, "completed", "pre-R10 pending updateAppAccess recovered without wedging on uncovered inbox");
  assert.equal(placements(oldGrantWs.pds, oldGrantWs.owner, oldGrantBot)[oldGrantWs.general], "rw");
  blockOldInbox = false;
});

test("pre-R10 installs without an inbox (active and inactive) work under both covering and pre-R10 authority grants", async () => {
  for (const grantCoversInbox of [true, false]) {
    let blockInboxScope = !grantCoversInbox;
    const { pds, owner, general } = await workspace(`Apps PreR10 Matrix ${grantCoversInbox}`, (method, target) => {
      if (!blockInboxScope) return undefined;
      if (method === "com.atproto.space.createSpace" && target.space === undefined) return SCOPE_MISSING();
      if (method === "com.atproto.space.getSpace" && target.space?.includes("/new.flock.app.inbox/")) return SCOPE_MISSING();
      return undefined;
    });
    const registered: string[] = [];
    const deps: RegistrationDeps = {
      register: async (_session, space) => { registered.push(space); return Date.now() + 86_400_000; },
      unregister: async () => undefined,
      now: () => Date.now(),
    };
    const run = (request: Record<string, unknown>, operationId = tidNow(), withDeps = true) =>
      executeOperatorOperation(owner, operationId, request, withDeps ? deps : undefined);

    const activeBot = "did:plc:active-prer10";
    const inactiveBot = "did:plc:inactive-prer10";
    const nowIso = "2026-11-15T00:00:00.000Z";
    pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(activeBot), {
      $type: COLLECTION.appInstall, subject: activeBot, active: true, channels: [{ skey: general, write: true }], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
    });
    pds.membersOf(owner.workspace.uri).set(activeBot, { did: activeBot, read: true, write: false });
    pds.membersOf(channelUri(OWNER, general)).set(activeBot, { did: activeBot, read: true, write: true });
    pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(inactiveBot), {
      $type: COLLECTION.appInstall, subject: inactiveBot, active: false, channels: [], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
    });

    // inviteMember, removeMember and leaveWorkspace skip missing/uncovered inboxes and complete cleanly
    await completes(run({ kind: "inviteMember", subject: OTHER }));
    await completes(run({ kind: "removeMember", subject: OTHER }));
    const leaver = "did:plc:leaver";
    await completes(run({ kind: "inviteMember", subject: leaver }));
    await completes(executeOperatorOperation({ ...owner, did: leaver, canRecoverOperations: false }, tidNow(), { kind: "leaveWorkspace" }, deps));

    if (!grantCoversInbox) {
      // updateAppAccess on an old grant fails at step 0 with nothing written and no row left behind
      const updateId = tidNow();
      const before = pds.writes.length;
      const updateView = await run({ kind: "updateAppAccess", subject: activeBot, channels: [{ skey: general, write: false }] }, updateId);
      assert.equal(updateView.authorizationRequired, true);
      assert.equal(rowOf(updateId), undefined);
      assert.deepEqual(pds.writes.slice(before), []);

      // reconcileWorkspace completes for every other space (fixing drift there) and reports that app inbox approval is needed
      pds.membersOf(owner.workspace.uri).delete(PERSON);
      await completes(run({ kind: "reconcileWorkspace" }));
      assert.deepEqual(pds.membersOf(owner.workspace.uri).get(PERSON), { did: PERSON, read: true, write: true }, "workspace drift fixed under old grant");
      assert.equal(await hasUncoveredAppInbox(owner), true);

      // uninstallApp on an old grant skips the inbox and completes
      await completes(run({ kind: "uninstallApp", subject: activeBot }));
      assert.equal(await hasUncoveredAppInbox(owner), false);
    } else {
      // Without registration deps, reconcile registers nothing; with deps, updateAppAccess creates, fills and registers a missing inbox
      const secondPreR10 = "did:plc:second-prer10";
      pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(secondPreR10), {
        $type: COLLECTION.appInstall, subject: secondPreR10, active: true, channels: [], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
      });
      pds.membersOf(owner.workspace.uri).set(secondPreR10, { did: secondPreR10, read: true, write: false });

      registered.length = 0;
      await completes(run({ kind: "updateAppAccess", subject: activeBot, channels: [{ skey: general, write: false }] }));
      const activeInbox = appInboxUri(OWNER, owner.workspace.skey, activeBot);
      assert.deepEqual(registered, [activeInbox], "updateAppAccess creates, fills and registers a missing pre-R10 inbox");
      assert.deepEqual(pds.membersOf(activeInbox).get(activeBot), { did: activeBot, read: true, write: false });
      assert.deepEqual(pds.membersOf(activeInbox).get(PERSON), { did: PERSON, read: false, write: true });

      registered.length = 0;
      await completes(run({ kind: "reconcileWorkspace" }, tidNow(), false));
      assert.deepEqual(registered, [], "reconcile without registration deps registers nothing");
      const secondInbox = appInboxUri(OWNER, owner.workspace.skey, secondPreR10);
      assert.deepEqual(pds.membersOf(secondInbox).get(secondPreR10), { did: secondPreR10, read: true, write: false });
      assert.equal(await appInboxState(pds.session, appInboxUri(OWNER, owner.workspace.skey, inactiveBot)), "missing", "inactive pre-R10 install keeps no inbox");

      // A transient PDS error inside afterOperation after reconcileWorkspace completed is audited without failing executeOperatorOperation
      const thirdPreR10 = "did:plc:third-prer10";
      pds.recordsOf(owner.workspace.uri, COLLECTION.appInstall).set(subjectKey(thirdPreR10), {
        $type: COLLECTION.appInstall, subject: thirdPreR10, active: true, channels: [], installedBy: OWNER, installedAt: nowIso, updatedAt: nowIso,
      });
      pds.membersOf(owner.workspace.uri).set(thirdPreR10, { did: thirdPreR10, read: true, write: false });
      const thirdInbox = appInboxUri(OWNER, owner.workspace.skey, thirdPreR10);
      pds.membersOf(thirdInbox).set(PERSON, { did: PERSON, read: false, write: true }).set(thirdPreR10, { did: thirdPreR10, read: true, write: false });
      let getSpaceCount = 0;
      const afterThrowActor: OperatorActor = { ...owner, session: {
        did: OWNER,
        fetchHandler: async (path: string, init?: RequestInit) => {
          const parsedUrl = new URL(path, "https://pds.invalid");
          if (parsedUrl.pathname.endsWith("/com.atproto.space.getSpace") && parsedUrl.searchParams.get("space") === thirdInbox) {
            getSpaceCount += 1;
            if (getSpaceCount >= 2) return OUTAGE();
          }
          return pds.session.fetchHandler(path, init);
        },
      } as unknown as OperatorActor["session"] };
      const afterThrowOpId = tidNow();
      await completes(executeOperatorOperation(afterThrowActor, afterThrowOpId, { kind: "reconcileWorkspace" }, deps));
      assert.deepEqual(registered, [secondInbox], "secondInbox registered before thirdInbox's getSpace threw");
      const auditFailure = getRawDb().prepare("SELECT event FROM audit_event WHERE operation_id = ? AND event = 'operationRegistrationFailed'").get(afterThrowOpId) as { event: string } | undefined;
      assert.equal(auditFailure?.event, "operationRegistrationFailed", "post-completion registration read failure is audited without failing execute");

      registered.length = 0;
      await completes(run({ kind: "reconcileWorkspace" }, tidNow(), true));
      assert.deepEqual(registered, [thirdInbox], "the next reconcile registers the remaining unregistered inbox");
      assert.equal(await hasUncoveredAppInbox(owner), false);
    }
    blockInboxScope = false;
  }
});
