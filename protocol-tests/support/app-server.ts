import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Running this app's servers from a test: the web app's production server, the operator's process, and optionally
// a Group Host process, each on a free port with readiness and a clean stop.

export type AppServer = { url: string; output(): string; stop(): Promise<void> };

/** `next start` on `port` with this process's environment; resolves once it serves its OAuth client metadata. */
export function startAppServer(port: number): Promise<AppServer> {
  return startServer(
    ["apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "127.0.0.1", "--port", String(port)],
    `http://127.0.0.1:${port}`,
    "/oauth/client-metadata.json",
  );
}

/**
 * Starts Flock Desk (`apps/desk`) on a dynamic or supplied origin, explicitly setting `DESK_APP_URL` and `APP_URL`
 * to the bound origin so any developer root `.env` `DESK_APP_URL` never overrides the test origin.
 */
export async function startDeskServer(env: NodeJS.ProcessEnv = {}): Promise<AppServer> {
  const configured = env.DESK_APP_URL ?? env.APP_URL;
  const appUrl = configured ? new URL(configured) : new URL(`http://127.0.0.1:${await availablePort()}`);
  const hostname = appUrl.hostname.replace(/^\[|\]$/g, "");
  const port = appUrl.port || (appUrl.protocol === "https:" ? "443" : "80");
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ...env,
    DESK_APP_URL: appUrl.origin,
    APP_URL: appUrl.origin,
  };
  return startServer(
    ["apps/desk/node_modules/next/dist/bin/next", "start", "apps/desk", "--hostname", hostname, "--port", port],
    appUrl.origin,
    "/oauth/client-metadata.json",
    mergedEnv,
  );
}

/** The operator's process at `OPERATOR_URL`, with this process's environment; resolves once it serves its did:web document. */
export function startOperatorServer(env: NodeJS.ProcessEnv = process.env): Promise<AppServer> {
  const url = env.OPERATOR_URL;
  assert.ok(url, "OPERATOR_URL says where the operator serves");
  return startServer(["--import", "tsx", "apps/operator/src/operator/main.ts"], new URL(url).origin, "/.well-known/did.json", env);
}

/** The Group Host's process at `GROUP_HOST_URL`, with `env`; resolves once it serves its did:web document. */
export function startGroupHostProcess(env: NodeJS.ProcessEnv = process.env): Promise<AppServer> {
  const url = env.GROUP_HOST_URL;
  assert.ok(url, "GROUP_HOST_URL says where the Group Host serves");
  return startServer(["--import", "tsx", "apps/group-host/src/main.ts"], new URL(url).origin, "/.well-known/did.json", env);
}

/** One app: the web app at `APP_URL` and its operator at `OPERATOR_URL`, each its own process and origin. */
export type Stack = { appUrl: URL; operatorUrl: URL; output(): string; stop(): Promise<void> };

/**
 * Starts the operator, then the web app, with `env` (both read it: the web app its URLs, the operator its database and keys).
 * The operator may be on another site than the web app (`[::1]` beside `127.0.0.1`), as a cross-site deployment is.
 */
export async function startStack(env: NodeJS.ProcessEnv): Promise<Stack> {
  assert.ok(env.APP_URL && env.OPERATOR_URL, "APP_URL and OPERATOR_URL say where the two processes serve");
  const appUrl = new URL(env.APP_URL);
  const operator = await startOperatorServer(env);
  let web: AppServer;
  try {
    web = await startServer(
      ["apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", appUrl.hostname, "--port", appUrl.port],
      appUrl.origin,
      "/oauth/client-metadata.json",
      env,
    );
  } catch (error) {
    await operator.stop();
    throw error;
  }
  return {
    appUrl,
    operatorUrl: new URL(env.OPERATOR_URL),
    output: () => `${web.output()}\n--- operator ---\n${operator.output()}`,
    stop: async () => {
      await web.stop();
      await operator.stop();
    },
  };
}

async function startServer(args: string[], url: string, readyPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AppServer> {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const capture = (chunk: string) => {
    output = `${output}${chunk}`.slice(-20_000);
  };
  child.stdout?.setEncoding("utf8").on("data", capture);
  child.stderr?.setEncoding("utf8").on("data", capture);
  const stop = async () => {
    const closed = waitForChildClose(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  };
  try {
    await waitForReady(`${url}${readyPath}`, child);
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
  return { url, output: () => output, stop };
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Waits until `readyUrl` answers 200, or the server exits. */
export async function waitForReady(readyUrl: string, child: ChildProcess): Promise<void> {
  let lastError = "The server did not become ready.";
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The server exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode}).`);
    }
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `${readyUrl} returned ${response.status}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(lastError);
}

export function waitForChildClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The server did not stop after SIGTERM."));
    }, 10_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
