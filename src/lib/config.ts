import { isIP } from "node:net";

/** What the web app and the operator both need: the web origin, the operator's own URL, the PLC and the operator's DID. */
export type AppConfig = {
  appUrl: URL;
  /** Where the operator serves its methods, its authority flow and its `did:web` document. */
  operatorUrl: URL;
  plcDirectoryUrl: URL;
  operatorServiceRef: string;
};

/** What only the operator has: its database and the key its stored grants are encrypted with. */
export type OperatorConfig = AppConfig & { databasePath: string; encryptionKey: Buffer };

/** A private EC P-256 JWK with its key ID. */
export type AuthorityClientKey = { kty: "EC"; crv: "P-256"; x: string; y: string; d: string; kid: string };

let cached: AppConfig | undefined;
let cachedOperator: OperatorConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const operatorServiceRef = process.env.OPERATOR_SERVICE_REF ?? "";
  if (!/^did:[a-z0-9]+:[^#]+#[a-zA-Z0-9_-]+$/.test(operatorServiceRef)) {
    throw new Error("OPERATOR_SERVICE_REF must be a DID service reference with a fragment.");
  }

  const appUrl = serviceUrl("APP_URL", process.env.APP_URL ?? "http://127.0.0.1:3000");
  // The operator's default is loopback development's; a deployed web app names its operator.
  const operatorInput = process.env.OPERATOR_URL ?? (isLoopback(appUrl.hostname) ? "http://127.0.0.1:3001" : undefined);
  if (operatorInput === undefined) throw new Error("OPERATOR_URL is required outside loopback development.");
  const operatorUrl = serviceUrl("OPERATOR_URL", operatorInput);
  cached = {
    appUrl,
    operatorUrl,
    plcDirectoryUrl: absoluteUrl("PLC_URL", process.env.PLC_URL ?? "https://plc.directory"),
    operatorServiceRef,
  };
  return cached;
}

/** The operator's configuration: the shared one, its database and its encryption key. Only the operator process reads it. */
export function getOperatorConfig(): OperatorConfig {
  if (cachedOperator) return cachedOperator;
  const rawKey = process.env.AUTH_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(rawKey)) {
    throw new Error("AUTH_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hex characters.");
  }
  cachedOperator = { ...getConfig(), databasePath: process.env.DATABASE_PATH ?? "./data/flock.db", encryptionKey: Buffer.from(rawKey, "hex") };
  return cachedOperator;
}

/**
 * A URL a browser reaches: HTTPS, except for loopback development. There the OAuth loopback redirect URI must be an IP
 * literal, so `localhost` becomes 127.0.0.1 and the browser stays on the origin its host-only OAuth flow cookies are for;
 * an IP literal (127.0.0.1, or [::1] for a second site) is kept.
 */
function serviceUrl(name: string, input: string): URL {
  const url = absoluteUrl(name, input);
  const local = isLoopback(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error(`${name} must use HTTPS outside loopback development.`);
  if (local && url.protocol === "http:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

let authorityKeys: readonly AuthorityClientKey[] | undefined;

/**
 * The workspace-authority OAuth client's private signing keys (ES256), newest first; the first signs and all are published
 * so a key can be rotated. Only the operator needs them, so they are read on first use. Empty on loopback development, where
 * the authority client is a public loopback client.
 */
export function getAuthorityClientKeys(): readonly AuthorityClientKey[] {
  if (authorityKeys) return authorityKeys;
  authorityKeys = getConfig().operatorUrl.protocol === "http:" ? [] : parseAuthorityClientKeys(process.env.AUTHORITY_CLIENT_PRIVATE_JWKS ?? "");
  return authorityKeys;
}

export function parseAuthorityClientKeys(raw: string): AuthorityClientKey[] {
  const failure = new Error("AUTHORITY_CLIENT_PRIVATE_JWKS must be a JSON JWK set of private EC P-256 keys with unique kids outside loopback development.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failure;
  }
  const keys = typeof parsed === "object" && parsed !== null && "keys" in parsed ? parsed.keys : undefined;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isAuthorityClientKey)) throw failure;
  if (new Set(keys.map((key) => key.kid)).size !== keys.length) throw failure;
  return keys;
}

function isAuthorityClientKey(value: unknown): value is AuthorityClientKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return key.kty === "EC" && key.crv === "P-256" &&
    [key.x, key.y, key.d, key.kid].every((part) => typeof part === "string" && part.length > 0);
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

/** Whether a URL's hostname is this machine: loopback development. */
export function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}
