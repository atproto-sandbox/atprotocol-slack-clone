import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

// Running this app's production server from a test: a free port, readiness, and a clean stop. The server inherits the test
// process's environment, so it shares its database and keys.

export type AppServer = { url: string; output(): string; stop(): Promise<void> };

/** `next start` on `port` with this process's environment; resolves once it serves its OAuth client metadata. */
export async function startAppServer(port: number): Promise<AppServer> {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: string) => { output = `${output}${chunk}`.slice(-20_000); };
  child.stdout?.setEncoding("utf8").on("data", capture);
  child.stderr?.setEncoding("utf8").on("data", capture);
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    const closed = waitForChildClose(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  };
  try {
    await waitForClientMetadata(url, child);
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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function waitForClientMetadata(serverUrl: string, child: ChildProcess): Promise<void> {
  let lastError = "Next.js did not become ready.";
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Next.js exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode}).`);
    }
    try {
      const response = await fetch(`${serverUrl}/oauth/client-metadata.json`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `Next.js client metadata returned ${response.status}.`;
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
      reject(new Error("Next.js did not stop after SIGTERM."));
    }, 10_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
