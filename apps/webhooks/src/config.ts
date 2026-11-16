import { resolve } from "node:path";
import type { Jwk } from "@flock/client/node/oauth";

// The webhooks app's configuration, from its environment (see `.env.example`).

export type WebhooksConfig = {
  appUrl: string;
  /** Where the server listens: on a loopback URL, that loopback address only; otherwise every interface (behind a proxy). */
  host: string | undefined;
  port: number;
  loopback: boolean;
  trustProxy: boolean;
  keys: Jwk[];
  stateFile: string;
  hooksFile: string;
  did: string | null;
  workspaces: string[];
  plcUrl: string;
  operatorUrl: string;
  operatorServiceRef: string;
};

export function readWebhooksConfig(env: Readonly<Record<string, string | undefined>>): WebhooksConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const appUrl = new URL(required("WEBHOOKS_URL"));
  const loopback = appUrl.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(appUrl.hostname);
  if (appUrl.protocol !== "https:" && !loopback) {
    throw new Error("WEBHOOKS_URL is https, or http on 127.0.0.1 or [::1] for development.");
  }
  const keys = env.WEBHOOKS_PRIVATE_JWKS?.trim() ? (JSON.parse(env.WEBHOOKS_PRIVATE_JWKS) as { keys?: Jwk[] }).keys : [];
  if (!Array.isArray(keys)) throw new Error('WEBHOOKS_PRIVATE_JWKS is a JWK set: {"keys":[...]}.');
  if (appUrl.protocol === "https:" && keys.length === 0) {
    throw new Error("WEBHOOKS_PRIVATE_JWKS is required when WEBHOOKS_URL is https.");
  }
  const port = Number(env.WEBHOOKS_PORT?.trim() || appUrl.port || (appUrl.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("WEBHOOKS_PORT is a TCP port.");
  const stateFile = required("WEBHOOKS_STATE_FILE");
  const hooksFile = env.WEBHOOKS_HOOKS_FILE?.trim() || `${stateFile}.hooks.json`;
  if (resolve(hooksFile) === resolve(stateFile)) {
    throw new Error("WEBHOOKS_HOOKS_FILE must sit beside WEBHOOKS_STATE_FILE, never inside the same file.");
  }
  return {
    appUrl: appUrl.origin,
    host: loopback ? appUrl.hostname.replace(/^\[|\]$/g, "") : undefined,
    port,
    loopback,
    trustProxy: env.WEBHOOKS_TRUST_PROXY?.trim() === "true",
    keys,
    stateFile,
    hooksFile,
    did: env.WEBHOOKS_DID?.trim() || null,
    workspaces: (env.WEBHOOKS_WORKSPACES ?? "").split(",").map((uri) => uri.trim()).filter(Boolean),
    plcUrl: required("PLC_URL"),
    operatorUrl: required("OPERATOR_URL"),
    operatorServiceRef: required("OPERATOR_SERVICE_REF"),
  };
}
