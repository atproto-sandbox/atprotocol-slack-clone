import { createServer, type Server } from "node:http";
import { appGrantScope, publishAppDeclaration } from "@flock/client/app-runtime";
import { createEngine } from "@flock/client/engine";
import { answerAppOAuthRoute, appOAuthClient, isSessionLost } from "@flock/client/node/oauth";
import { nodeTransport } from "@flock/client/node/transport";
import type { NodeOAuthClient, OAuthSession } from "@flock/client/node/oauth";
import { readEchoBotConfig, type EchoBotConfig } from "./config";
import { ECHO_BOT_COMMANDS, startEchoBot } from "./echo";
import { failureLine } from "./failure-line";

// `sign-in <handle>` signs the bot's account in once; `run` answers in the workspaces it was installed in. Both serve the
// bot's OAuth client metadata and keys at ECHO_BOT_URL, which the account's PDS reads at sign-in and at every refresh.

const [command, handle] = process.argv.slice(2);
const config = readEchoBotConfig(process.env);
const client = await appOAuthClient({ appUrl: config.appUrl, keys: config.keys, name: "Echo bot", scope: appGrantScope(config.operatorServiceRef), plcUrl: config.plcUrl, stateFile: config.stateFile });

if (command === "sign-in" && handle) await signIn(client, config, handle);
else if (command === "run") await run(client, config);
else {
  process.stderr.write("Usage: echo-bot sign-in <handle> | echo-bot run\n");
  process.exitCode = 2;
}

async function signIn(oauth: NodeOAuthClient, settings: EchoBotConfig, accountHandle: string): Promise<void> {
  let signedIn: (session: OAuthSession) => void = () => undefined;
  const done = new Promise<OAuthSession>((resolve) => { signedIn = resolve; });
  const server = await serve(oauth, settings, signedIn);
  const url = await oauth.authorize(accountHandle, { scope: appGrantScope(settings.operatorServiceRef) });
  process.stdout.write(`Open this page and approve the bot as ${accountHandle}:\n${url.href}\n`);
  const session = await done;
  process.stdout.write(`Signed in. Set ECHO_BOT_DID=${session.did} and run the bot.\n`);
  server.close();
}

async function run(oauth: NodeOAuthClient, settings: EchoBotConfig): Promise<void> {
  if (!settings.did) throw new Error("ECHO_BOT_DID is required: sign the bot in first.");
  if (settings.workspaces.length === 0) throw new Error("ECHO_BOT_WORKSPACES lists the workspaces the bot was installed in.");
  const server = await serve(oauth, settings, () => undefined);
  const transport = nodeTransport(await oauth.restore(settings.did), { plcUrl: settings.plcUrl, loopback: new URL(settings.appUrl).protocol === "http:" });
  const engine = createEngine(transport, { applyOwnWrites: false, operator: { serviceRef: settings.operatorServiceRef, endpoint: settings.operatorUrl } });
  if (!engine.operator) throw new Error("The engine has no operator.");
  await publishAppDeclaration(transport, { name: "Echo", description: "Answers each message with its text.", commands: ECHO_BOT_COMMANDS });
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  await startEchoBot({
    engine: { ...engine, operator: engine.operator },
    did: settings.did,
    workspaces: settings.workspaces,
    signal: controller.signal,
    onError: (error) => {
      process.stderr.write(failureLine(error));
      if (isSessionLost(error)) {
        process.stderr.write("echo-bot: the account's session is gone; sign the bot in again.\n");
        process.exitCode = 1;
        controller.abort();
      }
    },
  });
  server.close();
}

/** Serves the bot's OAuth routes; the sign-in's return hands its session to `signedIn`. */
async function serve(oauth: NodeOAuthClient, settings: EchoBotConfig, signedIn: (session: OAuthSession) => void): Promise<Server> {
  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", settings.appUrl);
    } catch {
      response.writeHead(400).end();
      return;
    }
    answerAppOAuthRoute(oauth, url).then((answer) => {
      if (!answer) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(answer.status, { "content-type": answer.type }).end(answer.body);
      if (answer.session) signedIn(answer.session);
    }, (error: unknown) => {
      process.stderr.write(failureLine(error));
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("The sign-in could not be completed.");
    });
  });
  await new Promise<void>((resolve) => server.listen(settings.port, settings.host, resolve));
  return server;
}
