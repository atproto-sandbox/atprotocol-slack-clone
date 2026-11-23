import { startAppFixture } from "../protocol-tests/support/app-fixture";

// Local playground: the shared app fixture (two in-memory personal PDS hosts, an OpenSocial Group Host, a PLC directory,
// this app served by `next start`, and its operator in its own process) with ready-made personal accounts.
// Nothing here touches the real network or any real account.

const PASSWORD = "playground-pass";

const accounts = [
  { handle: "alice.test", host: 0, role: "group creator / admin on PDS 1" },
  { handle: "bob.test2", host: 1, role: "member on PDS 2" },
  { handle: "carol.test2", host: 1, role: "member on PDS 2" },
  { handle: "dave.test", host: 0, role: "member on PDS 1" },
] as const;

async function main(): Promise<void> {
  const fixture = await startAppFixture({ preferredPort: 3000 });
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("\nShutting down…\n");
    await fixture.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const created = [];
  for (const account of accounts) {
    created.push({ ...(await fixture.createAccount(account.handle, account.host, PASSWORD)), role: account.role });
  }

  process.stdout.write(
    [
      "",
      `READY  ${fixture.appUrl.origin}`,
      "",
      `All personal accounts use the password "${created[0]!.password}". Type the DID (not the handle) into the app's sign-in box.`,
      "",
      ...created.map((account) => `  ${account.handle.padEnd(12)} ${account.did}   ${account.role}`),
      "",
      `PDS 1: ${fixture.pdsUrls[0]}   PDS 2: ${fixture.pdsUrls[1]}   Group Host: ${fixture.groupHostUrl.origin}   PLC: ${fixture.plcUrl}`,
      "State lives in memory and a temp folder; it disappears when you stop this. Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
