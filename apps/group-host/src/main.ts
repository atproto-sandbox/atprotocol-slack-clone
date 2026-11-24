import { startGroupHostServer } from "./server";

async function main(): Promise<void> {
  const host = await startGroupHostServer();
  process.stdout.write(`OpenSocial Group Host (${host.config.serviceDid}) listening at ${host.url}\n`);

  const shutdown = async () => {
    await host.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((err: unknown) => {
  process.stderr.write(`Group Host failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
