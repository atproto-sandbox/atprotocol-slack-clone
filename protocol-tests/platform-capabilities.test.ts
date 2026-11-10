import assert from "node:assert/strict";
import test from "node:test";
import { verifyJwt } from "@atproto/xrpc-server";
import {
  bearerSession,
  callOperatorMethod,
  combinedMemberScopes,
  SERVICE_METHODS_PLANNED,
  SERVICE_METHODS_TODAY,
  outcome,
  startPdsNetwork,
  storeAuthorityGrant,
  storeOAuthSession,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "./support/pds-network";

// K3 and K7 of `.ai/plans/platform-refactor.md`: capability checks against the pinned PDS that the browser member session
// (R5, R6) and the first bot (R9) depend on. K7 found that an app password cannot mint a space credential, so the bot path
// is proven with the bot's own OAuth session. They exercise the protocol and today's server-side code paths with the
// final grant shape, under today's `org.slack.*` names (R3 renames them).

test("platform capabilities at the pinned PDS (K3, K7)", async (t) => {
  const pds = await startPdsNetwork("platform-capabilities");
  try {
    const workspace = await createWorkspace(pds);

    await t.test("one browser grant carries every member, admin, operator and DM operation (K3)", async (st) => {
      // given a member, an admin and an outsider, each holding exactly the combined member grant
      const scopes = await combinedMemberScopes(pds.serviceRef);
      const member = await pds.createActor("k3member", 1);
      const admin = await pds.createActor("k3admin", 1);
      const outsider = await pds.createActor("k3outsider", 0);
      for (const actor of [member, admin, outsider]) await storeOAuthSession(actor.pds, actor.did, scopes, `k3-${actor.handle}`);
      await workspace.invite(member.did);
      await workspace.invite(admin.did);
      await workspace.promote(admin.did);

      // when each operation runs with that grant
      const results = await memberGrantOperations(pds, workspace, { member, admin, outsider });

      // then every operation succeeds
      for (const [operation, result] of Object.entries(results)) st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
      assert.deepEqual(Object.entries(results).filter(([, result]) => !result.ok).map(([operation]) => operation), []);
    });

    await t.test("an app-password session can write and get service tokens but cannot read a space (K7)", async (st) => {
      // given a bot account signed in with an app password and invited to the workspace
      const bot = await appPasswordActor(pds, "k7apppw");
      await workspace.invite(bot.did);
      const [{ mintSpaceCredential }, { sessionClient }, { tidNow }] = await Promise.all([
        import("@/atproto/space-credential"), import("@/atproto/client"), import("@/protocol/keys"),
      ]);
      const session = bearerSession(bot) as never;

      // when it writes into its own repo, asks for a service token, and asks for a space credential
      const results: Record<string, Outcome> = {
        "writes a message into its own repo": await outcome(() => sessionClient(session).procedure("com.atproto.space.createRecord", {
          space: workspace.general, repo: bot.did, collection: "org.slack.channel.message", rkey: tidNow(),
          record: { $type: "org.slack.channel.message", text: "k7 app password", createdAt: new Date().toISOString() },
        })),
        "gets a service token for an operator method": await outcome(async () => {
          const { token } = await sessionClient(session).query<{ token: string }>("com.atproto.server.getServiceAuth", { aud: pds.serviceRef, lxm: "org.slack.operator.getChanges" });
          await verifyServiceToken(token, pds.serviceRef, "org.slack.operator.getChanges");
        }),
      };
      for (const [operation, result] of Object.entries(results)) st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
      const refusal = await mintSpaceCredential(session, workspace.general).then(() => null, (error: unknown) => error);

      // then the write and the token succeed, and its own host refuses the delegation token (pinned getDelegationToken.ts requires ACCESS_FULL)
      assert.deepEqual(Object.entries(results).filter(([, result]) => !result.ok).map(([operation]) => operation), []);
      assert.match(String(refusal), /Bad token scope/);
    });

    await t.test("a bot with its own OAuth session reads, writes, calls the operator and loses access on removal (K7)", async (st) => {
      // given a bot account holding the member grant through OAuth, invited to the workspace
      const bot = await pds.createActor("k7bot", 1);
      await storeOAuthSession(bot.pds, bot.did, await combinedMemberScopes(pds.serviceRef), "k7-bot-dpop");
      await workspace.invite(bot.did);

      // when it uses only that session
      const results = await botOperations(pds, workspace, bot);

      // then each step behaves as the platform needs
      for (const [operation, result] of Object.entries(results)) st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
      assert.deepEqual(Object.entries(results).filter(([, result]) => !result.ok).map(([operation]) => operation), []);
    });
  } finally {
    await pds.close();
  }
});

type Workspace = {
  uri: string;
  inbox: string;
  general: string;
  generalSkey: string;
  invite(did: string): Promise<void>;
  promote(did: string): Promise<void>;
  remove(did: string): Promise<void>;
};

async function createWorkspace(pds: PdsNetwork): Promise<Workspace> {
  const [{ restoreAuthorityGrant }, { bootstrapWorkspace }, { requireActiveWorkspaceAdmin }, { executeOperatorOperation }, { tidNow, inboxUri }] = await Promise.all([
    import("@/operator/authority-grant"), import("@/workspaces/bootstrap"), import("@/operator/security"), import("@/operator/operations"), import("@/protocol/keys"),
  ]);
  const authority = await pds.createActor("k3owner", 0);
  await storeAuthorityGrant(pds.hosts[0], authority.did, "k3-authority-dpop");
  const created = await bootstrapWorkspace(await restoreAuthorityGrant(authority.did), { name: "Capabilities", operationId: tidNow() });
  assert.equal(created.state, "completed");
  const run = async (request: Record<string, unknown>) => {
    const view = await executeOperatorOperation(await requireActiveWorkspaceAdmin(created.workspace, authority.did), tidNow(), request);
    assert.equal(view.state, "completed", `${String(request.kind)} completes`);
  };
  const authorityDid = authority.did;
  const generalSkey = created.channel.split("/").at(-1)!;
  return {
    uri: created.workspace,
    inbox: inboxUri(authorityDid, created.workspace.split("/").at(-1)!),
    general: created.channel,
    generalSkey,
    invite: (did) => run({ kind: "inviteMember", subject: did }),
    promote: (did) => run({ kind: "setAdmin", subject: did, active: true }),
    remove: (did) => run({ kind: "removeMember", subject: did }),
  };
}

async function memberGrantOperations(
  pds: PdsNetwork,
  workspace: Workspace,
  actors: { member: NetworkActor; admin: NetworkActor; outsider: NetworkActor },
): Promise<Record<string, Outcome>> {
  const [{ getOAuthClientForSession }, { discoverWorkspaceState }, { mintSpaceCredential }, { isAccessLost }, { sessionClient }, { readChannelPage }, keys, { validateSpaceRecord }] = await Promise.all([
    import("@/auth/oauth"), import("@/workspaces/read-model"), import("@/atproto/space-credential"), import("@/atproto/space-credential-core"),
    import("@/atproto/client"), import("@/workspaces/channel-sync"), import("@/protocol/keys"), import("@/protocol/records"),
  ]);
  const restore = async (actor: NetworkActor) => (await getOAuthClientForSession(actor.did)).restore(actor.did);
  const member = await restore(actors.member);
  const admin = await restore(actors.admin);
  const outsider = await restore(actors.outsider);
  const authorityDid = keys.parseWorkspaceUri(workspace.uri)!.authorityDid;

  const results: Record<string, Outcome> = {};
  results["accepting the invitation writes the acceptance record"] = await outcome(async () => {
    const rkey = keys.acceptanceRecordKey(workspace.uri);
    const record = { $type: "org.slack.acceptance", workspace: workspace.uri, createdAt: new Date().toISOString() };
    assert.ok(validateSpaceRecord("org.slack.acceptance", record, { authorityDid, spaceUri: workspace.uri, repoDid: member.did, rkey }).valid);
    await mintSpaceCredential(member, workspace.uri);
    await sessionClient(member).procedure("com.atproto.space.putRecord", { space: workspace.uri, repo: member.did, collection: "org.slack.acceptance", rkey, record });
  });
  // Discovery finds a workspace through the member's own acceptance record (the protocol has no "spaces I was added to").
  results["discovery lists the accepted workspace"] = await outcome(async () => {
    const found = await discoverWorkspaceState(member);
    assert.ok(found.workspaces.some((entry) => entry.uri === workspace.uri), "the accepted workspace is listed");
  });
  results["writing a channel message"] = await outcome(async () => {
    await mintSpaceCredential(member, workspace.general);
    const record = { $type: "org.slack.channel.message", text: "k3 hello", createdAt: new Date().toISOString() };
    await sessionClient(member).procedure("com.atproto.space.createRecord", { space: workspace.general, repo: member.did, collection: "org.slack.channel.message", rkey: keys.tidNow(), record });
  });
  results["reading the channel page"] = await outcome(async () => {
    // The authority lists a writer once its host has delivered the write notice, which is asynchronous.
    for (let attempt = 0; ; attempt += 1) {
      const page = await readChannelPage(member, workspace.uri, workspace.generalSkey);
      if (page.messages.some((message) => message.value.text === "k3 hello")) return;
      assert.ok(attempt < 20, "the member's own message is read back");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  const requestKey = keys.requestRecordKey(workspace.general, member.did);
  results["a member files a join request in the inbox"] = await outcome(async () => {
    const record = { $type: "org.slack.joinRequest", channelSkey: workspace.generalSkey, requestId: keys.tidNow(), createdAt: new Date().toISOString() };
    assert.ok(validateSpaceRecord("org.slack.joinRequest", record, { authorityDid, spaceUri: workspace.inbox, repoDid: member.did, rkey: requestKey }).valid);
    await sessionClient(member).procedure("com.atproto.space.putRecord", { space: workspace.inbox, repo: member.did, collection: "org.slack.joinRequest", rkey: requestKey, record });
  });
  results["an admin reads that request from the inbox (MAC-verified)"] = await outcome(async () => {
    const credential = await mintSpaceCredential(admin, workspace.inbox);
    const request = await credential.client(actors.member.pds.url).query<{ value: { channelSkey?: string } }>("com.atproto.space.getRecord", {
      space: workspace.inbox, repo: member.did, collection: "org.slack.joinRequest", rkey: requestKey,
    });
    assert.equal(request.value.channelSkey, workspace.generalSkey);
  });
  const callOperator = (method: (typeof SERVICE_METHODS_TODAY)[number], query: Record<string, string>, body?: unknown) =>
    callOperatorMethod(admin, pds.serviceRef, method, query, body);
  const operationId = keys.tidNow();
  results["the admin calls org.slack.operator.execute"] = await outcome(async () => {
    const answer = await callOperator("org.slack.operator.execute", {}, {
      workspace: workspace.uri, operationId, request: { kind: "createChannel", skey: `k3-${operationId}`, name: "k3", visibility: "public" },
    }) as { operation?: { state?: string } };
    assert.equal(answer.operation?.state, "completed");
  });
  results["the admin calls org.slack.operator.getOperation"] = await outcome(async () => {
    const answer = await callOperator("org.slack.operator.getOperation", { workspace: workspace.uri, operationId }) as { operation?: { state?: string } };
    assert.equal(answer.operation?.state, "completed");
  });
  results["the admin calls org.slack.operator.listInboxWriters"] = await outcome(async () => {
    const answer = await callOperator("org.slack.operator.listInboxWriters", { workspace: workspace.uri }) as { writers?: string[] };
    assert.ok(answer.writers?.includes(member.did), "the member who filed a request is an inbox writer");
  });
  for (const method of SERVICE_METHODS_PLANNED) {
    results[`service token for not-yet-built ${method} is issued and verified`] = await outcome(async () => {
      const token = await sessionClient(admin).query<{ token: string }>("com.atproto.server.getServiceAuth", { aud: pds.serviceRef, lxm: method });
      await verifyServiceToken(token.token, pds.serviceRef, method);
    });
  }
  results["a non-member holding the grant is refused a credential"] = await outcome(async () => {
    const refusal = await mintSpaceCredential(outsider, workspace.uri).then(() => null, (error: unknown) => error);
    assert.ok(refusal && isAccessLost(refusal), "the authority refuses a credential to an account outside the member list");
  });
  results["direct messages: enable, start, accept, send, read"] = await outcome(async () => {
    const memberDm = await dmClientFor(pds, member.did, sessionClient(member));
    const adminDm = await dmClientFor(pds, admin.did, sessionClient(admin));
    await memberDm.enableDms("everyone");
    const started = await adminDm.startConversation([member.did]);
    assert.equal(started.delivery[member.did]?.status, "delivered");
    const [request] = await memberDm.listRequests();
    assert.ok(request, "the request reaches the member's inbox");
    await memberDm.accept(request);
    await memberDm.send(started.convKey, "k3 dm reply");
    const page = await adminDm.readConversation(started.convKey, started.participants);
    assert.ok(page.messages.some((message) => message.text === "k3 dm reply"));
  });
  return results;
}

async function botOperations(pds: PdsNetwork, workspace: Workspace, bot: NetworkActor): Promise<Record<string, Outcome>> {
  const [{ getOAuthClientForSession }, { mintSpaceCredential }, { isAccessLost }, { sessionClient }, { resolvePds }, keys] = await Promise.all([
    import("@/auth/oauth"), import("@/atproto/space-credential"), import("@/atproto/space-credential-core"), import("@/atproto/client"), import("@/atproto/identity"), import("@/protocol/keys"),
  ]);
  const session = await (await getOAuthClientForSession(bot.did)).restore(bot.did);
  const results: Record<string, Outcome> = {};
  let messageUri = "";
  results["mints a channel credential (getDelegationToken, getSpaceCredential)"] = await outcome(() => mintSpaceCredential(session, workspace.general));
  results["writes a message into its own repo in the channel"] = await outcome(async () => {
    const record = { $type: "org.slack.channel.message", text: "k7 bot", createdAt: new Date().toISOString() };
    const created = await sessionClient(session).procedure<unknown, { uri: string }>("com.atproto.space.createRecord", { space: workspace.general, repo: bot.did, collection: "org.slack.channel.message", rkey: keys.tidNow(), record });
    messageUri = created.uri;
  });
  results["reads the message back with a MAC-verified getRecord"] = await outcome(async () => {
    const credential = await mintSpaceCredential(session, workspace.general);
    const parsed = keys.parseSpaceRecordUri(messageUri, workspace.general, "org.slack.channel.message");
    assert.ok(parsed);
    const record = await credential.client(await resolvePds(bot.did)).query<{ value: { text?: string } }>("com.atproto.space.getRecord", {
      space: workspace.general, repo: bot.did, collection: "org.slack.channel.message", rkey: parsed.rkey,
    });
    assert.equal(record.value.text, "k7 bot");
  });
  results["lists the channel's writers"] = await outcome(async () => {
    const credential = await mintSpaceCredential(session, workspace.general);
    const authority = credential.client(await resolvePds(keys.parseWorkspaceUri(workspace.uri)!.authorityDid));
    // The authority lists a writer once the writer's host has delivered the write notice, which is asynchronous.
    for (let attempt = 0; ; attempt += 1) {
      const listed = await authority.query<{ repos: Array<{ did: string }> }>("com.atproto.space.listRepos", { space: workspace.general, limit: 100 });
      if (listed.repos.some((repo) => repo.did === bot.did)) return;
      assert.ok(attempt < 40, "the authority lists the bot as a writer");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  results["renews its credential and reads with the renewed one"] = await outcome(async () => {
    const first = await mintSpaceCredential(session, workspace.general);
    const second = await mintSpaceCredential(session, workspace.general);
    assert.notEqual(second.token, first.token);
    const parsed = keys.parseSpaceRecordUri(messageUri, workspace.general, "org.slack.channel.message");
    assert.ok(parsed);
    const record = await second.client(await resolvePds(bot.did)).query<{ value: { text?: string } }>("com.atproto.space.getRecord", {
      space: workspace.general, repo: bot.did, collection: "org.slack.channel.message", rkey: parsed.rkey,
    });
    assert.equal(record.value.text, "k7 bot");
  });
  results["gets a service token for an operator method"] = await outcome(async () => {
    const token = await sessionClient(session).query<{ token: string }>("com.atproto.server.getServiceAuth", { aud: pds.serviceRef, lxm: "org.slack.operator.getChanges" });
    await verifyServiceToken(token.token, pds.serviceRef, "org.slack.operator.getChanges");
  });
  results["is refused a credential once removed from the workspace"] = await outcome(async () => {
    await workspace.remove(bot.did);
    const refusal = await mintSpaceCredential(session, workspace.general).then(() => null, (error: unknown) => error);
    assert.ok(refusal && isAccessLost(refusal), "the authority refuses the removed bot");
  });
  return results;
}

async function appPasswordActor(pds: PdsNetwork, name: string): Promise<NetworkActor> {
  const account = await pds.createActor(name, 1);
  const agent = account.pds.getAgent();
  const appPassword = await agent.com.atproto.server.createAppPassword({ name: "bot" }, { headers: { authorization: `Bearer ${account.accessJwt}` } });
  const session = await agent.com.atproto.server.createSession({ identifier: account.handle, password: appPassword.data.password });
  return { ...account, password: appPassword.data.password, accessJwt: session.data.accessJwt };
}

/** A stand-in for an operator method that does not exist yet: verifies audience, method and issuer signature. */
async function verifyServiceToken(token: string, serviceRef: string, method: string): Promise<void> {
  const { getIdResolver } = await import("@/atproto/identity");
  const payload = await verifyJwt(token, serviceRef, method, async (issuer) => getIdResolver().did.resolveAtprotoKey(issuer.split("#", 1)[0]!));
  assert.equal(payload.lxm, method);
}

async function dmClientFor(pds: PdsNetwork, did: string, memberClient: import("@/atproto/xrpc").AtprotoClient) {
  const [{ DmClient }, { kemKeyFromDidDocument }, { generateSpaceKey }, { resolvePds, getIdResolver }] = await Promise.all([
    import("@/dm/dm-client"), import("@/atproto/kem-key"), import("@/atproto/space-key"), import("@/atproto/identity"),
  ]);
  const store = new Map<string, string>();
  return new DmClient({
    did,
    memberClient,
    resolvePds,
    resolveKemKey: async (subject, forceRefresh) => kemKeyFromDidDocument(subject, await getIdResolver().did.resolve(subject, forceRefresh) as { verificationMethod?: unknown }),
    fetchEndpoint: (request) => fetch(request),
    generateKey: generateSpaceKey,
    store: {
      async get(key) { return store.get(key) ?? null; },
      async set(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  });
}
