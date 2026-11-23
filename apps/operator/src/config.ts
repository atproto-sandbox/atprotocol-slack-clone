import { getConfig, resetConfigCacheForTest, type AppConfig } from "@flock/deployment/config";

// What only the operator reads from the environment: its database, the key its stored grants are encrypted with, and the
// authority client's signing keys. The URLs it shares with the web app come from `@flock/deployment/config`.

/** What only the operator has: its database and the key its stored grants are encrypted with. */
export type OperatorConfig = AppConfig & { databasePath: string; encryptionKey: Buffer };

/** A private EC P-256 JWK with its key ID. */
export type AuthorityClientKey = { kty: "EC"; crv: "P-256"; x: string; y: string; d: string; kid: string };

let cachedOperator: OperatorConfig | undefined;

export function resetOperatorConfigCacheForTest(): void {
  cachedOperator = undefined;
  authorityKeys = undefined;
  resetConfigCacheForTest();
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
