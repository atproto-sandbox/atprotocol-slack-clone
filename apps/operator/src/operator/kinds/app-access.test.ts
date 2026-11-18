import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb, getRawDb } from "../../lib/db";
import { channelUri, inboxUri, requestRecordKey, spaceRecordUri, subjectKey, tidNow } from "@flock/protocol/keys";
import { COLLECTION } from "@flock/protocol/nsids";
import { parseWorkspaceRef, type OperatorActor } from "../actor";
import { executeOperatorOperation } from "../operations";
import { fakeAuthorityPds, type FakeAuthorityPds, type FakeAuthorityPdsOptions } from "../testing/fake-authority-pds";
import { generalKey } from "../workspace-spaces";
import { createWorkspace } from "./create-workspace";

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
const WRITES = new Set(["com.atproto.space.putRecord", "com.atproto.memberspace.putMember", "com.atproto.memberspace.removeMember"]);

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

  // #then the install record is written first, and the app is a reader of the workspace and a writer in #general only
  assert.match(pds.writes[before] ?? "", /^putRecord \S+ new\.flock\.app\.install\//);
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
  { label: "install", installed: false, request: (general: string) => ({ kind: "installApp", subject: BOT, channels: [{ skey: general, write: true }] }), writes: 3, after: "rw" },
  { label: "update", installed: true, request: (general: string) => ({ kind: "updateAppAccess", subject: BOT, channels: [{ skey: general, write: false }] }), writes: 2, after: "r" },
  { label: "uninstall", installed: true, request: () => ({ kind: "uninstallApp", subject: BOT }), writes: 3, after: "-" },
];

for (const scenario of RESUMED) {
  test(`an app's ${scenario.label} stopped at any write resumes, repeating none`, async () => {
    for (let index = 0; index < scenario.writes; index += 1) {
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
  // #given an authority grant that lacks the install collection's scope
  let scopeMissing = true;
  const { pds, owner, run, general } = await workspace("Apps Seven", (method, target) =>
    scopeMissing && method === "com.atproto.space.putRecord" && target.collection === COLLECTION.appInstall ? SCOPE_MISSING() : undefined);
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
