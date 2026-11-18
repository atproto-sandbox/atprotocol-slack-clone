import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";
import { SHARED_ENVIRONMENT } from "@flock/deployment/config";
import { securityHeaderRule } from "@flock/deployment/security-headers";

// Next reads `.env` files from this app's directory, but the web app and the operator share the repository root's. The web
// app takes from it only the variables it reads, so the operator's secrets in the same file never reach this process; each
// is added only when the environment does not set it, as Node's `--env-file` (which the operator's scripts use) does.
const repositoryEnv = new URL("../../.env", import.meta.url);
if (existsSync(repositoryEnv)) {
  const file = parseEnv(readFileSync(repositoryEnv, "utf8"));
  for (const name of SHARED_ENVIRONMENT) process.env[name] ??= file[name];
}

const nextConfig: NextConfig = {
  // Output tracing starts at the repository root, where the workspace packages live.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  async headers() {
    return [securityHeaderRule()];
  },
};

export default nextConfig;
