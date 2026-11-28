import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Keypair } from "@atproto/crypto";
import BetterSqlite3 from "better-sqlite3";
import { GroupHostCryptoBox } from "@flock/group-host/crypto-box";
import { verifyPinnedCheckout } from "../../scripts/verify-pinned-checkout.mjs";
import { createFixtureTempRoot } from "../fixture-temp";
import { mintAppSession, publishAppLexicons, type OAuthProviderHost } from "./pds-network";

// A complete local stack for driving the real app: two in-memory personal PDS hosts plus a PLC directory from the
// pinned atproto checkout, a dedicated Atmosphere Groups Host (`apps/group-host`) process, both `new.flock.*` and
// `org.atgrp.*` lexicons published to the fixture's lexicon authority, and `next start` + Operator serving
// the production build against them. Personal PDSes never pre-create `org.atgrp.inbox/self`.

export const FIXTURE_PASSWORD = "fixture-pass";

type TestAgent = {
  com: {
    atproto: {
      server: {
        createAccount(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
        createSession(input: Record<string, unknown>): Promise<{ data: { did: string; accessJwt: string } }>;
        createAppPassword(
          input: Record<string, unknown>,
          options: { headers: { authorization: string } },
        ): Promise<{ data: { name: string; password: string } }>;
      };
      repo: {
        createRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown>;
        deleteRecord(input: Record<string, unknown>, options: { headers: { authorization: string } }): Promise<unknown>;
      };
    };
  };
};
type TestPds = { url: string; getAgent(): TestAgent; ctx: { actorStore: { keypair(did: string): Promise<Keypair> } } & OAuthProviderHost["ctx"] };
type TestNetwork = { pds: TestPds; extraPdses: TestPds[]; plc: { url: string }; close(): Promise<void>; lexiconAuthority?: { did: string } };

export type FixtureAccount = { handle: string; did: string; password: string; host: 0 | 1; pdsUrl: string; accessJwt: string };

/** One app: its web process at `appUrl` and its operator's process at `operatorUrl`, with the operator's database. */
export type SecondWebApp = { kind: "web"; appUrl: URL; operatorUrl: URL; databasePath: string; serverOutput(): string };
export type SecondApp = SecondWebApp;
/** Flock Desk: standalone browser client with no Operator process and no server SQLite database. */
export type DeskApp = { kind: "desk"; appUrl: URL; operatorUrl: null; databasePath: null; serverOutput(): string };
export type IndependentSecondApp = SecondWebApp | DeskApp;

export type AppFixture = {
  appUrl: URL;
  operatorUrl: URL;
  groupHostUrl: URL;
  databasePath: string;
  groupHostDatabasePath: string;
  plcUrl: string;
  pdsUrls: readonly [string, string];
  createAccount(handle: string, host: 0 | 1, password?: string): Promise<FixtureAccount>;
  /** An app account's own OAuth session with the app's grant, restored through the app's OAuth client and `stateFile`, as its sign-in leaves it. */
  appSession(account: FixtureAccount, serviceRef: string, stateFile: string): ReturnType<typeof mintAppSession>;
  /** A second, fully independent `@flock/web` + Operator app instance on the same PDS + Group Host network. */
  startSecondApp(options?: { env?: Record<string, string> }): Promise<SecondApp>;
  /** Starts Flock Desk (`apps/desk`) on a dynamic origin with zero Operator process and zero SQLite database. */
  startDeskApp(options?: { env?: Record<string, string> }): Promise<DeskApp>;
  /** Re-signs a space credential with updated claims using either `<groupDid>`'s key on Group Host or a personal account's key on `authorityHost`. */
  resignSpaceCredential(authorityHost: 0 | 1, credential: string, claims: { exp: number }): Promise<string>;
  serverOutput(): string;
  stop(): Promise<void>;
};

export function pinnedCheckoutPath(): string {
  const candidate = resolve(
    process.env.ATPROTO_PINNED_CHECKOUT ?? process.env.ATPROTO_PIN_CHECKOUT ?? join(process.cwd(), "../atproto-spaces-r12"),
  );
  if (!existsSync(join(candidate, "packages/dev-env/src/index.ts"))) {
    throw new Error(`Set ATPROTO_PINNED_CHECKOUT to the built pinned atproto checkout (looked in ${candidate}).`);
  }
  return verifyPinnedCheckout(candidate);
}

/** Starts the stack. `preferredPort` is used when free; otherwise any free port. Always call `stop()`. */
export async function startAppFixture(options: { preferredPort?: number } = {}): Promise<AppFixture> {
  const projectRoot = process.cwd();
  const pinnedCheckout = pinnedCheckoutPath();
  const { TestNetworkNoAppView } = (await import(pathToFileURL(join(pinnedCheckout, "packages/dev-env/src/index.ts")).href)) as {
    TestNetworkNoAppView: { create(options: { extraPdses: number; lexiconAuthority: boolean }): Promise<TestNetwork> };
  };
  const fixtureTemp = createFixtureTempRoot("slack-app-fixture-");
  const scratchDirectory = mkdtempSync(join(tmpdir(), "slack-app-fixture-app-"));
  let network: TestNetwork | undefined;
  const servers: Array<{ child: ChildProcess; output: () => string }> = [];

  const killOnExit = () => {
    for (const { child } of servers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const killOnSignal = (signal: NodeJS.Signals) => {
    killOnExit();
    process.kill(process.pid, signal);
  };
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
    await publishAppLexicons(net as never, projectRoot);
    const hosts = [net.pds, net.extraPdses[0]!] as const;

    const groupHostPort = await choosePort();
    const groupHostUrl = new URL(`http://127.0.0.1:${groupHostPort}`);
    const groupHostDatabasePath = join(scratchDirectory, "group-host.db");
    const groupHostEncryptionKey = randomBytes(32).toString("hex");
    const groupHostChild = await spawnGroupHost(projectRoot, {
      groupHostUrl,
      groupHostDatabasePath,
      groupHostEncryptionKey,
      plcUrl: net.plc.url,
    });
    servers.push({ child: groupHostChild.child, output: groupHostChild.output });

    const launch = async (name: string, preferredPort?: number, extraEnv: Record<string, string> = {}): Promise<SecondApp> => {
      const app = await spawnApp(net, projectRoot, scratchDirectory, name, groupHostUrl, groupHostChild.output, preferredPort, extraEnv);
      for (const child of app.children) servers.push({ child, output: app.serverOutput });
      return app;
    };
    const launchDesk = async (extraEnv: Record<string, string> = {}): Promise<DeskApp> => {
      const desk = await spawnDesk(net, projectRoot, groupHostUrl, groupHostChild.output, extraEnv);
      servers.push({ child: desk.child, output: desk.serverOutput });
      return {
        kind: "desk",
        appUrl: desk.appUrl,
        operatorUrl: null,
        databasePath: null,
        serverOutput: desk.serverOutput,
      };
    };
    const primary = await launch("app", options.preferredPort);

    return {
      appUrl: primary.appUrl,
      operatorUrl: primary.operatorUrl,
      groupHostUrl,
      databasePath: primary.databasePath,
      groupHostDatabasePath,
      plcUrl: net.plc.url,
      pdsUrls: [hosts[0].url, hosts[1].url],
      async createAccount(handle, host, password = FIXTURE_PASSWORD) {
        const created = await hosts[host].getAgent().com.atproto.server.createAccount({
          handle,
          email: `${handle}@fixture.test`,
          password,
        });
        return { handle, did: created.data.did, password, host, pdsUrl: hosts[host].url, accessJwt: created.data.accessJwt };
      },
      appSession: (account, serviceRef, stateFile) =>
        mintAppSession(hosts[account.host], account.did, { serviceRef, plcUrl: net.plc.url, stateFile }, `app-${account.handle}`),
      startSecondApp: (secondOptions) => launch(`second-app-${servers.length}`, undefined, secondOptions?.env),
      startDeskApp: (deskOptions) => launchDesk(deskOptions?.env),
      async resignSpaceCredential(authorityHost, credential, claims) {
        const [header, payload] = credential.split(".");
        if (!header || !payload) throw new Error("A space credential is a three-part JWT.");
        const signed = { ...(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string }), ...claims };
        const signingInput = `${header}.${Buffer.from(JSON.stringify(signed), "utf8").toString("base64url")}`;

        let keypair: Keypair | undefined;
        if (existsSync(groupHostDatabasePath)) {
          const ghDb = new BetterSqlite3(groupHostDatabasePath, { readonly: true, fileMustExist: true });
          try {
            const row = ghDb
              .prepare("SELECT signing_key_enc FROM group_account WHERE did = ?")
              .get(signed.iss) as { signing_key_enc: string } | undefined;
            if (row) {
              const cryptoBox = new GroupHostCryptoBox(groupHostEncryptionKey);
              keypair = await cryptoBox.decryptKeypair("group_account", signed.iss, "signing_key_enc", row.signing_key_enc);
            }
          } finally {
            ghDb.close();
          }
        }
        keypair ??= await hosts[authorityHost].ctx.actorStore.keypair(signed.iss);
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

async function spawnGroupHost(
  projectRoot: string,
  params: { groupHostUrl: URL; groupHostDatabasePath: string; groupHostEncryptionKey: string; plcUrl: string },
): Promise<{ child: ChildProcess; output: () => string }> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    ATPROTO_ACCEPTANCE_TEST: "true",
    GROUP_HOST_URL: params.groupHostUrl.origin,
    GROUP_HOST_DATABASE_PATH: params.groupHostDatabasePath,
    GROUP_HOST_ENCRYPTION_KEY: params.groupHostEncryptionKey,
    GROUP_HOST_HANDLE_DOMAIN: "groups.localhost",
    PLC_URL: params.plcUrl,
  };
  const child = spawn(process.execPath, ["--import", "tsx", join(projectRoot, "apps/group-host/src/main.ts")], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out = `${out}${chunk}`.slice(-20_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    out = `${out}${chunk}`.slice(-20_000);
  });
  const output = () => out;
  try {
    await waitForReady(new URL("/.well-known/did.json", params.groupHostUrl), child, output, "The Group Host");
  } catch (error) {
    await stopServer(child);
    throw error;
  }
  return { child, output };
}

type SpawnedApp = SecondApp & { children: ChildProcess[] };

async function spawnApp(
  network: TestNetwork,
  projectRoot: string,
  scratchDirectory: string,
  name: string,
  groupHostUrl: URL,
  groupHostOutput: () => string,
  preferredPort?: number,
  extraEnv: Record<string, string> = {},
): Promise<SpawnedApp> {
  const port = await choosePort(preferredPort);
  const operatorPort = await choosePort();
  const appUrl = new URL(`http://127.0.0.1:${port}`);
  const operatorUrl = new URL(`http://127.0.0.1:${operatorPort}`);
  const databasePath = join(scratchDirectory, `${name}.db`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    APP_URL: appUrl.origin,
    OPERATOR_URL: operatorUrl.origin,
    GROUP_HOST_URL: groupHostUrl.origin,
    DATABASE_PATH: databasePath,
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PLC_URL: network.plc.url,
    OPERATOR_SERVICE_REF: `did:web:localhost%3A${operatorPort}#atproto_flock_operator`,
    ...extraEnv,
  };
  const operator = spawn(process.execPath, ["--import", "tsx", join(projectRoot, "apps/operator/src/operator/main.ts")], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = spawn(
    process.execPath,
    [join(projectRoot, "apps/web/node_modules/next/dist/bin/next"), "start", "apps/web", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let operatorOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk}`.slice(-20_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk}`.slice(-20_000);
  });
  operator.stdout?.on("data", (chunk: Buffer) => {
    operatorOutput = `${operatorOutput}${chunk}`.slice(-20_000);
  });
  operator.stderr?.on("data", (chunk: Buffer) => {
    operatorOutput = `${operatorOutput}${chunk}`.slice(-20_000);
  });
  const serverOutput = () => `${output}\n--- operator ---\n${operatorOutput}\n--- group-host ---\n${groupHostOutput()}`;
  try {
    await waitForReady(new URL("/.well-known/did.json", operatorUrl), operator, serverOutput, "The operator");
    await waitForReady(appUrl, child, serverOutput, "The Next server");
  } catch (error) {
    await Promise.all([stopServer(child), stopServer(operator)]);
    throw error;
  }
  return { kind: "web", appUrl, operatorUrl, databasePath, serverOutput, children: [child, operator] };
}

async function spawnDesk(
  network: TestNetwork,
  projectRoot: string,
  groupHostUrl: URL,
  groupHostOutput: () => string,
  extraEnv: Record<string, string> = {},
): Promise<{ appUrl: URL; serverOutput: () => string; child: ChildProcess }> {
  const port = await choosePort();
  const appUrl = new URL(`http://127.0.0.1:${port}`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ATPROTO_ACCEPTANCE_TEST: "true",
    PLC_URL: network.plc.url,
    GROUP_HOST_URL: groupHostUrl.origin,
    ...extraEnv,
    // Always override DESK_APP_URL and APP_URL to the bound dynamic origin so developer `.env` cannot hijack it.
    DESK_APP_URL: appUrl.origin,
    APP_URL: appUrl.origin,
  };
  const child = spawn(
    process.execPath,
    [join(projectRoot, "apps/desk/node_modules/next/dist/bin/next"), "start", "apps/desk", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk}`.slice(-20_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk}`.slice(-20_000);
  });
  const serverOutput = () => `${output}\n--- group-host ---\n${groupHostOutput()}`;
  try {
    await waitForReady(new URL("/oauth/client-metadata.json", appUrl), child, serverOutput, "Flock Desk server");
  } catch (error) {
    await stopServer(child);
    throw error;
  }
  return { appUrl, serverOutput, child };
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

async function waitForReady(url: URL, child: ChildProcess, output: () => string, what: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited before becoming ready.\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${what} did not become ready.\n${output()}`);
}
