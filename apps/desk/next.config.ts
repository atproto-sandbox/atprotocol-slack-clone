import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";
import { DESK_ENV_FILE_KEYS } from "@flock/deployment/config";
import { securityHeaderRule } from "@flock/deployment/security-headers";

// Next reads `.env` files from this app's directory, while the repository shares a root `.env`.
// Desk loads strictly `DESK_ENV_FILE_KEYS` (`DESK_APP_URL`, `PLC_URL`, `GROUP_HOST_URL`),
// never inheriting Web's `APP_URL` or any Operator secrets.
const repositoryEnv = new URL("../../.env", import.meta.url);
if (existsSync(repositoryEnv)) {
  const file = parseEnv(readFileSync(repositoryEnv, "utf8"));
  for (const name of DESK_ENV_FILE_KEYS) process.env[name] ??= file[name];
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  async headers() {
    return [securityHeaderRule()];
  },
};

export default nextConfig;
