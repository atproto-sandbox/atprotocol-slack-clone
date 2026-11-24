import { isLoopback } from "@flock/deployment/config";

/**
 * Shared loopback hostname predicate aligned with `@flock/deployment/config`:
 * accepts ONLY `"localhost"`, `"127.0.0.1"`, `"::1"`, `"[::1]"` (never `*.localhost`).
 */
export function isLoopbackHostname(hostname: string): boolean {
  return isLoopback(hostname);
}

export type JwkPrivateKey = JsonWebKey & {
  kid: string;
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
};

export type GroupHostConfig = {
  port: number;
  /** Normalized canonical origin (`http://127.0.0.1:<port>` on loopback dev, `https://<host>` in prod; no trailing slash). */
  publicUrl: string;
  /** Canonical `did:web:...` service DID for this Group Host. */
  serviceDid: string;
  plcUrl: string;
  databasePath: string;
  encryptionKeyHex: string;
  servicePrivateJwks?: readonly JwkPrivateKey[];
  handleDomain: string;
  allowLoopback: boolean;
  blobUploadLimit: number;
  migrationBlobUploadLimit: number;
  maxRepoImportSize: number;
  maxSpaceMetaImportSize: number;
  maxManifestBytes: number;
  /** Optional custom fetch override for in-memory parity tests; defaults to SSRF-safe `boundedSafeFetch`. */
  fetchImpl?: typeof globalThis.fetch;
};

const KID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function normalizeGroupHostPublicUrl(rawUrl: string, allowLoopback: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid GROUP_HOST_URL: ${rawUrl}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error(`GROUP_HOST_URL must be a bare origin without credentials, path, query, or hash: ${rawUrl}`);
  }
  if (parsed.hostname.toLowerCase() === "localhost" && parsed.protocol === "http:") {
    parsed.hostname = "127.0.0.1";
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === "http:") {
    if (!allowLoopback || !loopback) {
      throw new Error(`Plain HTTP GROUP_HOST_URL is allowed only for loopback development: ${rawUrl}`);
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`GROUP_HOST_URL must use http (loopback dev) or https: ${rawUrl}`);
  }
  return new URL(parsed.origin);
}

export function normalizePlcUrl(rawUrl: string, allowLoopback: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid PLC_URL: ${rawUrl}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error(`PLC_URL must be a bare origin without credentials, path, query, or hash: ${rawUrl}`);
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol === "http:") {
    if (!allowLoopback || !loopback) {
      throw new Error(`Plain HTTP PLC_URL is allowed only for loopback development: ${rawUrl}`);
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`PLC_URL must use http (loopback dev) or https: ${rawUrl}`);
  }
  return parsed.origin;
}

export function deriveGroupHostServiceDid(publicUrl: URL): string {
  const host = publicUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (publicUrl.protocol === "http:" && isLoopbackHostname(host)) {
    return `did:web:localhost${publicUrl.port ? `%3A${publicUrl.port}` : ""}`;
  }
  return `did:web:${publicUrl.port ? `${host}%3A${publicUrl.port}` : host}`;
}

/**
 * The `#atproto_pds` / `#opensocial_group` service endpoint advertised in DID documents (`did:plc` groups and
 * `did:web` host metadata). Outside loopback development this is `config.publicUrl` verbatim (`https://...`).
 * On loopback development, RFC 8252 OAuth redirect URIs and host-only OAuth cookies use `http://127.0.0.1:<port>`,
 * whereas `@atproto/pds` routes outbound `notifyRepoUpdate` / `notifyCredentialsRevoked` calls through
 * `safeFetchWrap({ allowIpHost: false })`, which rejects IP literals and requires `http://localhost:<port>`.
 */
export function groupHostPdsServiceEndpoint(config: Pick<GroupHostConfig, "publicUrl" | "allowLoopback">): string {
  if (!config.allowLoopback) return config.publicUrl;
  const parsed = new URL(config.publicUrl);
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    parsed.hostname = "localhost";
    return parsed.origin;
  }
  return config.publicUrl;
}

export function parseServicePrivateJwks(rawJson: string | undefined): JwkPrivateKey[] | undefined {
  if (!rawJson || rawJson.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("GROUP_HOST_SERVICE_PRIVATE_JWKS must be valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { keys?: unknown }).keys) ||
    (parsed as { keys: unknown[] }).keys.length === 0
  ) {
    throw new Error("GROUP_HOST_SERVICE_PRIVATE_JWKS must be a non-empty JWK Set {\"keys\":[...]}.");
  }
  const seenKids = new Set<string>();
  const keys: JwkPrivateKey[] = [];
  for (const item of (parsed as { keys: unknown[] }).keys) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Each entry in GROUP_HOST_SERVICE_PRIVATE_JWKS must be a JWK object.");
    }
    const jwk = item as Record<string, unknown>;
    if (
      typeof jwk.kid !== "string" ||
      !KID_PATTERN.test(jwk.kid) ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      typeof jwk.d !== "string"
    ) {
      throw new Error("Each JWK in GROUP_HOST_SERVICE_PRIVATE_JWKS must be an ES256 private key with [a-zA-Z0-9_-]{1,64} kid.");
    }
    if (seenKids.has(jwk.kid)) {
      throw new Error(`Duplicate kid in GROUP_HOST_SERVICE_PRIVATE_JWKS: ${jwk.kid}`);
    }
    seenKids.add(jwk.kid);
    keys.push({
      kid: jwk.kid,
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      d: jwk.d,
    });
  }
  return keys;
}

export function parseGroupHostPortEnv(rawPort: string | undefined): number | undefined {
  if (rawPort === undefined || rawPort.trim() === "") return undefined;
  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid GROUP_HOST_PORT: ${rawPort}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid GROUP_HOST_PORT: ${rawPort}`);
  }
  return parsed;
}

export function loadGroupHostConfig(overrides: Partial<GroupHostConfig> = {}): GroupHostConfig {
  const allowLoopback =
    overrides.allowLoopback ??
    ((process.env.NODE_ENV !== "production" || process.env.ATPROTO_ACCEPTANCE_TEST === "true") &&
      process.env.ALLOW_LOOPBACK !== "false");
  const rawPublicUrl = overrides.publicUrl ?? process.env.GROUP_HOST_URL ?? "http://127.0.0.1:3004";
  const publicUrlObj = normalizeGroupHostPublicUrl(rawPublicUrl, allowLoopback);
  if (
    overrides.port !== undefined &&
    (!Number.isSafeInteger(overrides.port) || overrides.port < 0 || overrides.port > 65535)
  ) {
    throw new Error(`Invalid Group Host port: ${String(overrides.port)}`);
  }
  const envPort = parseGroupHostPortEnv(process.env.GROUP_HOST_PORT);
  const port =
    overrides.port ??
    envPort ??
    (publicUrlObj.port ? Number(publicUrlObj.port) : publicUrlObj.protocol === "https:" ? 443 : 3004);
  const serviceDid = overrides.serviceDid ?? deriveGroupHostServiceDid(publicUrlObj);
  const rawPlcUrl = overrides.plcUrl ?? process.env.PLC_URL ?? "https://plc.directory";
  const plcUrl = normalizePlcUrl(rawPlcUrl, allowLoopback);
  const databasePath = overrides.databasePath ?? process.env.GROUP_HOST_DATABASE_PATH ?? "./data/group-host.db";
  const encryptionKeyHex = overrides.encryptionKeyHex ?? process.env.GROUP_HOST_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
    throw new Error("GROUP_HOST_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
  }
  const servicePrivateJwks =
    overrides.servicePrivateJwks ?? parseServicePrivateJwks(process.env.GROUP_HOST_SERVICE_PRIVATE_JWKS);
  const handleDomain = (overrides.handleDomain ?? process.env.GROUP_HOST_HANDLE_DOMAIN ?? "groups.localhost")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!handleDomain || !/^[a-z0-9.-]+$/.test(handleDomain)) {
    throw new Error(`Invalid GROUP_HOST_HANDLE_DOMAIN: ${handleDomain}`);
  }

  return {
    port,
    publicUrl: publicUrlObj.origin,
    serviceDid,
    plcUrl,
    databasePath,
    encryptionKeyHex: encryptionKeyHex.toLowerCase(),
    ...(servicePrivateJwks ? { servicePrivateJwks } : {}),
    handleDomain,
    allowLoopback,
    blobUploadLimit: overrides.blobUploadLimit ?? 10 * 1024 * 1024,
    migrationBlobUploadLimit: overrides.migrationBlobUploadLimit ?? 100 * 1024 * 1024,
    maxRepoImportSize: overrides.maxRepoImportSize ?? 100 * 1024 * 1024,
    maxSpaceMetaImportSize: overrides.maxSpaceMetaImportSize ?? 100 * 1024 * 1024,
    maxManifestBytes: overrides.maxManifestBytes ?? 4 * 1024 * 1024,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  };
}
