import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { availablePort, startOperatorServer, type AppServer } from "./support/app-server";
import { actorTransport, mintAppSession, startPdsNetwork, storeAuthorityGrant } from "./support/pds-network";

// R9's gate (`.ai/plans/r9-apps-progress.md`): the echo bot, which imports nothing but the client, runs with its own OAuth
// session against two real PDS hosts and the operator's own process, which receives their notices. It answers a person in a
// granted channel within one poll of the change feed; once uninstalled it is in no member list, the feed denies it at once,
// and its next credential is refused. The residual of a credential it already held is r9a's measurement (`apps.test.ts`).
test("the echo bot answers a person within one poll, and once uninstalled is denied and refused (R9)", { timeout: 5 * 60_000 }, async () => {
  const port = await availablePort();
  const pds = await startPdsNetwork("echo-bot", { operatorPort: port });
  const directory = mkdtempSync(join(tmpdir(), "echo-bot-test-"));
  const stop = new AbortController();
  let server: AppServer | undefined;
  let running: Promise<void> | undefined;
  try {
    server = await startOperatorServer();
    const [{ restoreAuthorityGrant }, { createWorkspace }, { registrationDeps }, { requireActiveWorkspaceAdmin }, { executeOperatorOperation }, { listSpaceMembers }, { tidNow }, { createEngine }, { nodeTransport }, { ECHO_BOT_COMMANDS, startEchoBot }, { isAccessLost }] = await Promise.all([
      import("@flock/operator/operator/authority-grant"), import("@flock/operator/operator/kinds/create-workspace"), import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/security"), import("@flock/operator/operator/operations"), import("@flock/operator/atproto/space-ops"), import("@flock/protocol/keys"),
      import("@flock/client/engine"), import("@flock/client/node/transport"), import("@flock/echo-bot/echo"), import("@flock/protocol/atproto/space-credential-core"),
    ]);
    const [{ AppAccessLostError, publishAppDeclaration }, { validateAppDeclaration }] = await Promise.all([import("@flock/client/app-runtime"), import("@flock/protocol/registry")]);
    // given a workspace with a person in it, and the bot installed with write in #general
    const authority = await pds.createActor("echoowner", 0);
    const person = await pds.createActor("echoperson", 1);
    const bot = await pds.createActor("echobot", 1);
    await storeAuthorityGrant(pds.hosts[0], authority.did, "echo-authority-dpop");
    const created = await createWorkspace(await restoreAuthorityGrant(authority.did), { creator: authority.did, name: "Echo", operationId: tidNow() }, registrationDeps);
    assert.equal(created.state, "completed");
    const admin = await requireActiveWorkspaceAdmin(created.workspace, authority.did);
    const ref = { workspace: created.workspace, skey: created.channel.split("/").at(-1)! };
    for (const request of [{ kind: "inviteMember", subject: person.did }, { kind: "installApp", subject: bot.did, channels: [{ skey: ref.skey, write: true }] }]) {
      assert.equal((await executeOperatorOperation(admin, tidNow(), request, registrationDeps)).state, "completed", request.kind);
    }

    // and the bot running with its own session, as `echo-bot run` does, counting its polls of the feed that follow #general (its
    // start reads the feed's head before it follows anything, and a message written before it follows is one it found there)
    const session = await mintAppSession(bot.pds, bot.did, { serviceRef: pds.serviceRef, plcUrl: pds.plcUrl, stateFile: join(directory, "echo-bot.json") }, "echo-bot-dpop");
    const transport = nodeTransport(session, { plcUrl: pds.plcUrl, loopback: true });
    const engine = createEngine(transport, { operator: { serviceRef: pds.serviceRef, endpoint: server.url } });
    // (`echo-bot run` publishes the bot's declaration first, with the app's own grant)
    await publishAppDeclaration(transport, { name: "Echo", description: "Answers each message with its text.", commands: ECHO_BOT_COMMANDS });
    const declared = await transport.memberClient.query<{ value: unknown }>("com.atproto.repo.getRecord", { repo: bot.did, collection: "new.flock.app.declaration", rkey: "self" });
    assert.equal(validateAppDeclaration(declared.value).valid, true, "the bot's declaration is published and valid");
    const feed = engine.operator!;
    let polls = 0;
    let pollAtAnswer: number | undefined;
    const errors: unknown[] = [];
    running = startEchoBot({
      engine: {
        ...engine,
        channels: {
          ...engine.channels,
          send: (...args) => {
            pollAtAnswer ??= polls;
            return engine.channels.send(...args);
          },
        },
        operator: {
          getChanges: (follow, signal) => {
            if (follow.some((entry) => entry.space === created.channel)) polls += 1;
            return feed.getChanges(follow, signal);
          },
        },
      },
      did: bot.did, workspaces: [created.workspace], signal: stop.signal, onError: (error) => errors.push(error),
    });
    for (const started = Date.now(); polls === 0; await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() - started < 30_000, `the bot follows #general: ${errors.map(String).join("; ")}`);

    // when the person writes in #general
    const people = createEngine(actorTransport(pds, person));
    const pollAtSend = polls;
    const sent = await people.channels.send(ref, "hello bot");

    // then the bot answers in that message's thread, within the poll the change arrived in
    let reply: { value: Record<string, unknown> } | undefined;
    for (const started = Date.now(); !reply; await new Promise((resolve) => setTimeout(resolve, 250))) {
      assert.ok(Date.now() - started < 90_000, `the bot answered: ${errors.map(String).join("; ")}\n${server.output()}`);
      reply = (await people.channels.readPage(ref)).messages.find((message) => message.repo === bot.did);
    }
    assert.deepEqual({ text: reply.value.text, parent: reply.value.parent }, { text: "echo: hello bot", parent: sent.uri });
    assert.ok(pollAtAnswer !== undefined && pollAtAnswer - pollAtSend <= 1, `answered within one poll of the feed (${(pollAtAnswer ?? polls) - pollAtSend} more began before answering)`);
    assert.deepEqual(errors, [], "the bot ran without a failure");

    // when the admin uninstalls it, through the operator's own process as the admin's app does (that process serves the feed,
    // and drops its cached member list as it changes the list)
    const admins = createEngine(actorTransport(pds, authority), { operator: { serviceRef: pds.serviceRef, endpoint: server.url } });
    assert.equal((await admins.operator!.execute({ workspace: created.workspace, operationId: tidNow(), request: { kind: "uninstallApp", subject: bot.did } })).operation.state, "completed");

    // then it is in no member list, the feed denies it at once, and the authority refuses its next credential
    const grant = await restoreAuthorityGrant(authority.did);
    for (const space of [created.workspace, created.channel]) {
      assert.equal((await listSpaceMembers(grant, space)).some((member) => member.did === bot.did), false, `not in ${space}`);
    }
    const { head } = await feed.getChanges([]);
    assert.deepEqual((await feed.getChanges([{ space: created.channel, after: head }])).denied, [created.channel]);
    const refusal = await engine.credentials.fresh(created.channel).then(() => null, (error: unknown) => error);
    assert.ok(refusal && isAccessLost(refusal), `its next credential is refused: ${String(refusal)}`);

    // and the bot itself learns it, from the feed, and says so: it follows nothing of the workspace any more
    for (const started = Date.now(); !errors.some((error) => error instanceof AppAccessLostError); await new Promise((resolve) => setTimeout(resolve, 250))) {
      assert.ok(Date.now() - started < 60_000, `the bot reported its lost access: ${errors.map(String).join("; ")}`);
    }
    assert.deepEqual(errors.filter((error) => !(error instanceof AppAccessLostError)), [], "nothing but the lost access was reported");
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    await server?.stop();
    await pds.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
