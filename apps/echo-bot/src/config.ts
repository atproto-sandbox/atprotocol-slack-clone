import type { Jwk } from "@flock/client/node/oauth";

// The echo bot's configuration, from its environment (the repository's `.env` in development; see `.env.example`).

export type EchoBotConfig = {
  appUrl: string;
  /** Where the bot listens: on a loopback URL, that loopback address only; otherwise every interface (behind a proxy). */
  host: string | undefined;
  port: number;
  keys: Jwk[];
  stateFile: string;
  did: string | null;
  workspaces: string[];
  plcUrl: string;
  operatorUrl: string;
  operatorServiceRef: string;
};

export function readEchoBotConfig(env: Readonly<Record<string, string | undefined>>): EchoBotConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const appUrl = new URL(required("ECHO_BOT_URL"));
  // A loopback OAuth client is named by its address, never `localhost` (RFC 8252), as the OAuth client requires.
  const loopback = appUrl.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(appUrl.hostname);
  if (appUrl.protocol !== "https:" && !loopback) throw new Error("ECHO_BOT_URL is https, or http on 127.0.0.1 or [::1] for development.");
  const keys = env.ECHO_BOT_PRIVATE_JWKS?.trim() ? (JSON.parse(env.ECHO_BOT_PRIVATE_JWKS) as { keys?: Jwk[] }).keys : [];
  if (!Array.isArray(keys)) throw new Error("ECHO_BOT_PRIVATE_JWKS is a JWK set: {\"keys\":[...]}.");
  if (appUrl.protocol === "https:" && keys.length === 0) throw new Error("ECHO_BOT_PRIVATE_JWKS is required when ECHO_BOT_URL is https.");
  const port = Number(env.ECHO_BOT_PORT?.trim() || appUrl.port || (appUrl.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("ECHO_BOT_PORT is a TCP port.");
  return {
    appUrl: appUrl.origin,
    host: loopback ? appUrl.hostname.replace(/^\[|\]$/g, "") : undefined,
    port,
    keys,
    stateFile: required("ECHO_BOT_STATE_FILE"),
    did: env.ECHO_BOT_DID?.trim() || null,
    workspaces: (env.ECHO_BOT_WORKSPACES ?? "").split(",").map((uri) => uri.trim()).filter(Boolean),
    plcUrl: required("PLC_URL"),
    operatorUrl: required("OPERATOR_URL"),
    operatorServiceRef: required("OPERATOR_SERVICE_REF"),
  };
}
