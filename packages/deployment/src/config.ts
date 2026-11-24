/**
 * What the web app and the operator both read from the environment, with the same rules: the web origin, the operator's own
 * URL, the default opensocial.group Group Host URL, the PLC and the operator's DID. What only the operator reads is in `@flock/operator/config`.
 */
export type AppConfig = {
  appUrl: URL;
  /** Where the operator serves its methods, its authority flow and its `did:web` document. */
  operatorUrl: URL;
  /** Default `opensocial.group` Group Host origin used for `prompt=create` group creation and Group OAuth. */
  groupHostUrl: URL;
  plcDirectoryUrl: URL;
  operatorServiceRef: string;
};

/** The variables `getConfig` reads: everything the web app takes from its environment. */
export const SHARED_ENVIRONMENT = ["APP_URL", "OPERATOR_URL", "GROUP_HOST_URL", "PLC_URL", "OPERATOR_SERVICE_REF"] as const;

/**
 * The root `.env` keys Flock Desk is allowed to inherit. Explicitly omits Web's `APP_URL`,
 * `OPERATOR_URL`, `OPERATOR_SERVICE_REF`, and `AUTH_ENCRYPTION_KEY` so `@flock/web`'s local
 * configuration and Operator secrets never leak into or hijack Desk.
 */
export const DESK_ENV_FILE_KEYS = ["DESK_APP_URL", "PLC_URL", "GROUP_HOST_URL"] as const;

export type DeskConfig = {
  appUrl: URL;
  plcDirectoryUrl: URL;
  groupHostUrl?: URL;
};

let cached: AppConfig | undefined;
let cachedDesk: DeskConfig | undefined;

export function resetConfigCacheForTest(): void {
  cached = undefined;
  cachedDesk = undefined;
}

export function getDeskConfig(): DeskConfig {
  if (cachedDesk) return cachedDesk;

  const rawAppUrl =
    process.env.DESK_APP_URL ??
    process.env.APP_URL ??
    (process.env.NODE_ENV !== "production" ? "http://127.0.0.1:3005" : undefined);
  if (rawAppUrl === undefined) {
    throw new Error("DESK_APP_URL (or APP_URL) is required in production.");
  }
  const appUrlName = process.env.DESK_APP_URL !== undefined ? "DESK_APP_URL" : "APP_URL";
  const appUrl = serviceUrl(appUrlName, rawAppUrl);

  const groupHostInput = process.env.GROUP_HOST_URL ?? (isLoopback(appUrl.hostname) ? "http://127.0.0.1:3004" : undefined);
  const groupHostUrl = groupHostInput !== undefined ? serviceUrl("GROUP_HOST_URL", groupHostInput) : undefined;

  cachedDesk = {
    appUrl,
    plcDirectoryUrl: plcOriginUrl("PLC_URL", process.env.PLC_URL ?? "https://plc.directory"),
    ...(groupHostUrl !== undefined ? { groupHostUrl } : {}),
  };
  return cachedDesk;
}

export function getConfig(): AppConfig {
  if (cached) return cached;

  const operatorServiceRef = process.env.OPERATOR_SERVICE_REF ?? "";
  if (!/^did:[a-z0-9]+:[^#]+#[a-zA-Z0-9_-]+$/.test(operatorServiceRef)) {
    throw new Error("OPERATOR_SERVICE_REF must be a DID service reference with a fragment.");
  }

  const appUrl = serviceUrl("APP_URL", process.env.APP_URL ?? "http://127.0.0.1:3000");
  // The operator's and group host's defaults are loopback development's; a deployed web app names both.
  const operatorInput = process.env.OPERATOR_URL ?? (isLoopback(appUrl.hostname) ? "http://127.0.0.1:3001" : undefined);
  if (operatorInput === undefined) throw new Error("OPERATOR_URL is required outside loopback development.");
  const operatorUrl = serviceUrl("OPERATOR_URL", operatorInput);

  const groupHostInput = process.env.GROUP_HOST_URL ?? (isLoopback(appUrl.hostname) ? "http://127.0.0.1:3004" : undefined);
  if (groupHostInput === undefined) throw new Error("GROUP_HOST_URL is required outside loopback development.");
  const groupHostUrl = serviceUrl("GROUP_HOST_URL", groupHostInput);

  cached = {
    appUrl,
    operatorUrl,
    groupHostUrl,
    plcDirectoryUrl: plcOriginUrl("PLC_URL", process.env.PLC_URL ?? "https://plc.directory"),
    operatorServiceRef,
  };
  return cached;
}

/**
 * A URL a browser reaches: HTTPS, except for loopback development. There the OAuth loopback redirect URI must be an IP
 * literal, so `localhost` becomes 127.0.0.1 and the browser stays on the origin its host-only OAuth flow cookies are for;
 * an IP literal (127.0.0.1, or [::1] for a second site) is kept.
 */
export function serviceUrl(name: string, input: string): URL {
  const url = absoluteUrl(name, input);
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be a bare origin without credentials, path, query, or fragment.`);
  }
  const local = isLoopback(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error(`${name} must use HTTPS outside loopback development.`);
  if (local && url.protocol === "http:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function plcOriginUrl(name: string, input: string): URL {
  const url = absoluteUrl(name, input);
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${name} must be a bare origin without credentials, path, query, or fragment.`);
  }
  if (!isLoopback(url.hostname) && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS outside loopback development.`);
  }
  return new URL(url.origin);
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
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must not contain embedded credentials, query parameters, or fragments.`);
  }
  return url;
}

/** Whether a URL's hostname is this machine: loopback development (`localhost`, `127.0.0.1`, `::1`, `[::1]`). */
export function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
