import { createServer, type Server } from "node:http";
import { appGrantScope, publishAppDeclaration } from "@flock/client/app-runtime";
import { createEngine } from "@flock/client/engine";
import { createAdminIdentityOAuth } from "@flock/client/node/admin-oauth";
import { answerAppOAuthRoute, appOAuthClient, isSessionLost, type NodeOAuthClient, type OAuthSession } from "@flock/client/node/oauth";
import { nodeTransport } from "@flock/client/node/transport";
import { readWebhooksConfig, type WebhooksConfig } from "./config";
import { failureLine } from "./failure-line";
import { HooksStore } from "./hooks-store";
import { listenWebhooksServer } from "./server";

// `sign-in <handle>` signs the webhooks app's own account in once; `run` serves its admin page (`/admin`) and incoming
// webhook endpoint (`POST /hooks/<id>/<secret>`). It declares no slash commands, follows no inbox or channel messages, and
// keeps nothing it sends in memory (`applyOwnWrites: false`).

const [command, handle] = process.argv.slice(2);
const config = readWebhooksConfig(process.env);
const appOAuth = await appOAuthClient({
  appUrl: config.appUrl,
  keys: config.keys,
  name: "Webhooks",
  scope: appGrantScope(config.operatorServiceRef),
  plcUrl: config.plcUrl,
  stateFile: config.stateFile,
});

if (command === "sign-in" && handle) await signIn(appOAuth, config, handle);
else if (command === "run") await run(appOAuth, config);
else {
  process.stderr.write("Usage: webhooks sign-in <handle> | webhooks run\n");
  process.exitCode = 2;
}

async function signIn(oauth: NodeOAuthClient, settings: WebhooksConfig, accountHandle: string): Promise<void> {
  let signedIn: (session: OAuthSession) => void = () => undefined;
  const done = new Promise<OAuthSession>((resolve) => { signedIn = resolve; });
  const server = await serveSignIn(oauth, settings, signedIn);
  const url = await oauth.authorize(accountHandle, { scope: appGrantScope(settings.operatorServiceRef) });
  process.stdout.write(`Open this page and approve the webhooks app as ${accountHandle}:\n${url.href}\n`);
  const session = await done;
  process.stdout.write(`Signed in. Set WEBHOOKS_DID=${session.did} and run the webhooks app.\n`);
  server.close();
}

async function run(oauth: NodeOAuthClient, settings: WebhooksConfig): Promise<void> {
  if (!settings.did) throw new Error("WEBHOOKS_DID is required: sign the webhooks app in first.");
  if (settings.workspaces.length === 0) throw new Error("WEBHOOKS_WORKSPACES lists the workspaces the app was installed in.");
  const adminOAuth = await createAdminIdentityOAuth({
    appUrl: settings.appUrl,
    keys: settings.keys,
    name: "Webhooks Admin",
    plcUrl: settings.plcUrl,
  });
  const transport = nodeTransport(await oauth.restore(settings.did), {
    plcUrl: settings.plcUrl,
    loopback: settings.loopback,
  });
  const engine = createEngine(transport, { applyOwnWrites: false });
  await publishAppDeclaration(transport, {
    name: "Webhooks",
    description: "Posts incoming webhook messages in granted channels.",
  });
  const hooks = new HooksStore(settings.hooksFile);
  const server = await listenWebhooksServer(
    {
      appUrl: settings.appUrl,
      appDid: settings.did,
      workspaces: settings.workspaces,
      engine,
      hooks,
      adminOAuth,
      appOAuth: oauth,
      trustProxy: settings.trustProxy,
      onError: (error) => {
        process.stderr.write(failureLine(error));
        if (isSessionLost(error)) {
          process.stderr.write("webhooks: the account's session is gone; sign the app in again.\n");
          process.exitCode = 1;
          stop();
        }
      },
    },
    { port: settings.port, host: settings.host },
  );
  function stop() {
    server.close();
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
}

async function serveSignIn(
  oauth: NodeOAuthClient,
  settings: WebhooksConfig,
  signedIn: (session: OAuthSession) => void,
): Promise<Server> {
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", settings.appUrl);
    } catch {
      response.writeHead(400).end();
      return;
    }
    answerAppOAuthRoute(oauth, url).then(
      (answer) => {
        if (!answer) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(answer.status, { "content-type": answer.type }).end(answer.body);
        if (answer.session) signedIn(answer.session);
      },
      (error: unknown) => {
        process.stderr.write(failureLine(error));
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("The sign-in could not be completed.");
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(settings.port, settings.host, resolve));
  return server;
}
