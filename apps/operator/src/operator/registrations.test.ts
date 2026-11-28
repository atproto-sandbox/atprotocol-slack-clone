import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { SpaceCredentialError } from "@flock/protocol/atproto/space-credential-core";
import { XrpcError } from "@flock/protocol/atproto/xrpc";
import {
  appInboxUri,
  channelUri,
  groupMembersUri,
  groupMetaUri,
  inboxUri,
  subjectKey,
  tasksSpaceUri,
  workspaceUri,
} from "@flock/protocol/keys";
import { COLLECTION, ATGRP_POLICY, SPACE_TYPE } from "@flock/protocol/nsids";
import { closeDb, getRawDb } from "../lib/db";
import type { SpaceNotifyTarget } from "../atproto/space-credential";
import { parseWorkspaceRef, type OperatorActor } from "./actor";
import { AUTHORITY_SUSPENDED_BACKOFF_MS, resetAuthoritySuspensionForTests } from "./authority-suspension";
import { isRegisteredSpace, mayFollow, type MemberAccessDeps } from "./member-access";
import { purgeSpaceNotifications, readNotices, recordWriteNotification } from "./notices";
import {
  afterOperation,
  computeRenewWithinMs,
  FIRST_RETRY_MS,
  flushPendingRenewals,
  handleRegistrationExpiredNotice,
  handleSpaceDeletedNotice,
  LONGEST_RETRY_MS,
  refreshWorkspaceRegistrations,
  registrationDeps,
  registrationProblems,
  registerSpace,
  renewSpaceRegistration,
  RENEW_WITHIN_MS,
  sweepDueRegistrations,
  sweepRegistrations,
  unregisterSpace,
  type RegistrationOutcome,
  type SweepDeps,
} from "./registrations";
import { authenticateSpaceWebhook } from "./space-notification";
import { fakeGroupHost, plcDid } from "./testing/fake-group-session";

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-registrations-test-"));
const SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
process.env.DATABASE_PATH = join(DIRECTORY, "registrations.db");
process.env.AUTH_ENCRYPTION_KEY = "66".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_URL = "http://127.0.0.1:3001";
process.env.GROUP_HOST_URL = "http://127.0.0.1:3004";
process.env.OPERATOR_SERVICE_REF = SERVICE_REF;
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});
beforeEach(() => {
  resetAuthoritySuspensionForTests();
  for (const table of [
    "notification_registration",
    "notification_registration_failure",
    "space_notification",
    "oauth_request_lock",
    "workspace_lock",
  ]) {
    getRawDb().prepare(`DELETE FROM ${table}`).run();
  }
});

const GROUP = plcDid("groupreg");
const ADMIN = plcDid("adminreg");
const META = groupMetaUri(GROUP);
const MEMBERS = groupMembersUri(GROUP);
const WORKSPACE = workspaceUri(GROUP);
const INBOX = inboxUri(GROUP);
const GENERAL = channelUri(GROUP, "general");
const RANDOM = channelUri(GROUP, "random");
const TEN_MIN = 10 * 60 * 1000;
const baseGroup = await fakeGroupHost(GROUP, { creatorDid: ADMIN });
const { session } = baseGroup;
const actor: OperatorActor = {
  did: ADMIN,
  session,
  workspace: parseWorkspaceRef(WORKSPACE),
  canRecoverOperations: true,
};

type RegistrationRow = {
  expires_at: number;
  renew_at: number;
  token: string;
  last_space_rev: string | null;
  workspace_uri: string | null;
};

const registrationRow = (space: string): RegistrationRow | undefined =>
  getRawDb()
    .prepare("SELECT expires_at, renew_at, token, last_space_rev, workspace_uri FROM notification_registration WHERE service_ref=? AND space_uri=?")
    .get(SERVICE_REF, space) as RegistrationRow | undefined;

const expiry = (space: string): number | undefined => registrationRow(space)?.expires_at;

function authority(start = Date.UTC(2026, 10, 10), ttlMs = TEN_MIN, groupDid = GROUP, wsUri = WORKSPACE) {
  const clock = { now: start };
  const registered: string[] = [];
  const notifyCalls: Array<{ space: string; notify: SpaceNotifyTarget }> = [];
  const failing = new Map<string, () => Error>();
  const spaceRevs = new Map<string, string>();
  let grantCalls = 0;
  let confirmDeletedResult: boolean | (() => Promise<boolean>) = false;

  const deps: SweepDeps = {
    register: async (_session, space, notify): Promise<RegistrationOutcome> => {
      assert.deepEqual(
        authenticateSpaceWebhook(space, notify.token),
        { kind: "operator" },
        "placeholder token must be staged in SQLite BEFORE authorizeSpaceSync runs so synchronous confirmRegistration succeeds",
      );
      notifyCalls.push({ space, notify });
      const fail = failing.get(space);
      if (fail) throw fail();
      registered.push(space);
      const rev = spaceRevs.get(space);
      return {
        expiresAt: clock.now + ttlMs,
        ttlMs,
        ...(rev !== undefined ? { spaceRev: rev } : {}),
      };
    },
    confirmSpaceDeleted: async () => {
      if (typeof confirmDeletedResult === "function") return confirmDeletedResult();
      return confirmDeletedResult;
    },
    now: () => clock.now,
    workspaces: () => [{ authorityDid: groupDid, uri: wsUri }],
    grant: async () => {
      grantCalls += 1;
      return session;
    },
    activeSpaces: async () => [WORKSPACE, INBOX, GENERAL],
  };

  return {
    deps,
    clock,
    registered,
    notifyCalls,
    failing,
    spaceRevs,
    get grantCalls() {
      return grantCalls;
    },
    resetGrantCalls() {
      grantCalls = 0;
    },
    setConfirmDeleted(value: boolean | (() => Promise<boolean>)) {
      confirmDeletedResult = value;
    },
  };
}

test("registerSpace stages placeholder token before authorizeSpaceSync, persists renew_at, and reuses the exact same token across renewals", async () => {
  const { deps, clock, notifyCalls } = authority();
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);

  const first = registrationRow(GENERAL)!;
  assert.equal(first.expires_at, clock.now + TEN_MIN);
  assert.equal(first.renew_at, clock.now + TEN_MIN - computeRenewWithinMs(TEN_MIN));
  assert.equal(first.renew_at, clock.now + 7 * 60_000, "10-minute TTL renews 3 minutes before expiry");
  assert.ok(first.token.length >= 43, "32-byte base64url random token");
  assert.equal(notifyCalls[0]?.notify.endpoint, "http://localhost:3001");

  const shortAuth = authority(clock.now + 8 * 60_000, 60_000);
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, shortAuth.deps), true);
  const second = registrationRow(GENERAL)!;
  assert.equal(second.token, first.token, "exact same token reused on renewal — zero token rotation");
  assert.equal(second.renew_at, second.expires_at - 18_000, "30% renew margin for short 60s TTL");
  assert.equal(shortAuth.notifyCalls[0]?.notify.token, first.token);
});

test("a completed operation registers created spaces; transient or 401 AccountTakedown failure retains staged token and backs off 15s -> 30s -> 60s -> 120s", async () => {
  const { deps, clock, failing, notifyCalls } = authority();
  failing.set(GENERAL, () => Object.assign(new Error("host text that must not be stored"), { name: "XRPCError", status: 503 }));

  await afterOperation(actor, { createsSpaces: () => [WORKSPACE, INBOX, GENERAL] }, { kind: "bootstrapWorkspace" }, { state: "completed" }, deps);
  assert.ok(expiry(WORKSPACE)! > 0 && expiry(INBOX)! > 0);
  assert.equal(expiry(GENERAL), 0, "staged placeholder row remains at expires_at = 0 while retrying");
  const stagedToken = registrationRow(GENERAL)!.token;
  assert.ok(stagedToken.length > 0);

  const [firstProblem] = registrationProblems(WORKSPACE, deps.now());
  assert.deepEqual([firstProblem!.space, firstProblem!.failures, firstProblem!.error], [GENERAL, 1, "XRPCError 503"]);
  assert.equal(firstProblem!.expiredAt, undefined, "staged expires_at=0 placeholder is not reported as lapsed");
  assert.equal(Date.parse(firstProblem!.nextAttemptAt!) - clock.now, FIRST_RETRY_MS);

  failing.set(GENERAL, () => new XrpcError(401, "Account is takendown", "AccountTakedown"));
  const backoffs: number[] = [FIRST_RETRY_MS];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await registerSpace(session, WORKSPACE, GENERAL, deps);
    backoffs.push(Date.parse(registrationProblems(WORKSPACE, clock.now)[0]!.nextAttemptAt!) - clock.now);
  }
  assert.deepEqual(backoffs, [15_000, 30_000, 60_000, 120_000, LONGEST_RETRY_MS]);
  assert.equal(registrationRow(GENERAL)?.token, stagedToken, "staged token is retained across AccountTakedown failures");

  failing.delete(GENERAL);
  clock.now += LONGEST_RETRY_MS;
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);
  assert.equal(notifyCalls.at(-1)?.notify.token, stagedToken);
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
});

test("SpaceDeleted during initial staging deletes the placeholder row; SpaceDeleted on an existing space purges its state", async () => {
  const { deps, failing } = authority();
  failing.set(GENERAL, () => new SpaceCredentialError("Space was deleted", 410, "SpaceDeleted"));
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), false);
  assert.equal(registrationRow(GENERAL), undefined, "placeholder row deleted on initial SpaceDeleted");
  assert.deepEqual(registrationProblems(WORKSPACE, deps.now()), []);

  assert.equal(await registerSpace(session, WORKSPACE, RANDOM, deps), true);
  recordWriteNotification({ space: RANDOM, repo: plcDid("writer"), repoRev: "3kabcdefghij2" });
  failing.set(RANDOM, () => new SpaceCredentialError("Space was deleted", 410, "SpaceDeleted"));
  assert.equal(await registerSpace(session, WORKSPACE, RANDOM, deps), false);
  assert.equal(registrationRow(RANDOM), undefined);
  assert.equal(isRegisteredSpace(RANDOM), false);
});

test("authorizeSpaceSync.spaceRev gap catch-up emits a space_notification wake only when spaceRev advances", async () => {
  const { deps, spaceRevs } = authority();
  spaceRevs.set(GENERAL, "3kabcdefghij2");
  const startHead = readNotices([]).head;

  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);
  assert.equal(registrationRow(GENERAL)?.last_space_rev, "3kabcdefghij2");
  const afterInitHead = readNotices([]).head;
  assert.equal(afterInitHead, startHead + 1);

  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);
  assert.equal(readNotices([]).head, afterInitHead, "unchanged spaceRev emits no duplicate wake");

  spaceRevs.set(GENERAL, "3kabcdefghij5");
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);
  assert.equal(registrationRow(GENERAL)?.last_space_rev, "3kabcdefghij5");
  assert.equal(readNotices([{ space: GENERAL, after: afterInitHead }]).changed.length, 1);
});

test("an operation that did not complete registers nothing, and an archived channel drops its registration, notices, and webhook acceptance", async () => {
  const { deps, registered } = authority(Date.now());
  await afterOperation(actor, { createsSpaces: () => [GENERAL] }, { kind: "createChannel" }, { state: "pending" }, deps);
  assert.deepEqual(registered, []);

  await registerSpace(session, WORKSPACE, RANDOM, deps);
  const token = registrationRow(RANDOM)!.token;
  recordWriteNotification({ space: RANDOM, repo: plcDid("writer"), repoRev: "3kabcdefghij2" });
  assert.deepEqual(authenticateSpaceWebhook(RANDOM, token), { kind: "operator" });

  await afterOperation(actor, { archivesSpaces: () => [RANDOM] }, { kind: "archiveChannel" }, { state: "completed" }, deps);
  assert.throws(() => authenticateSpaceWebhook(RANDOM, token));
  assert.equal(registrationRow(RANDOM), undefined);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM space_notification WHERE space_uri=?").get(RANDOM) as { count: number }).count, 0);
});

test("sweepDueRegistrations does zero grant restores and zero PDS calls when nothing is due, upgrades migrated token='' rows, and bounds concurrency to 4", async () => {
  const auth = authority();
  const { deps, clock, registered, resetGrantCalls } = auth;
  await registerSpace(session, WORKSPACE, WORKSPACE, deps);
  await registerSpace(session, WORKSPACE, INBOX, deps);
  await registerSpace(session, WORKSPACE, GENERAL, deps);
  registered.length = 0;
  resetGrantCalls();

  assert.deepEqual(await sweepDueRegistrations(deps), { registered: 0, failed: 0, skipped: [] });
  assert.equal(auth.grantCalls, 0);
  assert.deepEqual(registered, []);

  const legacyChannel = channelUri(GROUP, "legacy");
  getRawDb()
    .prepare("INSERT INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at) VALUES (?, ?, 0, ?, '', 0)")
    .run(SERVICE_REF, legacyChannel, WORKSPACE);
  assert.deepEqual(await sweepDueRegistrations(deps), { registered: 1, failed: 0, skipped: [] });
  assert.deepEqual(registered, [legacyChannel]);
  assert.ok(registrationRow(legacyChannel)!.token.length > 0);
  assert.equal(auth.grantCalls, 1, "restores authority grant once for the authority");

  let inFlight = 0;
  let maxInFlight = 0;
  const manySpaces = Array.from({ length: 10 }, (_, idx) => channelUri(GROUP, `c${idx}`));
  for (const sp of manySpaces) {
    getRawDb()
      .prepare("INSERT INTO notification_registration (service_ref, space_uri, expires_at, workspace_uri, token, renew_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(SERVICE_REF, sp, clock.now + 30_000, WORKSPACE, `tok-${sp}`, clock.now - 1);
  }
  resetGrantCalls();
  const baseRegister = deps.register;
  deps.register = async (sess, sp, notify) => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await baseRegister(sess, sp, notify);
    } finally {
      inFlight -= 1;
    }
  };
  const [firstSweep, overlappingSweep] = await Promise.all([
    sweepDueRegistrations(deps),
    sweepDueRegistrations(deps),
  ]);
  assert.equal(overlappingSweep, null);
  assert.equal(firstSweep?.registered, 10);
  assert.equal(auth.grantCalls, 1);
  assert.ok(maxInFlight <= 4, `expected concurrency <= 4, saw ${maxInFlight}`);
});

test("handleRegistrationExpiredNotice marks renew_at=0, emits wake, and renews asynchronously with the same token", async () => {
  const { deps, clock, notifyCalls } = authority();
  await registerSpace(session, WORKSPACE, GENERAL, deps);
  const originalToken = registrationRow(GENERAL)!.token;
  notifyCalls.length = 0;

  clock.now += 20 * 60_000;
  const beforeHead = readNotices([]).head;
  handleRegistrationExpiredNotice(GENERAL, "3kabcdefghij7", deps);
  await flushPendingRenewals();

  assert.equal(readNotices([]).head, beforeHead + 1, "emits wake row for the write that triggered expiry");
  const renewed = registrationRow(GENERAL)!;
  assert.equal(renewed.token, originalToken, "renews using the exact same token");
  assert.equal(renewed.last_space_rev, "3kabcdefghij7");
  assert.equal(renewed.expires_at, clock.now + TEN_MIN);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0]?.notify.token, originalToken);
});

test("handleSpaceDeletedNotice refuses to purge unless authority authorizeSpaceSync confirms SpaceDeleted", async () => {
  const { deps, setConfirmDeleted } = authority();
  const memberDid = plcDid("memberreg");
  await registerSpace(session, WORKSPACE, GENERAL, deps);
  recordWriteNotification({ space: GENERAL, repo: GROUP, repoRev: "3kabcdefghij2" });
  const access: MemberAccessDeps = {
    isRegistered: isRegisteredSpace,
    readMembers: async () => [{ did: memberDid, read: true, write: true }],
    now: () => 1_000,
  };
  assert.equal(await mayFollow(GENERAL, memberDid, access), true);

  setConfirmDeleted(false);
  assert.equal(await handleSpaceDeletedNotice(GENERAL, deps), false);
  assert.ok(registrationRow(GENERAL));

  for (const err of [
    new XrpcError(503, "Service unavailable", "ServiceUnavailable"),
    new XrpcError(400, "Repo takendown", "RepoTakendown"),
    new XrpcError(400, "Repo deactivated", "RepoDeactivated"),
  ]) {
    setConfirmDeleted(async () => {
      throw err;
    });
    assert.equal(await handleSpaceDeletedNotice(GENERAL, deps), false);
    assert.ok(registrationRow(GENERAL), `state kept on ${err.code}`);
  }
  const savedGrant = deps.grant;
  deps.grant = async () => {
    throw Object.assign(new Error("no grant"), { name: "AuthorityReauthorizationRequiredError" });
  };
  assert.equal(await handleSpaceDeletedNotice(GENERAL, deps), false);
  assert.ok(registrationRow(GENERAL));
  deps.grant = savedGrant;

  setConfirmDeleted(true);
  assert.equal(await handleSpaceDeletedNotice(GENERAL, deps), true);
  assert.equal(registrationRow(GENERAL), undefined);
  assert.equal(isRegisteredSpace(GENERAL), false);
  assert.equal((getRawDb().prepare("SELECT count(*) AS count FROM space_notification WHERE space_uri=?").get(GENERAL) as { count: number }).count, 0);
  assert.equal(await mayFollow(GENERAL, memberDid, access), false);
});

test("the discovery sweep registers missing or due spaces, leaves fresh ones, waits out failure backoff, and drops inactive spaces", async () => {
  const { deps, clock, registered, failing } = authority();
  await registerSpace(session, WORKSPACE, WORKSPACE, deps);
  clock.now += TEN_MIN - RENEW_WITHIN_MS + 1;
  await registerSpace(session, WORKSPACE, INBOX, deps);
  await registerSpace(session, WORKSPACE, RANDOM, deps);
  registered.length = 0;
  failing.set(GENERAL, () => new XrpcError(503, "outage", "ServiceUnavailable"));

  assert.deepEqual(await sweepRegistrations(deps), { registered: 1, failed: 1, skipped: [] });
  assert.deepEqual(registered, [WORKSPACE], "workspace was due; inbox was fresh; general failed; random dropped");
  assert.equal(registrationRow(RANDOM), undefined, "inactive channel registration dropped");

  failing.delete(GENERAL);
  clock.now += 31 * 60 * 1000;
  registered.length = 0;
  await sweepRegistrations(deps);
  assert.deepEqual(registered.sort(), [WORKSPACE, INBOX, GENERAL].sort());
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
});

test("two operator processes do not run discovery sweep at once, and discovery runs at most every thirty minutes", async () => {
  const { deps, clock } = authority();
  const results = await Promise.all([sweepRegistrations(deps), sweepRegistrations(deps)]);
  assert.equal(results.filter((result) => result === null).length, 1);
  clock.now += 29 * 60 * 1000;
  assert.equal(await sweepRegistrations(deps), null);
  clock.now += 2 * 60 * 1000;
  assert.notEqual(await sweepRegistrations(deps), null);
});

test("an idle workspace keeps its 10-minute registrations continuously alive via the 60s due-renewal loop with zero token rotations", async () => {
  const { deps, clock } = authority();
  await sweepRegistrations(deps);
  const initialTokens = new Map([WORKSPACE, INBOX, GENERAL].map((sp) => [sp, registrationRow(sp)!.token]));

  const start = clock.now;
  while (clock.now - start < 3 * 60 * 60 * 1000) {
    clock.now += 60_000;
    await sweepDueRegistrations(deps);
    for (const space of [WORKSPACE, INBOX, GENERAL]) {
      const row = registrationRow(space)!;
      assert.ok(row.expires_at > clock.now, `${space} remains unexpired at +${(clock.now - start) / 60_000} min`);
      assert.equal(row.token, initialTokens.get(space), `${space} reuses its initial token`);
    }
  }
});

test("a registration that ran out while the operator was down is reported meanwhile, and restored by the next sweep", async () => {
  const { deps, clock } = authority();
  await sweepRegistrations(deps);
  clock.now += 60 * 60 * 1000;
  assert.deepEqual(
    registrationProblems(WORKSPACE, clock.now).map((problem) => [problem.space, problem.failures, Boolean(problem.expiredAt)]).sort(),
    [[GENERAL, 0, true], [INBOX, 0, true], [WORKSPACE, 0, true]].sort(),
  );
  assert.deepEqual(await sweepDueRegistrations(deps), { registered: 3, failed: 0, skipped: [] });
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
});

test("a workspace whose authority grant is gone is skipped by both sweeps and reported", async () => {
  const { deps, registered } = authority();
  await registerSpace(session, WORKSPACE, GENERAL, deps);
  registered.length = 0;
  getRawDb().prepare("UPDATE notification_registration SET renew_at = 0 WHERE space_uri = ?").run(GENERAL);

  deps.grant = async () => {
    throw Object.assign(new Error("no grant"), { name: "AuthorityReauthorizationRequiredError" });
  };
  assert.deepEqual(await sweepDueRegistrations(deps), {
    registered: 0,
    failed: 0,
    skipped: [{ workspace: WORKSPACE, reason: "AuthorityReauthorizationRequiredError" }],
  });
  assert.deepEqual(await sweepRegistrations(deps), {
    registered: 0,
    failed: 0,
    skipped: [{ workspace: WORKSPACE, reason: "AuthorityReauthorizationRequiredError" }],
  });
  assert.deepEqual(registered, []);
});

test("registering does not wait on the workspace lock, and sweeps pause while admin mutations are paused", async () => {
  const { deps, registered } = authority(Date.now());
  getRawDb()
    .prepare("INSERT INTO workspace_lock (workspace, token, expires_at) VALUES (?, ?, ?)")
    .run(GROUP, "held-by-an-operation", Math.floor(Date.now() / 1000) + 600);
  const started = Date.now();
  assert.equal(await registerSpace(session, WORKSPACE, GENERAL, deps), true);
  assert.ok(Date.now() - started < 1_000);

  registered.length = 0;
  process.env.FLOCK_ADMIN_MUTATIONS_PAUSED = "true";
  try {
    assert.equal(await sweepDueRegistrations(deps), null);
    assert.equal(await sweepRegistrations(deps), null);
  } finally {
    delete process.env.FLOCK_ADMIN_MUTATIONS_PAUSED;
  }
  assert.deepEqual(registered, []);
});

test("a space registered while the discovery sweep reads the directory is not mistaken for one no longer active", async () => {
  const { deps } = authority();
  const created = channelUri(GROUP, "newch");
  deps.activeSpaces = async () => {
    await registerSpace(session, WORKSPACE, created, deps);
    return [WORKSPACE, INBOX, GENERAL];
  };
  await sweepRegistrations(deps);
  assert.ok(expiry(created)! > 0);
});

test("the feed knows a space the operator registered or failed to, for this operator's service only, and a deleted space's failure goes too", async () => {
  const { deps, failing } = authority(Date.now());
  await registerSpace(session, WORKSPACE, GENERAL, deps);
  failing.set(RANDOM, () => new XrpcError(503, "outage", "ServiceUnavailable"));
  await registerSpace(session, WORKSPACE, RANDOM, deps);
  getRawDb()
    .prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at,workspace_uri,token,renew_at) VALUES (?,?,?,?,?,0)")
    .run("did:web:previous.test#atproto_flock_operator", INBOX, Date.now() + TEN_MIN, WORKSPACE, "other-tok");
  assert.deepEqual([GENERAL, RANDOM, INBOX, WORKSPACE].map(isRegisteredSpace), [true, true, false, false]);
  purgeSpaceNotifications(RANDOM);
  assert.equal(isRegisteredSpace(RANDOM), false);
  assert.deepEqual(registrationProblems(WORKSPACE, deps.now()), []);
});

async function createOpenSocialSpace(host: Awaited<ReturnType<typeof fakeGroupHost>>, spaceType: string, skey: string) {
  await host.selfClient.procedure("com.atproto.space.createSpace", {
    spaceType,
    skey,
    policy: {
      $type: ATGRP_POLICY,
      publicRead: false,
      unlisted: spaceType === SPACE_TYPE.appInbox,
      grants: [{ role: "member", read: true, write: true }],
    },
  });
}

test("after reconcileWorkspace, present unregistered active inboxes are registered and only registered inactive inboxes are unregistered", async () => {
  const gDid = plcDid("groupapp1");
  const host = await fakeGroupHost(gDid, { creatorDid: ADMIN });
  const wsUri = workspaceUri(gDid);
  await createOpenSocialSpace(host, SPACE_TYPE.workspace, "self");
  await createOpenSocialSpace(host, SPACE_TYPE.inbox, "self");
  await createOpenSocialSpace(host, SPACE_TYPE.channel, "general");

  const wsActor: OperatorActor = {
    did: ADMIN,
    session: host.session,
    workspace: parseWorkspaceRef(wsUri),
    canRecoverOperations: true,
  };
  const activeNew = plcDid("botnew");
  const activeAlready = plcDid("botalready");
  const activeMissing = plcDid("botmissing");
  const inactiveRegistered = plcDid("botgonereg");
  const inactiveUnregistered = plcDid("botgoneunreg");
  const nowIso = "2026-11-15T00:00:00.000Z";
  for (const [did, active] of [
    [activeNew, true],
    [activeAlready, true],
    [activeMissing, true],
    [inactiveRegistered, false],
    [inactiveUnregistered, false],
  ] as const) {
    await host.putRecord(wsUri, COLLECTION.appInstall, subjectKey(did), {
      subject: did,
      active,
      channels: [],
      installedBy: ADMIN,
      installedAt: nowIso,
      updatedAt: nowIso,
    });
  }
  const inboxNew = appInboxUri(gDid, "self", activeNew);
  const inboxAlready = appInboxUri(gDid, "self", activeAlready);
  const inboxGoneReg = appInboxUri(gDid, "self", inactiveRegistered);
  const inboxGoneUnreg = appInboxUri(gDid, "self", inactiveUnregistered);
  for (const uri of [inboxNew, inboxAlready, inboxGoneReg, inboxGoneUnreg]) {
    await createOpenSocialSpace(host, SPACE_TYPE.appInbox, uri.split("/").at(-1)!);
  }

  const { deps, registered } = authority(Date.now(), TEN_MIN, gDid, wsUri);
  await registerSpace(host.session, wsUri, inboxAlready, deps);
  await registerSpace(host.session, wsUri, inboxGoneReg, deps);
  registered.length = 0;

  await afterOperation(wsActor, {}, { kind: "reconcileWorkspace" }, { state: "completed" }, deps);
  assert.deepEqual(registered, [inboxNew]);
  assert.equal(isRegisteredSpace(inboxNew), true);
  assert.equal(isRegisteredSpace(inboxGoneReg), false);
});

test("the sweep keeps active present inboxes, drops inactive ones, raises no failure for missing ones, and renews core + modality spaces under an old grant", async () => {
  const gDid = plcDid("groupapp2");
  let rejectAppInboxScope = false;
  const host = await fakeGroupHost(gDid, {
    creatorDid: ADMIN,
    intercept: (method, target) =>
      rejectAppInboxScope && method === "com.atproto.space.getSpace" && target.space?.includes("/new.flock.app.inbox/")
        ? Response.json({ error: "ScopeMissingError", message: "missing scope" }, { status: 403 })
        : undefined,
  });
  const wsUri = workspaceUri(gDid);
  const inUri = inboxUri(gDid);
  const genUri = channelUri(gDid, "general");
  const metaUri = groupMetaUri(gDid);
  const memUri = groupMembersUri(gDid);
  await createOpenSocialSpace(host, SPACE_TYPE.workspace, "self");
  await createOpenSocialSpace(host, SPACE_TYPE.inbox, "self");
  await createOpenSocialSpace(host, SPACE_TYPE.channel, "general");
  await host.putRecord(wsUri, COLLECTION.directory, "general", {
    skey: "general",
    name: "general",
    visibility: "public",
  });

  const nowIso = "2026-11-15T00:00:00.000Z";
  const botPresent = plcDid("botpresent");
  const botMissing = plcDid("botmissing2");
  const botInactive = plcDid("botinactive");
  for (const [did, active] of [[botPresent, true], [botMissing, true], [botInactive, false]] as const) {
    await host.putRecord(wsUri, COLLECTION.appInstall, subjectKey(did), {
      subject: did,
      active,
      channels: [],
      installedBy: ADMIN,
      installedAt: nowIso,
      updatedAt: nowIso,
    });
  }
  const inboxPresent = appInboxUri(gDid, "self", botPresent);
  const inboxMissing = appInboxUri(gDid, "self", botMissing);
  const inboxInactive = appInboxUri(gDid, "self", botInactive);
  await createOpenSocialSpace(host, SPACE_TYPE.appInbox, inboxPresent.split("/").at(-1)!);
  await createOpenSocialSpace(host, SPACE_TYPE.appInbox, inboxInactive.split("/").at(-1)!);

  const { deps, clock, registered } = authority(Date.UTC(2026, 10, 10), TEN_MIN, gDid, wsUri);
  deps.grant = async () => host.session;
  deps.activeSpaces = registrationDeps.activeSpaces;
  await registerSpace(host.session, wsUri, inboxInactive, deps);
  registered.length = 0;

  assert.deepEqual(await sweepRegistrations(deps), { registered: 6, failed: 0, skipped: [] });
  assert.deepEqual(registered.sort(), [metaUri, memUri, wsUri, inUri, genUri, inboxPresent].sort());
  assert.equal(registered.includes(inboxMissing), false);
  assert.equal(isRegisteredSpace(inboxInactive), false);
  assert.deepEqual(registrationProblems(wsUri, clock.now), []);

  rejectAppInboxScope = true;
  clock.now += 31 * 60 * 1000;
  registered.length = 0;
  assert.deepEqual(await sweepRegistrations(deps), { registered: 5, failed: 0, skipped: [] });
  assert.deepEqual(registered.sort(), [metaUri, memUri, wsUri, inUri, genUri].sort());
});

test("reconcileWorkspace and sweep manage extension space registrations and tolerate ScopeMissingError during background sweep", async () => {
  const gDid = plcDid("groupext1");
  const tasksSpace = tasksSpaceUri(gDid, "self");
  let rejectTasksScope = false;
  const host = await fakeGroupHost(gDid, {
    creatorDid: ADMIN,
    intercept: (method, target) =>
      rejectTasksScope && method === "com.atproto.space.getSpace" && target.spaceType === "new.flock.ext.tasks"
        ? Response.json({ error: "ScopeMissingError", message: "missing tasks scope" }, { status: 403 })
        : undefined,
  });
  const wsUri = workspaceUri(gDid);
  const inUri = inboxUri(gDid);
  const genUri = channelUri(gDid, "general");
  const metaUri = groupMetaUri(gDid);
  const memUri = groupMembersUri(gDid);
  await createOpenSocialSpace(host, SPACE_TYPE.workspace, "self");
  await createOpenSocialSpace(host, SPACE_TYPE.inbox, "self");
  await createOpenSocialSpace(host, SPACE_TYPE.channel, "general");
  await createOpenSocialSpace(host, SPACE_TYPE.tasks, tasksSpace.split("/").at(-1)!);
  await host.putRecord(wsUri, COLLECTION.directory, "general", {
    skey: "general",
    name: "general",
    visibility: "public",
  });

  const wsActor: OperatorActor = {
    did: ADMIN,
    session: host.session,
    workspace: parseWorkspaceRef(wsUri),
    canRecoverOperations: true,
  };
  const nowIso = "2026-11-16T00:00:00.000Z";
  await host.putRecord(wsUri, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: true,
    space: tasksSpace,
    cleanupComplete: false,
    enabledBy: ADMIN,
    enabledAt: nowIso,
    updatedAt: nowIso,
  });

  const { deps, clock, registered } = authority(Date.UTC(2026, 10, 10), TEN_MIN, gDid, wsUri);
  deps.grant = async () => host.session;
  deps.activeSpaces = registrationDeps.activeSpaces;

  await afterOperation(wsActor, {}, { kind: "reconcileWorkspace" }, { state: "completed" }, deps);
  assert.deepEqual(registered, [tasksSpace]);
  assert.equal(isRegisteredSpace(tasksSpace), true);

  registered.length = 0;
  clock.now += 31 * 60 * 1000;
  assert.deepEqual(await sweepRegistrations(deps), { registered: 6, failed: 0, skipped: [] });
  assert.deepEqual(registered.sort(), [metaUri, memUri, wsUri, inUri, genUri, tasksSpace].sort());

  rejectTasksScope = true;
  clock.now += 31 * 60 * 1000;
  registered.length = 0;
  assert.deepEqual(await sweepRegistrations(deps), { registered: 5, failed: 0, skipped: [] });
  assert.deepEqual(registered.sort(), [metaUri, memUri, wsUri, inUri, genUri].sort());

  rejectTasksScope = false;
  await host.putRecord(wsUri, COLLECTION.extInstall, "tasks", {
    extId: "tasks",
    active: false,
    space: tasksSpace,
    cleanupComplete: true,
    enabledBy: ADMIN,
    enabledAt: nowIso,
    updatedAt: nowIso,
    disabledAt: nowIso,
  });
  await afterOperation(wsActor, {}, { kind: "reconcileWorkspace" }, { state: "completed" }, deps);
  assert.equal(isRegisteredSpace(tasksSpace), false);
});

test("sweepDueRegistrations stops after 1 suspended request for an authority, bulk-backs off all due rows in one transaction, and recovers after backoff", async () => {
  const { deps, clock, notifyCalls } = authority();
  const spaces = Array.from({ length: 12 }, (_, idx) => channelUri(GROUP, `susp-ch-${idx}`)).sort();
  for (const sp of spaces) {
    assert.equal(await registerSpace(session, WORKSPACE, sp, deps), true);
  }
  notifyCalls.length = 0;
  resetAuthoritySuspensionForTests();

  clock.now += TEN_MIN - RENEW_WITHIN_MS + 1_000;
  let suspended = true;
  const origRegister = deps.register;
  deps.register = async (sess, sp, notify) => {
    if (suspended) {
      notifyCalls.push({ space: sp, notify });
      throw new XrpcError(401, "Account is takendown", "AccountTakedown");
    }
    return origRegister(sess, sp, notify);
  };

  const firstReport = await sweepDueRegistrations(deps);
  assert.deepEqual(firstReport, { registered: 0, failed: 12, skipped: [] });
  assert.equal(notifyCalls.length, 1, `expected strictly 1 PDS call across 12 due spaces, saw ${notifyCalls.length}`);

  const failureRows = getRawDb()
    .prepare("SELECT space_uri, failures, next_attempt_at FROM notification_registration_failure ORDER BY space_uri")
    .all() as Array<{ space_uri: string; failures: number; next_attempt_at: number }>;
  assert.equal(failureRows.length, 12, "all 12 due rows of the authority are bulk-backed-off");
  for (const row of failureRows) {
    assert.equal(row.failures, 1);
    assert.equal(row.next_attempt_at, clock.now + FIRST_RETRY_MS);
  }

  clock.now += 5_000;
  assert.deepEqual(await sweepDueRegistrations(deps), { registered: 0, failed: 0, skipped: [] });
  assert.equal(notifyCalls.length, 1);

  clock.now += AUTHORITY_SUSPENDED_BACKOFF_MS;
  assert.deepEqual(await sweepDueRegistrations(deps), { registered: 0, failed: 12, skipped: [] });
  assert.equal(notifyCalls.length, 2, "still-suspended release makes only 1 probe call");

  suspended = false;
  clock.now += 30_000;
  const recoveredReport = await sweepDueRegistrations(deps);
  assert.deepEqual(recoveredReport, { registered: 12, failed: 0, skipped: [] });
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
});

test("two operator processes racing initial registerSpace claim and confirm the exact same winning token", async () => {
  const raceSpace = channelUri(GROUP, "cross-process-race");
  const registrationsPath = fileURLToPath(new URL("./registrations.ts", import.meta.url));
  const helperPath = fileURLToPath(new URL("./testing/fake-group-session.ts", import.meta.url));

  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let markParentClaimed!: () => void;
  const parentClaimed = new Promise<void>((resolve) => {
    markParentClaimed = resolve;
  });

  const parentSeenTokens: string[] = [];
  const parentDeps = authority().deps;
  const baseRegister = parentDeps.register;
  parentDeps.register = async (sess, sp, notify) => {
    parentSeenTokens.push(notify.token);
    markParentClaimed();
    await parentGate;
    return baseRegister(sess, sp, notify);
  };

  const parentPromise = registerSpace(session, WORKSPACE, raceSpace, parentDeps);
  await parentClaimed;

  const childToken = await new Promise<string>((resolve, reject) => {
    const script = `
      import { registerSpace } from ${JSON.stringify(registrationsPath)};
      import { fakeGroupHost, plcDid } from ${JSON.stringify(helperPath)};
      import { closeDb } from ${JSON.stringify(fileURLToPath(new URL("../lib/db.ts", import.meta.url)))};
      const { session } = await fakeGroupHost(${JSON.stringify(GROUP)}, { creatorDid: plcDid("adminreg") });
      let observed = "";
      const ok = await registerSpace(session, ${JSON.stringify(WORKSPACE)}, ${JSON.stringify(raceSpace)}, {
        now: () => Date.now(),
        register: async (_s, _sp, notify) => {
          observed = notify.token;
          return { expiresAt: Date.now() + 600_000, ttlMs: 600_000 };
        },
      });
      closeDb();
      if (!ok) process.exit(2);
      process.stdout.write(observed);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Child registerSpace exited ${code}: ${stderr}`));
    });
  });

  releaseParent();
  assert.equal(await parentPromise, true);

  const stored = registrationRow(raceSpace);
  assert.ok(stored && stored.token.length >= 43);
  assert.equal(parentSeenTokens[0], childToken, "both racing processes observe and confirm the exact same winning token");
  assert.equal(stored.token, parentSeenTokens[0]);
});

test("in-flight renewal awaiting a deferred grant or PDS authorizeSpaceSync while unregisterSpace archives does NOT recreate the purged row or failure state", async () => {
  for (const grantOutcome of ["resolve", "reject"] as const) {
    const { deps } = authority();
    const targetSpace = channelUri(GROUP, `archive-race-grant-${grantOutcome}`);
    assert.equal(await registerSpace(session, WORKSPACE, targetSpace, deps), true);
    assert.ok(registrationRow(targetSpace));

    let finishGrant!: () => void;
    const grantGate = new Promise<void>((resolve) => {
      finishGrant = resolve;
    });
    let grantEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      grantEntered = resolve;
    });

    deps.grant = async () => {
      grantEntered();
      await grantGate;
      if (grantOutcome === "reject") {
        throw new XrpcError(503, "Service unavailable", "ServiceUnavailable");
      }
      return session;
    };

    const renewing = renewSpaceRegistration(targetSpace, deps);
    await entered;

    await unregisterSpace(session, targetSpace);
    assert.equal(registrationRow(targetSpace), undefined);

    finishGrant();
    assert.equal(await renewing, false, `cancelled renewal (${grantOutcome}) returns false`);
    assert.equal(registrationRow(targetSpace), undefined, `purged registration row NOT recreated (${grantOutcome})`);
    assert.equal(
      getRawDb().prepare("SELECT 1 FROM notification_registration_failure WHERE space_uri = ?").get(targetSpace),
      undefined,
      `purged failure row NOT recreated (${grantOutcome})`,
    );
  }

  for (const pdsOutcome of ["resolve", "reject"] as const) {
    const { deps } = authority();
    const targetSpace = channelUri(GROUP, `archive-race-pds-${pdsOutcome}`);
    assert.equal(await registerSpace(session, WORKSPACE, targetSpace, deps), true);
    const beforeHead = readNotices([]).head;

    let finishPds!: () => void;
    const pdsGate = new Promise<void>((resolve) => {
      finishPds = resolve;
    });
    let pdsEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      pdsEntered = resolve;
    });

    const baseRegister = deps.register;
    deps.register = async (sess, sp, notify) => {
      pdsEntered();
      await pdsGate;
      if (pdsOutcome === "reject") {
        throw new XrpcError(503, "PDS error", "ServiceUnavailable");
      }
      const res = await baseRegister(sess, sp, notify);
      return typeof res === "number" ? { expiresAt: res, spaceRev: "3kzzzzzzzzzz7" } : { ...res, spaceRev: "3kzzzzzzzzzz7" };
    };

    const renewing = renewSpaceRegistration(targetSpace, deps);
    await entered;

    purgeSpaceNotifications(targetSpace);
    assert.equal(registrationRow(targetSpace), undefined);

    finishPds();
    assert.equal(await renewing, false, `post-await CAS detects archive cancellation (${pdsOutcome})`);
    assert.equal(registrationRow(targetSpace), undefined, `purged row NOT recreated (${pdsOutcome})`);
    assert.equal(
      getRawDb().prepare("SELECT 1 FROM notification_registration_failure WHERE space_uri = ?").get(targetSpace),
      undefined,
      `failure row NOT written for archived space (${pdsOutcome})`,
    );
    assert.equal(readNotices([]).head, beforeHead, "cancelled renewal emits zero wake notices");
  }
});

test("refreshWorkspaceRegistrations clears authority suspension, bypasses failure backoff timers across all active spaces, and drops removed spaces", async () => {
  const { deps, clock } = authority();
  const general = channelUri(GROUP, "general");
  const archived = channelUri(GROUP, "archived-old");
  const activeSpaces = [META, MEMBERS, WORKSPACE, INBOX, general];
  deps.activeSpaces = async () => activeSpaces;

  // Seed backed-off failure rows (next_attempt_at far in the future) + a stale registration on `archived`
  assert.equal(await registerSpace(session, WORKSPACE, archived, deps), true);
  let failAll = true;
  const baseRegister = deps.register;
  deps.register = async (sess, sp, notify) => {
    if (failAll) {
      throw new XrpcError(401, "Authority deactivated", "AccountDeactivated");
    }
    return baseRegister(sess, sp, notify);
  };
  for (const sp of activeSpaces) {
    assert.equal(await registerSpace(session, WORKSPACE, sp, deps), false);
  }
  // Normal `isDue` / `sweepRegistrations` is still within `FIRST_RETRY_MS` / `AUTHORITY_SUSPENDED_BACKOFF_MS` backoff!
  assert.equal(registrationProblems(WORKSPACE, clock.now).length, activeSpaces.length);

  // `refreshWorkspaceRegistrations` clears cached suspension and unconditionally refreshes every active space immediately!
  failAll = false;
  const refreshed = await refreshWorkspaceRegistrations(session, WORKSPACE, deps);
  assert.deepEqual(refreshed, { registered: activeSpaces.length, failed: 0 });
  assert.deepEqual(registrationProblems(WORKSPACE, clock.now), []);
  for (const sp of activeSpaces) {
    assert.equal(isRegisteredSpace(sp), true, `${sp} must be registered immediately`);
  }
  assert.equal(isRegisteredSpace(archived), false, "removed/archived space registration dropped");
});

void META;
void MEMBERS;
