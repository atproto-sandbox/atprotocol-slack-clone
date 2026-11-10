import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acceptedTimestamps, loadSlurFilter } from "./support/accepted-tid";
import test from "node:test";
import { createFixtureTempRoot } from "./fixture-temp";

type TestAgent = {
  com: { atproto: {
    server: {
      createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
      createSession(input: Record<string, unknown>): Promise<{ data: { accessJwt: string } }>;
    };
    repo: {
      createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown>;
    };
    space: { applyWrites(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<{ data: { results?: unknown[] } }> };
  } };
};
type DidResolver = { resolve(did: string, ...args: unknown[]): Promise<unknown> };
type TestPds = {
  url: string;
  getAgent(): TestAgent;
  ctx: { idResolver: { did: DidResolver } };
};
type TestNetwork = { plc: { url: string }; pds: TestPds; extraPdses: TestPds[]; lexiconAuthority?: { did: string }; close(): Promise<void> };
type Actor = { did: string; accessJwt: string; pds: TestPds };
type Session = { did: string; fetchHandler(path: string, init: RequestInit): Promise<Response> };

const PINNED_CHECKOUT = process.env.ATPROTO_PINNED_CHECKOUT;
const MEMBERS = 200;
const CHANNELS = 100;
const MESSAGES = 20_000;
const REACTIONS = 20_000;
const READ_RUNS = 10;

test("supported-size workload: 200 members, 100 channels, 20,000 messages and reactions per channel", { timeout: 60 * 60 * 1000 }, async () => {
  const fixtureTemp = createFixtureTempRoot("slack-performance-fixture-");
  let network: TestNetwork | undefined;
  let fixtureCleaned = false;
  const cleanupFixture = async () => {
    if (fixtureCleaned) return;
    fixtureCleaned = true;
    try {
      await network?.close();
    } finally {
      fixtureTemp.cleanup();
    }
  };
  const onSigint = () => {
    void cleanupFixture().finally(() => process.exit(130)).catch(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);

  try {
    assert.ok(PINNED_CHECKOUT, "set ATPROTO_PINNED_CHECKOUT to the pinned atproto checkout");
    const { TestNetworkNoAppView } = await import(pathToFileURL(join(PINNED_CHECKOUT, "packages/dev-env/src/index.ts")).href) as {
      TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean; pds?: { rateLimitsEnabled?: boolean } }): Promise<TestNetwork> };
    };
    network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true, pds: { rateLimitsEnabled: false } });
    process.stdout.write("PERFORMANCE_PROGRESS two-PDS fixture ready\n");
    const directory = mkdtempSync(join(fixtureTemp.path, "slack-performance-"));
    process.env.NODE_ENV = "test";
    process.env.APP_URL = "http://127.0.0.1:3000";
    process.env.AUTH_ENCRYPTION_KEY = "4b".repeat(32);
    process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
    process.env.PLC_URL = network.plc.url;
    process.env.DATABASE_PATH = join(directory, "app.db");

    try {
      await publishAppLexicons(network);
      const [{ bootstrapWorkspace }, { ensureMemberListSpace, listSpaceMembers, putAuthorityRecord, putSpaceMember }, { executeOperatorOperation, listInboxWriters }, { mintSpaceCredential, sessionCredentialDeps }, { readIndependentChannelPage }, { inboxUri, reactionRecordKey, requestRecordKey, spaceRecordUri, subjectKey, tidNow }, { readChannelPage }, { parseWorkspaceRef }, { getRawDb }, { resolvePds }, { createEngine }] = await Promise.all([
        import("@/operator/kinds/bootstrap-workspace"), import("@/atproto/space-ops"), import("@/operator/operations"), import("@/atproto/space-credential"), import("@/reader/independent"), import("@/protocol/keys"), import("@/workspaces/channel-sync"), import("@/operator/actor"), import("@/lib/db"), import("@/atproto/identity"),
        import("@/client/engine"),
      ]);
      const owner = await createActor(network.pds, "scaleowner", "test");
      const ownerSession = sessionFor(owner);
      const bootstrap = await bootstrapWorkspace(ownerSession as never, { name: "Scale Workspace", operationId: tidNow() });
      assert.equal(bootstrap.state, "completed");
      const registration = getRawDb().prepare("INSERT INTO notification_registration (service_ref,space_uri,expires_at) VALUES (?,?,?)");
      for (const space of [bootstrap.workspace, bootstrap.channel]) {
        registration.run(process.env.OPERATOR_SERVICE_REF!, space, Date.now() + 2 * 60 * 60 * 1000);
      }
      const workspaceSkey = bootstrap.workspace.split("/").at(-1)!;
      const inbox = inboxUri(owner.did, workspaceSkey);
      const channels = [bootstrap.channel];
      for (let index = 1; index < CHANNELS - 1; index += 1) {
        const skey = `${workspaceSkey}-scale-${String(index).padStart(3, "0")}`;
        const uri = await ensureMemberListSpace(ownerSession as never, "new.flock.channel", skey);
        await putAuthorityRecord(ownerSession as never, bootstrap.workspace, "new.flock.directory", skey, {
          skey, name: `scale-${String(index).padStart(3, "0")}`, visibility: index === CHANNELS - 2 ? "private" : "public",
        });
        channels.push(uri);
      }

      const accountStartedAt = performance.now();
      const members = await mapLimited(Array.from({ length: MEMBERS - 1 }, (_, index) => index), 8, async (index) => {
        const extra = index % 2 === 0;
        return createActor(extra ? network.extraPdses[0] : network.pds, `scale${String(index).padStart(3, "0")}`, extra ? "test2" : "test");
      });
      const accountMs = elapsed(accountStartedAt);
      process.stdout.write(`PERFORMANCE_PROGRESS accounts=${MEMBERS} elapsedMs=${accountMs}\n`);
      const rosterStartedAt = performance.now();
      const privateChannel = channels.at(-1)!;
      const seededMembers = members.slice(0, -1);
      const inviteTarget = members.at(-1)!;
      const memberTasks: Array<() => Promise<void>> = [];
      for (const member of seededMembers) {
        memberTasks.push(() => putSpaceMember(ownerSession as never, bootstrap.workspace, member.did, true, true));
        memberTasks.push(() => putSpaceMember(ownerSession as never, inbox, member.did, false, true));
        for (const channel of channels.filter((uri) => uri !== privateChannel)) memberTasks.push(() => putSpaceMember(ownerSession as never, channel, member.did, true, true));
      }
      for (const member of seededMembers.slice(0, MEMBERS - 2)) {
        memberTasks.push(() => putSpaceMember(ownerSession as never, privateChannel, member.did, true, true));
      }
      await mapLimited(memberTasks, 8, (task) => task());
      await mapLimited(seededMembers, 8, (member) => putAuthorityRecord(ownerSession as never, bootstrap.workspace, "new.flock.workspace.roster", subjectKey(member.did), {
        subject: member.did, active: true, updatedAt: new Date().toISOString(),
      }).then(() => undefined));
      const membershipSetupMs = elapsed(rosterStartedAt);
      process.stdout.write(`PERFORMANCE_PROGRESS memberAndRosterSetup elapsedMs=${membershipSetupMs}\n`);
      await mapLimited(seededMembers.slice(0, MEMBERS - 2), 8, (member) => putAuthorityRecord(ownerSession as never, privateChannel, "new.flock.channel.roster", subjectKey(member.did), {
        subject: member.did, active: true, updatedAt: new Date().toISOString(),
      }).then(() => undefined));
      const privateSkey = privateChannel.split("/").at(-1)!;
      await putAuthorityRecord(ownerSession as never, bootstrap.workspace, "new.flock.admin", subjectKey(members[0].did), {
        subject: members[0].did, active: true, updatedAt: new Date().toISOString(),
      });
      await putSpaceMember(ownerSession as never, inbox, members[0].did, true, true);
      const journaledInviteStartedAt = performance.now();
      const inviteOperation = await executeOperatorOperation({
        did: owner.did,
        session: ownerSession as never,
        workspace: parseWorkspaceRef(bootstrap.workspace),
        canRecoverOperations: true,
      } as never, tidNow(), { kind: "inviteMember", subject: inviteTarget.did });
      const journaledInviteMs = elapsed(journaledInviteStartedAt);
      assert.equal(inviteOperation.state, "completed");
      assert.ok(inviteOperation.completedSteps.some((step: string) => step.startsWith("member-public-channel-")));
      assert.equal((await listSpaceMembers(ownerSession as never, bootstrap.workspace)).length, MEMBERS - 1);

      const channelCreateStartedAt = performance.now();
      const channelCreateOperation = await executeOperatorOperation({
        did: owner.did,
        session: ownerSession as never,
        workspace: parseWorkspaceRef(bootstrap.workspace),
        canRecoverOperations: true,
      } as never, tidNow(), { kind: "createChannel", skey: "scale-final", name: "scale-final", visibility: "public" });
      const channelCreateAtEnvelopeMs = elapsed(channelCreateStartedAt);
      assert.equal(channelCreateOperation.state, "completed");
      channels.push(`at://${owner.did}/space/new.flock.channel/${workspaceSkey}-scale-final`);
      assert.equal(channels.length, CHANNELS);
      assert.equal((await listSpaceMembers(ownerSession as never, channels.at(-1)!)).length, MEMBERS - 1);

      const requestWriteStartedAt = performance.now();
      const requester = members[MEMBERS - 2];
      await (async () => {
        const requestId = tidNow();
        const rkey = requestRecordKey(privateChannel, requester.did);
        const write = {
          $type: "com.atproto.space.applyWrites#create", collection: "new.flock.joinRequest", rkey,
          value: { $type: "new.flock.joinRequest", channelSkey: privateSkey, requestId, createdAt: new Date().toISOString() },
        };
        await requester.pds.getAgent().com.atproto.space.applyWrites({ space: inbox, repo: requester.did, writes: [write] }, {
          headers: { authorization: `Bearer ${requester.accessJwt}` },
        });
      })();
      const requestWriteMs = elapsed(requestWriteStartedAt);
      const inboxRecoveryStartedAt = performance.now();
      const inboxWriters = await listInboxWriters({ did: owner.did, session: ownerSession as never, workspace: parseWorkspaceRef(bootstrap.workspace), canRecoverOperations: true } as never);
      assert.equal(inboxWriters.writers.length, MEMBERS - 1);
      const inboxCredential = await mintSpaceCredential(sessionFor(members[0]) as never, inbox);
      const recoveredRequests = await mapLimited(inboxWriters.writers, 8, async (repoDid) => {
        const client = inboxCredential.client(await resolvePds(repoDid));
        const page = await client.query<{ records: Array<{ rkey: string }> }>("com.atproto.space.listRecords", {
          space: inbox, repo: repoDid, collection: "new.flock.joinRequest", limit: 100,
        });
        return page.records.length;
      });
      const inboxWriterReconciliationMs = elapsed(inboxRecoveryStartedAt);
      assert.equal(recoveredRequests.reduce((sum, count) => sum + count, 0), 1);
      assert.ok(inboxWriterReconciliationMs <= 60_000, `inbox writer recovery took ${inboxWriterReconciliationMs}ms, exceeding the 60-second SLO`);

      const messageStartedAt = performance.now();
      const base = Date.now() - CHANNELS * MESSAGES - 1000;
      const stamps = acceptedTimestamps(tidNow, await loadSlurFilter(PINNED_CHECKOUT), base, CHANNELS * MESSAGES);
      const writtenPerChannel: number[] = [];
      const reactionsPerChannel: number[] = [];
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        const channel = channels[channelIndex];
        const writers = channel === privateChannel ? members.slice(0, MEMBERS - 2) : members;
        let channelWritten = 0;
        await mapLimited(writers, 16, async (actor, actorIndex) => {
          const writeCount = Math.floor(MESSAGES / writers.length) + (actorIndex < MESSAGES % writers.length ? 1 : 0);
          const writes = Array.from({ length: writeCount }, (_, localIndex) => {
            const sequence = localIndex * writers.length + actorIndex;
            const timestamp = stamps[channelIndex * MESSAGES + sequence]!;
            const rkey = tidNow(timestamp, 0);
            return {
              $type: "com.atproto.space.applyWrites#create", collection: "new.flock.channel.message", rkey,
              value: { $type: "new.flock.channel.message", text: `scale channel ${channelIndex} message ${sequence}`, createdAt: new Date(timestamp).toISOString() },
            };
          });
          const response = await actor.pds.getAgent().com.atproto.space.applyWrites({ space: channel, repo: actor.did, writes }, { headers: { authorization: `Bearer ${actor.accessJwt}` } });
          assert.equal(response.data.results?.length, writes.length);
          channelWritten += writes.length;
        });
        writtenPerChannel.push(channelWritten);
        if ((channelIndex + 1) % 10 === 0) {
          process.stdout.write(`PERFORMANCE_PROGRESS messagesChannels=${channelIndex + 1}/${channels.length} records=${writtenPerChannel.reduce((sum, count) => sum + count, 0)} elapsedMs=${elapsed(messageStartedAt)}\n`);
        }
      }
      const messageWriteMs = elapsed(messageStartedAt);
      assert.deepEqual(writtenPerChannel, Array.from({ length: CHANNELS }, () => MESSAGES));

      const reactionStartedAt = performance.now();
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        const channel = channels[channelIndex];
        const writers = channel === privateChannel ? members.slice(0, MEMBERS - 2) : members;
        const reactionAuthor = writers[0];
        const writes: Array<Record<string, unknown>> = [];
        for (let sequence = 0; sequence < REACTIONS; sequence += 1) {
          const messageAuthorIndex = sequence % writers.length;
          const timestamp = stamps[channelIndex * MESSAGES + sequence]!;
          const messageRkey = tidNow(timestamp, 0);
          const messageUri = spaceRecordUri(channel, writers[messageAuthorIndex].did, "new.flock.channel.message", messageRkey);
          const rkey = reactionRecordKey(messageUri, "👍", reactionAuthor.did);
          writes.push({
            $type: "com.atproto.space.applyWrites#create",
            collection: "new.flock.channel.reaction",
            rkey,
            value: {
              $type: "new.flock.channel.reaction",
              subject: messageUri,
              emoji: "👍",
              createdAt: new Date(timestamp).toISOString(),
            },
          });
        }
        const batches = Array.from({ length: Math.ceil(writes.length / 200) }, (_, index) => writes.slice(index * 200, (index + 1) * 200));
        assert.ok(batches.every((batch) => batch.length <= 200), "each reaction batch stays within the pinned PDS applyWrites limit");
        const accepted = await mapLimited(batches, 8, async (batch) => {
          const response = await reactionAuthor.pds.getAgent().com.atproto.space.applyWrites({
            space: channel,
            repo: reactionAuthor.did,
            writes: batch,
          }, { headers: { authorization: `Bearer ${reactionAuthor.accessJwt}` } });
          assert.equal(response.data.results?.length, batch.length);
          return response.data.results?.length ?? 0;
        });
        reactionsPerChannel.push(accepted.reduce((sum, count) => sum + count, 0));
        if ((channelIndex + 1) % 10 === 0) {
          process.stdout.write(`PERFORMANCE_PROGRESS reactionChannels=${channelIndex + 1}/${channels.length} records=${reactionsPerChannel.reduce((sum, count) => sum + count, 0)} elapsedMs=${elapsed(reactionStartedAt)}\n`);
        }
      }
      const reactionWriteMs = elapsed(reactionStartedAt);
      assert.deepEqual(reactionsPerChannel, Array.from({ length: CHANNELS }, () => REACTIONS));

      assert.equal((await listSpaceMembers(ownerSession as never, bootstrap.channel)).length, MEMBERS - 1, "the target public channel has all 199 non-authority members");
      const authorityCredential = await mintSpaceCredential(ownerSession as never, bootstrap.channel);
      const listedWriters = await authorityCredential.client(network.pds.url).query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: bootstrap.channel, limit: 500 });
      assert.equal(listedWriters.repos.length, MEMBERS - 1, "each target-channel member wrote at least one message");
      const independentStartedAt = performance.now();
      const independentPage = await readIndependentChannelPage(sessionCredentialDeps(ownerSession as never), bootstrap.workspace, `${workspaceSkey}-general`);
      const independentReadMs = elapsed(independentStartedAt);
      assert.equal(independentPage.messages.length, 100);
      assert.equal(independentPage.messages[0]?.value.text, `scale channel 0 message ${MESSAGES - 1}`);
      assert.equal(independentPage.reactions.length, 100, "every message on the latest page has its supported-size reaction");
      assert.equal(independentPage.degraded, false, "exactly 20,000 reactions per channel stays within the supported envelope");

      const primaryStartedAt = performance.now();
      const primaryPage = await readChannelPage(ownerSession as never, bootstrap.workspace, `${workspaceSkey}-general`);
      const primaryReadMs = elapsed(primaryStartedAt);
      assert.equal(primaryPage.messages.length, 100);
      assert.equal(primaryPage.messages[0]?.value.text, `scale channel 0 message ${MESSAGES - 1}`);
      assert.equal(primaryPage.reactions.length, 100, "the primary reader returns reactions for the full latest page");
      assert.equal(primaryPage.degraded, false, "the primary reader does not mark an exact-cap reaction history degraded");
      const normalized = (records: Array<{ uri: string; value: Record<string, unknown> }>) => records
        .map(({ uri, value }) => ({ uri, value }))
        .sort((left, right) => left.uri.localeCompare(right.uri));
      assert.deepEqual(normalized(independentPage.messages), normalized(primaryPage.messages), "the two readers return the same latest-100 URI and content set");
      assert.deepEqual(independentPage.reactions, primaryPage.reactions, "the two readers return the same latest-100 reaction records");

      // The bar for later phases (`.ai/plans/platform-refactor.md`, R0 baseline and R4 gate): each latest-100 read repeated,
      // reported as median and 95th percentile. The independent reader always reads from scratch; the primary reader and the
      // engine are timed from an empty cache or store (a first open) and with a warm one (a reopen). The readers take turns, so
      // load from elsewhere on the machine falls on all of them alike.
      const channelSkey = `${workspaceSkey}-general`;
      const loadAverageBeforeReads = loadavg()[0]!;
      const independentReadsMs = [independentReadMs];
      const primaryColdReadsMs = [primaryReadMs];
      const primaryWarmReadsMs: number[] = [];
      // Every timed read must return the page the first, fully checked reads returned; it is checked after its timer stops.
      const assertSamePage = (page: { messages: Array<{ uri: string; value: Record<string, unknown> }>; reactions: unknown[]; degraded: boolean }, what: string) => {
        assert.deepEqual(normalized(page.messages), normalized(primaryPage.messages), `${what} returns the same latest-100 messages`);
        assert.deepEqual(page.reactions, primaryPage.reactions, `${what} returns the same reactions`);
        assert.equal(page.degraded, false, `${what} is not degraded`);
      };
      // R4 gate: the latest-100 read through the engine: a fresh engine with an empty store (a first open) and the last one
      // again within the truth interval (a reopen), with the same checks on every page.
      const engineRef = { workspace: bootstrap.workspace, skey: channelSkey };
      const engineTransport = { did: owner.did, ...sessionCredentialDeps(ownerSession as never) };
      const assertSameEnginePage = (page: Awaited<ReturnType<ReturnType<typeof createEngine>["channels"]["readPage"]>>, what: string) => {
        assert.deepEqual(normalized(page.messages), normalized(primaryPage.messages), `${what} returns the same latest-100 messages`);
        assert.deepEqual(normalized(page.reactions), normalized(primaryPage.reactions as Array<{ uri: string; value: Record<string, unknown> }>), `${what} returns the same reactions`);
        assert.equal(page.reactions.length, 100, `${what} has every reaction on the latest page`);
        assert.deepEqual(page.degradedReasons, [], `${what} is not degraded`);
        assert.equal(page.complete, true, `${what} is complete`);
      };
      const engineColdReadsMs: number[] = [];
      const engineWarmReadsMs: number[] = [];
      let warmEngine = createEngine(engineTransport);
      const engineColdRead = async () => {
        warmEngine = createEngine(engineTransport);
        const coldRun = performance.now();
        const coldPage = await warmEngine.channels.readPage(engineRef);
        engineColdReadsMs.push(elapsed(coldRun));
        assertSameEnginePage(coldPage, "an engine read from an empty store");
      };
      await engineColdRead();
      for (let run = 1; run < READ_RUNS; run += 1) {
        const independentRun = performance.now();
        const independentRepeat = await readIndependentChannelPage(sessionCredentialDeps(ownerSession as never), bootstrap.workspace, channelSkey);
        independentReadsMs.push(elapsed(independentRun));
        assertSamePage(independentRepeat, "a repeated independent read");
        for (const table of ["channel_record_cache", "space_collection_cursor", "sync_cursor"]) {
          getRawDb().prepare(`DELETE FROM ${table} WHERE account_did = ?`).run(owner.did);
        }
        const coldRun = performance.now();
        const coldPage = await readChannelPage(ownerSession as never, bootstrap.workspace, channelSkey);
        primaryColdReadsMs.push(elapsed(coldRun));
        assertSamePage(coldPage, "a primary read from an empty cache");
        await engineColdRead();
      }
      for (let run = 0; run < READ_RUNS; run += 1) {
        const warmRun = performance.now();
        const warmPage = await readChannelPage(ownerSession as never, bootstrap.workspace, channelSkey);
        primaryWarmReadsMs.push(elapsed(warmRun));
        assertSamePage(warmPage, "a warm primary read");
        const engineWarmRun = performance.now();
        const engineWarmPage = await warmEngine.channels.readPage(engineRef);
        engineWarmReadsMs.push(elapsed(engineWarmRun));
        assertSameEnginePage(engineWarmPage, "a warm engine read");
      }
      const loadAverageAfterReads = loadavg()[0]!;

      const allWorkspaceMembers = [owner.did, ...members.map((member) => member.did)];
      const visibilityStartedAt = performance.now();
      const visibilityOperation = await executeOperatorOperation({
        did: owner.did,
        session: ownerSession as never,
        workspace: parseWorkspaceRef(bootstrap.workspace),
        canRecoverOperations: true,
      } as never, tidNow(), {
        kind: "transitionChannel",
        skey: bootstrap.channel.split("/").at(-1)!,
        visibility: "private",
        members: allWorkspaceMembers,
      });
      const channelTransitionToPrivateAtEnvelopeMs = elapsed(visibilityStartedAt);
      assert.equal(visibilityOperation.state, "completed");

      const archiveStartedAt = performance.now();
      const archiveOperation = await executeOperatorOperation({
        did: owner.did,
        session: ownerSession as never,
        workspace: parseWorkspaceRef(bootstrap.workspace),
        canRecoverOperations: true,
      } as never, tidNow(), { kind: "archiveChannel", skey: bootstrap.channel.split("/").at(-1)! });
      const channelArchiveAtEnvelopeMs = elapsed(archiveStartedAt);
      assert.equal(archiveOperation.state, "completed");

      const report = {
        logicalMembers: MEMBERS,
        channels: CHANNELS,
        messagesPerChannel: MESSAGES,
        totalMessages: CHANNELS * MESSAGES,
        reactionsPerChannel: REACTIONS,
        totalReactions: CHANNELS * REACTIONS,
        explicitWriterRepos: listedWriters.repos.length,
        latestPage: 100,
        accountProvisioningMs: accountMs,
        directMembershipSetupMs: membershipSetupMs,
        journaledInviteAtEnvelopeMs: journaledInviteMs,
        journaledChannelCreateAtEnvelopeMs: channelCreateAtEnvelopeMs,
        publicToPrivateTransitionAtEnvelopeMs: channelTransitionToPrivateAtEnvelopeMs,
        privateChannelArchiveAtEnvelopeMs: channelArchiveAtEnvelopeMs,
        messageWriteMs,
        reactionWriteMs,
        privateRequestWriteMs: requestWriteMs,
        inboxWriterReconciliationMs,
        independentLatest100ReadMs: independentReadMs,
        primaryLatest100ReadMs: primaryReadMs,
        independentLatest100Reads: summary(independentReadsMs),
        primaryLatest100ColdReads: summary(primaryColdReadsMs),
        primaryLatest100WarmReads: summary(primaryWarmReadsMs),
        engineLatest100ColdReads: summary(engineColdReadsMs),
        engineLatest100WarmReads: summary(engineWarmReadsMs),
        // The machine's one-minute load average around the timed reads, this test's own work included.
        machineLoadAverage: { beforeReads: loadAverageBeforeReads, afterReads: loadAverageAfterReads },
      };
      process.stdout.write(`PERFORMANCE_ENVELOPE ${JSON.stringify(report)}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    await cleanupFixture();
  }
});

async function createActor(pds: TestPds, name: string, domain: string): Promise<Actor> {
  const { data } = await pds.getAgent().com.atproto.server.createAccount({
    handle: `${name}.${domain}`, email: `${name}@acceptance.test`, password: `${name}-acceptance-pass`,
  });
  return { did: data.did, accessJwt: data.accessJwt, pds };
}

async function publishAppLexicons(network: TestNetwork): Promise<void> {
  assert.ok(network.lexiconAuthority, "fixture must expose its lexicon authority");
  const agent = network.pds.getAgent();
  const session = await agent.com.atproto.server.createSession({ identifier: "lex-authority.test", password: "hunter2" });
  const root = join(process.cwd(), "lexicons/new/flock");
  const { readdir, readFile } = await import("node:fs/promises");
  const files = await readdir(root, { recursive: true });
  const published = new Set<string>();
  for (const relative of files.filter((file) => file.endsWith(".json"))) {
    const lexicon = JSON.parse(await readFile(join(root, relative), "utf8")) as { id: string };
    if (published.has(lexicon.id)) continue;
    published.add(lexicon.id);
    await agent.com.atproto.repo.createRecord({
      repo: network.lexiconAuthority.did,
      collection: "com.atproto.lexicon.schema",
      rkey: lexicon.id,
      record: lexicon,
    }, { headers: { authorization: `Bearer ${session.data.accessJwt}` } });
  }
}

function sessionFor(actor: Actor): Session {
  return {
    did: actor.did,
    fetchHandler: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${actor.accessJwt}`);
      return fetch(new URL(path, actor.pds.url), { ...init, headers, redirect: "error" });
    },
  };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** Median and 95th percentile, with every run in the order it ran, so one slow run can be told from a slow read. */
function summary(samples: number[]): { runs: number; medianMs: number; p95Ms: number; samplesMs: number[] } {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
  return { runs: sorted.length, medianMs: at(0.5), p95Ms: at(0.95), samplesMs: samples.map(Math.round) };
}

async function mapLimited<T, R>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await action(items[index], index);
    }
  }));
  return results;
}
