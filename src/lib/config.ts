import { isIP } from "node:net";

export type AppConfig = {
  appUrl: URL;
  databasePath: string;
  encryptionKey: Buffer;
  plcDirectoryUrl: URL;
  operatorServiceRef: string;
  /** How long a cached copy of a space stays after the account last read it, for accounts that never return. */
  cacheRetentionDays: number;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const appUrl = absoluteUrl("APP_URL", process.env.APP_URL ?? "http://127.0.0.1:3000");
  const local = isLoopback(appUrl.hostname);
  if (!local && appUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS outside loopback development.");
  }
  // The OAuth loopback redirect URI must use an IP literal. Keep the browser
  // on that same origin so host-only OAuth flow cookies reach the callback.
  if (local && appUrl.protocol === "http:") appUrl.hostname = "127.0.0.1";

  const rawKey = process.env.AUTH_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(rawKey)) {
    throw new Error("AUTH_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hex characters.");
  }

  const operatorServiceRef = process.env.OPERATOR_SERVICE_REF ?? "";
  if (!/^did:[a-z0-9]+:[^#]+#[a-zA-Z0-9_-]+$/.test(operatorServiceRef)) {
    throw new Error("OPERATOR_SERVICE_REF must be a DID service reference with a fragment.");
  }

  const cacheRetentionDays = Number(process.env.CACHE_RETENTION_DAYS || "30");
  if (!Number.isSafeInteger(cacheRetentionDays) || cacheRetentionDays < 1 || cacheRetentionDays > 3650) {
    throw new Error("CACHE_RETENTION_DAYS must be a whole number of days from 1 to 3650.");
  }

  cached = {
    appUrl,
    databasePath: process.env.DATABASE_PATH ?? "./data/slack.db",
    encryptionKey: Buffer.from(rawKey, "hex"),
    plcDirectoryUrl: absoluteUrl("PLC_URL", process.env.PLC_URL ?? "https://plc.directory"),
    operatorServiceRef,
    cacheRetentionDays,
  };
  return cached;
}

function absoluteUrl(name: string, input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}
