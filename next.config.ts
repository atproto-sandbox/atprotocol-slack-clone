import type { NextConfig } from "next";
import { securityHeaderRule } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: process.cwd(),
  async headers() {
    return [securityHeaderRule()];
  },
};

export default nextConfig;
