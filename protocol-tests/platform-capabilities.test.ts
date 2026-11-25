import assert from "node:assert/strict";
import test from "node:test";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { verifyJwt } from "@atproto/xrpc-server";
import {
  actorTransport,
  bearerSession,
  callOperatorMethod,
  combinedMemberScopes,
  createOpenSocialGroup,
  inProcessOperator,
  mintBrowserSession,
  outcome,
  startPdsNetwork,
  type NetworkActor,
  type Outcome,
  type PdsNetwork,
} from "./support/pds-network";

// K3 and K7 of `.ai/plans/platform-refactor.md` updated for R13 OpenSocial groups: capability checks against the pinned PDS
// and Group Host that the browser personal-PDS member session and bot OAuth sessions depend on.

test("platform capabilities at the pinned PDS and OpenSocial Group Host (K3, K7)", async (t) => {
  const pds = await startPdsNetwork("platform-capabilities");
  try {
    const workspace = await createTestWorkspace(pds);

    await t.test("one browser grant carries every member, admin, operator, invites and DM operation (K3)", async (st) => {
      const scopes = await combinedMemberScopes(pds.serviceRef);
      const member = await pds.createActor("k3member", 1);
      const admin = await pds.createActor("k3admin", 1);
      const outsider = await pds.createActor("k3outsider", 0);
      const [memberGrant, adminGrant, outsiderGrant] = await Promise.all(
        [member, admin, outsider].map((actor) => mintBrowserSession(actor.pds, actor.did, scopes, `k3-${actor.handle}`)),
      );
      await workspace.invite(member.did);
      await workspace.invite(admin.did);
      await workspace.promote(admin.did);

      const results = await memberGrantOperations(pds, workspace, [
        { actor: member, session: memberGrant!.session },
        { actor: admin, session: adminGrant!.session },
        { actor: outsider, session: outsiderGrant!.session },
      ]);

      for (const [operation, result] of Object.entries(results)) {
        st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
      }
      assert.deepEqual(
        Object.entries(results)
          .filter(([, result]) => !result.ok)
          .map(([operation]) => operation),
        [],
      );
    });

    await t.test("an app-password session can get service tokens, while account-authenticated space writes and delegation tokens are refused with Bad token scope (K7, #5923)", async (st) => {
      const bot = await appPasswordActor(pds, "k7apppw");
      await workspace.invite(bot.did);
      const [{ mintSpaceCredential }, { sessionClient }, { XrpcError }, { tidNow }] = await Promise.all([
        import("@flock/operator/atproto/space-credential"),
        import("@flock/operator/atproto/client"),
        import("@flock/protocol/atproto/xrpc"),
        import("@flock/protocol/keys"),
      ]);
      const session = bearerSession(bot) as never;

      const results: Record<string, Outcome> = {
        "gets a service token for an operator method": await outcome(async () => {
          const { token } = await sessionClient(session).query<{ token: string }>("com.atproto.server.getServiceAuth", {
            aud: pds.serviceRef,
            lxm: "new.flock.operator.getChanges",
          });
          await verifyServiceToken(token, pds.serviceRef, "new.flock.operator.getChanges");
        }),
      };
      for (const [operation, result] of Object.entries(results)) {
        st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
      }

      const writeRefusal = await sessionClient(session)
        .procedure("com.atproto.space.createRecord", {
          space: workspace.general,
          repo: bot.did,
          collection: "new.flock.channel.message",
          rkey: tidNow(),
          record: { $type: "new.flock.channel.message", text: "k7 app password", createdAt: new Date().toISOString() },
        })
        .then(() => null, (error: unknown) => error);
      const delegationRefusal = await sessionClient(session)
        .query("com.atproto.space.getDelegationToken", {
          space: workspace.general,
        })
        .then(() => null, (error: unknown) => error);
      const credentialRefusal = await mintSpaceCredential(session, workspace.general).then(
        () => null,
        (error: unknown) => error,
      );

      assert.deepEqual(
        Object.entries(results)
          .filter(([, result]) => !result.ok)
          .map(([operation]) => operation),
        [],
      );
      assert.ok(
        writeRefusal instanceof XrpcError && writeRefusal.code === "InvalidToken",
        `expected InvalidToken on createRecord, got: ${String(writeRefusal)}`,
      );
      assert.match(writeRefusal.message, /Bad token scope/);
      assert.ok(
        delegationRefusal instanceof XrpcError && delegationRefusal.code === "InvalidToken",
        `expected InvalidToken on getDelegationToken, got: ${String(delegationRefusal)}`,
      );
      assert.match(delegationRefusal.message, /Bad token scope/);
      assert.match(String(credentialRefusal), /Bad token scope/);
    });

    await t.test("a bot with its own OAuth session reads, writes, calls the operator and loses access on removal (K7)", async (st) => {
      const bot = await pds.createActor("k7bot", 1);
      const grant = await mintBrowserSession(bot.pds, bot.did, await combinedMemberScopes(pds.serviceRef), "k7-bot-dpop");
      await workspace.invite(bot.did);

      const results = await botOperations(pds, workspace, bot, grant.session);

      for (const [operation, result] of Object.entries(results)) {
        st.diagnostic(`${operation}: ${result.ok ? "ok" : result.error}`);
      }
      assert.deepEqual(
        Object.entries(results)
          .filter(([, result]) => !result.ok)
          .map(([operation]) => operation),
        [],
      );
    });
  } finally {
    await pds.close();
  }
});

type Workspace = {
  uri: string;
  groupDid: string;
  inbox: string;
  general: string;
  generalSkey: string;
  invite(did: string): Promise<void>;
  promote(did: string): Promise<void>;
  remove(did: string): Promise<void>;
};

async function createTestWorkspace(pds: PdsNetwork): Promise<Workspace> {
  const [
    { restoreAuthorityGrant },
    { grantCreationAuthorization },
    { createWorkspace },
    { requireActiveWorkspaceAdmin },
    { executeOperatorOperation },
    { tidNow, inboxUri },
  ] = await Promise.all([
    import("@flock/operator/operator/authority-grant"),
    import("@flock/operator/operator/creation-authorization"),
    import("@flock/operator/operator/kinds/create-workspace"),
    import("@flock/operator/operator/security"),
    import("@flock/operator/operator/operations"),
    import("@flock/protocol/keys"),
  ]);
  const owner = await pds.createActor("k3owner", 0);
  const group = await createOpenSocialGroup(pds, owner, { name: "Capabilities", keyLabel: "k3-authority-dpop" });
  grantCreationAuthorization(
    { authorityDid: group.groupDid, initiatorDid: owner.did, name: "Capabilities" },
    Math.floor(Date.now() / 1000),
  );
  const created = await createWorkspace(await restoreAuthorityGrant(group.groupDid), {
    creator: owner.did,
    name: "Capabilities",
    operationId: tidNow(),
  });
  assert.equal(created.state, "completed");
  const run = async (request: Record<string, unknown>) => {
    const view = await executeOperatorOperation(
      await requireActiveWorkspaceAdmin(created.workspace, owner.did),
      tidNow(),
      request,
    );
    assert.equal(view.state, "completed", `${String(request.kind)} completes`);
  };
  const generalSkey = created.channel.split("/").at(-1)!;
  return {
    uri: created.workspace,
    groupDid: group.groupDid,
    inbox: inboxUri(group.groupDid, created.workspace.split("/").at(-1)!),
    general: created.channel,
    generalSkey,
    invite: (did) => run({ kind: "inviteMember", subject: did }),
    promote: (did) => run({ kind: "setAdmin", subject: did, active: true }),
    remove: (did) => run({ kind: "removeMember", subject: did }),
  };
}

type GrantHolder = { actor: NetworkActor; session: OAuthSession };

async function memberGrantOperations(
  pds: PdsNetwork,
  workspace: Workspace,
  holders: [GrantHolder, GrantHolder, GrantHolder],
): Promise<Record<string, Outcome>> {
  const [{ createEngine }, { isAccessLost }, { sessionClient }, keys, { OPENSOCIAL_COLLECTION }, { validateSpaceRecord }] =
    await Promise.all([
      import("@flock/client/engine"),
      import("@flock/protocol/atproto/space-credential-core"),
      import("@flock/operator/atproto/client"),
      import("@flock/protocol/keys"),
      import("@flock/protocol/nsids"),
      import("@flock/protocol/registry"),
    ]);
  const operatorEndpoint = await inProcessOperator();
  const engineFor = ({ actor, session }: GrantHolder) =>
    createEngine(
      { ...actorTransport(pds, actor), memberClient: sessionClient(session) },
      { operator: { serviceRef: pds.serviceRef, endpoint: operatorEndpoint } },
    );
  const [memberHolder, adminHolder, outsiderHolder] = holders;
  const [member, admin] = [memberHolder.session, adminHolder.session];
  const [memberEngine, adminEngine, outsiderEngine] = [
    engineFor(memberHolder),
    engineFor(adminHolder),
    engineFor(outsiderHolder),
  ];
  const authorityDid = workspace.groupDid;
  const general = { workspace: workspace.uri, skey: workspace.generalSkey };

  const results: Record<string, Outcome> = {};
  results["accepting the invitation writes the OpenSocial acceptance record"] = await outcome(async () => {
    const accepted = await memberEngine.workspaces.accept(workspace.uri);
    assert.equal(
      accepted.marker,
      `${keys.groupMembersUri(authorityDid)}/${member.did}/${OPENSOCIAL_COLLECTION.acceptance}/self`,
    );
  });
  results["discovery lists the accepted workspace"] = await outcome(async () => {
    const found = await memberEngine.workspaces.discover();
    assert.ok(found.workspaces.some((entry) => entry.uri === workspace.uri), "the accepted workspace is listed");
  });
  results["provisioning personal invites space and obtaining getSpaceNotifyTarget"] = await outcome(async () => {
    const space = await memberEngine.workspaces.watchInvites(memberEngine.operator!);
    assert.equal(space, keys.personalInvitesUri(member.did));
  });
  results["writing a channel message"] = await outcome(() => memberEngine.channels.send(general, "k3 hello"));
  results["reading the channel page"] = await outcome(async () => {
    const page = await memberEngine.channels.readPage(general);
    assert.ok(page.messages.some((message) => message.value.text === "k3 hello"), "the member's own message is read back");
  });
  const requestKey = keys.requestRecordKey(workspace.general, member.did);
  results["a member files a join request in the inbox"] = await outcome(async () => {
    const record = {
      $type: "new.flock.joinRequest",
      channelSkey: workspace.generalSkey,
      requestId: keys.tidNow(),
      createdAt: new Date().toISOString(),
    };
    assert.ok(
      validateSpaceRecord("new.flock.joinRequest", record, {
        authorityDid,
        spaceUri: workspace.inbox,
        repoDid: member.did,
        rkey: requestKey,
      }).valid,
    );
    await sessionClient(member).procedure("com.atproto.space.putRecord", {
      space: workspace.inbox,
      repo: member.did,
      collection: "new.flock.joinRequest",
      rkey: requestKey,
      record,
    });
  });
  results["an admin reads that request from the inbox (MAC-verified)"] = await outcome(async () => {
    const client = await adminEngine.credentials.clientFor(workspace.inbox, member.did);
    const request = await client.query<{ value: { channelSkey?: string } }>("com.atproto.space.getRecord", {
      space: workspace.inbox,
      repo: member.did,
      collection: "new.flock.joinRequest",
      rkey: requestKey,
    });
    assert.equal(request.value.channelSkey, workspace.generalSkey);
  });
  const callOperator = (
    method: import("@flock/protocol/nsids").OperatorMethod,
    query: Record<string, string>,
    body?: unknown,
  ) => callOperatorMethod(admin, pds.serviceRef, method, query, body);
  const operationId = keys.tidNow();
  results["the admin calls new.flock.operator.execute"] = await outcome(async () => {
    const answer = (await callOperator("new.flock.operator.execute", {}, {
      workspace: workspace.uri,
      operationId,
      request: { kind: "createChannel", skey: `k3-${operationId}`, name: "k3", visibility: "public" },
    })) as { operation?: { state?: string } };
    assert.equal(answer.operation?.state, "completed");
  });
  results["the admin calls new.flock.operator.getOperation"] = await outcome(async () => {
    const answer = (await callOperator("new.flock.operator.getOperation", {
      workspace: workspace.uri,
      operationId,
    })) as { operation?: { state?: string } };
    assert.equal(answer.operation?.state, "completed");
  });
  results["the admin calls new.flock.operator.getChanges: head at once, and a space it may not follow denied at once"] =
    await outcome(async () => {
      const head = (await callOperator("new.flock.operator.getChanges", {}, { follow: [] })) as { head?: string };
      assert.match(head.head ?? "", /^[a-z][0-9a-z]{2}\.(0|[1-9a-z][0-9a-z]*)\.(0|[1-9a-z][0-9a-z]*)$/);
      const elsewhere = `at:space/${member.did}/new.flock.channel/not-${operationId}`;
      const denied = (await callOperator("new.flock.operator.getChanges", {}, {
        follow: [{ space: elsewhere, after: head.head }],
      })) as { denied?: string[] };
      assert.deepEqual(denied.denied, [elsewhere]);
    });
  results["the admin calls new.flock.operator.listStalledOperations"] = await outcome(async () => {
    const answer = (await callOperator("new.flock.operator.listStalledOperations", {
      workspace: workspace.uri,
    })) as { operations?: unknown[]; registrations?: unknown[] };
    assert.ok(Array.isArray(answer.operations) && Array.isArray(answer.registrations));
  });
  results["the admin calls new.flock.operator.startAuthorityFlow for both reauthorize and createWorkspace"] =
    await outcome(async () => {
      const reauth = (await callOperator("new.flock.operator.startAuthorityFlow", {}, {
        purpose: "reauthorize",
        authority: authorityDid,
      })) as { url?: string };
      assert.match(reauth.url ?? "", /\/authority\/start\?ticket=[A-Za-z0-9_-]+$/);
      const createFlow = (await callOperator("new.flock.operator.startAuthorityFlow", {}, {
        purpose: "createWorkspace",
        name: "K3 Prompt Create",
      })) as { url?: string };
      assert.match(createFlow.url ?? "", /\/authority\/start\?ticket=[A-Za-z0-9_-]+$/);
    });
  results["the admin calls new.flock.operator.createWorkspace and is told authorization is required"] =
    await outcome(async () => {
      const refusal = await callOperator("new.flock.operator.createWorkspace", {}, {
        name: "K3 Admin",
        operationId: keys.tidNow(),
      }).then(() => null, (error: unknown) => error);
      assert.match(
        refusal instanceof Error ? refusal.message : "",
        /answered 403: .*AuthorizationRequired/,
        "the token was accepted; only the group creation approval is missing",
      );
    });
  results["a non-member holding the grant is refused a credential"] = await outcome(async () => {
    const refusal = await outsiderEngine.credentials.fresh(workspace.uri).then(() => null, (error: unknown) => error);
    assert.ok(refusal && isAccessLost(refusal), "the Group Host refuses a credential to an account outside the group");
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

async function botOperations(
  pds: PdsNetwork,
  workspace: Workspace,
  bot: NetworkActor,
  session: OAuthSession,
): Promise<Record<string, Outcome>> {
  const [{ mintSpaceCredential }, { isAccessLost }, { sessionClient }, { resolvePds }, keys] = await Promise.all([
    import("@flock/operator/atproto/space-credential"),
    import("@flock/protocol/atproto/space-credential-core"),
    import("@flock/operator/atproto/client"),
    import("@flock/operator/atproto/identity"),
    import("@flock/protocol/keys"),
  ]);
  const results: Record<string, Outcome> = {};
  let messageUri = "";
  results["mints a channel credential (getDelegationToken, authorizeSpaceSync)"] = await outcome(() =>
    mintSpaceCredential(session, workspace.general),
  );
  results["writes a message into its own repo in the channel"] = await outcome(async () => {
    const record = { $type: "new.flock.channel.message", text: "k7 bot", createdAt: new Date().toISOString() };
    const created = await sessionClient(session).procedure<unknown, { uri: string }>("com.atproto.space.createRecord", {
      space: workspace.general,
      repo: bot.did,
      collection: "new.flock.channel.message",
      rkey: keys.tidNow(),
      record,
    });
    messageUri = created.uri;
  });
  results["reads the message back with a MAC-verified getRecord"] = await outcome(async () => {
    const credential = await mintSpaceCredential(session, workspace.general);
    const parsed = keys.parseSpaceRecordUri(messageUri, workspace.general, "new.flock.channel.message");
    assert.ok(parsed);
    const record = await credential.client(await resolvePds(bot.did)).query<{ value: { text?: string } }>(
      "com.atproto.space.getRecord",
      {
        space: workspace.general,
        repo: bot.did,
        collection: "new.flock.channel.message",
        rkey: parsed.rkey,
      },
    );
    assert.equal(record.value.text, "k7 bot");
  });
  results["lists the channel's writers"] = await outcome(async () => {
    const credential = await mintSpaceCredential(session, workspace.general);
    const authority = credential.client(await resolvePds(workspace.groupDid));
    for (let attempt = 0; ; attempt += 1) {
      const listed = await authority.query<{ repos: Array<{ $type?: string; repo: string }> }>(
        "com.atproto.space.listWriters",
        { space: workspace.general, limit: 100 },
      );
      if (listed.repos.some((entry) => entry.$type === "com.atproto.space.defs#repoWrite" && entry.repo === bot.did)) return;
      assert.ok(attempt < 40, "the authority lists the bot as a writer");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  results["renews its credential and reads with the renewed one"] = await outcome(async () => {
    const first = await mintSpaceCredential(session, workspace.general);
    const second = await mintSpaceCredential(session, workspace.general);
    assert.notEqual(second.token, first.token);
    const parsed = keys.parseSpaceRecordUri(messageUri, workspace.general, "new.flock.channel.message");
    assert.ok(parsed);
    const record = await second.client(await resolvePds(bot.did)).query<{ value: { text?: string } }>(
      "com.atproto.space.getRecord",
      {
        space: workspace.general,
        repo: bot.did,
        collection: "new.flock.channel.message",
        rkey: parsed.rkey,
      },
    );
    assert.equal(record.value.text, "k7 bot");
  });
  results["gets a service token for an operator method"] = await outcome(async () => {
    const token = await sessionClient(session).query<{ token: string }>("com.atproto.server.getServiceAuth", {
      aud: pds.serviceRef,
      lxm: "new.flock.operator.getChanges",
    });
    await verifyServiceToken(token.token, pds.serviceRef, "new.flock.operator.getChanges");
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
  const appPassword = await agent.com.atproto.server.createAppPassword(
    { name: "bot" },
    { headers: { authorization: `Bearer ${account.accessJwt}` } },
  );
  const session = await agent.com.atproto.server.createSession({
    identifier: account.handle,
    password: appPassword.data.password,
  });
  return { ...account, password: appPassword.data.password, accessJwt: session.data.accessJwt };
}

async function verifyServiceToken(token: string, serviceRef: string, method: string): Promise<void> {
  const { getIdResolver } = await import("@flock/operator/atproto/identity");
  const payload = await verifyJwt(token, serviceRef, method, async (issuer) =>
    getIdResolver().did.resolveAtprotoKey(issuer.split("#", 1)[0]!),
  );
  assert.equal(payload.lxm, method);
}

async function dmClientFor(pds: PdsNetwork, did: string, memberClient: import("@flock/protocol/atproto/xrpc").AtprotoClient) {
  void pds;
  const [{ DmClient }, { kemKeyFromDidDocument }, { generateSpaceKey }, { resolvePds, getIdResolver }] = await Promise.all([
    import("@flock/client/dm/dm-client"),
    import("@flock/protocol/atproto/kem-key"),
    import("@flock/protocol/atproto/space-key"),
    import("@flock/operator/atproto/identity"),
  ]);
  const store = new Map<string, string>();
  return new DmClient({
    did,
    memberClient,
    resolvePds,
    resolveKemKey: async (subject, forceRefresh) =>
      kemKeyFromDidDocument(subject, (await getIdResolver().did.resolve(subject, forceRefresh)) as { verificationMethod?: unknown }),
    fetchEndpoint: (request) => fetch(request),
    generateKey: generateSpaceKey,
    store: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    },
  });
}
