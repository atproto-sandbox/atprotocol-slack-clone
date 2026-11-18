import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { closeDb, getRawDb } from "../lib/db";
import { channelUri, inboxUri, workspaceUri } from "@flock/protocol/keys";
import { parseWorkspaceRef, type OperatorActor } from "./actor";
import { isRegisteredSpace } from "./member-access";
import { isNotificationAccepted, purgeSpaceNotifications, recordWriteNotification } from "./notices";
import { afterOperation, registrationProblems, registerSpace, RENEW_WITHIN_MS, sweepRegistrations, type SweepDeps } from "./registrations";
import { fakeAuthorityPds } from "./testing/fake-authority-pds";

// The operator's change-notice registrations: made when an operation creates a space, kept alive by the sweep, dropped on
// archive, and reported when they fail or run out.

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-registrations-test-"));
process.env.DATABASE_PATH = join(DIRECTORY, "registrations.db");
process.env.AUTH_ENCRYPTION_KEY = "66".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});
beforeEach(() => {
  for (const table of ["notification_registration", "notification_registration_failure", "space_notification", "oauth_request_lock", "workspace_lock"]) {
    getRawDb().prepare(`DELETE FROM ${table}`).run();
  }
});

const OWNER = "did:plc:owner";
const WORKSPACE = workspaceUri(OWNER, "acme");
const INBOX = inboxUri(OWNER, "acme");
const GENERAL = channelUri(OWNER, "acme-general");
const RANDOM = channelUri(OWNER, "acme-random");
const DAY = 24 * 60 * 60 * 1000;
const { session } = fakeAuthorityPds(OWNER);
const actor: OperatorActor = { did: OWNER, session, workspace: parseWorkspaceRef(WORKSPACE), canRecoverOperations: true };

/** An authority whose registrations last a day, with a clock the test moves and spaces that can be made to fail. */
function authority(start = Date.UTC(2026, 10, 10)) {
  const clock = { now: start };
  const registered: string[] = [];
  const unregistered: string[] = [];
  const failing = new Set<string>();
  const deps: SweepDeps = {
    register: async (_session, space) => {
      if (failing.has(space)) throw Object.assign(new Error("host text that must not be stored"), { name: "XRPCError", status: 503 });
      registered.push(space);
      return clock.now + DAY;
    },
    unregister: async (_session, space) => {
      unregistered.push(space);
      throw new Error("the authority could not be reached");
    },
    now: () => clock.now,
    workspaces: () => [{ authorityDid: OWNER, uri: WORKSPACE }],
    grant: async () => session,
    activeSpaces: async () => [WORKSPACE, INBOX, GENERAL],
  };
  return { deps, clock, registered, unregistered, failing };
}

const expiry = (space: string) => (getRawDb().prepare("SELECT expires_at FROM notification_registration WHERE space_uri=?").get(space) as { expires_at: number } | undefined)?.expires_at;

test("a completed operation registers the spaces it created; one that fails is recorded and reported, and does not fail it", async () => {
  const { deps, failing } = authority();
  failing.add(GENERAL);
  await afterOperation(actor, { createsSpaces: () => [WORKSPACE, INBOX, GENERAL] }, { kind: "bootstrapWorkspace" }, { state: "completed" }, deps);
  assert.ok(expiry(WORKSPACE) && expiry(INBOX));
  assert.equal(expiry(GENERAL), undefined);
  const [problem] = registrationProblems(WORKSPACE, deps.now());
  assert.deepEqual([problem!.space, problem!.failures, problem!.error], [GENERAL, 1, "XRPCError 503"], "a safe description, never the host's text");
});

test("an operation that did not complete registers nothing", async () => {
  const { deps, registered } = authority();
  await afterOperation(actor, { createsSpaces: () => [GENERAL] }, { kind: "createChannel" }, { state: "pending" }, deps);
  assert.deepEqual(registered, []);
});

test("an archived channel loses its registration and its notices, so the sink refuses its notices from then on", async () => {
  const { deps, unregistered } = authority(Date.now());
  await registerSpace(session, WORKSPACE, RANDOM, deps);
  recordWriteNotification({ space: RANDOM, repo: "did:plc:writer", repoRev: "rev" });
  assert.equal(isNotificationAccepted(RANDOM), true);
  await afterOperation(actor, { archivesSpaces: () => [RANDOM] }, { kind: "archiveChannel" }, { state: "completed" }, deps);
  assert.deepEqual(unregistered, [RANDOM], "the authority is asked to stop, and its failing to answer changes nothing here");
  assert.equal(isNotificationAccepted(RANDOM), false);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM space_notification WHERE space_uri=?").get(RANDOM) as { count: number }).count, 0);
});

test("the sweep registers what is missing or near its end, leaves what is fresh, and waits out a failure's backoff", async () => {
  const { deps, clock, registered, failing } = authority();
  await registerSpace(session, WORKSPACE, WORKSPACE, deps);
  clock.now += DAY - RENEW_WITHIN_MS + 1;
  await registerSpace(session, WORKSPACE, INBOX, deps);
  registered.length = 0;
  failing.add(GENERAL);
  assert.deepEqual(await sweepRegistrations(deps), { registered: 1, failed: 1, skipped: [] });
  assert.deepEqual(registered, [WORKSPACE], "the workspace was near its end; the inbox was fresh; general failed");
  failing.delete(GENERAL);
  clock.now += 31 * 60 * 1000;
  registered.length = 0;
  await sweepRegistrations(deps);
  assert.deepEqual(registered, [GENERAL], "after its first backoff of thirty minutes");
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
});

test("two operator processes do not sweep at once, and a sweep runs at most every thirty minutes", async () => {
  const { deps, clock } = authority();
  const results = await Promise.all([sweepRegistrations(deps), sweepRegistrations(deps)]);
  assert.equal(results.filter((result) => result === null).length, 1);
  clock.now += 29 * 60 * 1000;
  assert.equal(await sweepRegistrations(deps), null);
  clock.now += 2 * 60 * 1000;
  assert.notEqual(await sweepRegistrations(deps), null);
});

test("an idle workspace keeps its registrations past a day with no admin activity", async () => {
  const { deps, clock } = authority();
  const start = clock.now;
  while (clock.now - start < 3 * DAY) {
    await sweepRegistrations(deps);
    for (const space of [WORKSPACE, INBOX, GENERAL]) assert.ok(expiry(space)! > clock.now, `${space} is registered at +${(clock.now - start) / 60_000} min`);
    clock.now += 30 * 60 * 1000;
  }
});

test("a registration that ran out while the operator was down is reported meanwhile, and restored by the next sweep", async () => {
  const { deps, clock } = authority();
  await sweepRegistrations(deps);
  clock.now += DAY + 60 * 60 * 1000;
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now).map((problem) => [problem.space, problem.failures, Boolean(problem.expiredAt)]).sort(),
    [[GENERAL, 0, true], [INBOX, 0, true], [WORKSPACE, 0, true]].sort());
  assert.deepEqual(await sweepRegistrations(deps), { registered: 3, failed: 0, skipped: [] });
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
});

test("a workspace whose authority grant is gone is skipped by the sweep and said so", async () => {
  const { deps, registered } = authority();
  deps.grant = async () => { throw Object.assign(new Error("no grant"), { name: "AuthorityReauthorizationRequiredError" }); };
  assert.deepEqual(await sweepRegistrations(deps), { registered: 0, failed: 0, skipped: [{ workspace: WORKSPACE, reason: "AuthorityReauthorizationRequiredError" }] });
  assert.deepEqual(registered, []);
});

test("registering does not wait on the workspace lock, which the operation that created the space may hold", async () => {
  const { deps } = authority(Date.now());
  getRawDb().prepare("INSERT INTO workspace_lock (workspace, token, expires_at) VALUES (?, ?, ?)").run(OWNER, "held-by-an-operation", Math.floor(Date.now() / 1000) + 600);
  const started = Date.now();
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);
  assert.ok(Date.now() - started < 1_000);
});

test("the sweep drops what it holds for a space no longer active, such as a channel an archive resumed elsewhere left behind", async () => {
  const { deps, unregistered } = authority();
  await registerSpace(session, WORKSPACE, RANDOM, deps);
  await sweepRegistrations(deps);
  assert.deepEqual(unregistered, [RANDOM]);
  assert.equal(expiry(RANDOM), undefined);
  assert.deepEqual(registrationProblems(WORKSPACE, deps.now()), []);
});

test("the sweep does not run while admin mutations are paused, since registering writes at the authority's host", async () => {
  const { deps, registered } = authority();
  process.env.FLOCK_ADMIN_MUTATIONS_PAUSED = "true";
  try {
    assert.equal(await sweepRegistrations(deps), null);
  } finally {
    delete process.env.FLOCK_ADMIN_MUTATIONS_PAUSED;
  }
  assert.deepEqual(registered, []);
});

test("a failing space is retried after thirty minutes, then an hour, and never less often, so the renewal window holds several tries", async () => {
  const { deps, clock, failing } = authority();
  failing.add(GENERAL);
  const nextAttempts: number[] = [];
  for (let failure = 0; failure < 4; failure += 1) {
    await registerSpace(session, WORKSPACE, GENERAL, deps);
    nextAttempts.push(Date.parse(registrationProblems(WORKSPACE, clock.now)[0]!.nextAttemptAt!) - clock.now);
  }
  assert.deepEqual(nextAttempts, [30, 60, 60, 60].map((minutes) => minutes * 60 * 1000));
});

test("a space registered while the sweep reads the directory is not mistaken for one no longer active", async () => {
  const { deps, unregistered } = authority();
  const created = channelUri(OWNER, "acme-new");
  deps.activeSpaces = async () => {
    // An operation creates the channel and registers it while the sweep's directory read is in flight.
    await registerSpace(session, WORKSPACE, created, deps);
    return [WORKSPACE, INBOX, GENERAL];
  };
  await sweepRegistrations(deps);
  assert.deepEqual(unregistered, []);
  assert.ok(expiry(created));
});

test("the feed knows a space the operator registered or failed to, for this operator's service only, and a deleted space's failure goes too", async () => {
  const { deps, failing } = authority(Date.now());
  await registerSpace(session, WORKSPACE, GENERAL, deps);
  failing.add(RANDOM);
  await registerSpace(session, WORKSPACE, RANDOM, deps);
  getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at,workspace_uri) VALUES (?,?,?,?)")
    .run("did:web:previous.test#atproto_flock_operator", INBOX, Date.now() + DAY, WORKSPACE);
  assert.deepEqual([GENERAL, RANDOM, INBOX, WORKSPACE].map(isRegisteredSpace), [true, true, false, false]);
  purgeSpaceNotifications(RANDOM);
  assert.equal(isRegisteredSpace(RANDOM), false);
  assert.deepEqual(registrationProblems(WORKSPACE, deps.now()), []);
});
