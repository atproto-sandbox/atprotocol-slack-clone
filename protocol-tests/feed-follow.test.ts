import assert from "node:assert/strict";
import test from "node:test";
import { availablePort, startOperatorServer, type AppServer } from "./support/app-server";
import { acceptGroupMembership, actorTransport, createOpenSocialGroup, startPdsNetwork } from "./support/pds-network";

// R5's gate (`.ai/plans/platform-refactor.md`): a Node client holding only its member session (no cookie, no session on this
// app's server) follows a channel live through the operator's change feed, against two real PDS hosts and an OpenSocial Group Host,
// with the operator's own process receiving their notices. The operator registered its notice sink when the workspace was created.

test("a member session alone follows a channel live through the change feed", { timeout: 5 * 60_000 }, async () => {
  const port = await availablePort();
  const pds = await startPdsNetwork("feed-follow", { operatorPort: port });
  let server: AppServer | undefined;
  try {
    server = await startOperatorServer();
    const [
      { restoreAuthorityGrant },
      { grantCreationAuthorization },
      { createWorkspace },
      { registrationDeps },
      { requireActiveWorkspaceAdmin },
      { executeOperatorOperation },
      { tidNow },
      { createEngine },
      { ChangeFollower },
    ] = await Promise.all([
      import("@flock/operator/operator/authority-grant"),
      import("@flock/operator/operator/creation-authorization"),
      import("@flock/operator/operator/kinds/create-workspace"),
      import("@flock/operator/operator/registrations"),
      import("@flock/operator/operator/security"),
      import("@flock/operator/operator/operations"),
      import("@flock/protocol/keys"),
      import("@flock/client/engine"),
      import("@flock/client/feed"),
    ]);
    const owner = await pds.createActor("feedowner", 0);
    const reader = await pds.createActor("feedreader", 1);
    const writer = await pds.createActor("feedwriter", 0);
    const group = await createOpenSocialGroup(pds, owner, { name: "Feed Follow", keyLabel: "feed-authority-dpop" });
    grantCreationAuthorization(
      { authorityDid: group.groupDid, initiatorDid: owner.did, name: "Feed Follow" },
      Math.floor(Date.now() / 1000),
    );
    const created = await createWorkspace(
      await restoreAuthorityGrant(group.groupDid),
      { creator: owner.did, name: "Feed Follow", operationId: tidNow() },
      registrationDeps,
    );
    assert.equal(created.state, "completed");
    const admin = await requireActiveWorkspaceAdmin(created.workspace, owner.did);
    for (const member of [reader, writer]) {
      assert.equal(
        (await executeOperatorOperation(admin, tidNow(), { kind: "inviteMember", subject: member.did }, registrationDeps)).state,
        "completed",
      );
      await acceptGroupMembership(pds, member, group.groupDid);
    }
    const ref = { workspace: created.workspace, skey: created.channel.split("/").at(-1)! };
    const operator = { serviceRef: pds.serviceRef, endpoint: server.url };

    // The reader: its own PDS session and the operator's public methods, nothing else.
    const engine = createEngine(actorTransport(pds, reader), { operator });
    let page = await engine.channels.readPage(ref);
    const follower = new ChangeFollower({
      operator: engine.operator!,
      credentials: engine.credentials,
      sync: async () => {
        page = await engine.channels.readPage(ref);
      },
    });
    await follower.follow([created.channel]);

    const sent = await createEngine(actorTransport(pds, writer)).channels.send(ref, "written while the reader was following");
    const started = performance.now();
    const polls: string[][] = [];
    while (!page.messages.some((message) => message.uri === sent.uri) && performance.now() - started < 90_000) {
      const result = await follower.poll();
      assert.deepEqual(result.failed, []);
      polls.push(result.synced);
    }
    assert.ok(page.messages.some((message) => message.uri === sent.uri), `the message reached the follower through the feed\n${server.output()}`);
    assert.ok(polls.some((synced) => synced.includes(created.channel)), "it arrived because the feed named the channel");
    process.stdout.write(`FEED_FOLLOW write-to-page ms=${Math.round(performance.now() - started)} polls=${polls.length}\n`);
  } finally {
    await server?.stop();
    await pds.close();
  }
});
