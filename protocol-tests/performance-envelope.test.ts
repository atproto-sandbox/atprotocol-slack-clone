import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { loadavg } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { startGroupHostServer, type RunningGroupHost } from "@flock/group-host/server";
import {
  channelRoleKey,
  groupMembersUri,
  inboxUri,
  reactionRecordKey,
  requestRecordKey,
  spaceRecordUri,
  tidNow,
} from "@flock/protocol/keys";
import { COLLECTION, OPENSOCIAL_COLLECTION, SPACE_TYPE } from "@flock/protocol/nsids";
import { createFixtureTempRoot } from "./fixture-temp";
import { acceptedTimestamps, loadSlurFilter } from "./support/accepted-tid";
import {
  acceptGroupMembership,
  actorTransport,
  createOpenSocialGroup,
  pinnedCheckout,
  publishAppLexicons,
  type NetworkActor,
  type TestPds as PdsHost,
} from "./support/pds-network";

type TestAgent = {
  com: {
    atproto: {
      server: {
        createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
        createSession(input: Record<string, unknown>): Promise<{ data: { accessJwt: string } }>;
      };
      repo: {
        createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown>;
      };
      space: {
        applyWrites(
          input: Record<string, unknown>,
          options: { headers: { authorization: string } },
        ): Promise<{ data: { results?: unknown[] } }>;
      };
    };
  };
};
type TestPds = PdsHost & { getAgent(): TestAgent };
type TestNetwork = {
  plc: { url: string };
  pds: TestPds;
  extraPdses: TestPds[];
  lexiconAuthority?: { did: string };
  close(): Promise<void>;
};

const MEMBERS = 200;
const CHANNELS = 100;
const MESSAGES = 20_000;
const REACTIONS = 20_000;
const READ_RUNS = 10;

test(
  "supported-size OpenSocial group workload: 200 members, 100 channels, 20,000 messages and reactions per channel (Gate 5d)",
  { timeout: 60 * 60 * 1000 },
  async () => {
    const pin = pinnedCheckout();
    const fixtureTemp = createFixtureTempRoot("slack-performance-fixture-");
    let network: TestNetwork | undefined;
    let groupHost: RunningGroupHost | undefined;
    let operatorWebhookServer: ReturnType<typeof createHttpServer> | undefined;
    let fixtureCleaned = false;
    const cleanupFixture = async () => {
      if (fixtureCleaned) return;
      fixtureCleaned = true;
      try {
        await new Promise<void>((r) => (operatorWebhookServer ? operatorWebhookServer.close(() => r()) : r()));
        await groupHost?.close().catch(() => undefined);
        await network?.close();
      } finally {
        (await import("@flock/operator/lib/db")).closeDb();
        fixtureTemp.cleanup();
      }
    };
    const onSigint = () => {
      void cleanupFixture()
        .finally(() => process.exit(130))
        .catch(() => process.exit(130));
    };
    process.once("SIGINT", onSigint);

    try {
      const { TestNetworkNoAppView } = (await import(pathToFileURL(join(pin, "packages/dev-env/src/index.ts")).href)) as {
        TestNetworkNoAppView: {
          create(options: {
            extraPdses: number;
            lexiconAuthority: boolean;
            pds?: { rateLimitsEnabled?: boolean };
          }): Promise<TestNetwork>;
        };
      };
      const fixture = await TestNetworkNoAppView.create({
        extraPdses: 1,
        lexiconAuthority: true,
        pds: { rateLimitsEnabled: false },
      });
      network = fixture;
      process.stdout.write("PERFORMANCE_PROGRESS two-PDS fixture ready\n");

      const directory = mkdtempSync(join(fixtureTemp.path, "slack-performance-"));
      groupHost = await startGroupHostServer({
        port: 0,
        databasePath: join(directory, "group-host.db"),
        plcUrl: fixture.plc.url,
        encryptionKeyHex: "5b".repeat(32),
        handleDomain: "groups.localhost",
        allowLoopback: true,
      });

      // Start a real in-process Operator HTTP server with a webhook counter on `/xrpc/com.atproto.space.notifySpaceUpdate`
      let operatorWebhookCount = 0;
      const proxyProbe = createHttpServer();
      await new Promise<void>((r) => proxyProbe.listen(0, "127.0.0.1", () => r()));
      const operatorPort = (proxyProbe.address() as AddressInfo).port;
      await new Promise<void>((r) => proxyProbe.close(() => r()));

      Object.assign(process.env, {
        NODE_ENV: "test",
        ATPROTO_ACCEPTANCE_TEST: "true",
        APP_URL: "http://127.0.0.1:3000",
        OPERATOR_URL: `http://127.0.0.1:${operatorPort}`,
        GROUP_HOST_URL: groupHost.url,
        GROUP_HOST_DATABASE_PATH: join(directory, "group-host.db"),
        GROUP_HOST_ENCRYPTION_KEY: "5b".repeat(32),
        GROUP_HOST_HANDLE_DOMAIN: "groups.localhost",
        AUTH_ENCRYPTION_KEY: "4b".repeat(32),
        OPERATOR_SERVICE_REF: `did:web:localhost%3A${operatorPort}#atproto_flock_operator`,
        PLC_URL: fixture.plc.url,
        DATABASE_PATH: join(directory, "app.db"),
      });
      (await import("@flock/operator/config")).resetOperatorConfigCacheForTest();

      const { createOperatorApp } = await import("@flock/operator/operator/server");
      const operatorApp = createOperatorApp();
      operatorWebhookServer = createHttpServer((req, res) => {
        if (req.url?.startsWith("/xrpc/com.atproto.space.notifySpaceUpdate")) {
          operatorWebhookCount += 1;
        }
        operatorApp(req, res);
      });
      await new Promise<void>((r) => operatorWebhookServer!.listen(operatorPort, "127.0.0.1", () => r()));

      try {
        await publishAppLexicons(fixture as never, process.cwd());
        const [
          { restoreAuthorityGrant },
          { createWorkspace },
          { executeOperatorOperation },
          { deleteAuthorityRecord, ensureOpenSocialSpace, putAuthorityRecord },
          { defaultPrivateChannelPolicy, defaultPublicChannelPolicy },
          { mintSpaceCredential, sessionCredentialDeps },
          { registerSpace },
          { readIndependentChannelPage },
          { parseWorkspaceRef },
          { resolvePds },
          { createEngine },
          { mintSpaceCredentialWith },
          { listBoundedWriters },
        ] = await Promise.all([
          import("@flock/operator/operator/authority-grant"),
          import("@flock/operator/operator/kinds/create-workspace"),
          import("@flock/operator/operator/operations"),
          import("@flock/operator/atproto/space-ops"),
          import("@flock/operator/operator/workspace-spaces"),
          import("@flock/operator/atproto/space-credential"),
          import("@flock/operator/operator/registrations"),
          import("@flock/reader/independent"),
          import("@flock/operator/operator/actor"),
          import("@flock/operator/atproto/identity"),
          import("@flock/client/engine"),
          import("@flock/protocol/atproto/space-credential-core"),
          import("@flock/protocol/atproto/record-pages"),
        ]);

        const owner = await createActor(fixture.pds, "scaleowner", "test");
        const createdGroup = await createOpenSocialGroup({ groupHost, plcUrl: fixture.plc.url }, owner, {
          name: "Scale Workspace",
        });
        const groupDid = createdGroup.groupDid;
        const ownerSession = await restoreAuthorityGrant(groupDid);
        const bootstrap = await createWorkspace(ownerSession, {
          creator: owner.did,
          name: "Scale Workspace",
          operationId: tidNow(),
        });
        assert.equal(bootstrap.state, "completed");

        const membersSpace = groupMembersUri(groupDid);
        const inbox = inboxUri(groupDid);
        const channels = [bootstrap.channel];
        const privateSkey = `scale-${String(CHANNELS - 2).padStart(3, "0")}`;
        const privateRole = channelRoleKey(privateSkey);
        await putAuthorityRecord(ownerSession, membersSpace, OPENSOCIAL_COLLECTION.role, privateRole, {
          displayName: `Private channel #${privateSkey}`,
          scopes: [],
        });

        for (let index = 1; index < CHANNELS - 1; index += 1) {
          const skey = `scale-${String(index).padStart(3, "0")}`;
          const isPrivate = index === CHANNELS - 2;
          const uri = await ensureOpenSocialSpace(
            ownerSession,
            SPACE_TYPE.channel,
            skey,
            isPrivate ? defaultPrivateChannelPolicy(privateRole) : defaultPublicChannelPolicy(),
          );
          await putAuthorityRecord(ownerSession, bootstrap.workspace, COLLECTION.directory, skey, {
            skey,
            name: skey,
            visibility: isPrivate ? "private" : "public",
          });
          channels.push(uri);
        }

        const channelCreateStartedAt = performance.now();
        const channelCreateOperation = await executeOperatorOperation(
          {
            did: owner.did,
            session: ownerSession,
            workspace: parseWorkspaceRef(bootstrap.workspace),
            canRecoverOperations: true,
          },
          tidNow(),
          { kind: "createChannel", skey: "scale-final", name: "scale-final", visibility: "public" },
        );
        const channelCreateAtEnvelopeMs = elapsed(channelCreateStartedAt);
        assert.equal(channelCreateOperation.state, "completed");
        channels.push(`at://${groupDid}/space/new.flock.channel/scale-final`);
        assert.equal(channels.length, CHANNELS);

        const accountStartedAt = performance.now();
        const members = await mapLimited(
          Array.from({ length: MEMBERS - 1 }, (_, index) => index),
          8,
          async (index) => {
            const extra = index % 2 === 0;
            return createActor(
              extra ? fixture.extraPdses[0]! : fixture.pds,
              `scale${String(index).padStart(3, "0")}`,
              extra ? "test2" : "test",
            );
          },
        );
        const accountMs = elapsed(accountStartedAt);
        process.stdout.write(`PERFORMANCE_PROGRESS accounts=${MEMBERS} elapsedMs=${accountMs}\n`);

        const rosterStartedAt = performance.now();
        const privateChannel = channels[CHANNELS - 2]!;
        const seededMembers = members.slice(0, -1);
        const inviteTarget = members.at(-1)!;
        const nowIso = new Date().toISOString();
        await mapLimited(seededMembers, 16, async (member, idx) => {
          const roles = ["member"];
          if (idx === 0) roles.push("admin");
          if (idx < MEMBERS - 2) roles.push(privateRole);
          await putAuthorityRecord(ownerSession, membersSpace, OPENSOCIAL_COLLECTION.membership, member.did, {
            roles,
            createdAt: nowIso,
          });
        });
        const membershipSetupMs = elapsed(rosterStartedAt);
        process.stdout.write(`PERFORMANCE_PROGRESS memberAndRosterSetup elapsedMs=${membershipSetupMs}\n`);

        // ── Gate 5d.1: `putRecord(membership)` across a 100-channel group === 1 XRPC write (<= 250 ms) ──
        let membershipXrpcWrites = 0;
        const countedOwnerSession = {
          did: ownerSession.did,
          fetchHandler: async (path: string, init?: RequestInit) => {
            if (path.startsWith("/xrpc/")) membershipXrpcWrites += 1;
            return ownerSession.fetchHandler(path, init);
          },
        };
        const singleMembershipStarted = performance.now();
        await putAuthorityRecord(countedOwnerSession as never, membersSpace, OPENSOCIAL_COLLECTION.membership, inviteTarget.did, {
          roles: ["member", privateRole],
          createdAt: new Date().toISOString(),
        });
        const singleMembershipWriteMs = elapsed(singleMembershipStarted);
        assert.equal(
          membershipXrpcWrites,
          1,
          `Gate 5d failed: putRecord(membership) across ${CHANNELS}-channel group made ${membershipXrpcWrites} XRPC calls (expected === 1)`,
        );
        assert.ok(
          singleMembershipWriteMs <= 250,
          `Gate 5d failed: putRecord(membership) took ${singleMembershipWriteMs} ms (expected <= 250 ms)`,
        );
        // Prove inviteTarget is immediately authorized on channel #100!
        const targetCred = await mintSpaceCredentialWith(actorTransport({ plcUrl: fixture.plc.url }, inviteTarget), channels.at(-1)!);
        assert.ok(targetCred.token.length > 0);
        await acceptGroupMembership({ plcUrl: fixture.plc.url }, owner, groupDid);
        await acceptGroupMembership({ plcUrl: fixture.plc.url }, members[0]!, groupDid);

        // ── Gate 5d.2: Group Host -> Operator webhook count per message at 200 members === 1 ──
        await registerSpace(ownerSession, bootstrap.workspace, bootstrap.channel);
        await groupHost.flushBackgroundWork();
        operatorWebhookCount = 0;
        const probeRkey = tidNow();
        await members[0]!.pds.getAgent().com.atproto.space.applyWrites(
          {
            space: bootstrap.channel,
            repo: members[0]!.did,
            writes: [
              {
                $type: "com.atproto.space.applyWrites#create",
                collection: COLLECTION.message,
                rkey: probeRkey,
                value: { $type: COLLECTION.message, text: "webhook count probe", createdAt: new Date().toISOString() },
              },
            ],
          },
          { headers: { authorization: `Bearer ${members[0]!.accessJwt}` } },
        );
        // Wait until Group Host records members[0]'s write and flushes its outbox
        const probeCred = await mintSpaceCredential(ownerSession, bootstrap.channel);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const lw = await probeCred
            .client(groupHost.url)
            .query<{ repos: Array<{ $type?: string; repo: string }> }>("com.atproto.space.listWriters", {
              space: bootstrap.channel,
              limit: 500,
            });
          if (lw.repos.some((r) => r.$type === "com.atproto.space.defs#repoWrite" && r.repo === members[0]!.did)) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        await groupHost.flushBackgroundWork();
        const webhooksPerMessageAt200Members = operatorWebhookCount;
        assert.equal(
          webhooksPerMessageAt200Members,
          1,
          `Gate 5d failed: expected Group Host -> Operator webhook count per message at 200 members === 1, got ${webhooksPerMessageAt200Members}`,
        );
        // Delete probe message before seeding exact 20,000 messages per channel
        await members[0]!.pds.getAgent().com.atproto.space.applyWrites(
          {
            space: bootstrap.channel,
            repo: members[0]!.did,
            writes: [{ $type: "com.atproto.space.applyWrites#delete", collection: COLLECTION.message, rkey: probeRkey }],
          },
          { headers: { authorization: `Bearer ${members[0]!.accessJwt}` } },
        );

        // Private channel join request & inbox writer scan
        const requestWriteStartedAt = performance.now();
        const requester = members[MEMBERS - 2]!;
        await (async () => {
          const requestId = tidNow();
          const rkey = requestRecordKey(privateChannel, requester.did);
          const write = {
            $type: "com.atproto.space.applyWrites#create",
            collection: "new.flock.joinRequest",
            rkey,
            value: { $type: "new.flock.joinRequest", channelSkey: privateSkey, requestId, createdAt: new Date().toISOString() },
          };
          await requester.pds
            .getAgent()
            .com.atproto.space.applyWrites(
              { space: inbox, repo: requester.did, writes: [write] },
              { headers: { authorization: `Bearer ${requester.accessJwt}` } },
            );
        })();
        const requestWriteMs = elapsed(requestWriteStartedAt);
        const inboxCredential = await mintSpaceCredential(ownerSession, inbox);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const lw = await inboxCredential
            .client(groupHost.url)
            .query<{ repos: Array<{ $type?: string; repo: string }> }>("com.atproto.space.listWriters", { space: inbox, limit: 500 });
          if (lw.repos.some((r) => r.$type === "com.atproto.space.defs#repoWrite" && r.repo === requester.did)) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const inboxRecoveryStartedAt = performance.now();
        const inboxWriterScan = await listBoundedWriters(inboxCredential.client(groupHost.url), {
          space: inbox,
          maxRepos: 500,
        });
        const inboxWriterDids = inboxWriterScan.writers.map((w) => w.repo).filter((did) => did !== groupDid);
        assert.ok(inboxWriterDids.includes(requester.did));
        const recoveredRequests = await mapLimited(inboxWriterDids, 8, async (repoDid) => {
          const client = inboxCredential.client(await resolvePds(repoDid));
          const page = await client.query<{ records: Array<{ rkey: string }> }>("com.atproto.space.listRecords", {
            space: inbox,
            repo: repoDid,
            collection: "new.flock.joinRequest",
            limit: 100,
          });
          return page.records.length;
        });
        const inboxWriterReconciliationMs = elapsed(inboxRecoveryStartedAt);
        assert.equal(recoveredRequests.reduce((sum, count) => sum + count, 0), 1);
        assert.ok(
          inboxWriterReconciliationMs <= 60_000,
          `inbox writer recovery took ${inboxWriterReconciliationMs}ms, exceeding the 60-second SLO`,
        );

        // Seed 20,000 messages + 20,000 reactions across all 100 channels!
        const messageStartedAt = performance.now();
        const base = Date.now() - CHANNELS * MESSAGES - 1000;
        const stamps = acceptedTimestamps(tidNow, await loadSlurFilter(pin), base, CHANNELS * MESSAGES);
        const writtenPerChannel: number[] = [];
        const reactionsPerChannel: number[] = [];
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
          const channel = channels[channelIndex]!;
          const writers = channel === privateChannel ? members.slice(0, MEMBERS - 2) : members;
          let channelWritten = 0;
          await mapLimited(writers, 16, async (actor, actorIndex) => {
            const writeCount = Math.floor(MESSAGES / writers.length) + (actorIndex < MESSAGES % writers.length ? 1 : 0);
            const writes = Array.from({ length: writeCount }, (_, localIndex) => {
              const sequence = localIndex * writers.length + actorIndex;
              const timestamp = stamps[channelIndex * MESSAGES + sequence]!;
              const rkey = tidNow(timestamp, 0);
              return {
                $type: "com.atproto.space.applyWrites#create",
                collection: "new.flock.channel.message",
                rkey,
                value: {
                  $type: "new.flock.channel.message",
                  text: `scale channel ${channelIndex} message ${sequence}`,
                  createdAt: new Date(timestamp).toISOString(),
                },
              };
            });
            const response = await actor.pds
              .getAgent()
              .com.atproto.space.applyWrites(
                { space: channel, repo: actor.did, writes },
                { headers: { authorization: `Bearer ${actor.accessJwt}` } },
              );
            assert.equal(response.data.results?.length, writes.length);
            channelWritten += writes.length;
          });
          writtenPerChannel.push(channelWritten);
          if ((channelIndex + 1) % 10 === 0) {
            process.stdout.write(
              `PERFORMANCE_PROGRESS messagesChannels=${channelIndex + 1}/${channels.length} records=${writtenPerChannel.reduce((sum, count) => sum + count, 0)} elapsedMs=${elapsed(messageStartedAt)}\n`,
            );
          }
        }
        const messageWriteMs = elapsed(messageStartedAt);
        assert.deepEqual(writtenPerChannel, Array.from({ length: CHANNELS }, () => MESSAGES));

        const reactionStartedAt = performance.now();
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
          const channel = channels[channelIndex]!;
          const writers = channel === privateChannel ? members.slice(0, MEMBERS - 2) : members;
          const reactionAuthor = writers[0]!;
          const writes: Array<Record<string, unknown>> = [];
          for (let sequence = 0; sequence < REACTIONS; sequence += 1) {
            const messageAuthorIndex = sequence % writers.length;
            const timestamp = stamps[channelIndex * MESSAGES + sequence]!;
            const messageRkey = tidNow(timestamp, 0);
            const messageUri = spaceRecordUri(channel, writers[messageAuthorIndex]!.did, "new.flock.channel.message", messageRkey);
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
          const batches = Array.from({ length: Math.ceil(writes.length / 200) }, (_, index) =>
            writes.slice(index * 200, (index + 1) * 200),
          );
          const accepted = await mapLimited(batches, 8, async (batch) => {
            const response = await reactionAuthor.pds
              .getAgent()
              .com.atproto.space.applyWrites(
                { space: channel, repo: reactionAuthor.did, writes: batch },
                { headers: { authorization: `Bearer ${reactionAuthor.accessJwt}` } },
              );
            assert.equal(response.data.results?.length, batch.length);
            return response.data.results?.length ?? 0;
          });
          reactionsPerChannel.push(accepted.reduce((sum, count) => sum + count, 0));
          if ((channelIndex + 1) % 10 === 0) {
            process.stdout.write(
              `PERFORMANCE_PROGRESS reactionChannels=${channelIndex + 1}/${channels.length} records=${reactionsPerChannel.reduce((sum, count) => sum + count, 0)} elapsedMs=${elapsed(reactionStartedAt)}\n`,
            );
          }
        }
        const reactionWriteMs = elapsed(reactionStartedAt);
        assert.deepEqual(reactionsPerChannel, Array.from({ length: CHANNELS }, () => REACTIONS));

        // Wait until Group Host has indexed all 199 non-owner writers on channel 0 (`general`)
        const authorityCredential = await mintSpaceCredential(ownerSession, bootstrap.channel);
        let activeWriters: Array<{ $type?: string; repo: string }> = [];
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const listedWriters = await authorityCredential
            .client(groupHost.url)
            .query<{ repos: Array<{ $type?: string; repo: string }> }>("com.atproto.space.listWriters", {
              space: bootstrap.channel,
              limit: 500,
            });
          activeWriters = listedWriters.repos.filter(
            (entry) => entry.$type === "com.atproto.space.defs#repoWrite" && entry.repo !== groupDid,
          );
          if (activeWriters.length === MEMBERS - 1) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(activeWriters.length, MEMBERS - 1, "each target-channel member wrote at least one message");

        const channelSkey = "general";
        const ownerDeps = actorTransport({ plcUrl: fixture.plc.url }, owner);
        const independentStartedAt = performance.now();
        const independentPage = await readIndependentChannelPage(ownerDeps, bootstrap.workspace, channelSkey);
        const independentReadMs = elapsed(independentStartedAt);
        assert.equal(independentPage.messages.length, 100);
        assert.equal(independentPage.messages[0]?.value.text, `scale channel 0 message ${MESSAGES - 1}`);
        assert.equal(independentPage.reactions.length, 100);
        assert.equal(independentPage.degraded, false);

        const normalized = (records: Array<{ uri: string; value: Record<string, unknown> }>) =>
          records.map(({ uri, value }) => ({ uri, value })).sort((left, right) => left.uri.localeCompare(right.uri));
        const engineRef = { workspace: bootstrap.workspace, skey: channelSkey };
        const engineColdReadsMs: number[] = [];
        const engineWarmReadsMs: number[] = [];
        let warmEngine = createEngine(ownerDeps);
        const engineColdRead = async () => {
          warmEngine = createEngine(ownerDeps);
          const coldRun = performance.now();
          const coldPage = await warmEngine.channels.readPage(engineRef);
          engineColdReadsMs.push(elapsed(coldRun));
          return coldPage;
        };
        const enginePage = await engineColdRead();
        assert.equal(enginePage.messages.length, 100);
        assert.equal(enginePage.messages[0]?.value.text, `scale channel 0 message ${MESSAGES - 1}`);
        assert.equal(enginePage.reactions.length, 100);
        assert.deepEqual(enginePage.degradedReasons, []);
        assert.equal(enginePage.complete, true);
        assert.deepEqual(normalized(independentPage.messages), normalized(enginePage.messages));
        assert.deepEqual(normalized(independentPage.reactions), normalized(enginePage.reactions));

        const loadAverageBeforeReads = loadavg()[0]!;
        const independentReadsMs = [independentReadMs];
        for (let run = 1; run < READ_RUNS; run += 1) {
          const independentRun = performance.now();
          const independentRepeat = await readIndependentChannelPage(ownerDeps, bootstrap.workspace, channelSkey);
          independentReadsMs.push(elapsed(independentRun));
          assert.deepEqual(normalized(independentRepeat.messages), normalized(enginePage.messages));
          assert.deepEqual(normalized(independentRepeat.reactions), normalized(enginePage.reactions));
          assert.equal(independentRepeat.degraded, false);

          const coldRepeat = await engineColdRead();
          assert.deepEqual(normalized(coldRepeat.messages), normalized(enginePage.messages));
          assert.deepEqual(normalized(coldRepeat.reactions), normalized(enginePage.reactions));
          assert.equal(coldRepeat.complete, true);
        }
        for (let run = 0; run < READ_RUNS; run += 1) {
          const engineWarmRun = performance.now();
          const engineWarmPage = await warmEngine.channels.readPage(engineRef);
          engineWarmReadsMs.push(elapsed(engineWarmRun));
          assert.deepEqual(normalized(engineWarmPage.messages), normalized(enginePage.messages));
          assert.equal(engineWarmPage.complete, true);
        }
        const loadAverageAfterReads = loadavg()[0]!;

        // ── Gate 5d.3: Cold latest-100 channel open <= 60,000 ms ──
        const indStats = summary(independentReadsMs);
        const coldStats = summary(engineColdReadsMs);
        assert.ok(
          indStats.p95Ms <= 60_000 && Math.max(...independentReadsMs) <= 60_000,
          `Gate 5d failed: independent cold latest-100 open p95=${indStats.p95Ms}ms exceeded 60,000 ms`,
        );
        assert.ok(
          coldStats.p95Ms <= 60_000 && Math.max(...engineColdReadsMs) <= 60_000,
          `Gate 5d failed: engine cold latest-100 open p95=${coldStats.p95Ms}ms exceeded 60,000 ms`,
        );

        // ── Gate 5d.4: Writer eviction across 100 spaces <= 500 ms ──
        const evictedMember = members[10]!;
        const evictionStartedAt = performance.now();
        await deleteAuthorityRecord(ownerSession, membersSpace, OPENSOCIAL_COLLECTION.membership, evictedMember.did);
        const writerEvictionAcross100SpacesMs = elapsed(evictionStartedAt);
        assert.ok(
          writerEvictionAcross100SpacesMs <= 500,
          `Gate 5d failed: writer eviction across 100 spaces took ${writerEvictionAcross100SpacesMs} ms (expected <= 500 ms)`,
        );
        // Verify evictedMember is #repoRemoved on channel 0 and channel 99 and refused new credentials!
        for (const checkSpace of [bootstrap.channel, privateChannel, channels.at(-1)!]) {
          const checkCred = await mintSpaceCredential(ownerSession, checkSpace);
          const checkWriters = await checkCred
            .client(groupHost.url)
            .query<{ repos: Array<{ $type?: string; repo: string }> }>("com.atproto.space.listWriters", {
              space: checkSpace,
              limit: 500,
            });
          assert.equal(
            checkWriters.repos.some((r) => r.$type === "com.atproto.space.defs#repoRemoved" && r.repo === evictedMember.did),
            true,
            `Expected evicted writer #repoRemoved in ${checkSpace}`,
          );
        }
        await assert.rejects(() =>
          mintSpaceCredentialWith(actorTransport({ plcUrl: fixture.plc.url }, evictedMember), bootstrap.channel),
        );

        // Transition & archive channel at envelope
        const remainingMembers = [owner.did, ...members.filter((m) => m.did !== evictedMember.did).map((m) => m.did)];
        const visibilityStartedAt = performance.now();
        const visibilityOperation = await executeOperatorOperation(
          {
            did: owner.did,
            session: ownerSession,
            workspace: parseWorkspaceRef(bootstrap.workspace),
            canRecoverOperations: true,
          },
          tidNow(),
          {
            kind: "transitionChannel",
            skey: channelSkey,
            visibility: "private",
            members: remainingMembers,
          },
        );
        const channelTransitionToPrivateAtEnvelopeMs = elapsed(visibilityStartedAt);
        assert.equal(visibilityOperation.state, "completed");

        const archiveStartedAt = performance.now();
        const archiveOperation = await executeOperatorOperation(
          {
            did: owner.did,
            session: ownerSession,
            workspace: parseWorkspaceRef(bootstrap.workspace),
            canRecoverOperations: true,
          },
          tidNow(),
          { kind: "archiveChannel", skey: channelSkey },
        );
        const channelArchiveAtEnvelopeMs = elapsed(archiveStartedAt);
        assert.equal(archiveOperation.state, "completed");

        const report = {
          logicalMembers: MEMBERS,
          channels: CHANNELS,
          messagesPerChannel: MESSAGES,
          totalMessages: CHANNELS * MESSAGES,
          reactionsPerChannel: REACTIONS,
          totalReactions: CHANNELS * REACTIONS,
          explicitWriterRepos: activeWriters.length,
          latestPage: 100,
          accountProvisioningMs: accountMs,
          directMembershipSetupMs: membershipSetupMs,
          singleMembershipXrpcWrites: membershipXrpcWrites,
          singleMembershipWriteMs,
          writerEvictionAcross100SpacesMs,
          webhooksPerMessageAt200Members,
          journaledChannelCreateAtEnvelopeMs: channelCreateAtEnvelopeMs,
          publicToPrivateTransitionAtEnvelopeMs: channelTransitionToPrivateAtEnvelopeMs,
          privateChannelArchiveAtEnvelopeMs: channelArchiveAtEnvelopeMs,
          messageWriteMs,
          reactionWriteMs,
          privateRequestWriteMs: requestWriteMs,
          inboxWriterReconciliationMs,
          independentLatest100ReadMs: independentReadMs,
          independentLatest100Reads: indStats,
          engineLatest100ColdReads: coldStats,
          engineLatest100WarmReads: summary(engineWarmReadsMs),
          machineLoadAverage: { beforeReads: loadAverageBeforeReads, afterReads: loadAverageAfterReads },
           sessionCredentialDepsChecked: Boolean(sessionCredentialDeps),
        };
        process.stdout.write(`PERFORMANCE_ENVELOPE ${JSON.stringify(report)}\n`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
      await cleanupFixture();
    }
  },
);

async function createActor(pds: TestPds, name: string, domain: string): Promise<NetworkActor> {
  const handle = `${name}.${domain}`;
  const password = `${name}-acceptance-pass`;
  const { data } = await pds.getAgent().com.atproto.server.createAccount({
    handle,
    email: `${name}@acceptance.test`,
    password,
  });
  return { did: data.did, handle, password, accessJwt: data.accessJwt, pds };
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function summary(samples: number[]): { runs: number; medianMs: number; p95Ms: number; samplesMs: number[] } {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
  return { runs: sorted.length, medianMs: at(0.5), p95Ms: at(0.95), samplesMs: samples.map(Math.round) };
}

async function mapLimited<T, R>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await action(items[index]!, index);
      }
    }),
  );
  return results;
}
