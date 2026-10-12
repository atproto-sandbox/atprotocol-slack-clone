import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Keypair } from "@atproto/crypto";
import { createFixtureTempRoot } from "../fixture-temp";

// A complete local stack for driving the real app: two in-memory PDS hosts plus a PLC directory from the
// pinned atproto checkout, this app's lexicons published to the fixture's lexicon authority, and `next start`
// serving the production build against them. Nothing here touches the real network or any real account.

export const FIXTURE_PASSWORD = "fixture-pass";

type TestAgent = {
  com: { atproto: { server: {
    createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
    createSession(input: Record<string, unknown>): Promise<{ data: { accessJwt: string } }>;
  }; repo: { createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown> } } };
};
type TestPds = { url: string; getAgent(): TestAgent; ctx: { actorStore: { keypair(did: string): Promise<Keypair> } } };
type TestNetwork = { pds: TestPds; extraPdses: TestPds[]; plc: { url: string }; close(): Promise<void>; lexiconAuthority?: { did: string } };

export type FixtureAccount = { handle: string; did: string; password: string; host: 0 | 1; pdsUrl: string; accessJwt: string };

export type SecondApp = { appUrl: URL; databasePath: string; serverOutput(): string };

export type AppFixture = {
  appUrl: URL;
  databasePath: string;
  plcUrl: string;
  pdsUrls: readonly [string, string];
  createAccount(handle: string, host: 0 | 1, password?: string): Promise<FixtureAccount>;
  /** A second, fully independent app instance (own port, own database, own encryption key) on the same PDS network. */
  startSecondApp(options?: { env?: Record<string, string> }): Promise<SecondApp>;
  /** The credential's own header and claims, re-signed with new claims by the authority's signing key on `authorityHost`: a genuinely expired (or extended) credential that keeps its jti and DPoP binding. */
  resignSpaceCredential(authorityHost: 0 | 1, credential: string, claims: { exp: number }): Promise<string>;
  serverOutput(): string;
  stop(): Promise<void>;
};

export function pinnedCheckoutPath(): string {
  return resolve(process.env.ATPROTO_PINNED_CHECKOUT ?? join(process.cwd(), "../atproto-spaces-phase0"));
}

/** Starts the stack. `preferredPort` is used when free; otherwise any free port. Always call `stop()`. */
export async function startAppFixture(options: { preferredPort?: number } = {}): Promise<AppFixture> {
  const projectRoot = process.cwd();
  const pinnedCheckout = pinnedCheckoutPath();
  if (!existsSync(join(pinnedCheckout, "packages/dev-env/src/index.ts"))) {
    throw new Error(`Set ATPROTO_PINNED_CHECKOUT to the built pinned atproto checkout (looked in ${pinnedCheckout}).`);
  }
  const { TestNetworkNoAppView } = await import(pathToFileURL(join(pinnedCheckout, "packages/dev-env/src/index.ts")).href) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean }): Promise<TestNetwork> };
  };
  const fixtureTemp = createFixtureTempRoot("slack-app-fixture-");
  const scratchDirectory = mkdtempSync(join(tmpdir(), "slack-app-fixture-app-"));
  let network: TestNetwork | undefined;
  const servers: Array<{ child: ChildProcess; output: () => string }> = [];

  // If the runner dies without calling stop(), do not orphan any app server.
  const killOnExit = () => {
    for (const { child } of servers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const killOnSignal = (signal: NodeJS.Signals) => { killOnExit(); process.kill(process.pid, signal); };
  const onTerm = () => killOnSignal("SIGTERM");
  const onHangup = () => killOnSignal("SIGHUP");
  process.once("exit", killOnExit);
  process.once("SIGTERM", onTerm);
  process.once("SIGHUP", onHangup);

  const stop = async (): Promise<void> => {
    process.off("exit", killOnExit);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHangup);
    try {
      await Promise.all(servers.map(({ child }) => stopServer(child)));
      await network?.close();
    } finally {
      rmSync(scratchDirectory, { recursive: true, force: true });
      fixtureTemp.cleanup();
    }
  };

  try {
    const net = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true });
    network = net;
    await publishAppLexicons(net, projectRoot);
    const hosts = [net.pds, net.extraPdses[0]!] as const;

    const launch = async (name: string, preferredPort?: number, extraEnv: Record<string, string> = {}): Promise<SecondApp> => {
      const app = await spawnApp(net, projectRoot, scratchDirectory, name, preferredPort, extraEnv);
      servers.push({ child: app.child, output: app.serverOutput });
      return app;
    };
    const primary = await launch("app", options.preferredPort);

    return {
      appUrl: primary.appUrl,
      databasePath: primary.databasePath,
      plcUrl: net.plc.url,
      pdsUrls: [hosts[0].url, hosts[1].url],
      async createAccount(handle, host, password = FIXTURE_PASSWORD) {
        const created = await hosts[host].getAgent().com.atproto.server.createAccount({
          handle, email: `${handle}@fixture.test`, password,
        });
        return { handle, did: created.data.did, password, host, pdsUrl: hosts[host].url, accessJwt: created.data.accessJwt };
      },
      startSecondApp: (secondOptions) => launch(`second-app-${servers.length}`, undefined, secondOptions?.env),
      async resignSpaceCredential(authorityHost, credential, claims) {
        const [header, payload] = credential.split(".");
        if (!header || !payload) throw new Error("A space credential is a three-part JWT.");
        const signed = { ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string }, ...claims };
        const signingInput = `${header}.${Buffer.from(JSON.stringify(signed), "utf8").toString("base64url")}`;
        const keypair = await hosts[authorityHost].ctx.actorStore.keypair(signed.iss);
        return `${signingInput}.${Buffer.from(await keypair.sign(new TextEncoder().encode(signingInput))).toString("base64url")}`;
      },
      serverOutput: primary.serverOutput,
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

type SpawnedApp = SecondApp & { child: ChildProcess };

async function spawnApp(network: TestNetwork, projectRoot: string, scratchDirectory: string, name: string, preferredPort?: number, extraEnv: Record<string, string> = {}): Promise<SpawnedApp> {
  const port = await choosePort(preferredPort);
  const appUrl = new URL(`http://127.0.0.1:${port}`);
  const databasePath = join(scratchDirectory, `${name}.db`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: appUrl.origin,
    DATABASE_PATH: databasePath,
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PLC_URL: network.plc.url,
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${port}#atproto_slack_admin`,
    ...extraEnv,
  };
  const child = spawn(process.execPath, [
    join(projectRoot, "node_modules/next/dist/bin/next"),
    "start", "--hostname", "127.0.0.1", "--port", String(port),
  ], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const capture = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-20_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const serverOutput = () => output;
  try {
    await waitForApp(appUrl, child, serverOutput);
  } catch (error) {
    await stopServer(child);
    throw error;
  }
  return { appUrl, databasePath, serverOutput, child };
}

async function publishAppLexicons(fixture: TestNetwork, projectRoot: string): Promise<void> {
  if (!fixture.lexiconAuthority) throw new Error("The fixture must expose its lexicon authority.");
  const agent = fixture.pds.getAgent();
  const session = await agent.com.atproto.server.createSession({ identifier: "lex-authority.test", password: "hunter2" });
  const root = join(projectRoot, "lexicons/org/slack");
  const files = await readdir(root, { recursive: true });
  const published = new Set<string>();
  for (const relative of files.filter((file) => file.endsWith(".json"))) {
    const lexicon = JSON.parse(await readFile(join(root, relative), "utf8")) as { id: string };
    if (published.has(lexicon.id)) continue;
    published.add(lexicon.id);
    await agent.com.atproto.repo.createRecord({
      repo: fixture.lexiconAuthority.did,
      collection: "com.atproto.lexicon.schema",
      rkey: lexicon.id,
      record: lexicon,
    }, { headers: { authorization: `Bearer ${session.data.accessJwt}` } });
  }
}

async function choosePort(preferred?: number): Promise<number> {
  for (const port of preferred === undefined ? [0] : [preferred, 0]) {
    const listener = createServer();
    const bound = await new Promise<number | null>((resolveBound) => {
      listener.once("error", () => resolveBound(null));
      listener.listen(port, "127.0.0.1", () => {
        const address = listener.address();
        resolveBound(address && typeof address !== "string" ? address.port : null);
      });
    });
    if (bound !== null) {
      await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
      return bound;
    }
  }
  throw new Error("No free local port.");
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
  });
}

async function waitForApp(url: URL, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited before becoming ready.\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Next server did not become ready.\n${output()}`);
}
